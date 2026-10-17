import type { Capability, ImgError } from "../core/errors.js";
import { providerHttp } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { SizeRule } from "../domain/size.js";
import type { ImageProvider, ProviderCtx, ProviderIO, ProviderModel, RawImage, ResolvedJob } from "./port.js";

const A1111_SIZE_RULE: SizeRule = deepFreeze({
	kind: "multiple",
	step: 8,
	min: 64,
	max: 4096,
});

const A1111_CAPS: ReadonlySet<Capability> = new Set<Capability>([
	"txt2img",
	"img2img",
	"inpaint",
	"seed",
	"negative_prompt",
	"arbitrary_size",
	"steps",
	"guidance",
	"partial_previews",
	"native_tiling",
	"count",
]);

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class A1111Provider implements ImageProvider {
	public readonly id = "a1111";

	public async models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>> {
		if (!ctx.config.providers.a1111.enabled) {
			return ok([]);
		}
		const baseUrl = (ctx.config.providers.a1111.baseUrl ?? "http://127.0.0.1:7860").replace(/\/+$/, "");
		const defaultModel: ProviderModel = Object.freeze({
			id: "a1111/default",
			provider: "a1111",
			label: "Automatic1111 Default Checkpoint",
			caps: A1111_CAPS,
			sizes: A1111_SIZE_RULE,
			maxRefs: 1,
			maxCount: 8,
			costHint: "local",
			costPerImageUsd: 0,
			hasKey: true,
		});

		const res = await ctx.http.requestJson({
			provider: "a1111",
			url: `${baseUrl}/sdapi/v1/sd-models`,
			method: "GET",
			timeoutMs: 3_000,
			maxAttempts: 1,
		});
		if (!res.ok || !Array.isArray(res.value.data)) {
			return ok([defaultModel]);
		}

		const models: ProviderModel[] = [defaultModel];
		for (const entry of res.value.data) {
			if (isRecord(entry) && typeof entry["model_name"] === "string") {
				const name = entry["model_name"];
				models.push(
					Object.freeze({
						id: `a1111/${name}`,
						provider: "a1111",
						label: `A1111 ${name}`,
						caps: A1111_CAPS,
						sizes: A1111_SIZE_RULE,
						maxRefs: 1,
						maxCount: 8,
						costHint: "local",
						costPerImageUsd: 0,
						hasKey: true,
					}),
				);
			}
		}

		return ok(models);
	}

	public async generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>> {
		const baseUrl = (io.config.providers.a1111.baseUrl ?? "http://127.0.0.1:7860").replace(/\/+$/, "");
		const checkpoint = job.model.id.replace(/^a1111\//, "");
		const firstRef = job.initImage ?? job.references[0];
		const isImg2Img = firstRef !== undefined;
		const endpoint = isImg2Img ? `${baseUrl}/sdapi/v1/img2img` : `${baseUrl}/sdapi/v1/txt2img`;

		const bodyObj: Record<string, unknown> = {
			prompt: job.finalPrompt,
			negative_prompt: job.negativePrompt ?? "",
			width: job.size.width,
			height: job.size.height,
			seed: job.seed,
			steps: job.steps ?? 25,
			cfg_scale: job.guidance ?? 7.0,
			batch_size: job.count,
			tiling: job.tileable === true,
			...(checkpoint !== "default" ? { override_settings: { sd_model_checkpoint: checkpoint } } : {}),
			...(isImg2Img
				? {
						init_images: [firstRef.b64],
						denoising_strength: job.strength ?? 0.75,
						...(job.maskImage !== undefined ? { mask: job.maskImage.b64 } : {}),
					}
				: {}),
		};

		let done = false;
		const pollProgress = async (): Promise<void> => {
			if (done) return;
			const progRes = await io.http.requestJson({
				provider: "a1111",
				url: `${baseUrl}/sdapi/v1/progress`,
				method: "GET",
				timeoutMs: 2_000,
				maxAttempts: 1,
				signal: io.signal,
			});
			if (progRes.ok && isRecord(progRes.value.data)) {
				const pData = progRes.value.data;
				const frac = typeof pData["progress"] === "number" ? pData["progress"] : undefined;
				const stateRec = isRecord(pData["state"]) ? pData["state"] : undefined;
				const step =
					stateRec !== undefined && typeof stateRec["sampling_step"] === "number"
						? stateRec["sampling_step"]
						: undefined;
				const steps =
					stateRec !== undefined && typeof stateRec["sampling_steps"] === "number"
						? stateRec["sampling_steps"]
						: undefined;
				if (frac !== undefined && frac > 0) {
					io.emit({
						t: "provider_progress",
						fraction: frac,
						...(step !== undefined ? { step } : {}),
						...(steps !== undefined ? { steps } : {}),
						at: Date.now(),
					});
				}
				if (typeof pData["current_image"] === "string" && pData["current_image"].length > 0) {
					io.emit({
						t: "partial",
						index: 0,
						thumbB64: pData["current_image"],
						at: Date.now(),
					});
				}
			}
		};

		// Trigger one progress check right after starting generation
		const genPromise = io.http.requestJson({
			provider: "a1111",
			url: endpoint,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(bodyObj),
			signal: io.signal,
		});

		await pollProgress();
		const genRes = await genPromise;
		done = true;

		if (!genRes.ok) {
			return genRes;
		}
		const data = genRes.value.data;
		if (!isRecord(data) || !Array.isArray(data["images"]) || data["images"].length === 0) {
			return err(providerHttp("a1111", 502, "A1111 response contained no images", false));
		}

		const rawImages: readonly unknown[] = data["images"];
		const outImages: RawImage[] = [];
		for (let i = 0; i < rawImages.length; i++) {
			const b64Item: unknown = rawImages[i];
			if (typeof b64Item !== "string") continue;
			const dec = await io.pool.run({ op: "decode_b64", b64: b64Item }, { signal: io.signal });
			if (!dec.ok) {
				return dec;
			}
			outImages.push({
				buffer: dec.value.buffer,
				mimeType: "image/png",
				seed: job.seed + i,
				reportedModel: checkpoint,
			});
		}

		return ok(outImages);
	}
}

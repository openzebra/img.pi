import type { Capability, ImgError } from "../core/errors.js";
import { contentPolicy, providerHttp } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { SizeRule } from "../domain/size.js";
import type { ImageProvider, ProviderCtx, ProviderIO, ProviderModel, RawImage, ResolvedJob } from "./port.js";

const REPLICATE_SIZE_RULE: SizeRule = deepFreeze({
	kind: "multiple",
	step: 16,
	min: 256,
	max: 1440,
});

const REPLICATE_CAPS: ReadonlySet<Capability> = new Set<Capability>([
	"txt2img",
	"img2img",
	"seed",
	"steps",
	"guidance",
	"arbitrary_size",
	"count",
]);

const REPLICATE_MODELS: readonly ProviderModel[] = Object.freeze([
	Object.freeze({
		id: "replicate/black-forest-labs/flux-1.1-pro",
		provider: "replicate",
		label: "Replicate FLUX 1.1 Pro",
		caps: REPLICATE_CAPS,
		sizes: REPLICATE_SIZE_RULE,
		maxRefs: 1,
		maxCount: 4,
		costHint: "$0.04/img",
		costPerImageUsd: 0.04,
	}),
	Object.freeze({
		id: "replicate/black-forest-labs/flux-dev",
		provider: "replicate",
		label: "Replicate FLUX Dev",
		caps: REPLICATE_CAPS,
		sizes: REPLICATE_SIZE_RULE,
		maxRefs: 1,
		maxCount: 4,
		costHint: "$0.025/img",
		costPerImageUsd: 0.025,
	}),
	Object.freeze({
		id: "replicate/black-forest-labs/flux-schnell",
		provider: "replicate",
		label: "Replicate FLUX Schnell",
		caps: REPLICATE_CAPS,
		sizes: REPLICATE_SIZE_RULE,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.003/img",
		costPerImageUsd: 0.003,
	}),
]);

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseReplicateLogProgress(logs: unknown): number | undefined {
	if (typeof logs !== "string") {
		return undefined;
	}
	const matches = Array.from(logs.matchAll(/(\d{1,3})%/g));
	const lastMatch = matches[matches.length - 1];
	if (lastMatch !== undefined) {
		const pct = Number(lastMatch[1]);
		if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
			return pct / 100;
		}
	}
	return undefined;
}

function extractOutputUrls(output: unknown): readonly string[] {
	if (typeof output === "string") {
		return [output];
	}
	if (Array.isArray(output)) {
		const urls: string[] = [];
		for (const item of output) {
			if (typeof item === "string") {
				urls.push(item);
			}
		}
		return urls;
	}
	return [];
}

export class ReplicateProvider implements ImageProvider {
	public readonly id = "replicate";

	public models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>> {
		if (!ctx.config.providers.replicate.enabled) {
			return Promise.resolve(ok([]));
		}
		const hasKey = ctx.secrets.hasDirectKey("replicate", ctx.config);
		return Promise.resolve(ok(REPLICATE_MODELS.map(m => Object.freeze({ ...m, hasKey }))));
	}

	public createDynamicModel(modelId: string, hasKey: boolean): ProviderModel {
		const clean = modelId.startsWith("replicate/") ? modelId : `replicate/${modelId}`;
		return Object.freeze({
			id: clean,
			provider: "replicate",
			label: clean.replace(/^replicate\//, ""),
			caps: REPLICATE_CAPS,
			sizes: REPLICATE_SIZE_RULE,
			maxRefs: 1,
			maxCount: 4,
			hasKey,
		});
	}

	public async generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>> {
		const keyRes = await io.secrets.resolveKey("replicate", io.config);
		if (!keyRes.ok) {
			return keyRes;
		}
		const apiKey = keyRes.value;
		const slug = job.model.id.replace(/^replicate\//, "");
		const [modelPath, versionHash] = slug.split(":");

		const firstRef = job.initImage ?? job.references[0];
		const inputObj: Record<string, unknown> = {
			prompt: job.finalPrompt,
			width: job.size.width,
			height: job.size.height,
			seed: job.seed,
			num_outputs: job.count,
			...(job.aspectRatio !== undefined ? { aspect_ratio: job.aspectRatio } : {}),
			...(job.steps !== undefined ? { num_inference_steps: job.steps } : {}),
			...(job.guidance !== undefined ? { guidance: job.guidance } : {}),
			...(firstRef !== undefined ? { image: `data:${firstRef.mimeType};base64,${firstRef.b64}` } : {}),
		};

		const endpoint =
			versionHash !== undefined && versionHash.length > 0
				? "https://api.replicate.com/v1/predictions"
				: `https://api.replicate.com/v1/models/${modelPath ?? slug}/predictions`;

		const bodyObj: Record<string, unknown> =
			versionHash !== undefined && versionHash.length > 0
				? { version: versionHash, input: inputObj }
				: { input: inputObj };

		const headers = {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Prefer: "wait=60",
		};

		const createRes = await io.http.requestJson({
			provider: "replicate",
			url: endpoint,
			method: "POST",
			headers,
			body: JSON.stringify(bodyObj),
			signal: io.signal,
		});
		if (!createRes.ok) {
			return createRes;
		}

		let pred: unknown = createRes.value.data;
		for (let poll = 0; poll < 180; poll++) {
			if (!isRecord(pred)) {
				break;
			}
			const frac = parseReplicateLogProgress(pred["logs"]);
			if (frac !== undefined) {
				io.emit({ t: "provider_progress", fraction: frac, at: Date.now() });
			}
			const status = typeof pred["status"] === "string" ? pred["status"] : "";
			if (status === "succeeded") {
				break;
			}
			if (status === "failed" || status === "canceled") {
				const errText = typeof pred["error"] === "string" ? pred["error"] : "Prediction failed";
				if (errText.toLowerCase().includes("nsfw") || errText.toLowerCase().includes("safety")) {
					return err(contentPolicy("replicate", errText));
				}
				return err(providerHttp("replicate", 500, errText, false));
			}
			const urlsRec = isRecord(pred["urls"]) ? pred["urls"] : undefined;
			const getUrl = urlsRec !== undefined && typeof urlsRec["get"] === "string" ? urlsRec["get"] : undefined;
			if (getUrl === undefined) {
				break;
			}
			const pollRes = await io.http.requestJson({
				provider: "replicate",
				url: getUrl,
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: io.signal,
			});
			if (!pollRes.ok) {
				return pollRes;
			}
			pred = pollRes.value.data;
		}

		const outputUrls = isRecord(pred) ? extractOutputUrls(pred["output"]) : [];
		if (outputUrls.length === 0) {
			return err(providerHttp("replicate", 502, "No output URLs in Replicate prediction", false));
		}

		const outImages: RawImage[] = [];
		for (const url of outputUrls) {
			const bytesRes = await io.http.requestBytes({
				provider: "replicate",
				url,
				method: "GET",
				signal: io.signal,
			});
			if (!bytesRes.ok) {
				return bytesRes;
			}
			outImages.push({
				buffer: bytesRes.value.buffer,
				mimeType: bytesRes.value.mimeType,
				seed: job.seed,
				reportedModel: slug,
			});
		}

		return ok(outImages);
	}
}

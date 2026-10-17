import type { Capability, ImgError } from "../core/errors.js";
import { providerHttp } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { SizeRule } from "../domain/size.js";
import type { ImageProvider, ProviderCtx, ProviderIO, ProviderModel, RawImage, ResolvedJob } from "./port.js";

const FAL_SIZE_RULE: SizeRule = deepFreeze({
	kind: "multiple",
	step: 16,
	min: 256,
	max: 2048,
});

const FLUX_CAPS: ReadonlySet<Capability> = new Set<Capability>([
	"txt2img",
	"seed",
	"steps",
	"guidance",
	"arbitrary_size",
	"count",
]);

const SCHNELL_CAPS: ReadonlySet<Capability> = new Set<Capability>(["txt2img", "seed", "arbitrary_size", "count"]);

const KONTEXT_CAPS: ReadonlySet<Capability> = new Set<Capability>([
	"txt2img",
	"img2img",
	"multi_ref",
	"seed",
	"steps",
	"guidance",
	"arbitrary_size",
]);

const FAL_UPSTREAM_MAP: Readonly<Record<string, string>> = Object.freeze({
	"fal/flux-pro-v1.1": "fal-ai/flux-pro/v1.1",
	"fal/flux-dev": "fal-ai/flux/dev",
	"fal/flux-schnell": "fal-ai/flux/schnell",
	"fal/flux-pro-kontext": "fal-ai/flux-pro/kontext",
});

const FAL_MODELS: readonly ProviderModel[] = Object.freeze([
	Object.freeze({
		id: "fal/flux-pro-v1.1",
		provider: "fal",
		label: "FLUX.1.1 [pro]",
		caps: FLUX_CAPS,
		sizes: FAL_SIZE_RULE,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.04/img",
		costPerImageUsd: 0.04,
	}),
	Object.freeze({
		id: "fal/flux-dev",
		provider: "fal",
		label: "FLUX.1 [dev]",
		caps: FLUX_CAPS,
		sizes: FAL_SIZE_RULE,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.025/img",
		costPerImageUsd: 0.025,
	}),
	Object.freeze({
		id: "fal/flux-schnell",
		provider: "fal",
		label: "FLUX.1 [schnell]",
		caps: SCHNELL_CAPS,
		sizes: FAL_SIZE_RULE,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.003/img",
		costPerImageUsd: 0.003,
	}),
	Object.freeze({
		id: "fal/flux-pro-kontext",
		provider: "fal",
		label: "FLUX.1 Kontext [pro]",
		caps: KONTEXT_CAPS,
		sizes: FAL_SIZE_RULE,
		maxRefs: 4,
		maxCount: 4,
		costHint: "$0.04/img",
		costPerImageUsd: 0.04,
	}),
]);

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractFalImages(
	data: unknown,
): readonly { readonly url: string; readonly contentType: string }[] | undefined {
	if (!isRecord(data) || !Array.isArray(data["images"])) {
		return undefined;
	}
	const out: { readonly url: string; readonly contentType: string }[] = [];
	for (const item of data["images"]) {
		if (isRecord(item) && typeof item["url"] === "string") {
			const ct = typeof item["content_type"] === "string" ? item["content_type"] : "image/png";
			out.push({ url: item["url"], contentType: ct });
		}
	}
	return out.length > 0 ? out : undefined;
}

function parseLogsFraction(data: unknown): number | undefined {
	if (!isRecord(data) || !Array.isArray(data["logs"])) {
		return undefined;
	}
	let bestPct: number | undefined;
	for (const entry of data["logs"]) {
		const msg = isRecord(entry) && typeof entry["message"] === "string" ? entry["message"] : "";
		const match = /(\d{1,3})%/.exec(msg);
		if (match !== null) {
			const pct = Number(match[1]);
			if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
				bestPct = pct / 100;
			}
		}
	}
	return bestPct;
}

export class FalProvider implements ImageProvider {
	public readonly id = "fal";

	public models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>> {
		if (!ctx.config.providers.fal.enabled) {
			return Promise.resolve(ok([]));
		}
		const hasKey = ctx.secrets.hasDirectKey("fal", ctx.config);
		return Promise.resolve(ok(FAL_MODELS.map(m => Object.freeze({ ...m, hasKey }))));
	}

	public async generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>> {
		const keyRes = await io.secrets.resolveKey("fal", io.config);
		if (!keyRes.ok) {
			return keyRes;
		}
		const apiKey = keyRes.value;
		const upstream = FAL_UPSTREAM_MAP[job.model.id] ?? `fal-ai/${job.model.id.replace(/^fal\//, "")}`;

		const firstRef = job.initImage ?? job.references[0];
		const reqBody: Record<string, unknown> = {
			prompt: job.finalPrompt,
			image_size: {
				width: job.size.width,
				height: job.size.height,
			},
			seed: job.seed,
			num_images: job.count,
			...(job.steps !== undefined ? { num_inference_steps: job.steps } : {}),
			...(job.guidance !== undefined ? { guidance_scale: job.guidance } : {}),
			...(firstRef !== undefined ? { image_url: `data:${firstRef.mimeType};base64,${firstRef.b64}` } : {}),
		};

		const authHeaders = {
			Authorization: `Key ${apiKey}`,
			"Content-Type": "application/json",
		};

		const submitRes = await io.http.requestJson({
			provider: "fal",
			url: `https://queue.fal.run/${upstream}`,
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(reqBody),
			signal: io.signal,
		});
		if (!submitRes.ok) {
			return submitRes;
		}

		let finalPayload: unknown = submitRes.value.data;
		const directImages = extractFalImages(finalPayload);

		if (directImages === undefined && isRecord(finalPayload)) {
			const statusUrl = typeof finalPayload["status_url"] === "string" ? finalPayload["status_url"] : undefined;
			const responseUrl =
				typeof finalPayload["response_url"] === "string" ? finalPayload["response_url"] : undefined;

			if (statusUrl !== undefined && responseUrl !== undefined) {
				for (let poll = 0; poll < 180; poll++) {
					const statusRes = await io.http.requestJson({
						provider: "fal",
						url: statusUrl.includes("?") ? `${statusUrl}&logs=1` : `${statusUrl}?logs=1`,
						method: "GET",
						headers: { Authorization: `Key ${apiKey}` },
						signal: io.signal,
					});
					if (!statusRes.ok) {
						return statusRes;
					}
					const sData = statusRes.value.data;
					const frac = parseLogsFraction(sData);
					if (frac !== undefined) {
						io.emit({ t: "provider_progress", fraction: frac, at: Date.now() });
					}
					const statusStr = isRecord(sData) && typeof sData["status"] === "string" ? sData["status"] : "";
					if (statusStr === "COMPLETED") {
						break;
					}
					if (statusStr === "FAILED" || statusStr === "ERROR") {
						return err(providerHttp("fal", 500, JSON.stringify(sData), false));
					}
				}

				const finalRes = await io.http.requestJson({
					provider: "fal",
					url: responseUrl,
					method: "GET",
					headers: { Authorization: `Key ${apiKey}` },
					signal: io.signal,
				});
				if (!finalRes.ok) {
					return finalRes;
				}
				finalPayload = finalRes.value.data;
			}
		}

		const images = extractFalImages(finalPayload);
		if (images === undefined || images.length === 0) {
			return err(providerHttp("fal", 502, "No images returned in fal response", false));
		}

		const reportedSeed =
			isRecord(finalPayload) && typeof finalPayload["seed"] === "number" ? finalPayload["seed"] : job.seed;

		const results: RawImage[] = [];
		for (const item of images) {
			const imgRes = await io.http.requestBytes({
				provider: "fal",
				url: item.url,
				method: "GET",
				signal: io.signal,
			});
			if (!imgRes.ok) {
				return imgRes;
			}
			results.push({
				buffer: imgRes.value.buffer,
				mimeType: imgRes.value.mimeType,
				seed: reportedSeed,
				reportedModel: upstream,
			});
		}

		return ok(results);
	}
}

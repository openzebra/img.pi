import type { Capability, ImgError } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { SizeRule } from "../domain/size.js";
import type { ImageProvider, ProviderCtx, ProviderIO, ProviderModel, RawImage, ResolvedJob } from "./port.js";

const STABILITY_ASPECT_SIZES: SizeRule = deepFreeze({
	kind: "aspects",
	aspects: ["1:1", "16:9", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"],
	resolutions: ["1K"],
});

const STABILITY_CAPS: ReadonlySet<Capability> = new Set<Capability>([
	"txt2img",
	"img2img",
	"seed",
	"negative_prompt",
	"count",
]);

const STABILITY_MODELS: readonly ProviderModel[] = Object.freeze([
	Object.freeze({
		id: "stability/sd3.5-large",
		provider: "stability",
		label: "Stable Diffusion 3.5 Large",
		caps: STABILITY_CAPS,
		sizes: STABILITY_ASPECT_SIZES,
		maxRefs: 1,
		maxCount: 4,
		costHint: "$0.065/img",
		costPerImageUsd: 0.065,
	}),
	Object.freeze({
		id: "stability/stable-image-ultra",
		provider: "stability",
		label: "Stable Image Ultra",
		caps: STABILITY_CAPS,
		sizes: STABILITY_ASPECT_SIZES,
		maxRefs: 1,
		maxCount: 4,
		costHint: "$0.08/img",
		costPerImageUsd: 0.08,
	}),
	Object.freeze({
		id: "stability/stable-image-core",
		provider: "stability",
		label: "Stable Image Core",
		caps: STABILITY_CAPS,
		sizes: STABILITY_ASPECT_SIZES,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.03/img",
		costPerImageUsd: 0.03,
	}),
]);

function endpointSuffixForModel(id: string): "sd3" | "ultra" | "core" {
	if (id.includes("ultra")) return "ultra";
	if (id.includes("core")) return "core";
	return "sd3";
}

export class StabilityProvider implements ImageProvider {
	public readonly id = "stability";

	public models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>> {
		if (!ctx.config.providers.stability.enabled) {
			return Promise.resolve(ok([]));
		}
		const hasKey = ctx.secrets.hasDirectKey("stability", ctx.config);
		return Promise.resolve(ok(STABILITY_MODELS.map(m => Object.freeze({ ...m, hasKey }))));
	}

	public async generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>> {
		const keyRes = await io.secrets.resolveKey("stability", io.config);
		if (!keyRes.ok) {
			return keyRes;
		}
		const apiKey = keyRes.value;
		const suffix = endpointSuffixForModel(job.model.id);
		const url = `https://api.stability.ai/v2beta/stable-image/generate/${suffix}`;

		const outImages: RawImage[] = [];
		for (let idx = 0; idx < job.count; idx++) {
			const form = new FormData();
			form.set("prompt", job.finalPrompt);
			if (job.negativePrompt !== undefined && job.negativePrompt.length > 0) {
				form.set("negative_prompt", job.negativePrompt);
			}
			form.set("aspect_ratio", job.aspectRatio ?? "1:1");
			form.set("seed", String(job.seed + idx));
			form.set("output_format", "png");
			if (suffix === "sd3") {
				form.set("model", "sd3.5-large");
			}
			const firstRef = job.initImage ?? job.references[0];
			if (firstRef !== undefined) {
				form.set("mode", "image-to-image");
				form.set("strength", String(job.strength ?? 0.7));
				const blob = new Blob([new Uint8Array(firstRef.buffer)], {
					type: firstRef.mimeType,
				});
				form.set("image", blob, "input.png");
			}

			const bytesRes = await io.http.requestBytes({
				provider: "stability",
				url,
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "image/*",
				},
				body: form,
				signal: io.signal,
			});
			if (!bytesRes.ok) {
				return bytesRes;
			}
			outImages.push({
				buffer: bytesRes.value.buffer,
				mimeType: bytesRes.value.mimeType,
				seed: job.seed + idx,
				reportedModel: job.model.id.replace(/^stability\//, ""),
			});
		}

		return ok(outImages);
	}
}

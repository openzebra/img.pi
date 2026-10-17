import type { Capability, ImgError } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { SizeRule } from "../domain/size.js";
import { Size } from "../domain/size.js";
import type { NativeInputImage } from "../host/port.js";
import type { ImageProvider, ProviderCtx, ProviderIO, ProviderModel, RawImage, ResolvedJob } from "./port.js";

const OPENAI_SIZES: SizeRule = deepFreeze({
	kind: "fixed",
	sizes: [new Size(1024, 1024), new Size(1536, 1024), new Size(1024, 1536)],
});

const GEMINI_ASPECT_SIZES: SizeRule = deepFreeze({
	kind: "aspects",
	aspects: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
	resolutions: ["1K", "2K"],
});

const IMAGEN_ASPECT_SIZES: SizeRule = deepFreeze({
	kind: "aspects",
	aspects: ["1:1", "3:4", "4:3", "9:16", "16:9"],
	resolutions: ["1K", "2K"],
});

const OPENAI_CAPS: ReadonlySet<Capability> = new Set<Capability>([
	"txt2img",
	"img2img",
	"inpaint",
	"multi_ref",
	"transparent_bg",
	"count",
]);

const GEMINI_CAPS: ReadonlySet<Capability> = new Set<Capability>(["txt2img", "img2img", "multi_ref"]);

const IMAGEN_CAPS: ReadonlySet<Capability> = new Set<Capability>(["txt2img", "count"]);

const BUILTIN_HOST_MODELS: readonly ProviderModel[] = Object.freeze([
	Object.freeze({
		id: "openai/gpt-image-1",
		provider: "openai",
		label: "GPT Image 1",
		caps: OPENAI_CAPS,
		sizes: OPENAI_SIZES,
		maxRefs: 16,
		maxCount: 10,
		costHint: "$0.04/img (1024² medium)",
		costPerImageUsd: 0.04,
	}),
	Object.freeze({
		id: "openai/gpt-image-1-mini",
		provider: "openai",
		label: "GPT Image 1 Mini",
		caps: OPENAI_CAPS,
		sizes: OPENAI_SIZES,
		maxRefs: 16,
		maxCount: 10,
		costHint: "$0.015/img",
		costPerImageUsd: 0.015,
	}),
	Object.freeze({
		id: "google/gemini-2.5-flash-image",
		provider: "google",
		label: "Gemini 2.5 Flash Image",
		caps: GEMINI_CAPS,
		sizes: GEMINI_ASPECT_SIZES,
		maxRefs: 8,
		maxCount: 4,
		costHint: "$0.039/img",
		costPerImageUsd: 0.039,
	}),
	Object.freeze({
		id: "google/imagen-4.0-generate-001",
		provider: "google",
		label: "Imagen 4.0",
		caps: IMAGEN_CAPS,
		sizes: IMAGEN_ASPECT_SIZES,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.04/img",
		costPerImageUsd: 0.04,
	}),
	Object.freeze({
		id: "google/imagen-4.0-ultra-generate-001",
		provider: "google",
		label: "Imagen 4.0 Ultra",
		caps: IMAGEN_CAPS,
		sizes: IMAGEN_ASPECT_SIZES,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.06/img",
		costPerImageUsd: 0.06,
	}),
	Object.freeze({
		id: "google/imagen-4.0-fast-generate-001",
		provider: "google",
		label: "Imagen 4.0 Fast",
		caps: IMAGEN_CAPS,
		sizes: IMAGEN_ASPECT_SIZES,
		maxRefs: 0,
		maxCount: 4,
		costHint: "$0.02/img",
		costPerImageUsd: 0.02,
	}),
]);

export class HostNativeProvider implements ImageProvider {
	public readonly id = "host";

	public models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>> {
		if (!ctx.config.providers.host.enabled) {
			return Promise.resolve(ok([]));
		}
		const discovered = ctx.host.nativeImageModels(ctx.hostCtx);
		const byId = new Map<string, ProviderModel>();

		for (const base of BUILTIN_HOST_MODELS) {
			const match = discovered.find(d => d.id === base.id || d.modelId === base.id.split("/")[1]);
			const hasDirectEnvKey = ctx.secrets.hasDirectKey(base.provider, ctx.config);
			byId.set(base.id, {
				...base,
				hasKey: match !== undefined ? match.hasKey : hasDirectEnvKey,
			});
		}

		for (const item of discovered) {
			if (byId.has(item.id)) {
				continue;
			}
			const isOpenRouter = item.provider === "openrouter" || item.api === "openrouter-images";
			byId.set(item.id, {
				id: item.id,
				provider: item.provider,
				label: item.label,
				caps: isOpenRouter ? GEMINI_CAPS : OPENAI_CAPS,
				sizes: isOpenRouter ? GEMINI_ASPECT_SIZES : OPENAI_SIZES,
				maxRefs: 8,
				maxCount: 4,
				hasKey: item.hasKey,
				...(item.costHint !== undefined ? { costHint: item.costHint } : {}),
			});
		}

		return Promise.resolve(ok(Array.from(byId.values())));
	}

	public async generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>> {
		const inputImages: NativeInputImage[] = [];
		if (job.initImage !== undefined) {
			inputImages.push({
				data: job.initImage.b64,
				mimeType: job.initImage.mimeType,
			});
		}
		if (job.maskImage !== undefined) {
			inputImages.push({
				data: job.maskImage.b64,
				mimeType: job.maskImage.mimeType,
			});
		}
		for (const ref of job.references) {
			inputImages.push({
				data: ref.b64,
				mimeType: ref.mimeType,
			});
		}

		const nativeRes = await io.host.generateNative(
			io.hostCtx,
			{
				model: job.model.id,
				prompt: job.finalPrompt,
				...(inputImages.length > 0 ? { inputImages } : {}),
				...(job.aspectRatio !== undefined ? { aspectRatio: job.aspectRatio } : {}),
				imageSize: job.model.provider === "openai" ? job.size.formatAscii() : (job.resolutionTier ?? "1K"),
				count: job.count,
			},
			io.signal,
		);
		if (!nativeRes.ok) {
			return nativeRes;
		}

		const outImages: RawImage[] = [];
		for (const img of nativeRes.value.images) {
			const dec = await io.pool.run({ op: "decode_b64", b64: img.data }, { signal: io.signal });
			if (!dec.ok) {
				return dec;
			}
			outImages.push({
				buffer: dec.value.buffer,
				mimeType: img.mimeType,
				seed: job.seed,
				...(nativeRes.value.reportedModel !== undefined ? { reportedModel: nativeRes.value.reportedModel } : {}),
				...(nativeRes.value.usage !== undefined
					? {
							usage: {
								...(nativeRes.value.usage.inputTokens !== undefined
									? { inputTokens: nativeRes.value.usage.inputTokens }
									: {}),
								...(nativeRes.value.usage.outputTokens !== undefined
									? { outputTokens: nativeRes.value.usage.outputTokens }
									: {}),
								images: nativeRes.value.images.length,
								...(nativeRes.value.usage.costUsd !== undefined
									? { costUsd: nativeRes.value.usage.costUsd }
									: {}),
							},
						}
					: {}),
			});
		}

		return ok(outImages);
	}
}

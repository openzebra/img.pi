import type { Capability, ImgError } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { SizeRule } from "../domain/size.js";
import type { HostImageModel, NativeInputImage } from "../host/port.js";
import type { ImageProvider, ProviderCtx, ProviderIO, ProviderModel, RawImage, ResolvedJob } from "./port.js";

/** Output size is the host's decision; post-processing fits it to the requested size. */
const HOST_SIZE_RULE: SizeRule = deepFreeze({ kind: "any" });

const TEXT_ONLY_CAPS: ReadonlySet<Capability> = new Set<Capability>(["txt2img"]);

/** Models that accept input images can edit and take references. */
const IMAGE_INPUT_CAPS: ReadonlySet<Capability> = new Set<Capability>(["txt2img", "img2img", "multi_ref"]);

export const HOST_PROVIDER_ID = "host";

function toProviderModel(m: HostImageModel): ProviderModel {
	return Object.freeze({
		id: m.id,
		provider: m.provider,
		providerLabel: m.providerLabel,
		label: m.label,
		caps: m.acceptsImages ? IMAGE_INPUT_CAPS : TEXT_ONLY_CAPS,
		sizes: HOST_SIZE_RULE,
		options: m.options,
	});
}

function inputImagesOf(job: ResolvedJob): readonly NativeInputImage[] {
	const sources = [job.initImage, job.maskImage, ...job.references];
	return sources.filter(ref => ref !== undefined).map(ref => ({ data: ref.b64, mimeType: ref.mimeType }));
}

export class HostNativeProvider implements ImageProvider {
	public readonly id = HOST_PROVIDER_ID;

	public async models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>> {
		const res = await ctx.host.nativeImageModels(ctx.hostCtx);
		return res.ok ? ok(res.value.map(toProviderModel)) : res;
	}

	/** One host call per image: the host APIs agree on a single image per request. */
	public async generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>> {
		const inputImages = inputImagesOf(job);
		const { options } = job.model;
		const nativeRes = await io.host.generateNative(
			io.hostCtx,
			{
				model: job.model.id,
				prompt: job.finalPrompt,
				...(inputImages.length > 0 ? { inputImages } : {}),
				...(options.aspectRatio && job.aspectRatio !== undefined ? { aspectRatio: job.aspectRatio } : {}),
				...(options.imageSize && job.imageSize !== undefined ? { imageSize: job.imageSize } : {}),
			},
			io.signal,
		);
		if (!nativeRes.ok) {
			return nativeRes;
		}
		const { images, reportedModel, usage } = nativeRes.value;
		const out = new Array<RawImage>(images.length);
		for (const [i, img] of images.entries()) {
			const dec = await io.pool.run({ op: "decode_b64", b64: img.data }, { signal: io.signal });
			if (!dec.ok) {
				return dec;
			}
			out[i] = {
				buffer: dec.value.buffer,
				mimeType: img.mimeType,
				...(reportedModel !== undefined ? { reportedModel } : {}),
				// Usage is per host call; attribute it to the first image only so totals are not multiplied.
				...(usage !== undefined && i === 0
					? {
							usage: {
								...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
								...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
								images: images.length,
								...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
							},
						}
					: {}),
			};
		}
		return ok(out);
	}
}

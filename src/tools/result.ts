import type { ImgConfig } from "../config/schema.js";
import type { ImgError } from "../core/errors.js";
import { formatImgError } from "../core/errors.js";
import { shortJobId } from "../core/ids.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { ArtifactSummary, UsageSummary } from "../domain/artifact.js";
import type { JobPhase, JobState } from "../domain/job.js";
import type { PostSpec } from "../domain/output.js";
import { OutputSpec } from "../domain/output.js";
import { ReferenceImage } from "../domain/reference.js";
import type { EditSpec } from "../domain/request.js";
import { GenerationRequest } from "../domain/request.js";
import type { Size, SizeRequest } from "../domain/size.js";
import { TextureSpec } from "../domain/texture.js";
import type {
	AgentToolContentItem,
	ComponentLike,
	PortableCtx,
	PortableRenderResultOpts,
	PortableTheme,
	PortableToolResult,
	PortableToolUpdateCallback,
} from "../host/port.js";
import type { DurationStatsStore } from "../jobs/progress.js";
import { createThrottledEmitter } from "../jobs/progress.js";
import type { ExecutedJobResult, PipelineDeps } from "../pipeline/run.js";
import { renderCallCard, renderJobCard } from "../ui/components/job-card.js";
import { formatBytes, formatCompactSeconds } from "../ui/theme.js";
import type { SharedTicker } from "../ui/ticker.js";
import { buildCallVM, buildJobCardVM, MemoizedComponent } from "../ui/view-models.js";
import type { ImgEditParams, ImgGenerateParams, ImgTextureParams, RawPostInput, RawReferenceInput } from "./schemas.js";

export interface GenerateDetails {
	readonly jobId: string;
	readonly model: string;
	readonly provider: string;
	readonly requestedSize: Size;
	readonly producedSize: Size;
	readonly seed: number | undefined;
	readonly artifacts: readonly ArtifactSummary[];
	readonly timings: Readonly<Record<JobPhase, number>>;
	readonly warnings: readonly string[];
	readonly usage?: UsageSummary;
	readonly state?: JobState;
	readonly dryRun?: boolean;
}

export function buildReferencesFromRaw(
	rawRefs: readonly RawReferenceInput[] | undefined,
): Result<readonly ReferenceImage[], ImgError> {
	if (rawRefs === undefined || rawRefs.length === 0) {
		return ok(Object.freeze([]));
	}
	const list = new Array<ReferenceImage>(rawRefs.length);
	for (let i = 0; i < rawRefs.length; i++) {
		const item = rawRefs[i];
		if (item === undefined) continue;
		const refRes = ReferenceImage.create({
			source: item.source,
			...(item.role !== undefined ? { role: item.role } : {}),
			...(item.weight !== undefined ? { weight: item.weight } : {}),
			...(item.label !== undefined ? { label: item.label } : {}),
		});
		if (!refRes.ok) {
			return refRes;
		}
		list[i] = refRes.value;
	}
	return ok(Object.freeze(list));
}

export function buildPostSpecFromRaw(raw: RawPostInput | undefined): PostSpec {
	if (raw === undefined) {
		return {};
	}
	return {
		...(raw.trim !== undefined ? { trim: raw.trim } : {}),
		...(raw.remove_background !== undefined ? { removeBackground: raw.remove_background } : {}),
		...(raw.upscale !== undefined ? { upscale: raw.upscale } : {}),
		...(raw.sharpen !== undefined ? { sharpen: raw.sharpen } : {}),
		...(raw.grayscale !== undefined ? { grayscale: raw.grayscale } : {}),
		...(raw.palette !== undefined ? { palette: raw.palette } : {}),
	};
}

export function buildGenerateRequest(
	params: ImgGenerateParams,
	config: ImgConfig,
): Result<GenerationRequest, ImgError> {
	const refsRes = buildReferencesFromRaw(params.references);
	if (!refsRes.ok) {
		return refsRes;
	}

	const outputRes = OutputSpec.create({
		dir: params.output_dir ?? config.output.dir,
		filenameTemplate: params.filename ?? config.output.filename,
		format: params.format ?? config.defaults.format,
		compression: params.compression ?? config.defaults.compression,
		onConflict: params.on_conflict ?? config.output.onConflict,
		returnImage: params.return_image ?? config.defaults.returnImage,
	});
	if (!outputRes.ok) {
		return outputRes;
	}

	const sizeReq: SizeRequest = {
		...(params.width !== undefined ? { width: params.width } : {}),
		...(params.height !== undefined ? { height: params.height } : {}),
		...(params.aspect_ratio !== undefined ? { aspectRatio: params.aspect_ratio } : {}),
		...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
	};

	return GenerationRequest.create({
		kind: "generate",
		prompt: params.prompt,
		...(params.negative_prompt !== undefined ? { negativePrompt: params.negative_prompt } : {}),
		...(params.style !== undefined
			? { style: params.style }
			: config.defaults.style !== undefined
				? { style: config.defaults.style }
				: {}),
		...(params.model !== undefined ? { model: params.model } : {}),
		references: refsRes.value,
		sizeRequest: sizeReq,
		...(params.size_mode !== undefined ? { sizeMode: params.size_mode } : {}),
		...(params.fit !== undefined ? { fit: params.fit } : {}),
		...(params.count !== undefined ? { count: params.count } : {}),
		...(params.seed !== undefined ? { seed: params.seed } : {}),
		...(params.steps !== undefined ? { steps: params.steps } : {}),
		...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
		quality: params.quality ?? config.defaults.quality,
		...(params.background !== undefined ? { background: params.background } : {}),
		output: outputRes.value,
		post: buildPostSpecFromRaw(params.post),
		...(params.tags !== undefined ? { tags: params.tags } : {}),
		...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
		timeoutMs: params.timeout_ms ?? config.defaults.timeoutMs,
		...(params.dry_run !== undefined ? { dryRun: params.dry_run } : {}),
	});
}

export function buildEditRequest(params: ImgEditParams, config: ImgConfig): Result<GenerationRequest, ImgError> {
	const initImgRes = ReferenceImage.create({
		source: params.image,
		role: "init",
	});
	if (!initImgRes.ok) {
		return initImgRes;
	}

	let maskImg: ReferenceImage | undefined;
	if (params.mask !== undefined) {
		const maskRes = ReferenceImage.create({
			source: params.mask,
			role: "mask",
		});
		if (!maskRes.ok) {
			return maskRes;
		}
		maskImg = maskRes.value;
	}

	const refsRes = buildReferencesFromRaw(params.references);
	if (!refsRes.ok) {
		return refsRes;
	}

	const outputRes = OutputSpec.create({
		dir: params.output_dir ?? config.output.dir,
		filenameTemplate: params.filename ?? config.output.filename,
		format: params.format ?? config.defaults.format,
		compression: params.compression ?? config.defaults.compression,
		onConflict: params.on_conflict ?? config.output.onConflict,
		returnImage: params.return_image ?? config.defaults.returnImage,
	});
	if (!outputRes.ok) {
		return outputRes;
	}

	const editSpec: EditSpec = {
		image: initImgRes.value,
		...(maskImg !== undefined ? { mask: maskImg } : {}),
		strength: params.strength ?? 0.75,
		mode: params.mode ?? (maskImg !== undefined ? "inpaint" : "edit"),
		...(params.outpaint !== undefined
			? {
					outpaint: {
						left: params.outpaint.left ?? 0,
						right: params.outpaint.right ?? 0,
						top: params.outpaint.top ?? 0,
						bottom: params.outpaint.bottom ?? 0,
					},
				}
			: {}),
	};

	const sizeReq: SizeRequest = {
		...(params.width !== undefined ? { width: params.width } : {}),
		...(params.height !== undefined ? { height: params.height } : {}),
		...(params.aspect_ratio !== undefined ? { aspectRatio: params.aspect_ratio } : {}),
		...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
	};

	return GenerationRequest.create({
		kind: "edit",
		prompt: params.prompt,
		...(params.negative_prompt !== undefined ? { negativePrompt: params.negative_prompt } : {}),
		...(params.style !== undefined
			? { style: params.style }
			: config.defaults.style !== undefined
				? { style: config.defaults.style }
				: {}),
		...(params.model !== undefined ? { model: params.model } : {}),
		references: refsRes.value,
		sizeRequest: sizeReq,
		...(params.size_mode !== undefined ? { sizeMode: params.size_mode } : {}),
		...(params.fit !== undefined ? { fit: params.fit } : {}),
		...(params.count !== undefined ? { count: params.count } : {}),
		...(params.seed !== undefined ? { seed: params.seed } : {}),
		...(params.steps !== undefined ? { steps: params.steps } : {}),
		...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
		quality: params.quality ?? config.defaults.quality,
		...(params.background !== undefined ? { background: params.background } : {}),
		output: outputRes.value,
		post: buildPostSpecFromRaw(params.post),
		...(params.tags !== undefined ? { tags: params.tags } : {}),
		...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
		timeoutMs: params.timeout_ms ?? config.defaults.timeoutMs,
		...(params.dry_run !== undefined ? { dryRun: params.dry_run } : {}),
		edit: editSpec,
	});
}

export function buildTextureRequest(params: ImgTextureParams, config: ImgConfig): Result<GenerationRequest, ImgError> {
	const refsRes = buildReferencesFromRaw(params.references);
	if (!refsRes.ok) {
		return refsRes;
	}

	const res = params.resolution ?? config.textures.resolution;
	const texRes = TextureSpec.create({
		material: params.material,
		maps: params.maps ?? config.textures.maps,
		resolution: res,
		...(params.tileable !== undefined ? { tileable: params.tileable } : {}),
		tilingMethod: params.tiling_method ?? config.textures.tilingMethod,
		...(params.seam_blend_px !== undefined ? { seamBlendPx: params.seam_blend_px } : {}),
		normalConvention: params.normal_convention ?? config.textures.normalConvention,
		normalStrength: params.normal_strength ?? config.textures.normalStrength,
		...(params.height_source !== undefined ? { heightSource: params.height_source } : {}),
		...(params.roughness_range !== undefined ? { roughnessRange: params.roughness_range } : {}),
		...(params.metallic !== undefined ? { metallic: params.metallic } : {}),
		...(params.orm_pack !== undefined ? { ormPack: params.orm_pack } : {}),
		...(params.bit_depth !== undefined ? { bitDepth: params.bit_depth } : {}),
		...(params.preview_tiles !== undefined ? { previewTiles: params.preview_tiles } : {}),
	});
	if (!texRes.ok) {
		return texRes;
	}

	const outputRes = OutputSpec.create({
		dir: params.output_dir ?? config.output.textureDir,
		filenameTemplate: params.filename ?? config.output.textureFilename,
		format: params.format ?? config.defaults.format,
		compression: params.compression ?? config.defaults.compression,
		onConflict: params.on_conflict ?? config.output.onConflict,
		returnImage: params.return_image ?? config.defaults.returnImage,
	});
	if (!outputRes.ok) {
		return outputRes;
	}

	return GenerationRequest.create({
		kind: "texture",
		prompt: params.material,
		...(params.negative_prompt !== undefined ? { negativePrompt: params.negative_prompt } : {}),
		...(params.style !== undefined ? { style: params.style } : {}),
		...(params.model !== undefined ? { model: params.model } : {}),
		references: refsRes.value,
		sizeRequest: { width: res, height: res },
		sizeMode: "exact",
		fit: "cover",
		count: 1,
		...(params.seed !== undefined ? { seed: params.seed } : {}),
		...(params.steps !== undefined ? { steps: params.steps } : {}),
		...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
		quality: params.quality ?? config.defaults.quality,
		background: "opaque",
		output: outputRes.value,
		post: buildPostSpecFromRaw(params.post),
		...(params.tags !== undefined ? { tags: params.tags } : {}),
		...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
		timeoutMs: params.timeout_ms ?? config.defaults.timeoutMs,
		...(params.dry_run !== undefined ? { dryRun: params.dry_run } : {}),
		texture: texRes.value,
	});
}

export function buildGenerateDetails(state: JobState, dryRun = false): GenerateDetails {
	return Object.freeze({
		jobId: state.id,
		model: state.modelId,
		provider: state.providerId,
		requestedSize: state.requestedSize,
		producedSize: state.producedSize,
		seed: state.request.seed,
		artifacts: Object.freeze(state.artifacts.map(a => a.summary)),
		timings: state.timings,
		warnings: state.warnings,
		...(state.usage !== undefined ? { usage: state.usage } : {}),
		state,
		...(dryRun ? { dryRun: true } : {}),
	});
}

export function formatJobCompletionText(execRes: ExecutedJobResult): string {
	const { job } = execRes;
	if (execRes.dryRun) {
		const lines = [
			`dry_run · ${job.modelId} · ${job.producedSize.format()} · ×${job.request.count} · est. $${execRes.estimatedCostUsd.toFixed(2)}`,
		];
		if (job.warnings.length > 0) {
			lines.push(`warnings: ${job.warnings.join("; ")}`);
		}
		return lines.join("\n");
	}

	const totalMs =
		job.finishedAt !== undefined && job.startedAt !== undefined ? Math.max(0, job.finishedAt - job.startedAt) : 0;
	const count = job.artifacts.length;
	const noun = job.request.kind === "texture" ? "texture maps" : count === 1 ? "image" : "images";

	const seamExtra =
		execRes.textureExtra?.seamScore !== undefined ? ` · seam score ${execRes.textureExtra.seamScore.toFixed(1)}` : "";

	const lines: string[] = [
		`generated ${count} ${noun} · ${job.modelId} · ${job.producedSize.format()} · seed ${job.request.seed} · ${formatCompactSeconds(totalMs)}${seamExtra}`,
	];

	for (const art of job.artifacts) {
		const s = art.summary;
		lines.push(`${s.index}. ${s.relativePath} (${s.width}×${s.height}, ${formatBytes(s.bytes)})`);
	}

	if (execRes.textureExtra?.previewRelativePath !== undefined) {
		lines.push(`preview: ${execRes.textureExtra.previewRelativePath}`);
	}
	if (execRes.textureExtra?.materialJsonPath !== undefined) {
		lines.push(`material: ${execRes.textureExtra.materialJsonPath}`);
	}

	const sId = shortJobId(job.id);
	lines.push(`job: ${sId}…  · reuse with references:[{source:"@job:${sId}#1"}]`);

	if (job.warnings.length > 0) {
		lines.push(`warnings: ${job.warnings.join("; ")}`);
	}

	return lines.join("\n");
}

export function buildSuccessToolResult(execRes: ExecutedJobResult): PortableToolResult<GenerateDetails> {
	const text = formatJobCompletionText(execRes);
	const content: AgentToolContentItem[] = [{ type: "text", text }];

	if (!execRes.dryRun && execRes.job.request.output.returnImage !== "none") {
		if (
			execRes.textureExtra?.previewThumbB64 !== undefined &&
			execRes.textureExtra.previewThumbMimeType !== undefined
		) {
			content.push({
				type: "image",
				data: execRes.textureExtra.previewThumbB64,
				mimeType: execRes.textureExtra.previewThumbMimeType,
			});
		} else {
			for (const art of execRes.job.artifacts) {
				if (art.summary.thumbB64 !== undefined && art.summary.thumbMimeType !== undefined) {
					content.push({
						type: "image",
						data: art.summary.thumbB64,
						mimeType: art.summary.thumbMimeType,
					});
				}
			}
		}
	}

	return Object.freeze({
		content: Object.freeze(content),
		details: buildGenerateDetails(execRes.job, execRes.dryRun),
		isError: false,
	});
}

export function buildErrorToolResult(error: ImgError, state?: JobState): PortableToolResult<GenerateDetails> {
	// Per AGENTS.md §4: Abort is not an error to the user; renders as cancelled, not failed.
	const isErr = error.kind !== "aborted";
	const text = formatImgError(error);
	const items: readonly AgentToolContentItem[] = Object.freeze([{ type: "text", text }]);
	return Object.freeze({
		content: items,
		...(state !== undefined ? { details: buildGenerateDetails(state) } : {}),
		isError: isErr,
	});
}

export function createProgressReporter(onUpdate: PortableToolUpdateCallback<GenerateDetails> | undefined): {
	readonly reportState: (state: JobState) => void;
	readonly dispose: () => void;
} {
	if (onUpdate === undefined) {
		return {
			reportState: () => undefined,
			dispose: () => undefined,
		};
	}

	const throttled = createThrottledEmitter<JobState>(st => {
		const phaseLine = `${st.phase} · ${st.modelId}${st.detail !== undefined ? ` · ${st.detail}` : ""}`;
		onUpdate({
			content: [{ type: "text", text: phaseLine }],
			details: buildGenerateDetails(st),
		});
	}, 100);

	return {
		reportState(state: JobState): void {
			throttled.emit(state);
		},
		dispose(): void {
			throttled.dispose();
		},
	};
}

export function createPortableJobRenderers<P extends Record<string, unknown>>(
	toolName: string,
	ticker: SharedTicker,
	stats: DurationStatsStore,
): {
	readonly renderCall: (args: P, theme: PortableTheme) => ComponentLike;
	readonly renderResult: (
		result: PortableToolResult<GenerateDetails>,
		opts: PortableRenderResultOpts,
		theme: PortableTheme,
		args?: P,
	) => ComponentLike;
} {
	const noColor = process.env["NO_COLOR"] !== undefined;

	return {
		renderCall: (args: P, theme: PortableTheme): ComponentLike => {
			const promptStr =
				typeof args["prompt"] === "string"
					? args["prompt"]
					: typeof args["material"] === "string"
						? args["material"]
						: "batch generation";
			const vm = buildCallVM({
				toolName,
				prompt: promptStr,
				...(typeof args["model"] === "string" ? { model: args["model"] } : {}),
				...(typeof args["width"] === "number" ? { width: args["width"] } : {}),
				...(typeof args["height"] === "number" ? { height: args["height"] } : {}),
				...(typeof args["count"] === "number" ? { count: args["count"] } : {}),
				...(typeof args["format"] === "string" ? { format: args["format"] } : {}),
				...(typeof args["output_dir"] === "string" ? { outputDir: args["output_dir"] } : {}),
				noColor,
			});
			return new MemoizedComponent(vm, renderCallCard, theme);
		},
		renderResult: (
			result: PortableToolResult<GenerateDetails>,
			opts: PortableRenderResultOpts,
			theme: PortableTheme,
			args?: P,
		): ComponentLike => {
			const state = result.details?.state;
			if (state === undefined) {
				const fallbackText = result.content[0]?.type === "text" ? result.content[0].text : toolName;
				const vm = buildCallVM({
					toolName,
					prompt: fallbackText,
					...(typeof args?.["model"] === "string" ? { model: args["model"] } : {}),
					noColor,
				});
				return new MemoizedComponent(vm, renderCallCard, theme);
			}
			const tauMs = stats.getTauMs(state.providerId, state.modelId, state.producedSize);
			const vm = buildJobCardVM({
				toolName,
				state,
				nowMs: state.finishedAt ?? Date.now(),
				spinnerTick: ticker.currentTick,
				tauMs,
				expanded: opts.expanded,
				noColor,
			});
			return new MemoizedComponent(vm, renderJobCard, theme);
		},
	};
}

export interface ToolRuntimeDeps {
	readonly getPipelineDeps: (hostCtx: PortableCtx) => PipelineDeps;
	readonly ticker: SharedTicker;
	readonly stats: DurationStatsStore;
}

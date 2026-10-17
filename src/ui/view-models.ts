import { computeHashCode } from "../core/equals.js";
import type { ImgError } from "../core/errors.js";
import { formatImgError } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import { shortJobId, toSlug } from "../core/ids.js";
import type { ArtifactSummary } from "../domain/artifact.js";
import { ARTIFACT_PATHS, failedRequestRelPath } from "../domain/artifact-paths.js";
import type { JobPhase, JobState } from "../domain/job.js";
import type { TextureMapKind } from "../domain/texture.js";
import type { ComponentLike, PortableTheme } from "../host/port.js";
import { computeJobProgress } from "../jobs/progress.js";
import type { QueueSnapshot } from "../jobs/queue.js";
import { formatBytes, formatCompactSeconds, formatEtaSeconds, formatStopwatch, PLAIN_THEME } from "./theme.js";

export interface HashedVM {
	readonly hash: string;
}

export class MemoizedComponent<V extends HashedVM> implements ComponentLike {
	private vm: V;
	private theme: PortableTheme;
	private readonly renderPure: (vm: V, width: number, theme: PortableTheme) => string[];
	private cachedHash: string | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	public constructor(
		initialVm: V,
		renderPure: (vm: V, width: number, theme: PortableTheme) => string[],
		theme: PortableTheme = PLAIN_THEME,
	) {
		this.vm = initialVm;
		this.renderPure = renderPure;
		this.theme = theme;
	}

	public setVM(nextVm: V, nextTheme?: PortableTheme): void {
		this.vm = nextVm;
		if (nextTheme !== undefined) {
			this.theme = nextTheme;
		}
	}

	public getVM(): V {
		return this.vm;
	}

	public render(width: number): string[] {
		const w = Math.max(10, Math.floor(width));
		if (this.cachedLines !== undefined && this.cachedHash === this.vm.hash && this.cachedWidth === w) {
			return this.cachedLines;
		}
		const lines = this.renderPure(this.vm, w, this.theme);
		this.cachedHash = this.vm.hash;
		this.cachedWidth = w;
		this.cachedLines = lines;
		return lines;
	}

	public invalidate(): void {
		this.cachedHash = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export interface CallVM extends HashedVM {
	readonly toolName: string;
	readonly prompt: string;
	readonly modelLabel: string;
	readonly sizeLabel: string;
	readonly count: number;
	readonly format: string;
	readonly outputDir: string;
	readonly noColor: boolean;
}

export function buildCallVM(input: {
	readonly toolName: string;
	readonly prompt: string;
	readonly model?: string;
	readonly width?: number;
	readonly height?: number;
	readonly count?: number;
	readonly format?: string;
	readonly outputDir?: string;
	readonly noColor?: boolean;
}): CallVM {
	const modelLabel = input.model ?? "auto";
	const sizeLabel =
		input.width !== undefined && input.height !== undefined ? `${input.width}×${input.height}` : "auto";
	const count = input.count ?? 1;
	const format = input.format ?? "png";
	const outputDir = input.outputDir ?? ARTIFACT_PATHS.images;
	const noColor = input.noColor ?? false;

	const payload = {
		toolName: input.toolName,
		prompt: input.prompt,
		modelLabel,
		sizeLabel,
		count,
		format,
		outputDir,
		noColor,
	};
	return deepFreeze({
		...payload,
		hash: computeHashCode(payload),
	});
}

export interface ArtifactRowVM {
	readonly index: number;
	readonly relativePath: string;
	readonly sizeLabel: string;
	readonly dimensionsLabel: string;
	readonly format: string;
	readonly mapKind?: TextureMapKind;
	readonly seamScore?: number;
	readonly previewLines: readonly string[];
}

export interface RefBadgeVM {
	readonly source: string;
	readonly role: string;
	readonly weight: number;
}

export interface JobCardVM extends HashedVM {
	readonly toolName: string;
	readonly jobId: string;
	readonly shortId: string;
	readonly phase: JobPhase;
	readonly expanded: boolean;
	readonly noColor: boolean;
	readonly spinnerTick: number;
	readonly queuePosition?: number;
	readonly prompt: string;
	readonly styleLabel?: string;
	readonly modelId: string;
	readonly shortModel: string;
	readonly providerId: string;
	readonly requestedSizeLabel: string;
	readonly producedSizeLabel: string;
	readonly sizeNote?: string;
	readonly count: number;
	readonly seed: number;
	readonly quality: string;
	readonly background: string;
	readonly format: string;
	readonly outputDir: string;
	readonly stopwatch: string;
	readonly durationSec: string;
	readonly percent: number;
	readonly fraction: number;
	readonly estimated: boolean;
	readonly etaLabel?: string;
	readonly step?: number;
	readonly steps?: number;
	readonly iterPerSec?: string;
	readonly detail?: string;
	readonly refs: readonly RefBadgeVM[];
	readonly livePreviewLines: readonly string[];
	readonly artifacts: readonly ArtifactRowVM[];
	readonly timingsLine: string;
	readonly usageLine: string;
	readonly sidecarLine: string;
	readonly warnings: readonly string[];
	readonly errorSummary?: string;
	readonly errorSuggestion?: string;
	readonly failedSavePath?: string;
}

/** Next step for a failed job. Generation is agent-driven, so hints never name commands. */
function errorSuggestionFor(error: ImgError): string | undefined {
	switch (error.kind) {
		case "no_api_key":
			return `→ log in to ${error.provider} in the host (/login)`;
		case "no_image_models":
			return "→ connect a provider that has image models in the host (/login)";
		case "model_not_found":
			return error.suggestions.length > 0
				? `→ try: ${error.suggestions.join(", ")}`
				: "→ ask for the available image models (img_list_models)";
		case "unsupported":
			return "→ ask for a model that supports it (img_list_models)";
		case "provider_http":
			return error.retryable ? "→ transient provider error; ask to retry" : undefined;
		case "config_invalid":
		case "ref_unreadable":
		case "path_forbidden":
		case "content_policy":
		case "timeout":
		case "aborted":
		case "worker_failed":
		case "internal":
			return undefined;
		default: {
			const _exhaustive: never = error;
			return _exhaustive;
		}
	}
}

export function buildJobCardVM(input: {
	readonly toolName: string;
	readonly state: JobState;
	readonly nowMs: number;
	readonly spinnerTick: number;
	readonly tauMs?: number;
	readonly expanded?: boolean;
	readonly noColor?: boolean;
	readonly livePreviewLines?: readonly string[];
	readonly artifactPreviewLines?: ReadonlyMap<number, readonly string[]>;
}): JobCardVM {
	const { state } = input;
	const prog = computeJobProgress(state, input.nowMs, undefined, input.tauMs);
	const shortModel = state.modelId.includes("/") ? (state.modelId.split("/").pop() ?? state.modelId) : state.modelId;

	const reqSizeLabel = state.requestedSize.format();
	const prodSizeLabel = state.producedSize.format();
	const sizeNote = !state.requestedSize.equals(state.producedSize)
		? `${prodSizeLabel} → ${reqSizeLabel} (resized)`
		: "exact";

	const refs: RefBadgeVM[] = state.request.references.map(r => ({
		source: r.source,
		role: r.role,
		weight: r.weight,
	}));

	const artifacts: ArtifactRowVM[] = state.artifacts.map(art => {
		const s: ArtifactSummary = art.summary;
		const prevLines = input.artifactPreviewLines?.get(s.index) ?? [`[image ${s.width}×${s.height} ${s.format}]`];
		return {
			index: s.index,
			relativePath: s.relativePath,
			sizeLabel: formatBytes(s.bytes),
			dimensionsLabel: `${s.width}×${s.height}`,
			format: s.format,
			...(s.mapKind !== undefined ? { mapKind: s.mapKind } : {}),
			...(s.seamScore !== undefined ? { seamScore: s.seamScore } : {}),
			previewLines: prevLines,
		};
	});

	const t = state.timings;
	const timingsLine = `prep ${formatCompactSeconds(t.preparing)} · submit ${formatCompactSeconds(t.submitting)} · gen ${formatCompactSeconds(t.generating)} · post ${formatCompactSeconds(t.postprocess)} · save ${formatCompactSeconds(t.saving)}`;

	const usageParts: string[] = [];
	if (state.usage?.inputTokens !== undefined) {
		usageParts.push(`in ${state.usage.inputTokens} tok`);
	}
	usageParts.push(`out ${state.artifacts.length || state.request.count}× image`);
	if (state.usage?.costUsd !== undefined) {
		usageParts.push(`$${state.usage.costUsd.toFixed(3)} reported`);
	}
	const usageLine = usageParts.join(" · ");

	const rawSidecar = state.artifacts[0]?.summary.sidecarPath ?? "none";
	const shortSidecar = rawSidecar.length > 20 ? `…${rawSidecar.slice(-12)}` : rawSidecar;
	const sidecarLine = `${shortSidecar}  ·  manifest ${ARTIFACT_PATHS.manifest}`;

	let iterPerSec: string | undefined;
	if (prog.step !== undefined && prog.step > 0 && prog.elapsedMs > 200) {
		const rate = prog.step / (prog.elapsedMs / 1000);
		iterPerSec = `${rate.toFixed(1)} it/s`;
	}

	let errorSummary: string | undefined;
	let errorSuggestion: string | undefined;
	let failedSavePath: string | undefined;

	if (state.error !== undefined) {
		errorSummary = formatImgError(state.error);
		errorSuggestion = errorSuggestionFor(state.error);
		failedSavePath = failedRequestRelPath(state.id);
	}

	const payload = {
		toolName: input.toolName,
		jobId: state.id,
		shortId: shortJobId(state.id),
		phase: state.phase,
		expanded: input.expanded ?? false,
		noColor: input.noColor ?? false,
		spinnerTick:
			state.phase === "done" || state.phase === "failed" || state.phase === "cancelled" ? 0 : input.spinnerTick,
		...(state.queuePosition !== undefined ? { queuePosition: state.queuePosition } : {}),
		prompt: state.request.prompt,
		...(state.request.style !== undefined ? { styleLabel: state.request.style } : {}),
		modelId: state.modelId,
		shortModel,
		providerId: state.providerId,
		requestedSizeLabel: reqSizeLabel,
		producedSizeLabel: prodSizeLabel,
		sizeNote,
		count: state.request.count,
		seed: state.request.seed,
		quality: state.request.quality,
		background: state.request.background,
		format: state.request.output.format,
		outputDir: state.request.output.dir,
		stopwatch: formatStopwatch(prog.elapsedMs),
		durationSec: formatCompactSeconds(prog.elapsedMs),
		percent: prog.percent,
		fraction: Number(prog.fraction.toFixed(3)),
		estimated: prog.estimated,
		...(prog.etaMs !== undefined ? { etaLabel: formatEtaSeconds(prog.etaMs) } : {}),
		...(prog.step !== undefined ? { step: prog.step } : {}),
		...(prog.steps !== undefined ? { steps: prog.steps } : {}),
		...(iterPerSec !== undefined ? { iterPerSec } : {}),
		...(state.detail !== undefined ? { detail: state.detail } : {}),
		refs,
		livePreviewLines: input.livePreviewLines ?? [],
		artifacts,
		timingsLine,
		usageLine,
		sidecarLine,
		warnings: state.warnings,
		...(errorSummary !== undefined ? { errorSummary } : {}),
		...(errorSuggestion !== undefined ? { errorSuggestion } : {}),
		...(failedSavePath !== undefined ? { failedSavePath } : {}),
	};

	return deepFreeze({
		...payload,
		hash: computeHashCode(payload),
	});
}

export interface QueueWidgetItemVM {
	readonly id: string;
	readonly shortId: string;
	readonly slugLabel: string;
	readonly shortModel: string;
	readonly phase: JobPhase;
	readonly spinnerIndex: number;
	readonly percent: number;
	readonly fraction: number;
	readonly estimated: boolean;
	readonly elapsedLabel: string;
	readonly queuePosition?: number;
	readonly detail?: string;
}

export interface QueueWidgetVM extends HashedVM {
	readonly visible: boolean;
	readonly runningCount: number;
	readonly queuedCount: number;
	readonly noColor: boolean;
	readonly items: readonly QueueWidgetItemVM[];
}

export function buildQueueWidgetVM(input: {
	readonly snapshot: QueueSnapshot;
	readonly nowMs: number;
	readonly spinnerTick: number;
	readonly noColor?: boolean;
}): QueueWidgetVM {
	const { snapshot } = input;
	const activeOrQueued = snapshot.runningCount > 0 || snapshot.queuedCount > 0;
	const recentlyFinished = snapshot.lastFinishedAt !== undefined && input.nowMs - snapshot.lastFinishedAt <= 5000;
	const visible = activeOrQueued || recentlyFinished;

	const items: QueueWidgetItemVM[] = [];
	if (visible) {
		let idx = 0;
		for (const job of snapshot.jobs) {
			if (job.phase === "done" || job.phase === "failed" || job.phase === "cancelled") {
				if (!activeOrQueued && recentlyFinished) {
					// Include recently finished jobs briefly
				} else {
					continue;
				}
			}
			const prog = computeJobProgress(job, input.nowMs);
			const slug = toSlug(job.request.prompt, 20);
			const suffix =
				job.request.kind === "texture" ? " (texture)" : job.request.count > 1 ? ` ×${job.request.count}` : "";
			const shortModel = job.modelId.includes("/") ? (job.modelId.split("/").pop() ?? job.modelId) : job.modelId;

			items.push({
				id: job.id,
				shortId: shortJobId(job.id),
				slugLabel: `${slug}${suffix}`,
				shortModel,
				phase: job.phase,
				spinnerIndex: input.spinnerTick + idx,
				percent: prog.percent,
				fraction: Number(prog.fraction.toFixed(2)),
				estimated: prog.estimated,
				elapsedLabel: formatCompactSeconds(prog.elapsedMs),
				...(job.queuePosition !== undefined ? { queuePosition: job.queuePosition } : {}),
				...(job.detail !== undefined ? { detail: job.detail } : {}),
			});
			idx++;
		}
	}

	const payload = {
		visible,
		runningCount: snapshot.runningCount,
		queuedCount: snapshot.queuedCount,
		noColor: input.noColor ?? false,
		items,
	};
	return deepFreeze({
		...payload,
		hash: computeHashCode(payload),
	});
}

export interface StatusSegmentVM extends HashedVM {
	readonly state: "idle" | "busy" | "error";
	readonly text: string;
}

export function buildStatusSegmentVM(input: {
	readonly snapshot: QueueSnapshot;
	readonly defaultModelLabel: string;
	readonly spinnerTick: number;
	readonly nowMs: number;
	readonly noColor?: boolean;
}): StatusSegmentVM {
	const { snapshot } = input;
	const modelLabel = input.defaultModelLabel;

	if (snapshot.runningCount > 0 || snapshot.queuedCount > 0) {
		const total = snapshot.runningCount + snapshot.queuedCount;
		let maxEtaMs = 8000;
		for (const j of snapshot.jobs) {
			if (j.phase !== "done" && j.phase !== "failed" && j.phase !== "cancelled") {
				const p = computeJobProgress(j, input.nowMs);
				if (p.etaMs !== undefined && p.etaMs > maxEtaMs) {
					maxEtaMs = p.etaMs;
				}
			}
		}
		const frames =
			input.noColor === true ? ["|", "/", "-", "\\"] : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const spin = frames[Math.abs(input.spinnerTick) % frames.length] ?? "⠼";
		const text = `img:${spin} ${snapshot.runningCount}/${total} · ~${formatEtaSeconds(maxEtaMs)}`;
		const payload = { state: "busy" as const, text };
		return deepFreeze({ ...payload, hash: computeHashCode(payload) });
	}

	if (snapshot.failedCount > 0) {
		const cross = input.noColor === true ? "[x]" : "✖";
		const text = `img:${cross} ${snapshot.failedCount} failed`;
		const payload = { state: "error" as const, text };
		return deepFreeze({ ...payload, hash: computeHashCode(payload) });
	}

	const text = `img:${modelLabel}`;
	const payload = { state: "idle" as const, text };
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

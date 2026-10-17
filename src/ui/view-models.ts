import type { ConfigScope as ConfigOrigin } from "../config/layers.js";
import type { ImgConfig } from "../config/schema.js";
import { computeHashCode } from "../core/equals.js";
import { formatImgError } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import { shortJobId, toSlug } from "../core/ids.js";
import type { ArtifactSummary, SidecarDocument } from "../domain/artifact.js";
import type { JobPhase, JobState } from "../domain/job.js";
import type { ImageFormat, QualityTier, ReturnImageMode } from "../domain/output.js";
import type { NormalConvention, TextureMapKind } from "../domain/texture.js";
import type { ComponentLike, PortableTheme } from "../host/port.js";
import { computeJobProgress } from "../jobs/progress.js";
import type { QueueSnapshot } from "../jobs/queue.js";
import type { ProviderModel } from "../providers/port.js";
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
		input.width !== undefined && input.height !== undefined ? `${input.width}×${input.height}` : "1024×1024";
	const count = input.count ?? 1;
	const format = input.format ?? "png";
	const outputDir = input.outputDir ?? "generated/images/";
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
		usageParts.push(`≈ $${state.usage.costUsd.toFixed(2)}`);
	}
	const usageLine = usageParts.join(" · ");

	const rawSidecar = state.artifacts[0]?.summary.sidecarPath ?? "none";
	const shortSidecar = rawSidecar.length > 20 ? `…${rawSidecar.slice(-12)}` : rawSidecar;
	const sidecarLine = `${shortSidecar}  ·  manifest .img-pi/manifest.jsonl`;

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
		if (state.error.kind === "provider_http" && state.error.status === 429) {
			errorSuggestion = "→ wait 20s or switch model:  /img:model  fal/flux-pro-v1.1";
		} else if (state.error.kind === "no_api_key") {
			errorSuggestion = "→ configure key in /img:settings → Providers";
		} else {
			errorSuggestion = "→ switch model with /img:model or press r to retry";
		}
		failedSavePath = `.img-pi/failed/${shortJobId(state.id)}.json`;
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
	const shortModel = input.defaultModelLabel.includes("/")
		? (input.defaultModelLabel.split("/").pop() ?? input.defaultModelLabel)
		: input.defaultModelLabel;
	const icon = input.noColor === true ? "[img]" : "🖼";

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
		const text = `${icon} ${spin} ${snapshot.runningCount}/${total} · ~${formatEtaSeconds(maxEtaMs)}`;
		const payload = { state: "busy" as const, text };
		return deepFreeze({ ...payload, hash: computeHashCode(payload) });
	}

	if (snapshot.failedCount > 0) {
		const cross = input.noColor === true ? "[x]" : "✖";
		const text = `${icon} ${cross} ${snapshot.failedCount} failed`;
		const payload = { state: "error" as const, text };
		return deepFreeze({ ...payload, hash: computeHashCode(payload) });
	}

	const text = `${icon} ${shortModel}`;
	const payload = { state: "idle" as const, text };
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface TilePreviewVM extends HashedVM {
	readonly filename: string;
	readonly seamScore: number;
	readonly availableMaps: readonly TextureMapKind[];
	readonly activeMap: TextureMapKind;
	readonly tiles: number;
	readonly showGrid: boolean;
	readonly tileLines: readonly string[];
	readonly noColor: boolean;
}

export function buildTilePreviewVM(input: {
	readonly filename: string;
	readonly seamScore: number;
	readonly availableMaps: readonly TextureMapKind[];
	readonly activeMap: TextureMapKind;
	readonly tiles: number;
	readonly showGrid: boolean;
	readonly tileLines?: readonly string[];
	readonly noColor?: boolean;
}): TilePreviewVM {
	const payload = {
		filename: input.filename,
		seamScore: Number(input.seamScore.toFixed(1)),
		availableMaps: input.availableMaps,
		activeMap: input.activeMap,
		tiles: input.tiles,
		showGrid: input.showGrid,
		tileLines: input.tileLines ?? ["[img]"],
		noColor: input.noColor ?? false,
	};
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface PbrGridVM extends HashedVM {
	readonly materialName: string;
	readonly resolution: number;
	readonly normalConvention: NormalConvention;
	readonly maps: readonly TextureMapKind[];
	readonly hasBlender: boolean;
	readonly noColor: boolean;
}

export function buildPbrGridVM(input: {
	readonly materialName: string;
	readonly resolution: number;
	readonly normalConvention: NormalConvention;
	readonly maps: readonly TextureMapKind[];
	readonly hasBlender?: boolean;
	readonly noColor?: boolean;
}): PbrGridVM {
	const payload = {
		materialName: input.materialName,
		resolution: input.resolution,
		normalConvention: input.normalConvention,
		maps: input.maps,
		hasBlender: input.hasBlender ?? false,
		noColor: input.noColor ?? false,
	};
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface ComposeState {
	readonly prompt: string;
	readonly negativePrompt: string;
	readonly model: string;
	readonly keyEnvHint: string;
	readonly hasKey: boolean;
	readonly mode: "image" | "texture" | "edit";
	readonly width: number;
	readonly height: number;
	readonly aspectRatio: string;
	readonly resolution: string;
	readonly sizeMode: "exact" | "snap";
	readonly count: number;
	readonly seed: number | "random";
	readonly seedLocked: boolean;
	readonly steps: number;
	readonly guidance: number;
	readonly style: string;
	readonly maps: readonly TextureMapKind[];
	readonly normalConvention: NormalConvention;
	readonly normalStrength: number;
	readonly tileable: boolean;
	readonly refs: readonly RefBadgeVM[];
	readonly outputTemplate: string;
	readonly focusedFieldIndex: number;
	readonly estCostUsd: number;
	readonly estTimeSec: number;
}

export interface ComposeVM extends HashedVM, ComposeState {
	readonly noColor: boolean;
}

export function buildComposeVM(state: ComposeState, noColor = false): ComposeVM {
	const payload = { ...state, noColor };
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface ModelPickerRowVM {
	readonly id: string;
	readonly provider: string;
	readonly shortName: string;
	readonly capsSummary: string;
	readonly keyIcon: string;
	readonly costLabel: string;
}

export interface ModelPickerVM extends HashedVM {
	readonly filter: string;
	readonly selectedIndex: number;
	readonly rows: readonly ModelPickerRowVM[];
	readonly noColor: boolean;
}

export function buildModelPickerVM(input: {
	readonly models: readonly ProviderModel[];
	readonly filter: string;
	readonly selectedIndex: number;
	readonly noColor?: boolean;
}): ModelPickerVM {
	const q = input.filter.trim().toLowerCase();
	const filtered = input.models.filter(m => {
		if (q.length === 0) return true;
		return (
			m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
		);
	});

	const rows: ModelPickerRowVM[] = filtered.map(m => {
		const shortName = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
		const capsList: string[] = [];
		if (m.caps.has("txt2img")) capsList.push("t2i");
		if (m.caps.has("img2img")) capsList.push("i2i");
		if (m.caps.has("multi_ref")) capsList.push("refs");
		if (m.caps.has("inpaint")) capsList.push("mask");
		if (m.caps.has("transparent_bg")) capsList.push("alpha");
		if (m.caps.has("seed")) capsList.push("seed");
		if (m.caps.has("steps")) capsList.push("steps");
		if (m.caps.has("arbitrary_size")) capsList.push("size");
		if (m.caps.has("native_tiling")) capsList.push("tiling");

		const keyIcon =
			m.provider === "comfyui" || m.provider === "a1111"
				? input.noColor === true
					? "[loc]"
					: "⌂"
				: m.hasKey === false
					? input.noColor === true
						? "[x]"
						: "✗"
					: input.noColor === true
						? "[v]"
						: "✓";

		const costLabel =
			m.costPerImageUsd !== undefined
				? m.costPerImageUsd === 0
					? "local"
					: `$${m.costPerImageUsd}`
				: (m.costHint ?? "$0.04");

		return {
			id: m.id,
			provider: m.provider,
			shortName,
			capsSummary: capsList.slice(0, 5).join(" "),
			keyIcon,
			costLabel,
		};
	});

	const clampedIdx = rows.length > 0 ? Math.max(0, Math.min(rows.length - 1, input.selectedIndex)) : 0;

	const payload = {
		filter: input.filter,
		selectedIndex: clampedIdx,
		rows,
		noColor: input.noColor ?? false,
	};
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface GalleryCardVM {
	readonly jobId: string;
	readonly index: number;
	readonly label: string;
	readonly filename: string;
	readonly dimensions: string;
	readonly model: string;
	readonly seed: number;
	readonly createdAtShort: string;
	readonly tags: readonly string[];
	readonly isTexture: boolean;
	readonly seamScore?: number;
	readonly thumbLines: readonly string[];
}

export interface GalleryVM extends HashedVM {
	readonly filter: string;
	readonly selectedIndex: number;
	readonly page: number;
	readonly totalPages: number;
	readonly cards: readonly GalleryCardVM[];
	readonly selectedDetailLine: string;
	readonly noColor: boolean;
}

export function buildGalleryVM(input: {
	readonly entries: readonly SidecarDocument[];
	readonly filter: string;
	readonly selectedIndex: number;
	readonly pageSize?: number;
	readonly thumbLinesMap?: ReadonlyMap<string, readonly string[]>;
	readonly noColor?: boolean;
}): GalleryVM {
	const pageSize = Math.max(1, input.pageSize ?? 10);
	const total = input.entries.length;
	const clampedSelected = total > 0 ? Math.max(0, Math.min(total - 1, input.selectedIndex)) : 0;
	const page = Math.floor(clampedSelected / pageSize);
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const startIdx = page * pageSize;
	const pageSlice = input.entries.slice(startIdx, startIdx + pageSize);

	const cards: GalleryCardVM[] = pageSlice.map(doc => {
		const fname = doc.path.split("/").pop() ?? doc.path;
		const shortLabel = fname.replace(/\.[a-z0-9]+$/i, "").slice(0, 12);
		const shortMod = doc.model.includes("/") ? (doc.model.split("/").pop() ?? doc.model) : doc.model;
		const dateShort = doc.createdAt.slice(0, 16).replace("T", " ");
		const key = `${doc.job}#${doc.index}`;
		const thumbLines = input.thumbLinesMap?.get(key) ?? ["  [img]   "];
		return {
			jobId: doc.job,
			index: doc.index,
			label: shortLabel,
			filename: fname,
			dimensions:
				doc.producedSize[0] === doc.producedSize[1]
					? `${doc.producedSize[0]}²`
					: `${doc.producedSize[0]}×${doc.producedSize[1]}`,
			model: shortMod,
			seed: doc.seed,
			createdAtShort: dateShort,
			tags: doc.tags,
			isTexture: doc.texture !== null,
			...(doc.texture?.seamScore !== null && doc.texture?.seamScore !== undefined
				? { seamScore: doc.texture.seamScore }
				: {}),
			thumbLines,
		};
	});

	const selDoc = input.entries[clampedSelected];
	const selCard = cards[clampedSelected - startIdx];
	const tagStr = selDoc !== undefined && selDoc.tags.length > 0 ? ` · ${selDoc.tags.map(t => `#${t}`).join(" ")}` : "";
	const selectedDetailLine =
		selCard !== undefined
			? `${selCard.filename} · ${selCard.dimensions} · ${selCard.model} · seed ${selCard.seed} · ${selCard.createdAtShort}${tagStr}`
			: "No images in gallery";

	const payload = {
		filter: input.filter,
		selectedIndex: clampedSelected - startIdx,
		page: page + 1,
		totalPages,
		cards,
		selectedDetailLine,
		noColor: input.noColor ?? false,
	};
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface QueueTabRowVM {
	readonly jobId: string;
	readonly shortId: string;
	readonly name: string;
	readonly model: string;
	readonly phase: JobPhase;
	readonly spinnerTick: number;
	readonly progressText: string;
	readonly percent: number;
	readonly fraction: number;
	readonly estimated: boolean;
	readonly timeText: string;
}

export interface QueueTabVM extends HashedVM {
	readonly runningCount: number;
	readonly maxConcurrent: number;
	readonly paused: boolean;
	readonly selectedIndex: number;
	readonly rows: readonly QueueTabRowVM[];
	readonly noColor: boolean;
}

export function buildQueueTabVM(input: {
	readonly snapshot: QueueSnapshot;
	readonly selectedIndex: number;
	readonly nowMs: number;
	readonly spinnerTick: number;
	readonly noColor?: boolean;
}): QueueTabVM {
	const { snapshot } = input;
	const rows: QueueTabRowVM[] = snapshot.jobs.map((j, idx) => {
		const prog = computeJobProgress(j, input.nowMs);
		const slug = toSlug(j.request.prompt, 16);
		const suffix = j.request.kind === "texture" ? " (tex)" : j.request.count > 1 ? `×${j.request.count}` : "";
		const shortModel = j.modelId.includes("/") ? (j.modelId.split("/").pop() ?? j.modelId) : j.modelId;

		let progressText: string = j.phase;
		if (j.phase === "queued") {
			progressText = `queued #${j.queuePosition ?? 1}`;
		} else if (j.phase === "failed") {
			progressText = j.error !== undefined ? formatImgError(j.error).slice(0, 18) : "failed";
		}

		return {
			jobId: j.id,
			shortId: shortJobId(j.id),
			name: `${slug}${suffix}`,
			model: shortModel,
			phase: j.phase,
			spinnerTick: input.spinnerTick + idx,
			progressText,
			percent: prog.percent,
			fraction: Number(prog.fraction.toFixed(2)),
			estimated: prog.estimated,
			timeText: j.phase === "queued" ? "" : formatCompactSeconds(prog.elapsedMs),
		};
	});

	const clampedIdx = rows.length > 0 ? Math.max(0, Math.min(rows.length - 1, input.selectedIndex)) : 0;

	const payload = {
		runningCount: snapshot.runningCount,
		maxConcurrent: snapshot.maxConcurrent,
		paused: snapshot.paused,
		selectedIndex: clampedIdx,
		rows,
		noColor: input.noColor ?? false,
	};
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface CompareVM extends HashedVM {
	readonly leftLabel: string;
	readonly rightLabel: string;
	readonly leftLines: readonly string[];
	readonly rightLines: readonly string[];
	readonly deltaLine: string;
	readonly activeSide: "left" | "right";
	readonly noColor: boolean;
}

export function buildCompareVM(input: {
	readonly left?: SidecarDocument;
	readonly right?: SidecarDocument;
	readonly leftLines?: readonly string[];
	readonly rightLines?: readonly string[];
	readonly activeSide?: "left" | "right";
	readonly noColor?: boolean;
}): CompareVM {
	const leftDoc = input.left;
	const rightDoc = input.right;
	const leftFname = leftDoc !== undefined ? (leftDoc.path.split("/").pop() ?? leftDoc.path) : "none";
	const rightFname = rightDoc !== undefined ? (rightDoc.path.split("/").pop() ?? rightDoc.path) : "none";

	const leftLabel =
		leftDoc !== undefined
			? `A ${leftFname} (${leftDoc.model}, seed ${leftDoc.seed})`
			: "A (select in Gallery with c)";
	const rightLabel =
		rightDoc !== undefined
			? `B ${rightFname} (${rightDoc.model}, seed ${rightDoc.seed})`
			: "B (select second image in Gallery with c)";

	const diffs: string[] = [];
	if (leftDoc !== undefined && rightDoc !== undefined) {
		if (leftDoc.model !== rightDoc.model) diffs.push("model");
		if (leftDoc.seed !== rightDoc.seed) diffs.push("seed");
		if (leftDoc.steps !== rightDoc.steps) {
			diffs.push(`steps ${leftDoc.steps ?? "—"}→${rightDoc.steps ?? "—"}`);
		}
		if (leftDoc.quality !== rightDoc.quality) {
			diffs.push(`quality ${leftDoc.quality}→${rightDoc.quality}`);
		}
	}
	const deltaLine = diffs.length > 0 ? `Δ params:  ${diffs.join(", ")}` : "Δ params:  identical parameters";

	const payload = {
		leftLabel,
		rightLabel,
		leftLines: input.leftLines ?? ["            [img A]           "],
		rightLines: input.rightLines ?? ["            [img B]           "],
		deltaLine,
		activeSide: input.activeSide ?? "left",
		noColor: input.noColor ?? false,
	};
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export interface SettingsFieldVM {
	readonly key: string;
	readonly label: string;
	readonly value: string;
	readonly origin: ConfigOrigin;
}

export interface SettingsProviderRowVM {
	readonly id: string;
	readonly enabled: boolean;
	readonly keySource: string;
	readonly status: string;
}

export interface SettingsVM extends HashedVM {
	readonly scope: "project" | "user";
	readonly sections: readonly string[];
	readonly activeSectionIndex: number;
	readonly activeFieldIndex: number;
	readonly fields: readonly SettingsFieldVM[];
	readonly providerRows: readonly SettingsProviderRowVM[];
	readonly originDescription: string;
	readonly overridesDescription: string;
	readonly noColor: boolean;
}

export const SETTINGS_SECTIONS: readonly string[] = Object.freeze([
	"Defaults",
	"Providers",
	"Output",
	"Textures",
	"UI",
	"Limits & cost",
	"Aliases",
	"Presets",
]);

export function buildSettingsVM(input: {
	readonly config: ImgConfig;
	readonly origins?: ReadonlyMap<string, ConfigOrigin>;
	readonly scope: "project" | "user";
	readonly activeSectionIndex: number;
	readonly activeFieldIndex: number;
	readonly projectDirName?: ".omp" | ".pi";
	readonly noColor?: boolean;
}): SettingsVM {
	const { config } = input;
	const secIdx = Math.max(0, Math.min(SETTINGS_SECTIONS.length - 1, input.activeSectionIndex));
	const secName = SETTINGS_SECTIONS[secIdx] ?? "Defaults";
	const origins = input.origins;
	const getOrigin = (pathKey: string): ConfigOrigin => origins?.get(pathKey) ?? "default";

	const fields: SettingsFieldVM[] = [];
	const providerRows: SettingsProviderRowVM[] = [];

	switch (secName) {
		case "Defaults":
			fields.push(
				{
					key: "defaults.model",
					label: "default model",
					value: config.defaults.model,
					origin: getOrigin("defaults.model"),
				},
				{
					key: "defaults.size",
					label: "default size",
					value: `${config.defaults.size.width} × ${config.defaults.size.height}`,
					origin: getOrigin("defaults.size"),
				},
				{
					key: "defaults.format",
					label: "default format",
					value: config.defaults.format,
					origin: getOrigin("defaults.format"),
				},
				{
					key: "defaults.returnImage",
					label: "return to model",
					value: config.defaults.returnImage,
					origin: getOrigin("defaults.returnImage"),
				},
				{
					key: "defaults.style",
					label: "style preset",
					value: config.defaults.style ?? "none",
					origin: getOrigin("defaults.style"),
				},
				{
					key: "defaults.timeoutMs",
					label: "timeout",
					value: `${Math.round(config.defaults.timeoutMs / 1000)} s`,
					origin: getOrigin("defaults.timeoutMs"),
				},
			);
			break;
		case "Providers":
			providerRows.push(
				{
					id: "host",
					enabled: config.providers.host.enabled,
					keySource: "omp model registry",
					status: "✓ 3 models",
				},
				{
					id: "fal",
					enabled: config.providers.fal.enabled,
					keySource: `env ${config.providers.fal.apiKeyEnv ?? "FAL_KEY"}`,
					status: config.providers.fal.enabled ? "✓" : "✗ disabled",
				},
				{
					id: "replicate",
					enabled: config.providers.replicate.enabled,
					keySource: `env ${config.providers.replicate.apiKeyEnv ?? "REPLICATE_API_TOKEN"}`,
					status: config.providers.replicate.enabled ? "✓" : "✗ unset",
				},
				{
					id: "stability",
					enabled: config.providers.stability.enabled,
					keySource: `env ${config.providers.stability.apiKeyEnv ?? "STABILITY_API_KEY"}`,
					status: config.providers.stability.enabled ? "✓" : "✗ unset",
				},
				{
					id: "comfyui",
					enabled: config.providers.comfyui.enabled,
					keySource: config.providers.comfyui.baseUrl ?? "http://127.0.0.1:8188",
					status: config.providers.comfyui.enabled ? "✓ online" : "✗ offline",
				},
				{
					id: "a1111",
					enabled: config.providers.a1111.enabled,
					keySource: config.providers.a1111.baseUrl ?? "http://127.0.0.1:7860",
					status: config.providers.a1111.enabled ? "✓ online" : "✗ offline",
				},
			);
			break;
		case "Output":
			fields.push(
				{
					key: "output.dir",
					label: "output dir",
					value: config.output.dir,
					origin: getOrigin("output.dir"),
				},
				{
					key: "output.filename",
					label: "filename template",
					value: config.output.filename,
					origin: getOrigin("output.filename"),
				},
				{
					key: "output.onConflict",
					label: "on conflict",
					value: config.output.onConflict,
					origin: getOrigin("output.onConflict"),
				},
				{
					key: "output.sidecar",
					label: "write sidecar",
					value: String(config.output.sidecar),
					origin: getOrigin("output.sidecar"),
				},
			);
			break;
		case "Textures":
			fields.push(
				{
					key: "textures.resolution",
					label: "resolution",
					value: `${config.textures.resolution}`,
					origin: getOrigin("textures.resolution"),
				},
				{
					key: "textures.normalConvention",
					label: "normal convention",
					value: config.textures.normalConvention,
					origin: getOrigin("textures.normalConvention"),
				},
				{
					key: "textures.normalStrength",
					label: "normal strength",
					value: `${config.textures.normalStrength}`,
					origin: getOrigin("textures.normalStrength"),
				},
				{
					key: "textures.tilingMethod",
					label: "tiling method",
					value: config.textures.tilingMethod,
					origin: getOrigin("textures.tilingMethod"),
				},
			);
			break;
		case "UI":
			fields.push(
				{
					key: "ui.inlinePreview",
					label: "inline preview",
					value: String(config.ui.inlinePreview),
					origin: getOrigin("ui.inlinePreview"),
				},
				{
					key: "ui.statusSegment",
					label: "status segment",
					value: String(config.ui.statusSegment),
					origin: getOrigin("ui.statusSegment"),
				},
				{
					key: "ui.queueWidget",
					label: "queue widget",
					value: String(config.ui.queueWidget),
					origin: getOrigin("ui.queueWidget"),
				},
			);
			break;
		case "Limits & cost":
			fields.push(
				{
					key: "limits.maxBatch",
					label: "max batch",
					value: String(config.limits.maxBatch),
					origin: getOrigin("limits.maxBatch"),
				},
				{
					key: "limits.maxCostPerCallUsd",
					label: "max cost / call",
					value: `$${config.limits.maxCostPerCallUsd.toFixed(2)}`,
					origin: getOrigin("limits.maxCostPerCallUsd"),
				},
				{
					key: "queue.maxConcurrent",
					label: "max concurrent",
					value: String(config.queue.maxConcurrent),
					origin: getOrigin("queue.maxConcurrent"),
				},
			);
			break;
		case "Aliases":
			for (const [alias, target] of Object.entries(config.aliases)) {
				fields.push({
					key: `aliases.${alias}`,
					label: alias,
					value: target,
					origin: getOrigin(`aliases.${alias}`),
				});
			}
			break;
		case "Presets":
			for (const [presetName, presetVal] of Object.entries(config.presets)) {
				fields.push({
					key: `presets.${presetName}`,
					label: presetName,
					value: presetVal.style.slice(0, 32),
					origin: getOrigin(`presets.${presetName}`),
				});
			}
			break;
		default:
			break;
	}

	const maxItems = secName === "Providers" ? providerRows.length : fields.length;
	const fieldIdx = maxItems > 0 ? Math.max(0, Math.min(maxItems - 1, input.activeFieldIndex)) : 0;
	const activeField = fields[fieldIdx];
	const pDir = input.projectDirName ?? ".omp";
	const activeOrigin = activeField?.origin ?? (input.scope === "project" ? "project" : "user");

	const originDescription =
		activeOrigin === "project"
			? `value source: project (${pDir}/img-pi.json)`
			: activeOrigin === "user"
				? `value source: user (~/${pDir}/agent/img-pi.json)`
				: `value source: ${activeOrigin}`;
	const overridesDescription = `  overrides user (~/${pDir}/agent/img-pi.json)`;

	const payload = {
		scope: input.scope,
		sections: SETTINGS_SECTIONS,
		activeSectionIndex: secIdx,
		activeFieldIndex: fieldIdx,
		fields,
		providerRows,
		originDescription,
		overridesDescription,
		noColor: input.noColor ?? false,
	};
	return deepFreeze({ ...payload, hash: computeHashCode(payload) });
}

export type StudioTabId = 1 | 2 | 3 | 4 | 5;

export interface StudioVM extends HashedVM {
	readonly activeTab: StudioTabId;
	readonly modal: "none" | "model_picker" | "tile_preview" | "pbr_grid" | "help";
	readonly compose: ComposeVM;
	readonly gallery: GalleryVM;
	readonly queueTab: QueueTabVM;
	readonly compare: CompareVM;
	readonly settings: SettingsVM;
	readonly modelPicker?: ModelPickerVM;
	readonly tilePreview?: TilePreviewVM;
	readonly pbrGrid?: PbrGridVM;
	readonly noColor: boolean;
}

export function buildStudioVM(input: {
	readonly activeTab: StudioTabId;
	readonly modal?: "none" | "model_picker" | "tile_preview" | "pbr_grid" | "help";
	readonly compose: ComposeVM;
	readonly gallery: GalleryVM;
	readonly queueTab: QueueTabVM;
	readonly compare: CompareVM;
	readonly settings: SettingsVM;
	readonly modelPicker?: ModelPickerVM;
	readonly tilePreview?: TilePreviewVM;
	readonly pbrGrid?: PbrGridVM;
	readonly noColor?: boolean;
}): StudioVM {
	const payload = {
		activeTab: input.activeTab,
		modal: input.modal ?? "none",
		compose: input.compose,
		gallery: input.gallery,
		queueTab: input.queueTab,
		compare: input.compare,
		settings: input.settings,
		...(input.modelPicker !== undefined ? { modelPicker: input.modelPicker } : {}),
		...(input.tilePreview !== undefined ? { tilePreview: input.tilePreview } : {}),
		...(input.pbrGrid !== undefined ? { pbrGrid: input.pbrGrid } : {}),
		noColor: input.noColor ?? false,
	};
	return deepFreeze({
		...payload,
		hash: computeHashCode({
			activeTab: payload.activeTab,
			modal: payload.modal,
			compose: payload.compose.hash,
			gallery: payload.gallery.hash,
			queueTab: payload.queueTab.hash,
			compare: payload.compare.hash,
			settings: payload.settings.hash,
			modelPicker: payload.modelPicker?.hash,
			tilePreview: payload.tilePreview?.hash,
			pbrGrid: payload.pbrGrid?.hash,
			noColor: payload.noColor,
		}),
	});
}

export type { ImageFormat, QualityTier, ReturnImageMode };

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PartialConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import { errorMessage, formatImgError } from "../core/errors.js";
import type { SidecarDocument } from "../domain/artifact.js";
import type {
	ComponentLike,
	HostPort,
	OverlayOptionsLike,
	PortableCommand,
	PortableCtx,
	PortableTheme,
	TuiHandleLike,
} from "../host/port.js";
import type { PipelineDeps } from "../pipeline/run.js";
import { AUTO_MODEL_SELECTOR } from "../providers/registry.js";
import { renderStudio } from "../ui/screens/studio.js";
import { SETTINGS_FIELDS } from "../ui/settings-fields.js";
import type { StudioMessage, StudioState } from "../ui/studio-state.js";
import { INITIAL_STUDIO_STATE, keyToAction, reduceStudio, withMessage, withScope } from "../ui/studio-state.js";
import type { StudioData, StudioVM } from "../ui/view-models.js";
import { buildStudioVM, MemoizedComponent, studioRowCounts } from "../ui/view-models.js";

export interface StudioDeps {
	readonly host: HostPort;
	readonly configStore: ConfigStore;
	readonly getPipelineDeps: (ctx: PortableCtx) => PipelineDeps;
}

const STUDIO_OVERLAY: OverlayOptionsLike = Object.freeze({ width: "90%", maxHeight: "90%" });

/** Longest side of gallery thumbnails decoded for the inline preview. */
const PREVIEW_MAX_SIDE = 512;
const PREVIEW_QUALITY = 80;

/** `~/…` for paths under the home directory, so they fit in a Studio row. */
function displayHomePath(p: string): string {
	const home = os.homedir();
	return p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
}

type PreviewSlot = { readonly t: "loading" } | { readonly t: "ready"; readonly component: ComponentLike };

/**
 * `/img` overlay: models, settings, gallery. Holds state and performs effects (config saves,
 * preview loading); rendering stays in the pure `renderStudio` via a memoized VM.
 */
class StudioController implements ComponentLike {
	private state: StudioState = INITIAL_STUDIO_STATE;
	private data: StudioData;
	private readonly view: MemoizedComponent<StudioVM>;
	private readonly previews = new Map<string, PreviewSlot>();
	private readonly noColor = process.env["NO_COLOR"] !== undefined;

	public constructor(
		private readonly deps: StudioDeps,
		private readonly ctx: PortableCtx,
		private readonly tui: TuiHandleLike,
		private readonly theme: PortableTheme,
		private readonly close: () => void,
	) {
		this.data = this.configData({
			loading: true,
			models: [],
			gallery: [],
		});
		this.view = new MemoizedComponent(buildStudioVM(this.state, this.data, this.noColor), renderStudio, theme);
		void this.runSafe(() => this.load());
	}

	private configData(base: Pick<StudioData, "loading" | "models" | "gallery"> & Partial<StudioData>): StudioData {
		const store = this.deps.configStore;
		const config = store.getEffective();
		const layers = store.getLayers();
		return {
			...base,
			configuredModel: config.defaults.model,
			config,
			layers: {
				...(layers.user !== undefined ? { user: layers.user } : {}),
				...(layers.project !== undefined ? { project: layers.project } : {}),
			},
			configPaths: {
				project: path.relative(this.ctx.cwd, store.paths.projectPath),
				user: displayHomePath(store.paths.userPath),
			},
		};
	}

	private update(next: { readonly state?: StudioState; readonly data?: StudioData }): void {
		this.state = next.state ?? this.state;
		this.data = next.data ?? this.data;
		this.view.setVM(buildStudioVM(this.state, this.data, this.noColor));
		this.tui.requestRender();
	}

	private notify(message: StudioMessage): void {
		this.update({ state: withMessage(this.state, message) });
	}

	/** Effects never throw into the host: failures become a Studio message. */
	private async runSafe(fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (e: unknown) {
			this.deps.host.logError("img.pi Studio action failed", e);
			this.notify({ tone: "error", text: errorMessage(e) });
		}
	}

	private async load(): Promise<void> {
		const pDeps = this.deps.getPipelineDeps(this.ctx);
		const [modelsRes, resolvedRes, galleryRes] = await Promise.all([
			pDeps.registry.listModels(pDeps),
			pDeps.registry.resolveModel(undefined, pDeps),
			pDeps.manifest.readAll(this.ctx.cwd, pDeps.config.output.manifest, pDeps.pool),
		]);
		this.update({
			data: this.configData({
				loading: false,
				models: modelsRes.ok ? modelsRes.value.map(e => e.model) : [],
				...(modelsRes.ok ? {} : { modelsError: formatImgError(modelsRes.error) }),
				...(resolvedRes.ok
					? { resolvedModel: { id: resolvedRes.value.model.id, label: resolvedRes.value.model.label } }
					: {}),
				gallery: galleryRes.ok ? [...galleryRes.value].reverse() : [],
			}),
		});
		this.ensurePreview();
	}

	private async save(patch: PartialConfig, done: string): Promise<void> {
		const res = await this.deps.configStore.patchScope(this.state.scope, patch);
		if (!res.ok) {
			this.notify({ tone: "error", text: formatImgError(res.error) });
			return;
		}
		this.update({
			state: withMessage(this.state, { tone: "info", text: `${done} — saved to ${this.state.scope} config` }),
		});
		await this.load();
	}

	private async activate(): Promise<void> {
		const cursor = this.state.cursor[this.state.tab];
		switch (this.state.tab) {
			case "models": {
				const model = cursor === 0 ? undefined : this.data.models[cursor - 1];
				const selector = model?.id ?? AUTO_MODEL_SELECTOR;
				await this.save(
					{ defaults: { model: selector } },
					`Default model: ${model?.label ?? "auto (host decides)"}`,
				);
				return;
			}
			case "settings": {
				if (cursor === 0) {
					const scope = this.state.scope === "project" ? "user" : "project";
					this.update({ state: withMessage(withScope(this.state, scope), undefined) });
					return;
				}
				const field = SETTINGS_FIELDS[cursor - 1];
				if (field === undefined) {
					return;
				}
				const nextIndex = (field.indexIn(this.data.config) + 1) % field.optionLabels.length;
				const patch = field.patchAt(nextIndex);
				if (patch !== undefined) {
					await this.save(patch, `${field.label}: ${field.optionLabels[nextIndex] ?? ""}`);
				}
				return;
			}
			case "gallery":
				return;
			default: {
				const _exhaustive: never = this.state.tab;
				return _exhaustive;
			}
		}
	}

	private selectedDoc(): SidecarDocument | undefined {
		return this.state.tab === "gallery" ? this.data.gallery[this.state.cursor.gallery] : undefined;
	}

	/** Decode the selected gallery image off-thread once, then keep the host Image component. */
	private ensurePreview(): void {
		const doc = this.selectedDoc();
		if (doc === undefined || this.previews.has(doc.path)) {
			return;
		}
		this.previews.set(doc.path, { t: "loading" });
		void this.runSafe(async () => {
			const bytes = await fs.readFile(path.resolve(this.ctx.cwd, doc.path));
			const buffer = new Uint8Array(bytes).buffer;
			const thumb = await this.deps
				.getPipelineDeps(this.ctx)
				.pool.run({ op: "thumbnail", buffer, maxSide: PREVIEW_MAX_SIDE, quality: PREVIEW_QUALITY });
			if (!thumb.ok) {
				this.previews.delete(doc.path);
				this.notify({ tone: "error", text: formatImgError(thumb.error) });
				return;
			}
			const cells = this.data.config.ui.thumbMaxCells;
			const component = this.deps.host.imageComponent(
				{ base64: thumb.value.b64, mimeType: thumb.value.mimeType },
				this.theme,
				{ maxWidthCells: cells.w, maxHeightCells: cells.h, filename: doc.path },
			);
			this.previews.set(doc.path, { t: "ready", component });
			this.tui.requestRender();
		});
	}

	public handleInput(raw: string): void {
		const key = this.deps.host.parseKey(raw) ?? (raw.length === 1 ? raw : undefined);
		const action = keyToAction(key);
		if (action === undefined) {
			return;
		}
		switch (action.t) {
			case "close":
				this.close();
				return;
			case "activate":
				void this.runSafe(() => this.activate());
				return;
			case "tab":
			case "move":
				this.update({ state: reduceStudio(this.state, action, studioRowCounts(this.data)) });
				this.ensurePreview();
				return;
			default: {
				const _exhaustive: never = action;
				return _exhaustive;
			}
		}
	}

	public render(width: number): string[] {
		const lines = this.view.render(width);
		const doc = this.selectedDoc();
		const slot = doc !== undefined ? this.previews.get(doc.path) : undefined;
		return slot?.t === "ready" ? [...lines, ...slot.component.render(width)] : lines;
	}

	public invalidate(): void {
		this.view.invalidate();
		for (const slot of this.previews.values()) {
			if (slot.t === "ready") {
				slot.component.invalidate();
			}
		}
	}
}

export function createImgCommand(deps: StudioDeps): PortableCommand {
	return {
		description: "img.pi Studio: image models, settings, gallery (images are generated by the agent)",
		async handler(_args: string, ctx: PortableCtx): Promise<void> {
			try {
				if (ctx.mode !== "tui") {
					const { projectPath, userPath } = deps.configStore.paths;
					ctx.ui.notify(`img.pi Studio needs the TUI. Config files: ${projectPath} · ${userPath}`, "info");
					return;
				}
				deps.configStore.setCwd(ctx.cwd);
				await deps.configStore.load();
				await ctx.ui.custom<undefined>(
					(tui, theme, done) =>
						new StudioController(deps, ctx, tui, theme, () => {
							done(undefined);
						}),
					STUDIO_OVERLAY,
				);
			} catch (e: unknown) {
				deps.host.logError("img.pi Studio failed", e);
				ctx.ui.notify(`img.pi Studio failed: ${errorMessage(e)}`, "error");
			}
		},
	};
}

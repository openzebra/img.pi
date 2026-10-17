import type { ConfigStore } from "../config/store.js";
import type { SidecarDocument } from "../domain/artifact.js";
import type { NormalConvention, TextureMapKind } from "../domain/texture.js";
import { DEFAULT_TEXTURE_MAPS } from "../domain/texture.js";
import type { ComponentLike, PortableCommand, PortableCtx, PortableTheme, TuiHandleLike } from "../host/port.js";
import type { DurationStatsStore } from "../jobs/progress.js";
import type { PipelineDeps } from "../pipeline/run.js";
import { runGenerationJob } from "../pipeline/run.js";
import type { ProviderModel } from "../providers/port.js";
import type { GalleryStore } from "../storage/gallery.js";
import { buildGenerateRequest, buildTextureRequest } from "../tools/result.js";
import { renderStudioScreen } from "../ui/screens/studio.js";
import type { SharedTicker } from "../ui/ticker.js";
import type { ComposeState, StudioTabId, StudioVM } from "../ui/view-models.js";
import {
	buildCompareVM,
	buildComposeVM,
	buildGalleryVM,
	buildModelPickerVM,
	buildPbrGridVM,
	buildQueueTabVM,
	buildSettingsVM,
	buildStudioVM,
	buildTilePreviewVM,
	SETTINGS_SECTIONS,
} from "../ui/view-models.js";
import {
	cycleProviderKeyEnv,
	cycleSettingValue,
	getSectionFieldCount,
	resetSettingValue,
	SETTINGS_PROVIDERS,
	testProviderConnection,
} from "./settings-actions.js";

export interface CommandDeps {
	readonly configStore: ConfigStore;
	readonly getPipelineDeps: (hostCtx: PortableCtx) => PipelineDeps;
	readonly galleryStore: GalleryStore;
	readonly ticker: SharedTicker;
	readonly stats: DurationStatsStore;
	readonly projectDirName: ".omp" | ".pi";
}

export interface StudioOpenOptions {
	readonly initialTab?: StudioTabId;
	readonly initialPrompt?: string;
	readonly initialGalleryFilter?: string;
}

const STYLE_CYCLE: readonly string[] = Object.freeze([
	"none",
	"photo",
	"concept-art",
	"pixel-art",
	"pbr-texture",
	"ui-icon",
	"flat-vector",
]);

const ASPECT_CYCLE: readonly { readonly ar: string; readonly w: number; readonly h: number }[] = Object.freeze([
	{ ar: "1:1", w: 1024, h: 1024 },
	{ ar: "16:9", w: 1536, h: 864 },
	{ ar: "9:16", w: 864, h: 1536 },
	{ ar: "4:3", w: 1280, h: 960 },
	{ ar: "3:2", w: 1536, h: 1024 },
]);

export async function openStudioOverlay(
	ctx: PortableCtx,
	deps: CommandDeps,
	opts: StudioOpenOptions = {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("img.pi Studio requires interactive TUI mode.", "info");
		return;
	}

	const pDeps = deps.getPipelineDeps(ctx);
	const config = deps.configStore.getEffective();
	const noColor = process.env["NO_COLOR"] !== undefined;

	const modelsRes = await pDeps.registry.listModels(pDeps);
	const models: readonly ProviderModel[] = modelsRes.ok ? modelsRes.value.map(e => e.model) : [];

	const galRes = await deps.galleryStore.query(ctx.cwd, config.output.manifest, {
		...(opts.initialGalleryFilter !== undefined ? { query: opts.initialGalleryFilter } : {}),
		limit: 100,
	});
	let galleryEntries: readonly SidecarDocument[] = galRes.ok ? galRes.value.items : [];

	const firstModel = models[0];
	let activeTab: StudioTabId = opts.initialTab ?? 1;
	let modal: "none" | "model_picker" | "tile_preview" | "pbr_grid" | "help" = "none";
	let pickerOrigin: "compose" | "settings" = "compose";

	let composeState: ComposeState = {
		prompt: opts.initialPrompt ?? "",
		negativePrompt: "",
		model: firstModel?.id ?? config.defaults.model,
		keyEnvHint: firstModel?.provider === "fal" ? "FAL_KEY" : "host",
		hasKey: firstModel?.hasKey ?? true,
		mode: "image",
		width: config.defaults.size.width,
		height: config.defaults.size.height,
		aspectRatio: "1:1",
		resolution: "1K",
		sizeMode: "exact",
		count: 1,
		seed: "random",
		seedLocked: false,
		steps: 28,
		guidance: 3.5,
		style: config.defaults.style ?? "none",
		maps: config.textures.maps,
		normalConvention: config.textures.normalConvention,
		normalStrength: config.textures.normalStrength,
		tileable: true,
		refs: [],
		outputTemplate: `${config.output.dir}/${config.output.filename}.${config.defaults.format}`,
		focusedFieldIndex: 0,
		estCostUsd: firstModel?.costPerImageUsd ?? 0.04,
		estTimeSec: 8,
	};

	const galleryFilter = opts.initialGalleryFilter ?? "";
	let gallerySelectedIndex = 0;
	let queueSelectedIndex = 0;
	let compareLeft: SidecarDocument | undefined = galleryEntries[0];
	let compareRight: SidecarDocument | undefined = galleryEntries[1];
	let compareActiveSide: "left" | "right" = "left";
	let settingsScope: "project" | "user" = "project";
	let settingsSectionIndex = 0;
	let settingsFieldIndex = 0;
	const pickerFilter = "";
	let pickerSelectedIndex = 0;
	let tileActiveMap: TextureMapKind = "albedo";
	let tileShowGrid = false;

	await ctx.ui.custom<undefined>((tui: TuiHandleLike, theme: PortableTheme, done: (res: undefined) => void) => {
		let cachedHash: string | undefined;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		const invalidateAndRender = (): void => {
			cachedHash = undefined;
			tui.requestRender();
		};

		const unsubQueue = pDeps.queue.onUpdate(() => {
			invalidateAndRender();
		});
		const unsubTicker = deps.ticker.onTick(() => {
			if (pDeps.queue.snapshot().runningCount > 0) {
				invalidateAndRender();
			}
		});

		const cleanupAndClose = (): void => {
			unsubQueue();
			unsubTicker();
			done(undefined);
		};

		const buildCurrentVM = (): StudioVM => {
			const effectiveCfg = deps.configStore.getEffective();
			const composeVM = buildComposeVM(composeState, noColor);
			const filteredGal =
				galleryFilter.trim().length === 0
					? galleryEntries
					: galleryEntries.filter(d => {
							const q = galleryFilter.trim().toLowerCase().replace(/^#/, "");
							return (
								d.prompt.toLowerCase().includes(q) ||
								d.tags.some(t => t.toLowerCase().includes(q)) ||
								d.model.toLowerCase().includes(q)
							);
						});
			const galleryVM = buildGalleryVM({
				entries: filteredGal,
				filter: galleryFilter,
				selectedIndex: gallerySelectedIndex,
				noColor,
			});
			const queueTabVM = buildQueueTabVM({
				snapshot: pDeps.queue.snapshot(),
				selectedIndex: queueSelectedIndex,
				nowMs: Date.now(),
				spinnerTick: deps.ticker.currentTick,
				noColor,
			});
			const compareVM = buildCompareVM({
				...(compareLeft !== undefined ? { left: compareLeft } : {}),
				...(compareRight !== undefined ? { right: compareRight } : {}),
				activeSide: compareActiveSide,
				noColor,
			});
			const settingsVM = buildSettingsVM({
				config: effectiveCfg,
				scope: settingsScope,
				activeSectionIndex: settingsSectionIndex,
				activeFieldIndex: settingsFieldIndex,
				projectDirName: deps.projectDirName,
				noColor,
			});

			const selGalDoc = filteredGal[gallerySelectedIndex];
			return buildStudioVM({
				activeTab,
				modal,
				compose: composeVM,
				gallery: galleryVM,
				queueTab: queueTabVM,
				compare: compareVM,
				settings: settingsVM,
				...(modal === "model_picker"
					? {
							modelPicker: buildModelPickerVM({
								models,
								filter: pickerFilter,
								selectedIndex: pickerSelectedIndex,
								noColor,
							}),
						}
					: {}),
				...(modal === "tile_preview"
					? {
							tilePreview: buildTilePreviewVM({
								filename: selGalDoc?.path ?? "texture_albedo.png",
								seamScore: selGalDoc?.texture?.seamScore ?? 2.8,
								availableMaps: DEFAULT_TEXTURE_MAPS,
								activeMap: tileActiveMap,
								tiles: 2,
								showGrid: tileShowGrid,
								noColor,
							}),
						}
					: {}),
				...(modal === "pbr_grid"
					? {
							pbrGrid: buildPbrGridVM({
								materialName: selGalDoc?.prompt ?? "material",
								resolution: selGalDoc?.producedSize[0] ?? 1024,
								normalConvention:
									selGalDoc?.texture?.normalConvention === "directx"
										? ("directx" satisfies NormalConvention)
										: ("opengl" satisfies NormalConvention),
								maps: DEFAULT_TEXTURE_MAPS,
								hasBlender: effectiveCfg.integrations.blender.path !== undefined,
								noColor,
							}),
						}
					: {}),
				noColor,
			});
		};

		const triggerComposeRun = (dryRun: boolean): void => {
			const promptText =
				composeState.prompt.trim().length > 0 ? composeState.prompt.trim() : "studio sample generation";
			const effCfg = deps.configStore.getEffective();
			const reqRes =
				composeState.mode === "texture"
					? buildTextureRequest(
							{
								material: promptText,
								model: composeState.model,
								maps: composeState.maps,
								tileable: composeState.tileable,
								normal_convention: composeState.normalConvention,
								normal_strength: composeState.normalStrength,
								...(typeof composeState.seed === "number" ? { seed: composeState.seed } : {}),
								dry_run: dryRun,
							},
							effCfg,
						)
					: buildGenerateRequest(
							{
								prompt: promptText,
								...(composeState.negativePrompt.length > 0
									? { negative_prompt: composeState.negativePrompt }
									: {}),
								model: composeState.model,
								width: composeState.width,
								height: composeState.height,
								count: composeState.count,
								...(composeState.style !== "none" ? { style: composeState.style } : {}),
								...(typeof composeState.seed === "number" ? { seed: composeState.seed } : {}),
								dry_run: dryRun,
							},
							effCfg,
						);

			if (!reqRes.ok) {
				ctx.ui.notify(reqRes.error.kind, "error");
				return;
			}
			activeTab = 3;
			invalidateAndRender();
			void runGenerationJob(reqRes.value, pDeps).then(async res => {
				if (res.ok) {
					const refreshed = await deps.galleryStore.query(ctx.cwd, effCfg.output.manifest, { limit: 100 });
					if (refreshed.ok) {
						galleryEntries = refreshed.value.items;
					}
				}
				invalidateAndRender();
			});
		};

		const component: ComponentLike = {
			render(width: number): string[] {
				const vm = buildCurrentVM();
				if (cachedHash === vm.hash && cachedWidth === width && cachedLines !== undefined) {
					return cachedLines;
				}
				const lines = renderStudioScreen(vm, width, theme);
				cachedHash = vm.hash;
				cachedWidth = width;
				cachedLines = lines;
				return lines;
			},
			invalidate(): void {
				cachedHash = undefined;
				cachedWidth = undefined;
				cachedLines = undefined;
			},
			handleInput(data: string): void {
				try {
					// Modal input handling first
					if (modal !== "none") {
						if (data === "\x1b" || data === "q") {
							modal = "none";
							invalidateAndRender();
							return;
						}
						if (modal === "model_picker") {
							if (data === "\x1b[A" || data === "\x1bOA" || data === "k") {
								pickerSelectedIndex = Math.max(0, pickerSelectedIndex - 1);
							} else if (data === "\x1b[B" || data === "\x1bOB" || data === "j") {
								pickerSelectedIndex = Math.min(Math.max(0, models.length - 1), pickerSelectedIndex + 1);
							} else if (data === "\r" || data === "\n") {
								const pickerVM = buildModelPickerVM({
									models,
									filter: pickerFilter,
									selectedIndex: pickerSelectedIndex,
									noColor,
								});
								const chosen = pickerVM.rows[pickerVM.selectedIndex];
								if (chosen !== undefined) {
									if (pickerOrigin === "settings") {
										const layers = deps.configStore.getLayers();
										const patch = (settingsScope === "project" ? layers.project : layers.user) ?? {};
										deps.configStore.setScopeLayer(settingsScope, {
											...patch,
											defaults: { ...patch.defaults, model: chosen.id },
										});
										ctx.ui.notify(`Set default model to ${chosen.id} (${settingsScope})`, "info");
									} else {
										composeState = { ...composeState, model: chosen.id };
									}
								}
								modal = "none";
							}
							invalidateAndRender();
							return;
						}
						if (modal === "tile_preview") {
							if (data === "g") {
								tileShowGrid = !tileShowGrid;
							} else if (data === "m") {
								const idx = DEFAULT_TEXTURE_MAPS.indexOf(tileActiveMap);
								const next = DEFAULT_TEXTURE_MAPS[(idx + 1) % DEFAULT_TEXTURE_MAPS.length];
								if (next !== undefined) {
									tileActiveMap = next;
								}
							}
							invalidateAndRender();
							return;
						}
						invalidateAndRender();
						return;
					}

					// Top-level studio shortcuts
					if (data === "\x1b" || data === "q") {
						cleanupAndClose();
						return;
					}
					if (data === "?") {
						modal = "help";
						invalidateAndRender();
						return;
					}
					if (data === "1") {
						activeTab = 1;
						invalidateAndRender();
						return;
					}
					if (data === "2") {
						activeTab = 2;
						invalidateAndRender();
						return;
					}
					if (data === "3") {
						activeTab = 3;
						invalidateAndRender();
						return;
					}
					if (data === "4") {
						activeTab = 4;
						invalidateAndRender();
						return;
					}
					if (data === "5") {
						activeTab = 5;
						invalidateAndRender();
						return;
					}
					if (data === "\t" && activeTab !== 5) {
						const nextTab: Record<StudioTabId, StudioTabId> = {
							1: 2,
							2: 3,
							3: 4,
							4: 5,
							5: 1,
						};
						activeTab = nextTab[activeTab];
						invalidateAndRender();
						return;
					}

					// Per-tab keyboard navigation
					if (activeTab === 1) {
						if (data === "m") {
							pickerOrigin = "compose";
							modal = "model_picker";
						} else if (data === "\x1b[A" || data === "\x1bOA" || data === "k") {
							composeState = {
								...composeState,
								focusedFieldIndex: Math.max(0, composeState.focusedFieldIndex - 1),
							};
						} else if (data === "\x1b[B" || data === "j") {
							composeState = {
								...composeState,
								focusedFieldIndex: Math.min(7, composeState.focusedFieldIndex + 1),
							};
						} else if (data === "\x1b[C" || data === "\x1b[D") {
							const f = composeState.focusedFieldIndex;
							if (f === 3) {
								const nextMode =
									composeState.mode === "image"
										? "texture"
										: composeState.mode === "texture"
											? "edit"
											: "image";
								composeState = { ...composeState, mode: nextMode };
							} else if (f === 4) {
								const curIdx = ASPECT_CYCLE.findIndex(a => a.ar === composeState.aspectRatio);
								const nextPreset = ASPECT_CYCLE[(curIdx + 1) % ASPECT_CYCLE.length] ?? ASPECT_CYCLE[0];
								if (nextPreset !== undefined) {
									composeState = {
										...composeState,
										aspectRatio: nextPreset.ar,
										width: nextPreset.w,
										height: nextPreset.h,
									};
								}
							} else if (f === 6) {
								const curIdx = STYLE_CYCLE.indexOf(composeState.style);
								const nextStyle = STYLE_CYCLE[(curIdx + 1) % STYLE_CYCLE.length] ?? "none";
								composeState = { ...composeState, style: nextStyle };
							}
						} else if (data === "\x04") {
							triggerComposeRun(true);
							return;
						} else if (data === "\r" || data === "\n") {
							triggerComposeRun(false);
							return;
						}
						invalidateAndRender();
						return;
					}

					if (activeTab === 2) {
						if (data === "\x1b[D" || data === "h" || data === "\x1b[A" || data === "k") {
							gallerySelectedIndex = Math.max(0, gallerySelectedIndex - 1);
						} else if (data === "\x1b[C" || data === "l" || data === "\x1b[B" || data === "j") {
							gallerySelectedIndex = Math.min(Math.max(0, galleryEntries.length - 1), gallerySelectedIndex + 1);
						} else if (data === "t") {
							modal = "tile_preview";
						} else if (data === "p") {
							modal = "pbr_grid";
						} else if (data === "c") {
							const sel = galleryEntries[gallerySelectedIndex];
							if (sel !== undefined) {
								if (compareLeft === undefined) {
									compareLeft = sel;
								} else {
									compareRight = sel;
									activeTab = 4;
								}
							}
						} else if (data === "r") {
							const sel = galleryEntries[gallerySelectedIndex];
							if (sel !== undefined) {
								composeState = {
									...composeState,
									prompt: sel.prompt,
									model: `${sel.provider}/${sel.model}`,
									seed: sel.seed,
								};
								activeTab = 1;
							}
						}
						invalidateAndRender();
						return;
					}

					if (activeTab === 3) {
						const snap = pDeps.queue.snapshot();
						if (data === "\x1b[A" || data === "k") {
							queueSelectedIndex = Math.max(0, queueSelectedIndex - 1);
						} else if (data === "\x1b[B" || data === "j") {
							queueSelectedIndex = Math.min(Math.max(0, snap.jobs.length - 1), queueSelectedIndex + 1);
						} else if (data === "c") {
							const target = snap.jobs[queueSelectedIndex];
							if (target !== undefined) {
								pDeps.queue.cancel(target.id);
							}
						} else if (data === "p") {
							if (snap.paused) {
								pDeps.queue.resume();
							} else {
								pDeps.queue.pause();
							}
						} else if (data === "+" || data === "=") {
							pDeps.queue.setMaxConcurrent(snap.maxConcurrent + 1);
						} else if (data === "-") {
							pDeps.queue.setMaxConcurrent(Math.max(1, snap.maxConcurrent - 1));
						}
						invalidateAndRender();
						return;
					}

					if (activeTab === 4) {
						if (data === "\x1b[D" || data === "h") {
							compareActiveSide = "left";
						} else if (data === "\x1b[C" || data === "l") {
							compareActiveSide = "right";
						} else if (data === "k") {
							const winner = compareActiveSide === "left" ? compareLeft : compareRight;
							if (winner !== undefined) {
								void deps.galleryStore.addTag(ctx.cwd, winner, "#pick").then(() => {
									ctx.ui.notify(`Tagged ${winner.path} with #pick`, "info");
								});
							}
						}
						invalidateAndRender();
						return;
					}

					// Active tab 5 (Settings)
					const eff = deps.configStore.getEffective();
					const secName = SETTINGS_SECTIONS[settingsSectionIndex] ?? "Defaults";
					const fieldCount = getSectionFieldCount(secName, eff);

					// Toggle scope
					if (data === "s" || data === "S" || data === "\t") {
						settingsScope = settingsScope === "project" ? "user" : "project";
						ctx.ui.notify(`Settings scope: ${settingsScope}`, "info");
						invalidateAndRender();
						return;
					}

					// Direct jump between sections
					if (data === "[" || data === "\x1b[5~") {
						settingsSectionIndex = Math.max(0, settingsSectionIndex - 1);
						settingsFieldIndex = 0;
						invalidateAndRender();
						return;
					}
					if (data === "]" || data === "\x1b[6~") {
						settingsSectionIndex = Math.min(SETTINGS_SECTIONS.length - 1, settingsSectionIndex + 1);
						settingsFieldIndex = 0;
						invalidateAndRender();
						return;
					}

					// Navigate up
					if (data === "\x1b[A" || data === "\x1bOA" || data === "k") {
						if (settingsFieldIndex > 0) {
							settingsFieldIndex--;
						} else if (settingsSectionIndex > 0) {
							settingsSectionIndex--;
							const prevSec = SETTINGS_SECTIONS[settingsSectionIndex] ?? "Defaults";
							const prevCount = getSectionFieldCount(prevSec, eff);
							settingsFieldIndex = Math.max(0, prevCount - 1);
						}
						invalidateAndRender();
						return;
					}

					// Navigate down
					if (data === "\x1b[B" || data === "\x1bOB" || data === "j") {
						if (settingsFieldIndex < fieldCount - 1) {
							settingsFieldIndex++;
						} else if (settingsSectionIndex < SETTINGS_SECTIONS.length - 1) {
							settingsSectionIndex++;
							settingsFieldIndex = 0;
						}
						invalidateAndRender();
						return;
					}

					// Value adjustment: cycle left (← / h)
					if (data === "\x1b[D" || data === "\x1bOD" || data === "h") {
						const layers = deps.configStore.getLayers();
						const currentPatch = (settingsScope === "project" ? layers.project : layers.user) ?? {};
						const updated = cycleSettingValue(secName, settingsFieldIndex, -1, eff, currentPatch, models);
						deps.configStore.setScopeLayer(settingsScope, updated);
						invalidateAndRender();
						return;
					}

					// Value adjustment: cycle right (→ / l)
					if (data === "\x1b[C" || data === "\x1bOC" || data === "l") {
						const layers = deps.configStore.getLayers();
						const currentPatch = (settingsScope === "project" ? layers.project : layers.user) ?? {};
						const updated = cycleSettingValue(secName, settingsFieldIndex, 1, eff, currentPatch, models);
						deps.configStore.setScopeLayer(settingsScope, updated);
						invalidateAndRender();
						return;
					}

					// Edit / activate: Enter or Space
					if (data === "\r" || data === "\n" || (secName === "Providers" && data === " ")) {
						if (secName === "Defaults" && settingsFieldIndex === 0) {
							pickerOrigin = "settings";
							pickerSelectedIndex = 0;
							modal = "model_picker";
						} else {
							const layers = deps.configStore.getLayers();
							const currentPatch = (settingsScope === "project" ? layers.project : layers.user) ?? {};
							const updated = cycleSettingValue(secName, settingsFieldIndex, 1, eff, currentPatch, models);
							deps.configStore.setScopeLayer(settingsScope, updated);
						}
						invalidateAndRender();
						return;
					}

					// Reset to inherited: u
					if (data === "u" || data === "U") {
						const layers = deps.configStore.getLayers();
						const currentPatch = (settingsScope === "project" ? layers.project : layers.user) ?? {};
						const res = resetSettingValue(secName, settingsFieldIndex, currentPatch);
						deps.configStore.setScopeLayer(settingsScope, res.patch);
						ctx.ui.notify(`Reset ${res.label} in ${settingsScope} scope to inherited`, "info");
						invalidateAndRender();
						return;
					}

					// Providers actions: t (test connection) and k (cycle key env)
					if (secName === "Providers") {
						const pId = SETTINGS_PROVIDERS[settingsFieldIndex] ?? "host";
						if (data === "t") {
							const testRes = testProviderConnection(pId, eff, models.length);
							ctx.ui.notify(testRes.message, testRes.type);
							invalidateAndRender();
							return;
						}
						if (data === "k") {
							const layers = deps.configStore.getLayers();
							const currentPatch = (settingsScope === "project" ? layers.project : layers.user) ?? {};
							const keyRes = cycleProviderKeyEnv(pId, eff, currentPatch);
							deps.configStore.setScopeLayer(settingsScope, keyRes.patch);
							ctx.ui.notify(keyRes.message, "info");
							invalidateAndRender();
							return;
						}
					}

					// Save: Ctrl+S
					if (data === "\x13") {
						const layers = deps.configStore.getLayers();
						const patch = (settingsScope === "project" ? layers.project : layers.user) ?? {};
						void deps.configStore.saveScope(settingsScope, patch).then(res => {
							if (res.ok) {
								ctx.ui.notify(`Saved ${settingsScope} settings (${deps.projectDirName}/img-pi.json)`, "info");
							} else {
								ctx.ui.notify(`Failed to save settings: ${res.error.kind}`, "error");
							}
						});
						invalidateAndRender();
						return;
					}
					invalidateAndRender();
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					ctx.ui.notify(`Studio UI error: ${msg}`, "error");
				}
			},
		};

		return component;
	});
}

export function createImgCommand(deps: CommandDeps): PortableCommand {
	return {
		description: "Open the img.pi Studio overlay (or prefill Compose with /img <prompt>)",
		async handler(args: string, ctx: PortableCtx): Promise<void> {
			try {
				const trimmed = args.trim();
				await openStudioOverlay(ctx, deps, {
					initialTab: 1,
					...(trimmed.length > 0 ? { initialPrompt: trimmed } : {}),
				});
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Failed to open Studio: ${msg}`, "error");
			}
		},
	};
}

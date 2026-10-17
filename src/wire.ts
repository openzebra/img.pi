import type { CommandDeps } from "./commands/img.js";
import { createImgCommand, openStudioOverlay } from "./commands/img.js";
import { createImgGalleryCommand } from "./commands/img-gallery.js";
import { createImgModelCommand } from "./commands/img-model.js";
import { createImgQueueCommand } from "./commands/img-queue.js";
import { createImgSettingsCommand } from "./commands/img-settings.js";
import { ConfigStore } from "./config/store.js";
import type { Disposer } from "./core/events.js";
import type { HostPort, PortableCtx, ToolCallPrecheckResult } from "./host/port.js";
import { DurationStatsStore } from "./jobs/progress.js";
import { JobQueue } from "./jobs/queue.js";
import type { PipelineDeps } from "./pipeline/run.js";
import { estimateJobCostUsd } from "./pipeline/run.js";
import { HttpClient } from "./providers/http.js";
import { SecretResolver } from "./providers/port.js";
import { ProviderRegistry } from "./providers/registry.js";
import { GalleryStore } from "./storage/gallery.js";
import { ManifestStore } from "./storage/manifest.js";
import { createImgDescribeJobTool } from "./tools/img-describe-job.js";
import { createImgEditTool } from "./tools/img-edit.js";
import { createImgGenerateTool } from "./tools/img-generate.js";
import { createImgListModelsTool } from "./tools/img-list-models.js";
import { createImgTextureTool } from "./tools/img-texture.js";
import { createImgVariationsTool } from "./tools/img-variations.js";
import type { ToolRuntimeDeps } from "./tools/result.js";
import { renderQueueWidget } from "./ui/components/queue-widget.js";
import { PLAIN_THEME } from "./ui/theme.js";
import { SharedTicker } from "./ui/ticker.js";
import { buildQueueWidgetVM, buildStatusSegmentVM } from "./ui/view-models.js";
import { WorkerPool } from "./workers/pool.js";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const GENERATION_TOOL_NAMES: ReadonlySet<string> = new Set([
	"img_generate",
	"img_edit",
	"img_texture",
	"img_variations",
]);

export interface WiredExtension {
	readonly host: HostPort;
	readonly configStore: ConfigStore;
	readonly pool: WorkerPool;
	readonly queue: JobQueue;
	readonly ticker: SharedTicker;
	readonly registry: ProviderRegistry;
	readonly manifest: ManifestStore;
	readonly galleryStore: GalleryStore;
	readonly stats: DurationStatsStore;
	shutdown(): Promise<void>;
}

export function wireExtension(host: HostPort): WiredExtension {
	const configStore = new ConfigStore({
		agentDir: host.agentDir,
		cwd: process.cwd(),
		projectDirName: host.projectDirName,
	});
	const initialConfig = configStore.getEffective();
	const pool = new WorkerPool();
	const http = new HttpClient();
	const secrets = new SecretResolver();
	const registry = new ProviderRegistry();
	const manifest = new ManifestStore();
	const galleryStore = new GalleryStore(manifest, pool);
	const stats = new DurationStatsStore(host.agentDir);
	const queue = new JobQueue(initialConfig);
	const ticker = new SharedTicker(initialConfig.ui.spinnerMs);

	const getPipelineDeps = (hostCtx: PortableCtx): PipelineDeps => {
		configStore.setCwd(hostCtx.cwd);
		return {
			host,
			hostCtx,
			config: configStore.getEffective(),
			pool,
			http,
			secrets,
			registry,
			manifest,
			queue,
			stats,
		};
	};

	const toolDeps: ToolRuntimeDeps = {
		getPipelineDeps,
		ticker,
		stats,
	};

	const commandDeps: CommandDeps = {
		configStore,
		getPipelineDeps,
		galleryStore,
		ticker,
		stats,
		projectDirName: host.projectDirName,
	};

	// Register CLI flag
	host.registerFlag("img-model", {
		description: "Override session default image/texture generation model",
		type: "string",
	});

	// Register all 6 tools
	host.registerTool(createImgGenerateTool(toolDeps));
	host.registerTool(createImgEditTool(toolDeps));
	host.registerTool(createImgTextureTool(toolDeps));
	host.registerTool(createImgVariationsTool(toolDeps));
	host.registerTool(createImgListModelsTool(toolDeps));
	host.registerTool(createImgDescribeJobTool(toolDeps));

	// Register all 5 commands
	host.registerCommand("img", createImgCommand(commandDeps));
	host.registerCommand("img:settings", createImgSettingsCommand(commandDeps));
	host.registerCommand("img:gallery", createImgGalleryCommand(commandDeps));
	host.registerCommand("img:queue", createImgQueueCommand(commandDeps));
	host.registerCommand("img:model", createImgModelCommand(commandDeps));

	// Register shortcut ctrl+alt+i
	host.registerShortcut("ctrl+alt+i", {
		description: "Open img.pi Studio overlay",
		async handler(ctx: PortableCtx): Promise<void> {
			try {
				await openStudioOverlay(ctx, commandDeps, { initialTab: 1 });
			} catch (e: unknown) {
				host.logError("Failed to open Studio via shortcut", e);
			}
		},
	});

	// Pre-call cost guard hook
	host.onToolCall(
		async (toolName: string, rawArgs: unknown, ctx: PortableCtx): Promise<ToolCallPrecheckResult | undefined> => {
			if (!GENERATION_TOOL_NAMES.has(toolName)) {
				return undefined;
			}
			const pDeps = getPipelineDeps(ctx);
			const argsRec = isRecord(rawArgs) ? rawArgs : {};
			if (argsRec["dry_run"] === true) {
				return undefined;
			}

			let requestedModel: string | undefined;
			let totalImages = 1;

			if (toolName === "img_variations") {
				const baseRec = isRecord(argsRec["base"]) ? argsRec["base"] : {};
				const varyRec = isRecord(argsRec["vary"]) ? argsRec["vary"] : {};
				requestedModel = typeof baseRec["model"] === "string" ? baseRec["model"] : undefined;
				const seedsLen = Array.isArray(varyRec["seeds"]) ? varyRec["seeds"].length : 1;
				const promptsLen = Array.isArray(varyRec["prompts"]) ? varyRec["prompts"].length : 1;
				const modelsLen = Array.isArray(varyRec["models"]) ? varyRec["models"].length : 1;
				const stylesLen = Array.isArray(varyRec["styles"]) ? varyRec["styles"].length : 1;
				totalImages =
					argsRec["mode"] === "zip"
						? Math.max(seedsLen, promptsLen, modelsLen, stylesLen)
						: Math.max(1, seedsLen) * Math.max(1, promptsLen) * Math.max(1, modelsLen) * Math.max(1, stylesLen);
			} else {
				requestedModel = typeof argsRec["model"] === "string" ? argsRec["model"] : undefined;
				totalImages = typeof argsRec["count"] === "number" && argsRec["count"] > 0 ? argsRec["count"] : 1;
			}

			const resolvedRes = await registry.resolveModel(requestedModel, pDeps);
			if (!resolvedRes.ok) {
				return undefined;
			}
			const estCost = estimateJobCostUsd(resolvedRes.value.model, totalImages);
			const maxCost = pDeps.config.limits.maxCostPerCallUsd;
			if (estCost > maxCost) {
				if (ctx.mode === "tui") {
					const approved = await ctx.ui.confirm(
						"Cost guard",
						`Estimated cost $${estCost.toFixed(2)} (${totalImages} image(s) on ${resolvedRes.value.model.id}) exceeds limits.maxCostPerCallUsd ($${maxCost.toFixed(2)}). Proceed?`,
					);
					if (!approved) {
						return {
							block: true,
							reason: `Cancelled by user: estimated cost $${estCost.toFixed(2)} exceeds limit $${maxCost.toFixed(2)}`,
						};
					}
					return undefined;
				}
				return {
					block: true,
					reason: `Estimated cost $${estCost.toFixed(2)} exceeds limits.maxCostPerCallUsd ($${maxCost.toFixed(2)})`,
				};
			}
			return undefined;
		},
	);

	let sessionDisposers: Disposer[] = [];

	const disposeSessionListeners = (): void => {
		for (const dispose of sessionDisposers) {
			try {
				dispose();
			} catch {
				// Ignore disposer failure
			}
		}
		sessionDisposers = [];
	};

	host.onSessionStart(async (ctx: PortableCtx) => {
		try {
			disposeSessionListeners();
			configStore.setCwd(ctx.cwd);
			await configStore.load();
			await stats.load();

			const flagModel = host.getFlag("img-model");
			if (typeof flagModel === "string" && flagModel.trim().length > 0) {
				configStore.setSessionLayer({
					defaults: { model: flagModel.trim() },
				});
			}

			const cfg = configStore.getEffective();
			queue.setMaxConcurrent(cfg.queue.maxConcurrent);
			ticker.setIntervalMs(cfg.ui.spinnerMs);

			if (cfg.compat.hideBuiltin && host.deactivateBuiltinImageTool !== undefined) {
				host.deactivateBuiltinImageTool();
			}

			const noColor = process.env["NO_COLOR"] !== undefined;
			const refreshHud = (): void => {
				if (ctx.mode !== "tui") {
					return;
				}
				const currentCfg = configStore.getEffective();
				const snap = queue.snapshot();
				ticker.setActiveJobCount(snap.runningCount);

				if (currentCfg.ui.statusSegment) {
					const statusVM = buildStatusSegmentVM({
						snapshot: snap,
						defaultModelLabel: currentCfg.defaults.model,
						spinnerTick: ticker.currentTick,
						nowMs: Date.now(),
						noColor,
					});
					ctx.ui.setStatus("img-pi", statusVM.text);
				} else {
					ctx.ui.setStatus("img-pi", undefined);
				}

				if (currentCfg.ui.queueWidget) {
					const widgetVM = buildQueueWidgetVM({
						snapshot: snap,
						nowMs: Date.now(),
						spinnerTick: ticker.currentTick,
						noColor,
					});
					if (widgetVM.visible) {
						const lines = renderQueueWidget(widgetVM, 80, PLAIN_THEME);
						ctx.ui.setWidget("img-pi-queue", lines);
					} else {
						ctx.ui.setWidget("img-pi-queue", undefined);
					}
				} else {
					ctx.ui.setWidget("img-pi-queue", undefined);
				}
			};

			sessionDisposers.push(
				queue.onUpdate(() => {
					refreshHud();
				}),
				ticker.onTick(() => {
					refreshHud();
				}),
			);
			refreshHud();
		} catch (e: unknown) {
			host.logError("Failed during img.pi session_start", e);
		}
	});

	const shutdown = async (): Promise<void> => {
		disposeSessionListeners();
		ticker.stop();
		queue.cancelAll();
		await manifest.flush();
		await stats.save();
		await pool.terminate();
	};

	host.onSessionShutdown(async () => {
		try {
			await shutdown();
		} catch (e: unknown) {
			host.logError("Error during img.pi session_shutdown", e);
		}
	});

	return {
		host,
		configStore,
		pool,
		queue,
		ticker,
		registry,
		manifest,
		galleryStore,
		stats,
		shutdown,
	};
}

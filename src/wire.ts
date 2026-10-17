import { ConfigStore } from "./config/store.js";
import type { Disposer } from "./core/events.js";
import type { HostPort, PortableCtx } from "./host/port.js";
import { DurationStatsStore } from "./jobs/progress.js";
import { JobQueue } from "./jobs/queue.js";
import type { PipelineDeps } from "./pipeline/run.js";
import { HttpClient } from "./providers/http.js";
import { IMG_MODEL_FLAG, ProviderRegistry } from "./providers/registry.js";
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

const STATUS_KEY = "img-pi";
const QUEUE_WIDGET_KEY = "img-pi-queue";
/** Widget lines are rendered before the host knows the terminal width. */
const QUEUE_WIDGET_WIDTH = 80;
/** Status label before the first model resolution completes, or when none is available. */
const AUTO_MODEL_LABEL = "auto";

export interface WiredExtension {
	readonly host: HostPort;
	readonly configStore: ConfigStore;
	readonly pool: WorkerPool;
	readonly queue: JobQueue;
	readonly ticker: SharedTicker;
	readonly registry: ProviderRegistry;
	readonly manifest: ManifestStore;
	readonly stats: DurationStatsStore;
	shutdown(): Promise<void>;
}

/**
 * Composition root. Generation is agent-driven: the extension registers tools only,
 * plus a passive HUD (status segment + queue widget). No commands, no shortcuts.
 */
export function wireExtension(host: HostPort): WiredExtension {
	const configStore = new ConfigStore({
		agentDir: host.agentDir,
		cwd: process.cwd(),
		projectDirName: host.projectDirName,
	});
	const initialConfig = configStore.getEffective();
	const pool = new WorkerPool();
	const http = new HttpClient();
	const registry = new ProviderRegistry();
	const manifest = new ManifestStore();
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
		imageComponent: host.imageComponent,
		previewOptions: () => {
			const { inlinePreview, thumbMaxCells } = configStore.getEffective().ui;
			return inlinePreview ? { maxWidthCells: thumbMaxCells.w, maxHeightCells: thumbMaxCells.h } : undefined;
		},
	};

	host.registerFlag(IMG_MODEL_FLAG, {
		description: "Image model for this session (an id from img_list_models)",
		type: "string",
	});

	host.registerTool(createImgGenerateTool(toolDeps));
	host.registerTool(createImgEditTool(toolDeps));
	host.registerTool(createImgTextureTool(toolDeps));
	host.registerTool(createImgVariationsTool(toolDeps));
	host.registerTool(createImgListModelsTool(toolDeps));
	host.registerTool(createImgDescribeJobTool(toolDeps));

	let sessionDisposers: Disposer[] = [];

	const disposeSessionListeners = (): void => {
		for (const dispose of sessionDisposers) {
			try {
				dispose();
			} catch (e: unknown) {
				host.logError("img.pi listener dispose failed", e);
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

			const cfg = configStore.getEffective();
			queue.setMaxConcurrent(cfg.queue.maxConcurrent);
			ticker.setIntervalMs(cfg.ui.spinnerMs);
			if (cfg.compat.hideBuiltin) {
				host.deactivateBuiltinImageTool?.();
			}

			const noColor = process.env["NO_COLOR"] !== undefined;
			let activeModelLabel = AUTO_MODEL_LABEL;

			const refreshHud = (): void => {
				if (ctx.mode !== "tui") {
					return;
				}
				const currentCfg = configStore.getEffective();
				const snap = queue.snapshot();
				ticker.setActiveJobCount(snap.runningCount);

				const statusText = currentCfg.ui.statusSegment
					? buildStatusSegmentVM({
							snapshot: snap,
							defaultModelLabel: activeModelLabel,
							spinnerTick: ticker.currentTick,
							nowMs: Date.now(),
							noColor,
						}).text
					: undefined;
				ctx.ui.setStatus(STATUS_KEY, statusText);

				const widgetVM = buildQueueWidgetVM({
					snapshot: snap,
					nowMs: Date.now(),
					spinnerTick: ticker.currentTick,
					noColor,
				});
				const showWidget = currentCfg.ui.queueWidget && widgetVM.visible;
				ctx.ui.setWidget(
					QUEUE_WIDGET_KEY,
					showWidget ? renderQueueWidget(widgetVM, QUEUE_WIDGET_WIDTH, PLAIN_THEME) : undefined,
				);
			};

			/** The label is whatever the registry would pick right now, straight from the host. */
			const refreshModelLabel = async (): Promise<void> => {
				const res = await registry.resolveModel(undefined, getPipelineDeps(ctx));
				activeModelLabel = res.ok ? res.value.model.label : AUTO_MODEL_LABEL;
				refreshHud();
			};

			const refreshAll = (): void => {
				const currentCfg = configStore.getEffective();
				queue.setMaxConcurrent(currentCfg.queue.maxConcurrent);
				ticker.setIntervalMs(currentCfg.ui.spinnerMs);
				void refreshModelLabel().catch((e: unknown) => {
					host.logError("img.pi model label refresh failed", e);
				});
			};

			sessionDisposers.push(configStore.onChange(refreshAll), queue.onUpdate(refreshHud), ticker.onTick(refreshHud));
			refreshAll();
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

	return { host, configStore, pool, queue, ticker, registry, manifest, stats, shutdown };
}

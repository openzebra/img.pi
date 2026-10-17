import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { providerHttp } from "../../src/core/errors.js";
import { ok } from "../../src/core/result.js";
import type { SidecarDocument } from "../../src/domain/artifact.js";
import { Artifact, SIDECAR_SCHEMA_VERSION } from "../../src/domain/artifact.js";
import { createInitialJobState, reduceJob } from "../../src/domain/job.js";
import { OutputSpec } from "../../src/domain/output.js";
import { ReferenceImage } from "../../src/domain/reference.js";
import { GenerationRequest } from "../../src/domain/request.js";
import { Size } from "../../src/domain/size.js";
import { computeJobProgress, createThrottledEmitter, DurationStatsStore } from "../../src/jobs/progress.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { renderCallCard, renderJobCard } from "../../src/ui/components/job-card.js";
import { renderKeyHints } from "../../src/ui/components/key-hints.js";
import { renderPbrGrid } from "../../src/ui/components/pbr-grid.js";
import { renderQueueWidget } from "../../src/ui/components/queue-widget.js";
import { renderTilePreview } from "../../src/ui/components/tile-preview.js";
import { renderStudioScreen } from "../../src/ui/screens/studio.js";
import { PLAIN_THEME } from "../../src/ui/theme.js";
import { SharedTicker } from "../../src/ui/ticker.js";
import {
	buildCallVM,
	buildCompareVM,
	buildComposeVM,
	buildGalleryVM,
	buildJobCardVM,
	buildModelPickerVM,
	buildPbrGridVM,
	buildQueueTabVM,
	buildQueueWidgetVM,
	buildSettingsVM,
	buildStatusSegmentVM,
	buildStudioVM,
	buildTilePreviewVM,
	MemoizedComponent,
} from "../../src/ui/view-models.js";

function makeSampleRequest(): GenerationRequest {
	const outRes = OutputSpec.create({
		dir: "generated/images",
		filenameTemplate: "{date}_{slug}_{index}",
		format: "png",
		compression: 90,
		onConflict: "suffix",
		returnImage: "thumbnail",
	});
	if (!outRes.ok) throw new Error("Failed to create OutputSpec");
	const ref1 = ReferenceImage.create({ source: "ref/panel.jpg", role: "style", weight: 0.8 });
	if (!ref1.ok) throw new Error("Failed to create ref1");
	const reqRes = GenerationRequest.create({
		prompt: "rusty corroded metal panel, rivets, scratches",
		style: "pbr-texture",
		model: "openai/gpt-image-1",
		references: [ref1.value],
		sizeRequest: { width: 1536, height: 1024 },
		count: 2,
		seed: 41822,
		quality: "high",
		background: "opaque",
		output: outRes.value,
	});
	if (!reqRes.ok) throw new Error("Failed to create GenerationRequest");
	return reqRes.value;
}

describe("ui/view-models, components, screens, ticker, progress, and queue", () => {
	test("MemoizedComponent caches render(width) by (vm.hash, width) and invalidates", () => {
		let renderCount = 0;
		const vm1 = buildCallVM({
			toolName: "img_generate",
			prompt: "rusty panel",
			model: "openai/gpt-image-1",
			width: 1536,
			height: 1024,
			count: 2,
		});
		const comp = new MemoizedComponent(vm1, (v, w, theme) => {
			renderCount++;
			return renderCallCard(v, w, theme);
		});

		const lines80a = comp.render(80);
		expect(renderCount).toBe(1);
		const lines80b = comp.render(80);
		expect(renderCount).toBe(1);
		expect(lines80b).toBe(lines80a);

		// Width change triggers recomputation
		const lines120 = comp.render(120);
		expect(renderCount).toBe(2);
		expect(lines120[0]?.length).toBeGreaterThan(lines80a[0]?.length ?? 0);

		// Same VM content produces identical hash -> no recomputation at width 120
		const vm1Clone = buildCallVM({
			toolName: "img_generate",
			prompt: "rusty panel",
			model: "openai/gpt-image-1",
			width: 1536,
			height: 1024,
			count: 2,
		});
		expect(vm1Clone.hash).toBe(vm1.hash);
		comp.setVM(vm1Clone);
		comp.render(120);
		expect(renderCount).toBe(2);

		// invalidate() clears cache
		comp.invalidate();
		comp.render(120);
		expect(renderCount).toBe(3);
	});

	test("renderJobCard across all phases and widths 40 / 80 / 120 + NO_COLOR", () => {
		const req = makeSampleRequest();
		const baseSize = new Size(1536, 1024);
		let state = createInitialJobState({
			id: "01JXA9K3ABCDEFGH1234567890",
			request: req,
			modelId: "openai/gpt-image-1",
			providerId: "openai",
			requestedSize: baseSize,
			producedSize: baseSize,
			createdAt: 1000,
			queuePosition: 2,
		});

		// 1. Queued at width 40, 80, 120
		const queuedVm = buildJobCardVM({
			toolName: "img_generate",
			state,
			nowMs: 1200,
			spinnerTick: 0,
		});
		const q40 = renderJobCard(queuedVm, 40, PLAIN_THEME);
		expect(q40.length).toBe(2);
		const q80 = renderJobCard(queuedVm, 80, PLAIN_THEME);
		expect(q80.join("\n")).toContain("queued #2");
		expect(q80.join("\n")).toContain("esc cancel");
		const q120 = renderJobCard(queuedVm, 120, PLAIN_THEME);
		expect(q120.length).toBe(q80.length);

		// 2. Preparing
		state = reduceJob(state, { t: "start", at: 1500 });
		const prepVm = buildJobCardVM({
			toolName: "img_generate",
			state,
			nowMs: 2900,
			spinnerTick: 2,
		});
		const prep80 = renderJobCard(prepVm, 80, PLAIN_THEME);
		expect(prep80.join("\n")).toContain("refs");
		expect(prep80.join("\n")).toContain("ref/panel.jpg");

		// 3. Generating (estimated)
		state = reduceJob(state, { t: "phase", phase: "generating", at: 3000 });
		const genEstVm = buildJobCardVM({
			toolName: "img_generate",
			state,
			nowMs: 11800,
			spinnerTick: 4,
			tauMs: 12000,
		});
		expect(genEstVm.estimated).toBe(true);
		const genEst80 = renderJobCard(genEstVm, 80, PLAIN_THEME);
		expect(genEst80.join("\n")).toContain("~");
		expect(genEst80.join("\n")).toContain("● generate");

		// 4. Generating (real steps + live preview)
		state = reduceJob(state, {
			t: "provider_progress",
			step: 18,
			steps: 30,
			fraction: 0.6,
			at: 9100,
		});
		const genRealVm = buildJobCardVM({
			toolName: "img_generate",
			state,
			nowMs: 9100,
			spinnerTick: 6,
			livePreviewLines: ["░░▒▒▓▓▒▒░░▒▒", "▒▓██▓▒░▒▓██▓", "░▒▓▓▒░░▒▓▓▒░"],
		});
		expect(genRealVm.estimated).toBe(false);
		const genReal80 = renderJobCard(genRealVm, 80, PLAIN_THEME);
		expect(genReal80.join("\n")).toContain("step 18/30");
		expect(genReal80.join("\n")).toContain("░░▒▒▓▓▒▒░░▒▒");

		// 5. Done (collapsed + expanded)
		const sampleSidecar: SidecarDocument = {
			schema: SIDECAR_SCHEMA_VERSION,
			job: state.id,
			index: 1,
			createdAt: "2025-06-11T14:02:11.233Z",
			host: "omp",
			provider: "openai",
			model: "openai/gpt-image-1",
			reportedModel: "gpt-image-1",
			prompt: req.prompt,
			negativePrompt: null,
			style: "pbr-texture",
			finalPrompt: req.prompt,
			seed: 41822,
			steps: null,
			guidance: null,
			quality: "high",
			requestedSize: [1536, 1024],
			producedSize: [1536, 1024],
			post: [],
			references: [{ source: "ref/panel.jpg", sha256: "abc", role: "style", weight: 0.8 }],
			sha256: "deadbeef",
			bytes: 2_201_331,
			format: "png",
			path: "generated/images/2025-06-11_rusty-metal-panel_1.png",
			usage: { input: 312, images: 2 },
			costUsd: 0.33,
			texture: null,
			tags: ["metal"],
			metadata: {},
		};
		const art = new Artifact(
			{
				index: 1,
				path: "/tmp/generated/images/2025-06-11_rusty-metal-panel_1.png",
				relativePath: "generated/images/2025-06-11_rusty-metal-panel_1.png",
				sidecarPath: "generated/images/2025-06-11_rusty-metal-panel_1.png.json",
				bytes: 2_201_331,
				width: 1536,
				height: 1024,
				format: "png",
				sha256: "deadbeef",
			},
			sampleSidecar,
		);
		state = reduceJob(state, { t: "artifact", artifact: art, at: 15000 });
		state = reduceJob(state, {
			t: "usage",
			usage: { inputTokens: 312, images: 2, costUsd: 0.33 },
			at: 15100,
		});
		state = reduceJob(state, { t: "phase", phase: "done", at: 15200 });

		const doneCollapsedVm = buildJobCardVM({
			toolName: "img_generate",
			state,
			nowMs: 15200,
			spinnerTick: 0,
			expanded: false,
		});
		const dc80 = renderJobCard(doneCollapsedVm, 80, PLAIN_THEME);
		expect(dc80.join("\n")).toContain("2025-06-11_rusty-metal-panel_1.png");
		expect(dc80.join("\n")).toContain("ctrl+o expand");

		const doneExpandedVm = buildJobCardVM({
			toolName: "img_generate",
			state,
			nowMs: 15200,
			spinnerTick: 0,
			expanded: true,
		});
		const de80 = renderJobCard(doneExpandedVm, 80, PLAIN_THEME);
		expect(de80.join("\n")).toContain("sidecar");
		expect(de80.join("\n")).toContain("manifest .img-pi/manifest.jsonl");

		// 6. Failed + NO_COLOR
		let failedState = createInitialJobState({
			id: "01JXA9FAIL0000000000000000",
			request: req,
			modelId: "openai/gpt-image-1",
			providerId: "openai",
			requestedSize: baseSize,
			producedSize: baseSize,
			createdAt: 1000,
		});
		failedState = reduceJob(failedState, {
			t: "fail",
			error: providerHttp("openai", 429, "rate limited (retried 3×)", true),
			at: 4200,
		});
		const failedVm = buildJobCardVM({
			toolName: "img_generate",
			state: failedState,
			nowMs: 4200,
			spinnerTick: 0,
			noColor: true,
		});
		const f80 = renderJobCard(failedVm, 80, PLAIN_THEME);
		expect(f80.join("\n")).toContain("[x] img_generate");
		expect(f80.join("\n")).toContain("provider_http 429");
		expect(f80.join("\n")).toContain("r retry");
	});

	test("Studio screens (Compose, Gallery, Queue, Compare, Settings) and modals render cleanly", () => {
		const queue = new JobQueue(DEFAULT_CONFIG);
		const snap = queue.snapshot();

		const composeVm = buildComposeVM({
			prompt: "mossy cobblestone path, wet, moss in cracks",
			negativePrompt: "blurry, text, watermark",
			model: "fal/flux-pro-v1.1",
			keyEnvHint: "FAL_KEY",
			hasKey: true,
			mode: "texture",
			width: 1024,
			height: 1024,
			aspectRatio: "1:1",
			resolution: "1K",
			sizeMode: "exact",
			count: 2,
			seed: "random",
			seedLocked: true,
			steps: 28,
			guidance: 3.5,
			style: "pbr-texture",
			maps: ["albedo", "normal", "roughness", "ao", "height"],
			normalConvention: "opengl",
			normalStrength: 2.0,
			tileable: true,
			refs: [{ source: "refs/stone.jpg", role: "style", weight: 0.8 }],
			outputTemplate: "generated/textures/{slug}_{map}.png",
			focusedFieldIndex: 0,
			estCostUsd: 0.08,
			estTimeSec: 11,
		});

		const galleryVm = buildGalleryVM({
			entries: [],
			filter: "#stone",
			selectedIndex: 0,
		});

		const queueTabVm = buildQueueTabVM({
			snapshot: snap,
			selectedIndex: 0,
			nowMs: 5000,
			spinnerTick: 1,
		});

		const compareVm = buildCompareVM({});

		const settingsVm = buildSettingsVM({
			config: DEFAULT_CONFIG,
			scope: "project",
			activeSectionIndex: 0,
			activeFieldIndex: 0,
		});

		for (const tab of [1, 2, 3, 4, 5] as const) {
			const studioVm = buildStudioVM({
				activeTab: tab,
				compose: composeVm,
				gallery: galleryVm,
				queueTab: queueTabVm,
				compare: compareVm,
				settings: settingsVm,
			});
			const lines = renderStudioScreen(studioVm, 84, PLAIN_THEME);
			expect(lines.length).toBeGreaterThan(6);
		}

		// Modals: model_picker, tile_preview, pbr_grid, help
		const pickerVm = buildModelPickerVM({
			models: [
				{
					id: "fal/flux-pro-v1.1",
					provider: "fal",
					label: "FLUX 1.1 Pro",
					caps: new Set(["txt2img", "seed", "steps", "arbitrary_size"]),
					sizes: { kind: "multiple", step: 16, min: 256, max: 2048 },
					maxRefs: 0,
					maxCount: 4,
					costPerImageUsd: 0.04,
					hasKey: true,
				},
			],
			filter: "flux",
			selectedIndex: 0,
		});
		const modalStudio = buildStudioVM({
			activeTab: 1,
			modal: "model_picker",
			compose: composeVm,
			gallery: galleryVm,
			queueTab: queueTabVm,
			compare: compareVm,
			settings: settingsVm,
			modelPicker: pickerVm,
		});
		const pickerLines = renderStudioScreen(modalStudio, 80, PLAIN_THEME);
		expect(pickerLines.join("\n")).toContain("choose model");
		expect(pickerLines.join("\n")).toContain("flux-pro-v1.1");

		const tileVm = buildTilePreviewVM({
			filename: "cobble_albedo.png",
			seamScore: 3.1,
			availableMaps: ["albedo", "normal", "roughness", "ao", "height"],
			activeMap: "albedo",
			tiles: 2,
			showGrid: true,
		});
		const tileLines = renderTilePreview(tileVm, 80, PLAIN_THEME);
		expect(tileLines.join("\n")).toContain("seam score 3.1 (good < 6)");

		const pbrVm = buildPbrGridVM({
			materialName: "mossy-cobblestone",
			resolution: 1024,
			normalConvention: "opengl",
			maps: ["albedo", "normal", "roughness", "ao", "height"],
			hasBlender: true,
		});
		const pbrLines = renderPbrGrid(pbrVm, 80, PLAIN_THEME);
		expect(pbrLines.join("\n")).toContain("material.json");
		expect(pbrLines.join("\n")).toContain("open in Blender");

		const statusVm = buildStatusSegmentVM({
			snapshot: snap,
			defaultModelLabel: "openai/gpt-image-1",
			spinnerTick: 0,
			nowMs: 1000,
		});
		expect(statusVm.text).toContain("gpt-image-1");

		const qWidgetVm = buildQueueWidgetVM({
			snapshot: snap,
			nowMs: 1000,
			spinnerTick: 0,
		});
		expect(renderQueueWidget(qWidgetVm, 80, PLAIN_THEME)).toEqual([]);

		expect(renderKeyHints([{ key: "⏎", label: "generate" }], PLAIN_THEME)).toContain("generate");
	});

	test("SharedTicker runs only while jobs are active, and DurationStatsStore + JobQueue work", async () => {
		const ticker = new SharedTicker(30);
		expect(ticker.isRunning).toBe(false);
		let ticks = 0;
		const off = ticker.onTick(() => {
			ticks++;
		});
		ticker.setActiveJobCount(1);
		expect(ticker.isRunning).toBe(true);
		await new Promise(r => setTimeout(r, 75));
		expect(ticks).toBeGreaterThanOrEqual(1);
		ticker.setActiveJobCount(0);
		expect(ticker.isRunning).toBe(false);
		off();
		ticker.dispose();

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-stats-"));
		try {
			const stats = new DurationStatsStore(tmpDir);
			const s = new Size(1024, 1024);
			expect(stats.getTauMs("openai", "openai/gpt-image-1", s)).toBe(12000);
			stats.recordDuration("openai", "openai/gpt-image-1", s, 6000);
			await stats.save();

			const stats2 = new DurationStatsStore(tmpDir);
			await stats2.load();
			expect(stats2.getTauMs("openai", "openai/gpt-image-1", s)).toBe(6000);

			// Progress never exceeds 0.95 before completion
			const req = makeSampleRequest();
			let st = createInitialJobState({
				id: "01JXA9PROG",
				request: req,
				modelId: "openai/gpt-image-1",
				providerId: "openai",
				requestedSize: s,
				producedSize: s,
				createdAt: 0,
			});
			st = reduceJob(st, { t: "start", at: 10 });
			st = reduceJob(st, { t: "phase", phase: "saving", at: 50000 });
			const prog = computeJobProgress(st, 200000, undefined, 6000);
			expect(prog.fraction).toBeLessThanOrEqual(0.95);

			// Throttled emitter
			let emittedCount = 0;
			const throttled = createThrottledEmitter<number>(() => {
				emittedCount++;
			}, 50);
			throttled.emit(1);
			throttled.emit(2);
			throttled.emit(3);
			expect(emittedCount).toBe(1);
			throttled.flush();
			expect(emittedCount).toBe(2);
			throttled.dispose();

			// JobQueue bounded concurrency & cancel
			const q = new JobQueue(DEFAULT_CONFIG);
			const res = await q.enqueue({
				request: req,
				modelId: "mock/gradient",
				providerId: "mock",
				requestedSize: s,
				producedSize: s,
				run: ctx => {
					ctx.emit({ t: "phase", phase: "generating", at: Date.now() });
					return Promise.resolve(ok(undefined));
				},
			});
			expect(res.ok).toBe(true);
			q.dispose();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

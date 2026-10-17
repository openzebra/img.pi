import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../../src/config/store.js";
import { wrapPortableCtx } from "../../src/host/base.js";
import { DurationStatsStore } from "../../src/jobs/progress.js";
import { JobQueue } from "../../src/jobs/queue.js";
import type { PipelineDeps } from "../../src/pipeline/run.js";
import { HttpClient } from "../../src/providers/http.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { ManifestStore } from "../../src/storage/manifest.js";
import { createImgDescribeJobTool } from "../../src/tools/img-describe-job.js";
import { createImgEditTool } from "../../src/tools/img-edit.js";
import { createImgGenerateTool } from "../../src/tools/img-generate.js";
import { createImgListModelsTool } from "../../src/tools/img-list-models.js";
import { createImgTextureTool } from "../../src/tools/img-texture.js";
import { createImgVariationsTool, expandVariations } from "../../src/tools/img-variations.js";
import type { ToolRuntimeDeps } from "../../src/tools/result.js";
import {
	IMG_DESCRIBE_JOB_SCHEMA,
	IMG_EDIT_SCHEMA,
	IMG_GENERATE_SCHEMA,
	IMG_LIST_MODELS_SCHEMA,
	IMG_TEXTURE_SCHEMA,
	IMG_VARIATIONS_SCHEMA,
} from "../../src/tools/schemas.js";
import { PLAIN_THEME } from "../../src/ui/theme.js";
import { SharedTicker } from "../../src/ui/ticker.js";
import { WorkerPool } from "../../src/workers/pool.js";
import { quotaExhausted } from "../../src/core/errors.js";
import { FakeHost, GOOGLE_IMAGE_MODEL, TEXT_ONLY_IMAGE_MODEL } from "../fixtures/fake-host.js";
import { buildTinySeedPng } from "../fixtures/png.js";

describe("tools: schemas & execution", () => {
	let tmpDir = "";
	let pool: WorkerPool;
	let runtimeDeps: ToolRuntimeDeps;
	let host: FakeHost;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-tools-"));
		pool = new WorkerPool({ size: 2 });

		host = new FakeHost(path.join(tmpDir, ".omp-agent"), [GOOGLE_IMAGE_MODEL, TEXT_ONLY_IMAGE_MODEL]);
		const configStore = new ConfigStore({
			agentDir: path.join(tmpDir, ".omp-agent"),
			cwd: tmpDir,
			projectDirName: ".omp",
		});
		const http = new HttpClient();
		const registry = new ProviderRegistry();
		const manifest = new ManifestStore();
		const stats = new DurationStatsStore(path.join(tmpDir, ".omp-agent"));
		const queue = new JobQueue(configStore.getEffective());
		const ticker = new SharedTicker(80);

		runtimeDeps = {
			getPipelineDeps: (hostCtx): PipelineDeps => ({
				host,
				hostCtx,
				config: configStore.getEffective(),
				pool,
				http,
				registry,
				manifest,
				queue,
				stats,
			}),
			ticker,
			stats,
			imageComponent: host.imageComponent,
			previewOptions: () => ({ maxWidthCells: 40, maxHeightCells: 14 }),
		};
	});

	afterAll(async () => {
		await pool.terminate();
		if (tmpDir.length > 0) {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("tool schemas validate valid inputs and reject unknown or invalid fields", () => {
		const okGen = IMG_GENERATE_SCHEMA.validate({
			prompt: "test prompt",
			width: 512,
			height: 512,
			count: 2,
		});
		expect(okGen.ok).toBe(true);

		const unknownField = IMG_GENERATE_SCHEMA.validate({
			prompt: "test",
			bogus_param: 123,
		});
		expect(unknownField.ok).toBe(false);

		const badEdit = IMG_EDIT_SCHEMA.validate({
			prompt: "edit without image",
		});
		expect(badEdit.ok).toBe(false);

		const okTex = IMG_TEXTURE_SCHEMA.validate({
			material: "rough granite",
			resolution: 512,
			maps: ["albedo", "normal", "roughness"],
		});
		expect(okTex.ok).toBe(true);

		const okVar = IMG_VARIATIONS_SCHEMA.validate({
			base: { prompt: "ceramic vase" },
			vary: { seeds: [1, 2, 3] },
			mode: "cartesian",
		});
		expect(okVar.ok).toBe(true);

		const okList = IMG_LIST_MODELS_SCHEMA.validate({
			provider: "google",
			capability: "txt2img",
		});
		expect(okList.ok).toBe(true);

		const okDesc = IMG_DESCRIBE_JOB_SCHEMA.validate({
			job: "@last",
		});
		expect(okDesc.ok).toBe(true);
	});

	test("img_generate executes dry_run and a host generation, saving under .pi/img with sidecar and manifest", async () => {
		const genTool = createImgGenerateTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		// 1. Dry run
		const dryRes = await genTool.execute(
			"call-dry",
			{
				prompt: "red cube on white table",
				model: GOOGLE_IMAGE_MODEL.id,
				width: 128,
				height: 128,
				dry_run: true,
			},
			undefined,
			undefined,
			ctx,
		);
		expect(dryRes.isError).toBe(false);
		expect(dryRes.details?.dryRun).toBe(true);
		const dryText = dryRes.content[0]?.type === "text" ? dryRes.content[0].text : "";
		expect(dryText).toContain("dry_run");

		// 2. Real generation through the (fake) host
		const genRes = await genTool.execute(
			"call-gen-1",
			{
				prompt: "emerald crystal shard",
				model: GOOGLE_IMAGE_MODEL.id,
				width: 128,
				height: 128,
				seed: 42,
				tags: ["crystal", "prop"],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(genRes.isError).toBe(false);
		expect(genRes.details?.artifacts.length).toBe(1);
		expect(genRes.details?.seed).toBe(42);
		expect(genRes.details?.artifacts[0]?.relativePath.startsWith(".pi/img/images/")).toBe(true);
		const manifestText = await fs.readFile(path.join(tmpDir, ".pi/img/manifest.jsonl"), "utf8");
		expect(manifestText).toContain("emerald crystal shard");
		expect(host.requests.at(-1)).toMatchObject({ model: GOOGLE_IMAGE_MODEL.id, aspectRatio: "1:1" });
		// Should include text summary + thumbnail image
		expect(genRes.content.length).toBe(2);
		expect(genRes.content[1]?.type).toBe("image");

		// Verify renderers work cleanly
		const callComp = genTool.renderCall?.({ prompt: "emerald crystal shard" }, PLAIN_THEME);
		expect(callComp?.render(80).length).toBeGreaterThan(0);
		const resComp = genTool.renderResult?.(genRes, { expanded: true, isPartial: false }, PLAIN_THEME);
		expect(resComp?.render(80).at(-1)).toBe("[image]");
	});

	test("img_describe_job inspects @last and job ID prefix", async () => {
		const descTool = createImgDescribeJobTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		const lastRes = await descTool.execute("call-desc-1", { job: "@last" }, undefined, undefined, ctx);
		expect(lastRes.isError).toBe(false);
		expect(lastRes.details?.sidecars.length).toBe(1);
		const doc = lastRes.details?.sidecars[0];
		expect(doc?.prompt).toBe("emerald crystal shard");
		expect(doc?.seed).toBe(42);

		if (doc !== undefined) {
			const prefixRes = await descTool.execute(
				"call-desc-2",
				{ job: doc.job.slice(0, 6) },
				undefined,
				undefined,
				ctx,
			);
			expect(prefixRes.isError).toBe(false);
			expect(prefixRes.details?.sidecars[0]?.job).toBe(doc.job);
		}
	});

	test("img_edit edits @last image through the host", async () => {
		const editTool = createImgEditTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		const editRes = await editTool.execute(
			"call-edit-1",
			{
				image: "@last",
				prompt: "add golden rim light",
				model: GOOGLE_IMAGE_MODEL.id,
				width: 128,
				height: 128,
				return_image: "none",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(editRes.isError).toBe(false);
		expect(editRes.content.length).toBe(1);
		expect(editRes.details?.artifacts.length).toBe(1);
	});

	test("img_texture generates tileable PBR maps, 2x2 preview, and material.json", async () => {
		const texTool = createImgTextureTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		const texRes = await texTool.execute(
			"call-tex-1",
			{
				material: "weathered basalt cobblestone",
				model: GOOGLE_IMAGE_MODEL.id,
				resolution: 256,
				maps: ["albedo", "normal", "roughness", "ao", "height"],
				orm_pack: true,
				tileable: true,
			},
			undefined,
			undefined,
			ctx,
		);
		expect(texRes.isError).toBe(false);
		// 5 requested maps + orm = 6 artifacts
		expect(texRes.details?.artifacts.length).toBe(6);
		const summaryText = texRes.content[0]?.type === "text" ? texRes.content[0].text : "";
		expect(summaryText).toContain("preview:");
		expect(summaryText).toContain("material:");
	});

	test("img_variations expands cartesian & zip axes and generates contact sheet", async () => {
		const varTool = createImgVariationsTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });
		const pDeps = runtimeDeps.getPipelineDeps(ctx);

		// Test zip length mismatch error
		const badZip = expandVariations(
			{ prompt: "test" },
			{ seeds: [1, 2], styles: ["photo", "pixel-art", "ui-icon"] },
			"zip",
			pDeps.config,
		);
		expect(badZip.ok).toBe(false);

		// Execute cartesian batch of 2 seeds
		const varRes = await varTool.execute(
			"call-var-1",
			{
				base: {
					prompt: "brass gear icon",
					model: GOOGLE_IMAGE_MODEL.id,
					width: 128,
					height: 128,
				},
				vary: {
					seeds: [10, 20],
				},
				mode: "cartesian",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(varRes.isError).toBe(false);
		const text = varRes.content[0]?.type === "text" ? varRes.content[0].text : "";
		expect(text).toContain("generated 2 variations");
		expect(text).toContain("contact sheet:");
		expect(varRes.content.length).toBe(2);
	});

	test("agent guidance: texture requests route to img_texture with the requested resolution, honestly described", () => {
		const texture = createImgTextureTool(runtimeDeps);
		expect(texture.description).toContain("4K → 4096");
		expect(texture.description).toContain("native");
		expect(JSON.stringify(texture.parameters)).toContain("4K = 4096");
		expect(createImgGenerateTool(runtimeDeps).description).toContain("img_texture");
	});

	test("img_list_models lists host models, grouped by provider, with the default marked", async () => {
		const listTool = createImgListModelsTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		const listRes = await listTool.execute(
			"call-list-1",
			{ provider: "google", capability: "txt2img" },
			undefined,
			undefined,
			ctx,
		);
		expect(listRes.isError).toBe(false);
		expect(listRes.details?.models.some(m => m.id === GOOGLE_IMAGE_MODEL.id)).toBe(true);
		expect(listRes.details?.defaultModelId).toBe(GOOGLE_IMAGE_MODEL.id);
		const text = listRes.content[0]?.type === "text" ? listRes.content[0].text : "";
		expect(text).toContain("Google");
		expect(text).toContain(`${GOOGLE_IMAGE_MODEL.id} · Gemini Image · generate + edit  ← default`);
		expect(text).not.toMatch(/\$|cost|key/i);
	});

	test("img_generate without a model uses the host default and reports only host-reported cost", async () => {
		host.costPerCallUsd = 0.039;
		try {
			const res = await createImgGenerateTool(runtimeDeps).execute(
				"call-default",
				{ prompt: "a ginger cat on a windowsill", aspect_ratio: "3:2" },
				undefined,
				undefined,
				wrapPortableCtx({ cwd: tmpDir, mode: "print" }),
			);
			expect(res.isError).toBe(false);
			expect(res.details?.model).toBe(GOOGLE_IMAGE_MODEL.id);
			expect(host.requests.at(-1)?.aspectRatio).toBe("3:2");
			const text = res.content[0]?.type === "text" ? res.content[0].text : "";
			expect(text).toContain("cost: $0.0390 (reported by host)");
		} finally {
			host.costPerCallUsd = undefined;
		}
	});

	test("img_edit rejects a host model that does not accept input images", async () => {
		const res = await createImgEditTool(runtimeDeps).execute(
			"call-edit-text-only",
			{ image: "@last", prompt: "make it blue", model: TEXT_ONLY_IMAGE_MODEL.id },
			undefined,
			undefined,
			wrapPortableCtx({ cwd: tmpDir, mode: "print" }),
		);
		expect(res.isError).toBe(true);
		const text = res.content[0]?.type === "text" ? res.content[0].text : "";
		expect(text).toContain("unsupported");
	});

	// Regression: a pasted omp image (`local://…`, stored outside cwd) failed as "File not found".
	test("img_generate reads a host-internal reference URL the host resolves outside cwd", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-host-url-"));
		try {
			const file = path.join(outside, "pasted-image-ab.png");
			await fs.writeFile(file, new Uint8Array(buildTinySeedPng(3, false)));
			host.hostUrls.set("local://pasted-image-ab.png", file);
			host.requests.length = 0;
			const res = await createImgGenerateTool(runtimeDeps).execute(
				"call-host-url",
				{
					prompt: "wood texture like the reference",
					model: GOOGLE_IMAGE_MODEL.id,
					references: [{ source: "local://pasted-image-ab.png", role: "style" }],
				},
				undefined,
				undefined,
				wrapPortableCtx({ cwd: tmpDir, mode: "print" }),
			);
			expect(res.isError).toBe(false);
			expect(host.requests[0]?.inputImages?.length).toBe(1);
		} finally {
			host.hostUrls.clear();
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("a failed generation saves debug facts: model, failing phase, timings, the agent-facing message", async () => {
		host.failWith = quotaExhausted(GOOGLE_IMAGE_MODEL.id, 429, "You have exhausted your capacity");
		try {
			const res = await createImgGenerateTool(runtimeDeps).execute(
				"call-quota",
				{ prompt: "quota victim", model: GOOGLE_IMAGE_MODEL.id },
				undefined,
				undefined,
				wrapPortableCtx({ cwd: tmpDir, mode: "print" }),
			);
			expect(res.isError).toBe(true);
			const text = res.content[0]?.type === "text" ? res.content[0].text : "";
			expect(text).toContain("quota_exhausted 429");
			expect(text).toContain("use another image model");

			const failedDir = path.join(tmpDir, ".pi/img/failed");
			const names = await fs.readdir(failedDir);
			const records = await Promise.all(
				names.map(async n => JSON.parse(await fs.readFile(path.join(failedDir, n), "utf8")) as unknown),
			);
			const record = records.find(
				(r): r is { debug: Record<string, unknown> } =>
					typeof r === "object" &&
					r !== null &&
					"debug" in r &&
					typeof r.debug === "object" &&
					r.debug !== null &&
					"message" in r.debug &&
					String(r.debug.message).startsWith("quota_exhausted"),
			);
			expect(record?.debug).toMatchObject({
				host: "omp",
				provider: GOOGLE_IMAGE_MODEL.provider,
				model: GOOGLE_IMAGE_MODEL.id,
				failedPhase: "generating",
			});
			expect(typeof record?.debug["durationMs"]).toBe("number");
			expect(String(record?.debug["finalPrompt"])).toContain("quota victim");
		} finally {
			host.failWith = undefined;
		}
	});

	test("aborted tool call returns isError: false (cancelled, not failed)", async () => {
		const genTool = createImgGenerateTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });
		const ac = new AbortController();
		ac.abort();

		const abortRes = await genTool.execute(
			"call-abort",
			{
				prompt: "cancelled generation",
				model: GOOGLE_IMAGE_MODEL.id,
				width: 128,
				height: 128,
			},
			ac.signal,
			undefined,
			ctx,
		);
		expect(abortRes.isError).toBe(false);
		const text = abortRes.content[0]?.type === "text" ? abortRes.content[0].text : "";
		expect(text.toLowerCase()).toContain("cancel");
	});
});

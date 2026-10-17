import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../../src/config/store.js";
import { OmpHost } from "../../src/host/omp.js";
import { wrapPortableCtx } from "../../src/host/omp.js";
import { DurationStatsStore } from "../../src/jobs/progress.js";
import { JobQueue } from "../../src/jobs/queue.js";
import type { PipelineDeps } from "../../src/pipeline/run.js";
import { HttpClient } from "../../src/providers/http.js";
import { SecretResolver } from "../../src/providers/port.js";
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

describe("tools: schemas & execution", () => {
	let tmpDir = "";
	let pool: WorkerPool;
	let runtimeDeps: ToolRuntimeDeps;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-tools-"));
		pool = new WorkerPool({ size: 2 });

		const host = new OmpHost({ arktype: true });
		const configStore = new ConfigStore({
			agentDir: path.join(tmpDir, ".omp-agent"),
			cwd: tmpDir,
			projectDirName: ".omp",
		});
		const http = new HttpClient();
		const secrets = new SecretResolver({});
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
				secrets,
				registry,
				manifest,
				queue,
				stats,
			}),
			ticker,
			stats,
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
			provider: "mock",
			capability: "txt2img",
		});
		expect(okList.ok).toBe(true);

		const okDesc = IMG_DESCRIBE_JOB_SCHEMA.validate({
			job: "@last",
		});
		expect(okDesc.ok).toBe(true);
	});

	test("img_generate executes dry_run and full mock/solid generation with sidecar and manifest", async () => {
		const genTool = createImgGenerateTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		// 1. Dry run
		const dryRes = await genTool.execute(
			"call-dry",
			{
				prompt: "red cube on white table",
				model: "mock/solid",
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

		// 2. Real generation with mock/solid
		const genRes = await genTool.execute(
			"call-gen-1",
			{
				prompt: "emerald crystal shard",
				model: "mock/solid",
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
		// Should include text summary + thumbnail image
		expect(genRes.content.length).toBe(2);
		expect(genRes.content[1]?.type).toBe("image");

		// Verify renderers work cleanly
		const callComp = genTool.renderCall?.({ prompt: "emerald crystal shard" }, PLAIN_THEME);
		expect(callComp?.render(80).length).toBeGreaterThan(0);
		const resComp = genTool.renderResult?.(genRes, { expanded: true, isPartial: false }, PLAIN_THEME);
		expect(resComp?.render(80).length).toBeGreaterThan(0);
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

	test("img_edit edits @last image using mock/solid", async () => {
		const editTool = createImgEditTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		const editRes = await editTool.execute(
			"call-edit-1",
			{
				image: "@last",
				prompt: "add golden rim light",
				model: "mock/solid",
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
				model: "mock/solid",
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
					model: "mock/solid",
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

	test("img_list_models lists mock provider models with capabilities", async () => {
		const listTool = createImgListModelsTool(runtimeDeps);
		const ctx = wrapPortableCtx({ cwd: tmpDir, mode: "print" });

		const listRes = await listTool.execute(
			"call-list-1",
			{ provider: "mock", capability: "txt2img" },
			undefined,
			undefined,
			ctx,
		);
		expect(listRes.isError).toBe(false);
		expect(listRes.details?.models.some(m => m.id === "mock/solid")).toBe(true);
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
				model: "mock/solid",
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createImgCommand } from "../../src/commands/img.js";
import { ConfigStore } from "../../src/config/store.js";
import { wrapPortableCtx } from "../../src/host/base.js";
import type { ComponentLike, PortableCtx } from "../../src/host/port.js";
import { DurationStatsStore } from "../../src/jobs/progress.js";
import { JobQueue } from "../../src/jobs/queue.js";
import type { PipelineDeps } from "../../src/pipeline/run.js";
import { HttpClient } from "../../src/providers/http.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { ManifestStore } from "../../src/storage/manifest.js";
import { createImgGenerateTool } from "../../src/tools/img-generate.js";
import { visibleWidth } from "../../src/ui/theme.js";
import { SharedTicker } from "../../src/ui/ticker.js";
import { WorkerPool } from "../../src/workers/pool.js";
import { FakeHost, GOOGLE_IMAGE_MODEL, KEY_SEQ, TEXT_ONLY_IMAGE_MODEL } from "../fixtures/fake-host.js";

const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

/** Host-shaped `ui.custom`: hands back the component and resolves when it calls `done`. */
function overlayCtx(cwd: string): {
	readonly ctx: PortableCtx;
	readonly opened: Promise<ComponentLike>;
	readonly closed: Promise<unknown>;
} {
	let resolveOpened: (c: ComponentLike) => void = () => undefined;
	let resolveClosed: (v: unknown) => void = () => undefined;
	const opened = new Promise<ComponentLike>(r => {
		resolveOpened = r;
	});
	const closed = new Promise<unknown>(r => {
		resolveClosed = r;
	});
	const ctx = wrapPortableCtx({
		cwd,
		mode: "tui",
		ui: {
			notify: () => undefined,
			custom: (
				factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => ComponentLike,
			) =>
				new Promise(resolve => {
					const component = factory({ requestRender: () => undefined }, plainTheme, {}, v => {
						resolveClosed(v);
						resolve(v);
					});
					resolveOpened(component);
				}),
		},
	});
	return { ctx, opened, closed };
}

async function waitForText(component: ComponentLike, text: string): Promise<string> {
	for (let i = 0; i < 100; i++) {
		const screen = component.render(120).join("\n");
		if (screen.includes(text)) {
			return screen;
		}
		await Bun.sleep(5);
	}
	return component.render(120).join("\n");
}

describe("/img Studio", () => {
	let tmpDir = "";
	let pool: WorkerPool;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-studio-"));
		pool = new WorkerPool({ size: 1 });
	});

	afterAll(async () => {
		await pool.terminate();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("lists host models, saves the default model and settings to the project file, closes on esc", async () => {
		const agentDir = path.join(tmpDir, "agent");
		const host = new FakeHost(agentDir, [GOOGLE_IMAGE_MODEL, TEXT_ONLY_IMAGE_MODEL]);
		const configStore = new ConfigStore({ agentDir, cwd: tmpDir, projectDirName: ".omp" });
		const registry = new ProviderRegistry();
		const manifest = new ManifestStore();
		const stats = new DurationStatsStore(agentDir);
		const getPipelineDeps = (hostCtx: PortableCtx): PipelineDeps => ({
			host,
			hostCtx,
			config: configStore.getEffective(),
			pool,
			http: new HttpClient(),
			registry,
			manifest,
			queue: new JobQueue(configStore.getEffective()),
			stats,
		});
		const command = createImgCommand({ host, configStore, getPipelineDeps });
		const { ctx, opened, closed } = overlayCtx(tmpDir);
		const running = command.handler("", ctx);
		const studio = await opened;

		// Models tab: host models grouped by provider, auto is the default.
		const models = await waitForText(studio, "Gemini Image");
		expect(models).toContain("[Models]");
		expect(models).toContain("Google");
		expect(models).toContain("google/imagen");
		expect(models).toMatch(/✓ auto/);
		expect(models).not.toMatch(/\$|openai|mock/i);
		for (const width of [50, 72, 160]) {
			expect(studio.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
		}

		// Pick Gemini Image as the default → written to <cwd>/.omp/img-pi.json.
		studio.handleInput?.(KEY_SEQ.down);
		studio.handleInput?.(KEY_SEQ.enter);
		await waitForText(studio, "saved to project config");
		const projectFile = path.join(tmpDir, ".omp", "img-pi.json");
		const afterModel: unknown = JSON.parse(await fs.readFile(projectFile, "utf8"));
		expect(afterModel).toMatchObject({ defaults: { model: GOOGLE_IMAGE_MODEL.id } });
		expect(await waitForText(studio, "✓ Gemini Image")).toMatch(/✓ Gemini Image/);

		// Settings tab: toggle "Save outside project" (4th field) without losing the model choice.
		studio.handleInput?.(KEY_SEQ.right);
		const settings = await waitForText(studio, "[Settings]");
		expect(settings).toContain(path.join(".omp", "img-pi.json"));
		for (let i = 0; i < 4; i++) {
			studio.handleInput?.(KEY_SEQ.down);
		}
		studio.handleInput?.(KEY_SEQ.enter);
		await waitForText(studio, "Save outside project: on");
		const afterSetting: unknown = JSON.parse(await fs.readFile(projectFile, "utf8"));
		expect(afterSetting).toMatchObject({
			defaults: { model: GOOGLE_IMAGE_MODEL.id },
			output: { allowOutsideCwd: true },
		});
		expect(configStore.getEffective().output.allowOutsideCwd).toBe(true);

		// Gallery tab: empty manifest explains how images appear.
		studio.handleInput?.(KEY_SEQ.right);
		expect(await waitForText(studio, "ask the agent to draw")).toContain("[Gallery]");

		studio.handleInput?.(KEY_SEQ.escape);
		await closed;
		await running;
	});

	test("gallery lists generated images newest first with an inline host preview", async () => {
		const agentDir = path.join(tmpDir, "agent3");
		const cwd = await fs.mkdtemp(path.join(tmpDir, "proj-"));
		const host = new FakeHost(agentDir);
		const configStore = new ConfigStore({ agentDir, cwd, projectDirName: ".omp" });
		const stats = new DurationStatsStore(agentDir);
		const deps = {
			host,
			config: configStore.getEffective(),
			pool,
			http: new HttpClient(),
			registry: new ProviderRegistry(),
			manifest: new ManifestStore(),
			queue: new JobQueue(configStore.getEffective()),
			stats,
		};
		const getPipelineDeps = (hostCtx: PortableCtx): PipelineDeps => ({ ...deps, hostCtx });
		const gen = createImgGenerateTool({
			getPipelineDeps,
			ticker: new SharedTicker(80),
			stats,
			imageComponent: host.imageComponent,
			previewOptions: () => undefined,
		});
		const printCtx = wrapPortableCtx({ cwd, mode: "print" });
		for (const prompt of ["first cat", "second cat"]) {
			const res = await gen.execute(prompt, { prompt }, undefined, undefined, printCtx);
			expect(res.isError).toBe(false);
		}
		await deps.manifest.flush();

		const { ctx, opened, closed } = overlayCtx(cwd);
		const running = createImgCommand({ host, configStore, getPipelineDeps }).handler("", ctx);
		const studio = await opened;
		await waitForText(studio, "Gemini Image");
		studio.handleInput?.(KEY_SEQ.left);
		const gallery = await waitForText(studio, "[image]");
		expect(gallery).toContain("[Gallery]");
		expect(gallery.indexOf("second cat")).toBeLessThan(gallery.indexOf("first cat"));
		expect(gallery).toContain(".pi/img/images/");
		expect(gallery.trimEnd().endsWith("[image]")).toBe(true);

		studio.handleInput?.(KEY_SEQ.escape);
		await closed;
		await running;
	});

	test("outside the TUI it explains where the config files are instead of opening", async () => {
		const notices: string[] = [];
		const agentDir = path.join(tmpDir, "agent2");
		const host = new FakeHost(agentDir);
		const configStore = new ConfigStore({ agentDir, cwd: tmpDir, projectDirName: ".pi" });
		const command = createImgCommand({
			host,
			configStore,
			getPipelineDeps: () => {
				throw new Error("must not be called");
			},
		});
		await command.handler(
			"",
			wrapPortableCtx({ cwd: tmpDir, mode: "print", ui: { notify: (m: string) => notices.push(m) } }),
		);
		expect(notices[0]).toContain("img-pi.json");
	});
});

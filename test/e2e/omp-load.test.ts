import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ComponentLike } from "../../src/host/port.js";
import imgPiExtension from "../../src/index.js";

interface RegisteredTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<{
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: unknown;
		readonly isError?: boolean;
	}>;
	readonly renderCall?: (args: unknown, options: unknown, theme: unknown) => ComponentLike;
	readonly renderResult?: (result: unknown, options: unknown, theme: unknown, args?: unknown) => ComponentLike;
}

describe("e2e: omp host harness", () => {
	let tmpDir = "";

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-omp-e2e-"));
	});

	afterAll(async () => {
		if (tmpDir.length > 0) {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("loads on omp ExtensionAPI, registers tools/commands/flags/shortcuts, runs jobs, and shuts down cleanly", async () => {
		const tools = new Map<string, RegisteredTool>();
		const commands = new Map<
			string,
			{ readonly description: string; readonly handler: (args: string, ctx: unknown) => Promise<void> }
		>();
		const shortcuts = new Map<
			string,
			{ readonly description: string; readonly handler: (ctx: unknown) => Promise<void> }
		>();
		const flags = new Map<string, unknown>();
		const listeners = new Map<string, ((...args: readonly unknown[]) => unknown)[]>();

		const ompApi = {
			arktype: {},
			zod: {},
			logger: {
				error: (_msg: string, _err?: unknown) => undefined,
			},
			registerTool(def: RegisteredTool): void {
				tools.set(def.name, def);
			},
			registerCommand(
				name: string,
				spec: { readonly description: string; readonly handler: (args: string, ctx: unknown) => Promise<void> },
			): void {
				commands.set(name, spec);
			},
			registerShortcut(
				key: string,
				spec: { readonly description: string; readonly handler: (ctx: unknown) => Promise<void> },
			): void {
				shortcuts.set(key, spec);
			},
			registerFlag(name: string, spec: unknown): void {
				flags.set(name, spec);
			},
			getFlag(_name: string): string | undefined {
				return undefined;
			},
			on(event: string, handler: (...args: readonly unknown[]) => unknown): void {
				const list = listeners.get(event) ?? [];
				list.push(handler);
				listeners.set(event, list);
			},
		};

		const wired = imgPiExtension(ompApi);
		expect(wired).toBeDefined();
		expect(wired?.host.kind).toBe("omp");

		// Verify all 6 tools
		expect(tools.has("img_generate")).toBe(true);
		expect(tools.has("img_edit")).toBe(true);
		expect(tools.has("img_texture")).toBe(true);
		expect(tools.has("img_variations")).toBe(true);
		expect(tools.has("img_list_models")).toBe(true);
		expect(tools.has("img_describe_job")).toBe(true);

		// Verify all 5 commands
		expect(commands.has("img")).toBe(true);
		expect(commands.has("img:settings")).toBe(true);
		expect(commands.has("img:gallery")).toBe(true);
		expect(commands.has("img:queue")).toBe(true);
		expect(commands.has("img:model")).toBe(true);

		// Verify shortcut and flag
		expect(shortcuts.has("ctrl+alt+i")).toBe(true);
		expect(flags.has("img-model")).toBe(true);

		const statusUpdates: (string | undefined)[] = [];
		const ompCtx = {
			cwd: tmpDir,
			mode: "tui",
			hasUI: true,
			ui: {
				notify: (_m: string) => undefined,
				setStatus: (_k: string, text: string | undefined) => {
					statusUpdates.push(text);
				},
				setWidget: (_k: string, _lines: readonly string[] | undefined) => undefined,
				confirm: () => Promise.resolve(false),
				select: () => Promise.resolve("mock/solid"),
			},
		};

		// Trigger session_start
		for (const fn of listeners.get("session_start") ?? []) {
			await fn({}, ompCtx);
		}
		expect(statusUpdates.length).toBeGreaterThan(0);

		// Test omp 3-arg renderCall and 4-arg renderResult signature
		const genTool = tools.get("img_generate");
		const mockTheme = {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => `**${t}**`,
		};
		const callCard = genTool?.renderCall?.(
			{ prompt: "omp render test", width: 256, height: 256 },
			{ expanded: false, isPartial: false },
			mockTheme,
		);
		expect(callCard?.render(80).join("\n")).toContain("omp render test");

		const genResult = await genTool?.execute(
			"omp-call-1",
			{
				prompt: "omp e2e sample",
				model: "mock/solid",
				width: 128,
				height: 128,
				seed: 7,
			},
			undefined,
			undefined,
			ompCtx,
		);
		expect(genResult?.isError).toBe(false);

		const resCard = genTool?.renderResult?.(genResult, { expanded: true, isPartial: false }, mockTheme, {
			prompt: "omp e2e sample",
		});
		expect(resCard?.render(80).join("\n")).toContain("mock/solid");

		// Test /img:model command handler
		const modelCmd = commands.get("img:model");
		await modelCmd?.handler("mock/solid", ompCtx);
		expect(wired?.configStore.getEffective().defaults.model).toBe("mock/solid");

		// Trigger session_shutdown
		for (const fn of listeners.get("session_shutdown") ?? []) {
			await fn();
		}
		expect(wired?.ticker.isRunning).toBe(false);
	});

	test("event-loop responsiveness: p99 delay stays < 20 ms during a 32-job batch", async () => {
		const tools = new Map<string, RegisteredTool>();
		const ompApi = {
			arktype: {},
			registerTool(def: RegisteredTool): void {
				tools.set(def.name, def);
			},
			registerCommand(): void {
				// no-op
			},
			registerShortcut(): void {
				// no-op
			},
			registerFlag(): void {
				// no-op
			},
			on(): void {
				// no-op
			},
		};

		const wired = imgPiExtension(ompApi);
		const varTool = tools.get("img_variations");
		expect(varTool).toBeDefined();

		const delaysMs: number[] = [];
		const intervalMs = 5;
		let expectedNext = performance.now() + intervalMs;
		const timer = setInterval(() => {
			const now = performance.now();
			const drift = Math.max(0, now - expectedNext);
			delaysMs.push(drift);
			expectedNext = now + intervalMs;
		}, intervalMs);

		try {
			const seeds = Array.from({ length: 32 }, (_, i) => i + 1);
			const res = await varTool?.execute(
				"perf-32",
				{
					base: {
						prompt: "perf batch item",
						model: "mock/solid",
						width: 128,
						height: 128,
						return_image: "none",
					},
					vary: { seeds },
					mode: "cartesian",
				},
				undefined,
				undefined,
				{ cwd: tmpDir, mode: "print", hasUI: false, ui: {} },
			);
			expect(res?.isError).toBe(false);
		} finally {
			clearInterval(timer);
			await wired?.shutdown();
		}

		if (delaysMs.length > 0) {
			const sorted = [...delaysMs].sort((a, b) => a - b);
			const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
			const p99 = sorted[p99Idx] ?? 0;
			expect(p99).toBeLessThan(20);
		}
	});
});

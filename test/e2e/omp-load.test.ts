import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ComponentLike } from "../../src/host/port.js";
import { generateCalls, installOmpAiStub } from "../fixtures/omp-ai-stub.js";

installOmpAiStub();
const { default: imgPiExtension } = await import("../../src/index.js");

interface RegisteredTool {
	readonly name: string;
	readonly loadMode?: string;
	readonly approval?: string;
	readonly execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: unknown) => void) | undefined,
		ctx: unknown,
	) => Promise<{
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: { readonly model?: string; readonly artifacts?: readonly { readonly path: string }[] };
		readonly isError?: boolean;
	}>;
	readonly renderCall?: (args: unknown, options: unknown, theme: unknown) => ComponentLike;
	readonly renderResult?: (result: unknown, options: unknown, theme: unknown, args?: unknown) => ComponentLike;
}

const GOOGLE_IMAGE = {
	id: "gemini-image",
	name: "Gemini Image",
	provider: "google",
	api: "google-generative-ai",
	kind: "image",
	input: ["text", "image"],
};
const GOOGLE_CHAT = { id: "gemini-pro", name: "Gemini Pro", provider: "google", api: "google-generative-ai" };

/** A session whose only connection is Google: no OpenAI anywhere. */
const googleOnlyRegistry = {
	getAvailable: (kind?: string): unknown[] => (kind === "all" ? [GOOGLE_CHAT, GOOGLE_IMAGE] : [GOOGLE_CHAT]),
	getApiKey: () => Promise.resolve("google-key"),
	resolver: () => "google-resolver",
	resolveModelHeaders: () => Promise.resolve(undefined),
};

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function createOmpApi(): {
	readonly api: Record<string, unknown>;
	readonly tools: Map<string, RegisteredTool>;
	readonly commands: string[];
	readonly listeners: Map<string, ((...args: readonly unknown[]) => unknown)[]>;
	readonly activeTools: { value: string[] };
} {
	const tools = new Map<string, RegisteredTool>();
	const commands: string[] = [];
	const listeners = new Map<string, ((...args: readonly unknown[]) => unknown)[]>();
	const activeTools = { value: ["read", "generate_image", "bash"] };
	const api = {
		arktype: {},
		logger: { error: () => undefined },
		registerTool: (def: RegisteredTool) => tools.set(def.name, def),
		registerCommand: (name: string) => commands.push(name),
		registerShortcut: (key: string) => commands.push(key),
		registerFlag: () => undefined,
		getFlag: () => undefined,
		getActiveTools: () => activeTools.value,
		setActiveTools: (next: string[]) => {
			activeTools.value = next;
		},
		on: (event: string, handler: (...args: readonly unknown[]) => unknown) => {
			listeners.set(event, [...(listeners.get(event) ?? []), handler]);
		},
	};
	return { api, tools, commands, listeners, activeTools };
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

	test("'draw me a cat': agent-visible tools, host model, .pi/img output, inline host image", async () => {
		const { api, tools, commands, listeners, activeTools } = createOmpApi();
		const wired = imgPiExtension(api);
		expect(wired?.host.kind).toBe("omp");

		// The agent sees the image tools at top level; nothing for the user to invoke.
		expect(tools.get("img_generate")).toMatchObject({ loadMode: "essential", approval: "write" });
		expect(tools.get("img_edit")).toMatchObject({ loadMode: "essential", approval: "write" });
		expect(tools.get("img_list_models")?.loadMode).toBeUndefined();
		expect(commands).toEqual([]);

		const statusUpdates: (string | undefined)[] = [];
		const ctx = {
			cwd: tmpDir,
			mode: "tui",
			hasUI: true,
			sessionId: "e2e-session",
			model: { provider: "google", id: "gemini-pro" },
			modelRegistry: googleOnlyRegistry,
			ui: {
				notify: () => undefined,
				setStatus: (_k: string, text: string | undefined) => statusUpdates.push(text),
				setWidget: () => undefined,
			},
		};
		for (const fn of listeners.get("session_start") ?? []) {
			await fn({}, ctx);
		}
		await Bun.sleep(0);
		expect(activeTools.value).toEqual(["read", "bash"]);
		expect(statusUpdates.at(-1)).toBe("img:Gemini Image");

		generateCalls.length = 0;
		const genTool = tools.get("img_generate");
		const res = await genTool?.execute("omp-cat", { prompt: "a fluffy ginger cat" }, undefined, undefined, ctx);
		expect(res?.isError).toBe(false);
		expect(res?.details?.model).toBe("google/gemini-image");
		expect(generateCalls[0]?.model["id"]).toBe("gemini-image");
		expect(generateCalls[0]?.options["apiKey"]).toBe("google-resolver");

		const saved = res?.details?.artifacts?.[0]?.path ?? "";
		expect(path.relative(await fs.realpath(tmpDir), saved).startsWith(path.join(".pi", "img", "images"))).toBe(true);
		expect((await fs.stat(saved)).size).toBeGreaterThan(0);
		expect((await fs.readFile(path.join(tmpDir, ".pi/img/manifest.jsonl"), "utf8")).length).toBeGreaterThan(0);

		const card = genTool?.renderResult?.(res, { expanded: false, isPartial: false }, theme, {
			prompt: "a fluffy ginger cat",
		});
		expect(card?.render(80).at(-1)).toBe("[[host image]]");

		const listRes = await tools.get("img_list_models")?.execute("omp-list", {}, undefined, undefined, ctx);
		const listText = listRes?.content[0]?.text ?? "";
		expect(listText).toContain("google/gemini-image");
		expect(listText).not.toContain("openai");

		for (const fn of listeners.get("session_shutdown") ?? []) {
			await fn();
		}
		expect(wired?.ticker.isRunning).toBe(false);
	});

	test("event-loop responsiveness: p99 delay stays < 20 ms during a 32-job batch", async () => {
		const { api, tools } = createOmpApi();
		const wired = imgPiExtension(api);
		const varTool = tools.get("img_variations");
		expect(varTool).toBeDefined();

		const delaysMs: number[] = [];
		const intervalMs = 5;
		let expectedNext = performance.now() + intervalMs;
		const timer = setInterval(() => {
			const now = performance.now();
			delaysMs.push(Math.max(0, now - expectedNext));
			expectedNext = now + intervalMs;
		}, intervalMs);

		try {
			const res = await varTool?.execute(
				"perf-32",
				{
					base: { prompt: "perf batch item", width: 128, height: 128, return_image: "none" },
					vary: { seeds: Array.from({ length: 32 }, (_, i) => i + 1) },
					mode: "cartesian",
				},
				undefined,
				undefined,
				{ cwd: tmpDir, mode: "print", hasUI: false, ui: {}, modelRegistry: googleOnlyRegistry },
			);
			expect(res?.isError).toBe(false);
		} finally {
			clearInterval(timer);
			await wired?.shutdown();
		}

		const sorted = [...delaysMs].sort((a, b) => a - b);
		const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
		expect(p99).toBeLessThan(20);
	});
});

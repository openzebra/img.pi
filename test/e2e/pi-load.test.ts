import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ComponentLike } from "../../src/host/port.js";
import imgPiExtension from "../../src/index.js";

interface PiRegisteredTool {
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
	readonly renderCall?: (args: unknown, theme: unknown, context: unknown) => ComponentLike;
	readonly renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => ComponentLike;
}

describe("e2e: pi host harness", () => {
	let tmpDir = "";

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-pi-e2e-"));
	});

	afterAll(async () => {
		if (tmpDir.length > 0) {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("loads on pi ExtensionAPI, normalizes pi renderCall/renderResult signatures, and executes tools", async () => {
		const tools = new Map<string, PiRegisteredTool>();
		const commands = new Map<string, unknown>();
		const listeners = new Map<string, ((...args: readonly unknown[]) => unknown)[]>();

		// pi exposes typebox without arktype/zod/logger
		const piApi = {
			typebox: {},
			registerTool(def: PiRegisteredTool): void {
				tools.set(def.name, def);
			},
			registerCommand(name: string, spec: unknown): void {
				commands.set(name, spec);
			},
			registerShortcut(): void {
				// no-op
			},
			registerFlag(): void {
				// no-op
			},
			on(event: string, handler: (...args: readonly unknown[]) => unknown): void {
				const list = listeners.get(event) ?? [];
				list.push(handler);
				listeners.set(event, list);
			},
		};

		const wired = imgPiExtension(piApi);
		expect(wired).toBeDefined();
		expect(wired?.host.kind).toBe("pi");
		expect(wired?.host.projectDirName).toBe(".pi");

		expect(tools.size).toBe(6);
		expect(commands.size).toBe(5);

		const piCtx = {
			cwd: tmpDir,
			mode: "print",
			hasUI: false,
			ui: {
				notify: (_m: string) => undefined,
				setStatus: () => undefined,
				setWidget: () => undefined,
			},
		};

		for (const fn of listeners.get("session_start") ?? []) {
			await fn({}, piCtx);
		}

		// Verify pi's renderCall(args, theme, context) signature (theme is 2nd arg!)
		const genTool = tools.get("img_generate");
		const mockTheme = {
			fg: (_c: string, t: string) => `<${t}>`,
			bold: (t: string) => `[${t}]`,
		};
		const callCard = genTool?.renderCall?.({ prompt: "pi signature check" }, mockTheme, { toolCallId: "pi-1" });
		const callRendered = callCard?.render(80).join("\n") ?? "";
		expect(callRendered).toContain("pi signature check");
		expect(callRendered).toContain("[img_generate]");

		const res = await genTool?.execute(
			"pi-call-1",
			{
				prompt: "pi generated sphere",
				model: "mock/solid",
				width: 128,
				height: 128,
			},
			undefined,
			undefined,
			piCtx,
		);
		expect(res?.isError).toBe(false);

		// Verify pi's renderResult(result, options, theme, context) signature
		const resCard = genTool?.renderResult?.(res, { expanded: false, isPartial: false }, mockTheme, {
			args: { prompt: "pi generated sphere" },
		});
		expect(resCard?.render(80).join("\n")).toContain("solid · 128×128");

		const expandedCard = genTool?.renderResult?.(res, { expanded: true, isPartial: false }, mockTheme, {
			args: { prompt: "pi generated sphere" },
		});
		expect(expandedCard?.render(80).join("\n")).toContain("mock/solid");

		for (const fn of listeners.get("session_shutdown") ?? []) {
			await fn();
		}
	});
});

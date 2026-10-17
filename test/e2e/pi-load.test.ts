import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ComponentLike } from "../../src/host/port.js";
import imgPiExtension from "../../src/index.js";
import { STUB_PNG_B64 } from "../fixtures/omp-ai-stub.js";

interface PiRegisteredTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
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

	test("loads on pi: tools listed in the prompt, host image models, pi renderer signatures", async () => {
		const tools = new Map<string, PiRegisteredTool>();
		const commands: string[] = [];
		const listeners = new Map<string, ((...args: readonly unknown[]) => unknown)[]>();
		const piApi = {
			typebox: {},
			registerTool: (def: PiRegisteredTool) => tools.set(def.name, def),
			registerCommand: (name: string) => commands.push(name),
			registerShortcut: (key: string) => commands.push(key),
			registerFlag: () => undefined,
			on: (event: string, handler: (...args: readonly unknown[]) => unknown) => {
				listeners.set(event, [...(listeners.get(event) ?? []), handler]);
			},
		};

		const wired = imgPiExtension(piApi);
		expect(wired?.host.kind).toBe("pi");
		expect(tools.size).toBe(6);
		expect(commands).toEqual([]);
		expect(tools.get("img_generate")?.promptSnippet).toContain("img_generate");
		expect(tools.get("img_generate")?.promptGuidelines?.length).toBeGreaterThan(0);
		expect(tools.get("img_edit")?.promptSnippet).toContain("img_edit");

		const flux = { id: "flux", name: "FLUX", provider: "openrouter", input: ["text"] };
		const sentContexts: unknown[] = [];
		const piCtx = {
			cwd: tmpDir,
			mode: "print",
			hasUI: false,
			ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
			modelRegistry: {
				getAvailableOfType: (type: string) => Promise.resolve(type === "image" ? [flux] : []),
				getProviderDisplayName: () => "OpenRouter",
				generateImages: (_model: unknown, context: unknown) => {
					sentContexts.push(context);
					return Promise.resolve({
						stopReason: "stop",
						model: "flux",
						output: [{ type: "image", data: STUB_PNG_B64, mimeType: "image/png" }],
					});
				},
			},
		};
		for (const fn of listeners.get("session_start") ?? []) {
			await fn({}, piCtx);
		}

		// pi renderCall(args, theme, context): theme is the 2nd argument.
		const genTool = tools.get("img_generate");
		const mockTheme = { fg: (_c: string, t: string) => `<${t}>`, bold: (t: string) => `[${t}]` };
		const callRendered = genTool?.renderCall?.({ prompt: "pi signature check" }, mockTheme, {}).render(80).join("\n");
		expect(callRendered).toContain("pi signature check");
		expect(callRendered).toContain("[img_generate]");

		const res = await genTool?.execute("pi-cat", { prompt: "a sleepy cat" }, undefined, undefined, piCtx);
		expect(res?.isError).toBe(false);
		expect(JSON.stringify(sentContexts[0])).toContain("a sleepy cat");
		expect(JSON.stringify(sentContexts[0])).not.toContain('"type":"image"');
		const files = await fs.readdir(path.join(tmpDir, ".pi/img/images"));
		expect(files.some(f => f.endsWith(".png"))).toBe(true);

		// pi renderResult(result, options, theme, context)
		const resCard = genTool?.renderResult?.(res, { expanded: true, isPartial: false }, mockTheme, {
			args: { prompt: "a sleepy cat" },
		});
		expect(resCard?.render(80).join("\n")).toContain("openrouter/flux");

		for (const fn of listeners.get("session_shutdown") ?? []) {
			await fn();
		}
	});
});

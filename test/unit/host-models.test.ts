import { describe, expect, test } from "bun:test";
import { wrapPortableCtx } from "../../src/host/base.js";
import type { PortableTool } from "../../src/host/port.js";
import { generateCalls, installOmpAiStub } from "../fixtures/omp-ai-stub.js";

installOmpAiStub();

const { OmpHost } = await import("../../src/host/omp.js");
const { PiHost } = await import("../../src/host/pi.js");

const googleImage = {
	id: "gemini-image",
	name: "Gemini Image",
	provider: "google",
	api: "google-generative-ai",
	kind: "image",
	input: ["text", "image"],
};
const googleChat = { id: "gemini-pro", name: "Gemini Pro", provider: "google", api: "google-generative-ai" };
const unsupportedImage = { id: "video-1", provider: "google", api: "google-video", kind: "image", input: ["text"] };
const zaiImage = {
	id: "cogview",
	name: "CogView",
	provider: "zai",
	api: "openai-images",
	kind: "image",
	input: ["text"],
};

function ompCtx(
	registry: Record<string, unknown>,
	sessionModel?: Record<string, unknown>,
): ReturnType<typeof wrapPortableCtx> {
	return wrapPortableCtx({
		cwd: "/tmp",
		mode: "print",
		modelRegistry: registry,
		model: sessionModel,
		sessionId: "s1",
	});
}

function noopTool(): PortableTool<unknown, unknown> {
	return {
		name: "img_generate",
		label: "Generate",
		description: "d",
		parameters: {},
		essential: true,
		approval: "write",
		promptSnippet: "snippet",
		promptGuidelines: ["g"],
		execute: () => Promise.resolve({ content: [] }),
	};
}

describe("host adapters: models come from the host registry", () => {
	test("omp lists only available image models the host can generate with, session provider first", async () => {
		const kinds: unknown[] = [];
		const registry = {
			getAvailable: (kind: unknown): unknown[] => {
				kinds.push(kind);
				return [zaiImage, googleChat, unsupportedImage, googleImage];
			},
		};
		const host = new OmpHost({});
		const res = await host.nativeImageModels(ompCtx(registry, { provider: "google", id: "gemini-pro" }));
		expect(kinds).toEqual(["all"]);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.map(m => m.id)).toEqual(["google/gemini-image", "zai/cogview"]);
		expect(res.value[0]).toMatchObject({ label: "Gemini Image", acceptsImages: true });
		expect(res.value[1]?.acceptsImages).toBe(false);
	});

	test("omp with no image-capable connection lists nothing (no fallback tables, no env vars)", async () => {
		process.env["OPENAI_API_KEY"] = "sk-should-be-ignored";
		try {
			const res = await new OmpHost({}).nativeImageModels(ompCtx({ getAvailable: () => [googleChat] }));
			expect(res.ok ? res.value : ["error"]).toEqual([]);
		} finally {
			delete process.env["OPENAI_API_KEY"];
		}
	});

	test("omp generateNative authenticates through the registry and passes host request knobs", async () => {
		generateCalls.length = 0;
		const registry = {
			getAvailable: () => [googleImage],
			getApiKey: () => Promise.resolve("key-123"),
			resolver: () => "resolver-token",
			resolveModelHeaders: () => Promise.resolve({ "x-test": "1" }),
		};
		const host = new OmpHost({});
		const res = await host.generateNative(
			ompCtx(registry),
			{ model: "google/gemini-image", prompt: "a cat", aspectRatio: "3:2", imageSize: "2K" },
			new AbortController().signal,
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.value.reportedModel).toBe("gemini-image-v2");
			expect(res.value.usage).toEqual({ inputTokens: 10, outputTokens: 20, costUsd: 0.039 });
		}
		const call = generateCalls[0];
		expect(call?.request).toMatchObject({ prompt: "a cat", aspectRatio: "3:2", imageSize: "2K", count: 1 });
		expect(call?.options["apiKey"]).toBe("resolver-token");
		expect(typeof call?.model["resolveHeaders"]).toBe("function");

		const noAuth = await host.generateNative(
			ompCtx({ ...registry, getApiKey: () => Promise.resolve("N/A") }),
			{ model: "google/gemini-image", prompt: "a cat" },
			new AbortController().signal,
		);
		expect(noAuth.ok ? "ok" : noAuth.error.kind).toBe("no_api_key");

		const missing = await host.generateNative(
			ompCtx(registry),
			{ model: "openai/gpt-image-1", prompt: "a cat" },
			new AbortController().signal,
		);
		expect(missing.ok ? "ok" : missing.error.kind).toBe("model_not_found");
	});

	test("omp configuredImageModel uses the session model's imageModel swap", () => {
		const host = new OmpHost({});
		expect(host.configuredImageModel(ompCtx({}, { provider: "google", imageModel: "gemini-image" }))).toBe(
			"google/gemini-image",
		);
		expect(host.configuredImageModel(ompCtx({}, { provider: "google" }))).toBeUndefined();
	});

	test("pi lists getAvailableOfType('image') with host provider names, and generates via the registry", async () => {
		const types: unknown[] = [];
		const piImage = { id: "flux", name: "FLUX", provider: "openrouter", input: ["text"] };
		let sent: { model: unknown; context: unknown } | undefined;
		const registry = {
			getAvailableOfType: (type: unknown) => {
				types.push(type);
				return Promise.resolve([piImage]);
			},
			getProviderDisplayName: (p: string) => (p === "openrouter" ? "OpenRouter" : p),
			generateImages: (model: unknown, context: unknown) => {
				sent = { model, context };
				return Promise.resolve({
					stopReason: "stop",
					model: "flux",
					output: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
					usage: { cost: { total: 0.02 } },
				});
			},
		};
		const host = new PiHost({});
		const ctx = wrapPortableCtx({ cwd: "/tmp", mode: "print", modelRegistry: registry });
		const list = await host.nativeImageModels(ctx);
		expect(types).toEqual(["image"]);
		expect(list.ok ? list.value : []).toEqual([
			{
				id: "openrouter/flux",
				provider: "openrouter",
				providerLabel: "OpenRouter",
				label: "FLUX",
				acceptsImages: false,
				options: { aspectRatio: false, imageSize: false },
			},
		]);

		const gen = await host.generateNative(
			ctx,
			{ model: "openrouter/flux", prompt: "a cat" },
			new AbortController().signal,
		);
		expect(gen.ok ? gen.value.usage?.costUsd : "error").toBe(0.02);
		expect(sent?.model).toBe(piImage);
		expect(sent?.context).toEqual({ input: [{ type: "text", text: "a cat" }] });

		const failing = {
			...registry,
			generateImages: () => Promise.resolve({ stopReason: "error", errorMessage: "quota" }),
		};
		const failed = await host.generateNative(
			wrapPortableCtx({ cwd: "/tmp", modelRegistry: failing }),
			{ model: "openrouter/flux", prompt: "x" },
			new AbortController().signal,
		);
		expect(failed.ok ? "ok" : failed.error.kind).toBe("provider_http");
	});

	test("tool visibility: omp gets loadMode/approval, pi gets promptSnippet/guidelines", () => {
		const ompDefs: Record<string, unknown>[] = [];
		const piDefs: Record<string, unknown>[] = [];
		new OmpHost({ registerTool: (d: Record<string, unknown>) => ompDefs.push(d) }).registerTool(noopTool());
		new PiHost({ registerTool: (d: Record<string, unknown>) => piDefs.push(d) }).registerTool(noopTool());
		expect(ompDefs[0]).toMatchObject({ name: "img_generate", loadMode: "essential", approval: "write" });
		expect(ompDefs[0]?.["promptSnippet"]).toBeUndefined();
		expect(piDefs[0]).toMatchObject({ name: "img_generate", promptSnippet: "snippet", promptGuidelines: ["g"] });
		expect(piDefs[0]?.["loadMode"]).toBeUndefined();
	});
});

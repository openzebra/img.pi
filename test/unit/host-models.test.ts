import { describe, expect, test } from "bun:test";
import { wrapPortableCtx } from "../../src/host/base.js";
import type { PortableTool } from "../../src/host/port.js";
import { generateCalls, generateControl, installOmpAiStub, StubHttpError } from "../fixtures/omp-ai-stub.js";

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

	// Regression: every host HTTP failure surfaced as `internal`, hiding the status, and a quota cap read as retryable.
	test("omp maps host HTTP failures: quota cap → quota_exhausted, other 4xx → provider_http with status", async () => {
		const registry = { getAvailable: () => [googleImage], getApiKey: () => Promise.resolve("key-123") };
		const host = new OmpHost({});
		const run = async (): Promise<unknown> => {
			const res = await host.generateNative(
				ompCtx(registry),
				{ model: "google/gemini-image", prompt: "a cat" },
				new AbortController().signal,
			);
			return res.ok ? "ok" : res.error;
		};
		try {
			generateControl.failWith = new StubHttpError(
				"google/gemini-image image request failed (429): You have exhausted your capacity on this model.",
				429,
				new Headers({ "retry-after": "60" }),
			);
			expect(await run()).toMatchObject({
				kind: "quota_exhausted",
				provider: "google/gemini-image",
				status: 429,
				retryAfterMs: 60_000,
			});

			generateControl.failWith = new StubHttpError("bad request", 400);
			expect(await run()).toMatchObject({ kind: "provider_http", status: 400, retryable: false });

			generateControl.failWith = new Error("socket closed");
			expect(await run()).toMatchObject({ kind: "internal", message: "socket closed" });
		} finally {
			generateControl.failWith = undefined;
		}
	});

	test("omp hosted image models use the cheapest same-provider carrier and name it on failure", async () => {
		generateCalls.length = 0;
		const hostedImage = { id: "gpt-image-2", provider: "codex", api: "openai-codex-responses", kind: "image" };
		const pricey = {
			id: "big",
			provider: "codex",
			api: "openai-codex-responses",
			hostedImage: true,
			cost: { input: 5 },
		};
		const cheap = {
			id: "mini",
			provider: "codex",
			api: "openai-codex-responses",
			hostedImage: true,
			cost: { input: 1 },
		};
		const registry = {
			getAvailable: (kind?: unknown) => (kind === "all" ? [hostedImage] : [pricey, cheap]),
			getApiKey: () => Promise.resolve("key-123"),
		};
		const host = new OmpHost({});
		const req = { model: "codex/gpt-image-2", prompt: "a cat" };
		const okRes = await host.generateNative(ompCtx(registry), req, new AbortController().signal);
		expect(okRes.ok).toBe(true);
		expect(generateCalls[0]?.options["carrier"]).toMatchObject({ id: "mini" });

		generateControl.failWith = new StubHttpError("Tool choice 'image_generation' must be specified", 400);
		try {
			const failed = await host.generateNative(ompCtx(registry), req, new AbortController().signal);
			expect(failed.ok ? "ok" : failed.error).toMatchObject({ kind: "provider_http", via: "codex/mini" });
		} finally {
			generateControl.failWith = undefined;
		}
	});

	// Regression: omp pastes images as `local://pasted-image-*.png`; they were read as cwd-relative paths.
	test("omp resolves local:// against the session artifacts dir; other schemes stay unresolved", async () => {
		const host = new OmpHost({});
		const ctx = wrapPortableCtx({
			cwd: "/tmp",
			sessionManager: { getArtifactsDir: () => "/art", getSessionId: () => "s1" },
		});
		const res = await host.resolveHostUrl(ctx, "local://pasted-image-ab.png");
		expect(res.ok ? res.value : "error").toBe("/art/local/pasted-image-ab.png");
		const other = await host.resolveHostUrl(ctx, "skill://x.png");
		expect(other.ok ? other.value : "error").toBeUndefined();
		const pi = await new PiHost({}).resolveHostUrl(ctx, "local://pasted-image-ab.png");
		expect(pi.ok ? pi.value : "error").toBeUndefined();
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

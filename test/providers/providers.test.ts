import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type ImgConfig } from "../../src/config/schema.js";
import type { JobEvent } from "../../src/domain/job.js";
import { Size } from "../../src/domain/size.js";
import type { HostPort, PortableCtx } from "../../src/host/port.js";
import { A1111Provider } from "../../src/providers/a1111.js";
import { ComfyUIProvider } from "../../src/providers/comfyui.js";
import { FalProvider } from "../../src/providers/fal.js";
import { HttpClient } from "../../src/providers/http.js";
import { buildTinySeedPng, MockProvider } from "../../src/providers/mock.js";
import { SecretResolver, type ProviderCtx, type ProviderIO, type ResolvedJob } from "../../src/providers/port.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { ReplicateProvider } from "../../src/providers/replicate.js";
import { StabilityProvider } from "../../src/providers/stability.js";
import { WorkerPool } from "../../src/workers/pool.js";

function createStubHostPort(): HostPort {
	const noopComponent = {
		render: (): string[] => [],
		invalidate: (): void => undefined,
	};
	return {
		kind: "omp",
		agentDir: "/tmp/omp-agent",
		projectDirName: ".omp",
		registerTool: (): void => undefined,
		registerCommand: (): void => undefined,
		registerShortcut: (): void => undefined,
		registerFlag: (): void => undefined,
		getFlag: (): undefined => undefined,
		onSessionStart: (): void => undefined,
		onSessionShutdown: (): void => undefined,
		onToolCall: (): void => undefined,
		createImageBudget: (): undefined => undefined,
		hasGraphicsSupport: (): boolean => false,
		imageComponent: () => noopComponent,
		imageDims: (): undefined => undefined,
		configuredImageModel: (): string => "openai/gpt-image-1",
		nativeImageModels: () => [
			{
				id: "openai/gpt-image-1",
				provider: "openai",
				modelId: "gpt-image-1",
				label: "GPT Image 1",
				api: "openai-images",
				hasKey: true,
			},
		],
		generateNative: () =>
			Promise.resolve({
				ok: true,
				value: {
					images: [
						{
							data: Buffer.from(new Uint8Array(buildTinySeedPng(42, false))).toString("base64"),
							mimeType: "image/png",
						},
					],
					reportedModel: "gpt-image-1",
					usage: { inputTokens: 20, images: 1, costUsd: 0.04 },
				},
			}),
		logError: (): void => undefined,
	};
}

function createStubPortableCtx(): PortableCtx {
	return {
		cwd: "/tmp",
		mode: "tui",
		hasUI: true,
		ui: {
			select: () => Promise.resolve(undefined),
			confirm: () => Promise.resolve(true),
			input: () => Promise.resolve(undefined),
			notify: (): void => undefined,
			setStatus: (): void => undefined,
			setWorkingMessage: (): void => undefined,
			setWidget: (): void => undefined,
			custom: () => Promise.resolve(undefined),
		},
		raw: {},
	};
}

describe("providers/http, adapters, and registry", () => {
	let pool: WorkerPool;

	beforeAll(() => {
		pool = new WorkerPool({ size: 1 });
	});

	afterAll(async () => {
		await pool.terminate();
	});

	test("HttpClient retries on 429/500 with Retry-After, does not retry 400 or content_policy, and handles abort", async () => {
		const sleepDelays: number[] = [];
		let callCount = 0;

		const client = new HttpClient({
			fetchImpl: _input => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve(
						new Response("rate limited", {
							status: 429,
							headers: { "retry-after": "2" },
						}),
					);
				}
				if (callCount === 2) {
					return Promise.resolve(new Response("server error", { status: 503 }));
				}
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);
			},
			sleepImpl: ms => {
				sleepDelays.push(ms);
				return Promise.resolve();
			},
			baseDelayMs: 100,
		});

		const okRes = await client.requestJson({
			provider: "openai",
			url: "https://api.example.com/v1/images",
			method: "POST",
		});
		expect(okRes.ok).toBe(true);
		expect(callCount).toBe(3);
		expect(sleepDelays[0]).toBeGreaterThanOrEqual(2000);

		// Content policy 400 should not retry
		let policyCalls = 0;
		const policyClient = new HttpClient({
			fetchImpl: () => {
				policyCalls++;
				return Promise.resolve(
					new Response(
						JSON.stringify({ error: { code: "content_policy_violation", message: "blocked by safety_system" } }),
						{ status: 400 },
					),
				);
			},
			sleepImpl: () => Promise.resolve(),
		});
		const policyRes = await policyClient.requestJson({
			provider: "openai",
			url: "https://api.example.com/v1/images",
			method: "POST",
		});
		expect(policyRes.ok).toBe(false);
		expect(policyCalls).toBe(1);
		if (!policyRes.ok) {
			expect(policyRes.error.kind).toBe("content_policy");
		}

		// Abort mid-flight
		const ac = new AbortController();
		ac.abort();
		const abortRes = await policyClient.requestJson({
			provider: "openai",
			url: "https://api.example.com/v1/images",
			signal: ac.signal,
		});
		expect(abortRes.ok).toBe(false);
		if (!abortRes.ok) {
			expect(abortRes.error.kind).toBe("aborted");
		}

		// Reference URL validation: protocol and content-type
		const badProto = await client.fetchReferenceUrl("file:///etc/passwd");
		expect(badProto.ok).toBe(false);

		const badCtClient = new HttpClient({
			fetchImpl: () =>
				Promise.resolve(
					new Response("not an image", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
				),
		});
		const badCt = await badCtClient.fetchReferenceUrl("https://example.com/page.html");
		expect(badCt.ok).toBe(false);
		if (!badCt.ok) {
			expect(badCt.error.kind).toBe("ref_unreadable");
		}
	});

	test("fal, replicate, stability, comfyui, a1111, and mock adapters format requests and parse outputs", async () => {
		const samplePngBuf = buildTinySeedPng(777, false);
		const samplePngB64 = Buffer.from(new Uint8Array(samplePngBuf)).toString("base64");
		const recordedRequests: { readonly url: string; readonly method: string; readonly body?: unknown }[] = [];

		const stubHttp = new HttpClient({
			fetchImpl: (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				const method = init?.method ?? "GET";
				recordedRequests.push({ url, method, body: init?.body });

				// Fal queue endpoints
				if (url.startsWith("https://queue.fal.run/jobs/123/status")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								status: "COMPLETED",
								logs: [{ message: "Generating 75%" }],
							}),
							{ status: 200 },
						),
					);
				}
				if (url.startsWith("https://queue.fal.run/jobs/123/response")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								seed: 42,
								images: [{ url: "https://cdn.example.com/out.png", content_type: "image/png" }],
							}),
							{ status: 200 },
						),
					);
				}
				if (url.startsWith("https://queue.fal.run/")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								status_url: "https://queue.fal.run/jobs/123/status",
								response_url: "https://queue.fal.run/jobs/123/response",
							}),
							{ status: 200 },
						),
					);
				}

				// Replicate endpoints
				if (url.startsWith("https://api.replicate.com/v1/")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								id: "pred_1",
								status: "succeeded",
								logs: "step 10/10 100%",
								output: ["https://cdn.example.com/out.png"],
							}),
							{ status: 200 },
						),
					);
				}

				// Stability endpoint
				if (url.startsWith("https://api.stability.ai/v2beta/")) {
					return Promise.resolve(
						new Response(samplePngBuf.slice(0), {
							status: 200,
							headers: { "content-type": "image/png" },
						}),
					);
				}

				// ComfyUI endpoints
				if (url.endsWith("/prompt")) {
					return Promise.resolve(new Response(JSON.stringify({ prompt_id: "comfy_99" }), { status: 200 }));
				}
				if (url.includes("/history/comfy_99")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								comfy_99: {
									outputs: {
										"9": {
											images: [{ filename: "img_pi_001.png", subfolder: "", type: "output" }],
										},
									},
								},
							}),
							{ status: 200 },
						),
					);
				}
				if (url.includes("/view?")) {
					return Promise.resolve(
						new Response(samplePngBuf.slice(0), {
							status: 200,
							headers: { "content-type": "image/png" },
						}),
					);
				}

				// A1111 endpoints
				if (url.endsWith("/sdapi/v1/progress")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								progress: 0.5,
								state: { sampling_step: 12, sampling_steps: 24 },
								current_image: samplePngB64,
							}),
							{ status: 200 },
						),
					);
				}
				if (url.endsWith("/sdapi/v1/txt2img")) {
					return Promise.resolve(new Response(JSON.stringify({ images: [samplePngB64] }), { status: 200 }));
				}

				// CDN image download
				if (url === "https://cdn.example.com/out.png") {
					return Promise.resolve(
						new Response(samplePngBuf.slice(0), {
							status: 200,
							headers: { "content-type": "image/png" },
						}),
					);
				}

				return Promise.resolve(new Response("not found", { status: 404 }));
			},
			sleepImpl: () => Promise.resolve(),
			pool,
		});

		const secrets = new SecretResolver({
			FAL_KEY: "test-fal-key",
			REPLICATE_API_TOKEN: "test-rep-key",
			STABILITY_API_KEY: "test-stab-key",
		});

		const enabledConfig: ImgConfig = {
			...DEFAULT_CONFIG,
			providers: {
				...DEFAULT_CONFIG.providers,
				fal: { ...DEFAULT_CONFIG.providers.fal, enabled: true },
				replicate: { ...DEFAULT_CONFIG.providers.replicate, enabled: true },
				stability: { ...DEFAULT_CONFIG.providers.stability, enabled: true },
				comfyui: { ...DEFAULT_CONFIG.providers.comfyui, enabled: true },
				a1111: { ...DEFAULT_CONFIG.providers.a1111, enabled: true },
			},
		};

		const events: JobEvent[] = [];
		const io: ProviderIO = {
			signal: new AbortController().signal,
			emit: ev => events.push(ev),
			http: stubHttp,
			secrets,
			host: createStubHostPort(),
			hostCtx: createStubPortableCtx(),
			config: enabledConfig,
			pool,
		};

		const makeJob = (modelId: string, providerName: string): ResolvedJob => ({
			jobId: "01JXA9TEST",
			model: {
				id: modelId,
				provider: providerName,
				label: modelId,
				caps: new Set(),
				sizes: { kind: "any" },
				maxRefs: 4,
				maxCount: 4,
			},
			prompt: "rusty metal",
			finalPrompt: "rusty metal, high detail",
			size: new Size(512, 512),
			requestedSize: new Size(512, 512),
			aspectRatio: "1:1",
			count: 1,
			seed: 42,
			steps: 24,
			guidance: 4.0,
			quality: "auto",
			background: "auto",
			tileable: true,
			references: [],
		});

		const falRes = await new FalProvider().generate(makeJob("fal/flux-pro-v1.1", "fal"), io);
		expect(falRes.ok).toBe(true);
		if (falRes.ok) {
			expect(falRes.value.length).toBe(1);
			expect(falRes.value[0]?.buffer.byteLength).toBeGreaterThan(20);
		}

		const repRes = await new ReplicateProvider().generate(
			makeJob("replicate/black-forest-labs/flux-1.1-pro", "replicate"),
			io,
		);
		expect(repRes.ok).toBe(true);

		const stabRes = await new StabilityProvider().generate(makeJob("stability/sd3.5-large", "stability"), io);
		expect(stabRes.ok).toBe(true);

		const comfyRes = await new ComfyUIProvider().generate(makeJob("comfyui/sdxl-pbr", "comfyui"), io);
		expect(comfyRes.ok).toBe(true);

		const a1111Res = await new A1111Provider().generate(makeJob("a1111/default", "a1111"), io);
		expect(a1111Res.ok).toBe(true);

		const mockRes = await new MockProvider().generate(makeJob("mock/gradient", "mock"), io);
		expect(mockRes.ok).toBe(true);
		expect(events.some(e => e.t === "provider_progress")).toBe(true);
	});

	test("ProviderRegistry resolves exact id, aliases, defaults, and returns fuzzy suggestions on unknown models", async () => {
		const registry = new ProviderRegistry();
		const ctx: ProviderCtx = {
			host: createStubHostPort(),
			hostCtx: createStubPortableCtx(),
			config: DEFAULT_CONFIG,
			http: new HttpClient(),
			secrets: new SecretResolver({ FAL_KEY: "test-key" }),
		};

		// Alias "fast" -> "fal/flux-schnell"
		const fastRes = await registry.resolveModel("fast", ctx);
		expect(fastRes.ok).toBe(true);
		if (fastRes.ok) {
			expect(fastRes.value.model.id).toBe("fal/flux-schnell");
		}

		// Auto -> host configured "openai/gpt-image-1"
		const autoRes = await registry.resolveModel(undefined, ctx);
		expect(autoRes.ok).toBe(true);
		if (autoRes.ok) {
			expect(autoRes.value.model.id).toBe("openai/gpt-image-1");
		}

		// Typo -> model_not_found with Levenshtein suggestion
		const typoRes = await registry.resolveModel("openai/gpt-image-2", ctx);
		expect(typoRes.ok).toBe(false);
		if (!typoRes.ok && typoRes.error.kind === "model_not_found") {
			expect(typoRes.error.suggestions).toContain("openai/gpt-image-1");
		}
	});
});

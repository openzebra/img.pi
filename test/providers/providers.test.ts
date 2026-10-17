import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ImgConfig } from "../../src/config/schema.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { Size } from "../../src/domain/size.js";
import type { HostImageModel } from "../../src/host/port.js";
import { HostNativeProvider } from "../../src/providers/host-native.js";
import { HttpClient } from "../../src/providers/http.js";
import type { ProviderCtx, ProviderIO, ResolvedJob } from "../../src/providers/port.js";
import { IMG_MODEL_FLAG, ProviderRegistry } from "../../src/providers/registry.js";
import { WorkerPool } from "../../src/workers/pool.js";
import { FakeHost, fakeCtx, GOOGLE_IMAGE_MODEL, TEXT_ONLY_IMAGE_MODEL } from "../fixtures/fake-host.js";

const PI_STYLE_MODEL: HostImageModel = Object.freeze({
	id: "openrouter/flux",
	provider: "openrouter",
	providerLabel: "OpenRouter",
	label: "FLUX",
	acceptsImages: false,
	options: Object.freeze({ aspectRatio: false, imageSize: false }),
});

function providerCtx(host: FakeHost, config: ImgConfig = DEFAULT_CONFIG): ProviderCtx {
	return { host, hostCtx: fakeCtx("/tmp"), config };
}

function resolvedJob(model: ResolvedJob["model"], overrides: Partial<ResolvedJob> = {}): ResolvedJob {
	return {
		jobId: "job-1",
		model,
		prompt: "a cat",
		finalPrompt: "a cat, detailed",
		size: new Size(1024, 1024),
		requestedSize: new Size(1024, 1024),
		aspectRatio: "3:2",
		imageSize: "2K",
		count: 1,
		seed: 1,
		quality: "auto",
		background: "auto",
		references: [],
		...overrides,
	};
}

describe("providers: host-native mapping, registry resolution, reference fetch", () => {
	let pool: WorkerPool;

	beforeAll(() => {
		pool = new WorkerPool({ size: 1 });
	});

	afterAll(async () => {
		await pool.terminate();
	});

	test("HostNativeProvider derives caps from the host's input modalities, with no tables", async () => {
		const host = new FakeHost("/tmp/agent", [GOOGLE_IMAGE_MODEL, TEXT_ONLY_IMAGE_MODEL]);
		const res = await new HostNativeProvider().models(providerCtx(host));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const [editable, textOnly] = res.value;
		expect(editable?.caps.has("img2img")).toBe(true);
		expect(editable?.caps.has("multi_ref")).toBe(true);
		expect(textOnly?.caps.has("img2img")).toBe(false);
		expect(textOnly?.caps.has("txt2img")).toBe(true);
		expect(editable?.sizes.kind).toBe("any");
	});

	test("HostNativeProvider sends only the knobs the host transport honors", async () => {
		const host = new FakeHost("/tmp/agent", [GOOGLE_IMAGE_MODEL, PI_STYLE_MODEL]);
		host.costPerCallUsd = 0.039;
		const provider = new HostNativeProvider();
		const modelsRes = await provider.models(providerCtx(host));
		if (!modelsRes.ok) throw new Error("models failed");
		const [omp, pi] = modelsRes.value;
		if (omp === undefined || pi === undefined) throw new Error("missing models");

		const io: ProviderIO = {
			...providerCtx(host),
			signal: new AbortController().signal,
			emit: () => undefined,
			pool,
		};
		const ompRes = await provider.generate(resolvedJob(omp), io);
		const piRes = await provider.generate(resolvedJob(pi), io);
		expect(ompRes.ok && piRes.ok).toBe(true);

		expect(host.requests[0]).toMatchObject({ model: omp.id, aspectRatio: "3:2", imageSize: "2K" });
		expect(host.requests[1]?.aspectRatio).toBeUndefined();
		expect(host.requests[1]?.imageSize).toBeUndefined();
		if (ompRes.ok) {
			expect(ompRes.value[0]?.usage?.costUsd).toBe(0.039);
		}
	});

	test("ProviderRegistry resolution order: explicit > alias > flag > config default > host preference > first", async () => {
		const host = new FakeHost("/tmp/agent", [GOOGLE_IMAGE_MODEL, TEXT_ONLY_IMAGE_MODEL]);
		const registry = new ProviderRegistry();
		const pick = async (requested: string | undefined, config: ImgConfig = DEFAULT_CONFIG): Promise<string> => {
			const res = await registry.resolveModel(requested, providerCtx(host, config));
			return res.ok ? res.value.model.id : `error:${res.error.kind}`;
		};

		expect(await pick(undefined)).toBe(GOOGLE_IMAGE_MODEL.id);
		host.configured = TEXT_ONLY_IMAGE_MODEL.id;
		expect(await pick(undefined)).toBe(TEXT_ONLY_IMAGE_MODEL.id);
		expect(
			await pick(undefined, { ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults, model: "gemini-image" } }),
		).toBe(GOOGLE_IMAGE_MODEL.id);
		host.flags.set(IMG_MODEL_FLAG, GOOGLE_IMAGE_MODEL.id);
		expect(await pick(undefined)).toBe(GOOGLE_IMAGE_MODEL.id);
		expect(await pick("imagen")).toBe(TEXT_ONLY_IMAGE_MODEL.id);
		expect(await pick("quick", { ...DEFAULT_CONFIG, aliases: { quick: "google/imagen" } })).toBe(
			TEXT_ONLY_IMAGE_MODEL.id,
		);

		// A stale preference that no longer matches an available model falls through.
		host.flags.set(IMG_MODEL_FLAG, "openai/gpt-image-1");
		host.configured = undefined;
		expect(await pick(undefined)).toBe(GOOGLE_IMAGE_MODEL.id);
	});

	test("ProviderRegistry errors: no models → no_image_models; unknown model → suggestions from host models", async () => {
		const registry = new ProviderRegistry();
		const empty = await registry.resolveModel(undefined, providerCtx(new FakeHost("/tmp/agent", [])));
		expect(empty.ok ? "ok" : empty.error.kind).toBe("no_image_models");

		const typo = await registry.resolveModel("google/gemini-imag", providerCtx(new FakeHost("/tmp/agent")));
		expect(typo.ok).toBe(false);
		if (!typo.ok && typo.error.kind === "model_not_found") {
			expect(typo.error.suggestions).toContain(GOOGLE_IMAGE_MODEL.id);
		}

		const editCapable = await registry.listModels(
			providerCtx(new FakeHost("/tmp/agent", [GOOGLE_IMAGE_MODEL, TEXT_ONLY_IMAGE_MODEL])),
			{ capability: "img2img" },
		);
		expect(editCapable.ok ? editCapable.value.map(e => e.model.id) : []).toEqual([GOOGLE_IMAGE_MODEL.id]);
	});

	test("HttpClient.fetchReferenceUrl enforces http(s), image/* and the size cap", async () => {
		const badProto = await new HttpClient().fetchReferenceUrl("file:///etc/passwd");
		expect(badProto.ok ? "ok" : badProto.error.kind).toBe("ref_unreadable");

		const html = new HttpClient({
			fetchImpl: () => Promise.resolve(new Response("nope", { headers: { "content-type": "text/html" } })),
		});
		const badCt = await html.fetchReferenceUrl("https://example.com/page.html");
		expect(badCt.ok ? "ok" : badCt.error.kind).toBe("ref_unreadable");

		const huge = new HttpClient({
			fetchImpl: () =>
				Promise.resolve(
					new Response("x", {
						headers: { "content-type": "image/png", "content-length": String(60 * 1024 * 1024) },
					}),
				),
		});
		const tooBig = await huge.fetchReferenceUrl("https://example.com/big.png");
		expect(tooBig.ok ? "ok" : tooBig.error.kind).toBe("ref_unreadable");

		const png = new HttpClient({
			fetchImpl: () =>
				Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })),
		});
		const good = await png.fetchReferenceUrl("https://example.com/a.png");
		expect(good.ok ? good.value.mimeType : "error").toBe("image/png");
	});
});

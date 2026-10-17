import { describe, expect, test } from "bun:test";
import { abortedError, providerHttp } from "../../src/core/errors";
import { fuzzySuggest, levenshtein, newJobId, shortJobId, toSlug } from "../../src/core/ids";
import { Artifact, SIDECAR_SCHEMA_VERSION, type SidecarDocument } from "../../src/domain/artifact";
import { createInitialJobState, reduceJob } from "../../src/domain/job";
import { OutputSpec, validateTemplateTokens } from "../../src/domain/output";
import { parseJobRef, ReferenceImage } from "../../src/domain/reference";
import { GenerationRequest } from "../../src/domain/request";
import { parseAspectRatio, Size, type SizeRequest, type SizeRule, snapSize } from "../../src/domain/size";
import { TextureSpec } from "../../src/domain/texture";

const FIXED_OPENAI_RULE: SizeRule = {
	kind: "fixed",
	sizes: [new Size(1024, 1024), new Size(1536, 1024), new Size(1024, 1536)],
};

const MULTIPLE_16_RULE: SizeRule = {
	kind: "multiple",
	step: 16,
	min: 256,
	max: 2048,
};

const MULTIPLE_8_RULE: SizeRule = {
	kind: "multiple",
	step: 8,
	min: 64,
	max: 4096,
};

const ASPECTS_GEMINI_RULE: SizeRule = {
	kind: "aspects",
	aspects: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
	resolutions: ["1K", "2K"],
};

const RANGE_RULE: SizeRule = {
	kind: "range",
	min: 512,
	max: 1536,
};

const ANY_RULE: SizeRule = {
	kind: "any",
	min: 64,
	max: 8192,
};

interface SnapCase {
	readonly name: string;
	readonly req: SizeRequest;
	readonly rule: SizeRule;
	readonly expectedW: number;
	readonly expectedH: number;
	readonly exact: boolean;
}

const SNAP_CASES: readonly SnapCase[] = [
	// Fixed OpenAI rule (15 cases)
	{
		name: "fixed 1024x1024 exact",
		req: { width: 1024, height: 1024 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1024,
		exact: true,
	},
	{
		name: "fixed 1536x1024 exact",
		req: { width: 1536, height: 1024 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1536,
		expectedH: 1024,
		exact: true,
	},
	{
		name: "fixed 1024x1536 exact",
		req: { width: 1024, height: 1536 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1536,
		exact: true,
	},
	{
		name: "fixed 512x512 snaps to 1024x1024",
		req: { width: 512, height: 512 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "fixed 2048x2048 snaps to 1024x1024",
		req: { width: 2048, height: 2048 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "fixed 1920x1080 snaps to 1536x1024",
		req: { width: 1920, height: 1080 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1536,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "fixed 1080x1920 snaps to 1024x1536",
		req: { width: 1080, height: 1920 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1536,
		exact: false,
	},
	{
		name: "fixed 1080x1620 snaps to 1024x1536",
		req: { width: 1080, height: 1620 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1536,
		exact: false,
	},
	{
		name: "fixed 1620x1080 snaps to 1536x1024",
		req: { width: 1620, height: 1080 },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1536,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "fixed aspect 1:1 1K",
		req: { aspectRatio: "1:1", resolution: "1K" },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1024,
		exact: true,
	},
	{
		name: "fixed aspect 3:2 1K",
		req: { aspectRatio: "3:2", resolution: "1K" },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1536,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "fixed aspect 2:3 1K",
		req: { aspectRatio: "2:3", resolution: "1K" },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1536,
		exact: false,
	},
	{
		name: "fixed aspect 16:9 1K",
		req: { aspectRatio: "16:9", resolution: "1K" },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1536,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "fixed aspect 9:16 1K",
		req: { aspectRatio: "9:16", resolution: "1K" },
		rule: FIXED_OPENAI_RULE,
		expectedW: 1024,
		expectedH: 1536,
		exact: false,
	},
	{ name: "fixed default empty req", req: {}, rule: FIXED_OPENAI_RULE, expectedW: 1024, expectedH: 1024, exact: true },

	// Multiple of 16 rule (15 cases)
	{
		name: "mult16 1024x1024 exact",
		req: { width: 1024, height: 1024 },
		rule: MULTIPLE_16_RULE,
		expectedW: 1024,
		expectedH: 1024,
		exact: true,
	},
	{
		name: "mult16 1000x1000 rounds to 1008",
		req: { width: 1000, height: 1000 },
		rule: MULTIPLE_16_RULE,
		expectedW: 1008,
		expectedH: 1008,
		exact: false,
	},
	{
		name: "mult16 1001x1001 rounds to 1008",
		req: { width: 1001, height: 1001 },
		rule: MULTIPLE_16_RULE,
		expectedW: 1008,
		expectedH: 1008,
		exact: false,
	},
	{
		name: "mult16 995x995 rounds to 992",
		req: { width: 995, height: 995 },
		rule: MULTIPLE_16_RULE,
		expectedW: 992,
		expectedH: 992,
		exact: false,
	},
	{
		name: "mult16 128x128 clamps to 256",
		req: { width: 128, height: 128 },
		rule: MULTIPLE_16_RULE,
		expectedW: 256,
		expectedH: 256,
		exact: false,
	},
	{
		name: "mult16 64x64 clamps to 256",
		req: { width: 64, height: 64 },
		rule: MULTIPLE_16_RULE,
		expectedW: 256,
		expectedH: 256,
		exact: false,
	},
	{
		name: "mult16 3000x3000 clamps to 2048",
		req: { width: 3000, height: 3000 },
		rule: MULTIPLE_16_RULE,
		expectedW: 2048,
		expectedH: 2048,
		exact: false,
	},
	{
		name: "mult16 1920x1080 rounds height to 1088",
		req: { width: 1920, height: 1080 },
		rule: MULTIPLE_16_RULE,
		expectedW: 1920,
		expectedH: 1088,
		exact: false,
	},
	{
		name: "mult16 1280x720 exact",
		req: { width: 1280, height: 720 },
		rule: MULTIPLE_16_RULE,
		expectedW: 1280,
		expectedH: 720,
		exact: true,
	},
	{
		name: "mult16 768x512 exact",
		req: { width: 768, height: 512 },
		rule: MULTIPLE_16_RULE,
		expectedW: 768,
		expectedH: 512,
		exact: true,
	},
	{
		name: "mult16 512x768 exact",
		req: { width: 512, height: 768 },
		rule: MULTIPLE_16_RULE,
		expectedW: 512,
		expectedH: 768,
		exact: true,
	},
	{
		name: "mult16 width only 640",
		req: { width: 640 },
		rule: MULTIPLE_16_RULE,
		expectedW: 640,
		expectedH: 640,
		exact: true,
	},
	{
		name: "mult16 height only 800",
		req: { height: 800 },
		rule: MULTIPLE_16_RULE,
		expectedW: 800,
		expectedH: 800,
		exact: true,
	},
	{
		name: "mult16 width + aspect 16:9",
		req: { width: 1280, aspectRatio: "16:9" },
		rule: MULTIPLE_16_RULE,
		expectedW: 1280,
		expectedH: 720,
		exact: true,
	},
	{
		name: "mult16 height + aspect 4:3",
		req: { height: 768, aspectRatio: "4:3" },
		rule: MULTIPLE_16_RULE,
		expectedW: 1024,
		expectedH: 768,
		exact: true,
	},

	// Multiple of 8 rule (10 cases)
	{
		name: "mult8 64x64 exact",
		req: { width: 64, height: 64 },
		rule: MULTIPLE_8_RULE,
		expectedW: 64,
		expectedH: 64,
		exact: true,
	},
	{
		name: "mult8 70x70 rounds to 72",
		req: { width: 70, height: 70 },
		rule: MULTIPLE_8_RULE,
		expectedW: 72,
		expectedH: 72,
		exact: false,
	},
	{
		name: "mult8 66x66 rounds to 64",
		req: { width: 66, height: 66 },
		rule: MULTIPLE_8_RULE,
		expectedW: 64,
		expectedH: 64,
		exact: false,
	},
	{
		name: "mult8 1080x1080 exact",
		req: { width: 1080, height: 1080 },
		rule: MULTIPLE_8_RULE,
		expectedW: 1080,
		expectedH: 1080,
		exact: true,
	},
	{
		name: "mult8 4096x4096 exact",
		req: { width: 4096, height: 4096 },
		rule: MULTIPLE_8_RULE,
		expectedW: 4096,
		expectedH: 4096,
		exact: true,
	},
	{
		name: "mult8 5000x5000 clamps to 4096",
		req: { width: 5000, height: 5000 },
		rule: MULTIPLE_8_RULE,
		expectedW: 4096,
		expectedH: 4096,
		exact: false,
	},
	{
		name: "mult8 aspect 1:1 0.5K",
		req: { aspectRatio: "1:1", resolution: "0.5K" },
		rule: MULTIPLE_8_RULE,
		expectedW: 512,
		expectedH: 512,
		exact: true,
	},
	{
		name: "mult8 aspect 1:1 2K",
		req: { aspectRatio: "1:1", resolution: "2K" },
		rule: MULTIPLE_8_RULE,
		expectedW: 2048,
		expectedH: 2048,
		exact: true,
	},
	{
		name: "mult8 aspect 1:1 4K",
		req: { aspectRatio: "1:1", resolution: "4K" },
		rule: MULTIPLE_8_RULE,
		expectedW: 4096,
		expectedH: 4096,
		exact: true,
	},
	{
		name: "mult8 aspect 16:9 1K",
		req: { aspectRatio: "16:9", resolution: "1K" },
		rule: MULTIPLE_8_RULE,
		expectedW: 1024,
		expectedH: 576,
		exact: true,
	},

	// Aspects rule (10 cases)
	{
		name: "aspects 1:1 1K",
		req: { aspectRatio: "1:1", resolution: "1K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 1024,
		expectedH: 1024,
		exact: true,
	},
	{
		name: "aspects 16:9 1K",
		req: { aspectRatio: "16:9", resolution: "1K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 1024,
		expectedH: 576,
		exact: true,
	},
	{
		name: "aspects 9:16 1K",
		req: { aspectRatio: "9:16", resolution: "1K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 576,
		expectedH: 1024,
		exact: true,
	},
	{
		name: "aspects 4:3 1K",
		req: { aspectRatio: "4:3", resolution: "1K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 1024,
		expectedH: 768,
		exact: true,
	},
	{
		name: "aspects 3:4 1K",
		req: { aspectRatio: "3:4", resolution: "1K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 768,
		expectedH: 1024,
		exact: true,
	},
	{
		name: "aspects 1:1 2K",
		req: { aspectRatio: "1:1", resolution: "2K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 2048,
		expectedH: 2048,
		exact: true,
	},
	{
		name: "aspects 4:3 2K",
		req: { aspectRatio: "4:3", resolution: "2K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 2048,
		expectedH: 1536,
		exact: true,
	},
	{
		name: "aspects 0.5K snaps to 1K",
		req: { aspectRatio: "1:1", resolution: "0.5K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 1024,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "aspects 4K snaps to 2K",
		req: { aspectRatio: "1:1", resolution: "4K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 2048,
		expectedH: 2048,
		exact: false,
	},
	{
		name: "aspects 21:9 1K",
		req: { aspectRatio: "21:9", resolution: "1K" },
		rule: ASPECTS_GEMINI_RULE,
		expectedW: 1024,
		expectedH: 440,
		exact: true,
	},

	// Range and Any rules (12 cases)
	{
		name: "range 512x512 exact",
		req: { width: 512, height: 512 },
		rule: RANGE_RULE,
		expectedW: 512,
		expectedH: 512,
		exact: true,
	},
	{
		name: "range 1536x1536 exact",
		req: { width: 1536, height: 1536 },
		rule: RANGE_RULE,
		expectedW: 1536,
		expectedH: 1536,
		exact: true,
	},
	{
		name: "range 256x256 clamps to 512",
		req: { width: 256, height: 256 },
		rule: RANGE_RULE,
		expectedW: 512,
		expectedH: 512,
		exact: false,
	},
	{
		name: "range 2048x1024 clamps w to 1536",
		req: { width: 2048, height: 1024 },
		rule: RANGE_RULE,
		expectedW: 1536,
		expectedH: 1024,
		exact: false,
	},
	{
		name: "range 1024x2048 clamps h to 1536",
		req: { width: 1024, height: 2048 },
		rule: RANGE_RULE,
		expectedW: 1024,
		expectedH: 1536,
		exact: false,
	},
	{
		name: "range 777x888 exact",
		req: { width: 777, height: 888 },
		rule: RANGE_RULE,
		expectedW: 777,
		expectedH: 888,
		exact: true,
	},
	{
		name: "any 64x64 exact",
		req: { width: 64, height: 64 },
		rule: ANY_RULE,
		expectedW: 64,
		expectedH: 64,
		exact: true,
	},
	{
		name: "any 8192x8192 exact",
		req: { width: 8192, height: 8192 },
		rule: ANY_RULE,
		expectedW: 8192,
		expectedH: 8192,
		exact: true,
	},
	{
		name: "any 123x456 exact",
		req: { width: 123, height: 456 },
		rule: ANY_RULE,
		expectedW: 123,
		expectedH: 456,
		exact: true,
	},
	{
		name: "any 1920x1080 exact",
		req: { width: 1920, height: 1080 },
		rule: ANY_RULE,
		expectedW: 1920,
		expectedH: 1080,
		exact: true,
	},
	{
		name: "any 3840x2160 exact",
		req: { width: 3840, height: 2160 },
		rule: ANY_RULE,
		expectedW: 3840,
		expectedH: 2160,
		exact: true,
	},
	{
		name: "any 300x600 exact",
		req: { width: 300, height: 600 },
		rule: ANY_RULE,
		expectedW: 300,
		expectedH: 600,
		exact: true,
	},
];

describe("domain/size — 62 table-driven cases", () => {
	for (let i = 0; i < SNAP_CASES.length; i++) {
		const tc = SNAP_CASES[i];
		if (!tc) continue;
		test(`snap case #${i + 1}: ${tc.name}`, () => {
			const res = snapSize(tc.req, tc.rule);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.value.size.width).toBe(tc.expectedW);
			expect(res.value.size.height).toBe(tc.expectedH);
			expect(res.value.exact).toBe(tc.exact);
			if (!tc.exact) {
				expect(res.value.note).toContain("resized");
			} else {
				expect(res.value.note).toBeUndefined();
			}
		});
	}

	test("rejects out-of-bounds dimensions and malformed aspect ratios", () => {
		expect(Size.create(32, 1024).ok).toBe(false);
		expect(Size.create(1024, 9000).ok).toBe(false);
		expect(parseAspectRatio("invalid").ok).toBe(false);
		expect(parseAspectRatio("0:1").ok).toBe(false);
		expect(parseAspectRatio("16:-9").ok).toBe(false);
	});
});

describe("domain VOs — equals and hashCode", () => {
	test("Size equals and hashCode", () => {
		const a = new Size(1024, 1536);
		const b = new Size(1024, 1536);
		const c = new Size(1536, 1024);
		expect(a.equals(b)).toBe(true);
		expect(a.hashCode()).toBe(b.hashCode());
		expect(a.equals(c)).toBe(false);
		expect(a.hashCode()).not.toBe(c.hashCode());
	});

	test("ReferenceImage creation, job_ref parsing, equals, hashCode", () => {
		expect(parseJobRef("@last")).toEqual({ kind: "last", index: 1 });
		expect(parseJobRef("@last#3")).toEqual({ kind: "last", index: 3 });
		expect(parseJobRef("@job:01JXA9K3")).toEqual({ kind: "job", jobId: "01JXA9K3", index: 1 });
		expect(parseJobRef("@job:01JXA9K3#2")).toEqual({ kind: "job", jobId: "01JXA9K3", index: 2 });
		expect(parseJobRef("@job:")).toBeUndefined();

		const r1 = ReferenceImage.create({ source: "ref/panel.jpg", role: "style", weight: 0.8 });
		const r2 = ReferenceImage.create({ source: "ref/panel.jpg", role: "style", weight: 0.8 });
		const r3 = ReferenceImage.create({ source: "ref/panel.jpg", role: "content", weight: 0.8 });
		expect(r1.ok && r2.ok && r3.ok).toBe(true);
		if (!r1.ok || !r2.ok || !r3.ok) return;
		expect(r1.value.equals(r2.value)).toBe(true);
		expect(r1.value.hashCode()).toBe(r2.value.hashCode());
		expect(r1.value.equals(r3.value)).toBe(false);
	});

	test("OutputSpec and template validation", () => {
		expect(validateTemplateTokens("{date}_{slug}_{index}").ok).toBe(true);
		expect(validateTemplateTokens("{slug}/{slug}_{map}").ok).toBe(true);
		const bad = validateTemplateTokens("{date}_{unknown_token}");
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.error.kind).toBe("config_invalid");
		}

		const o1 = OutputSpec.create({
			dir: "generated/images",
			filenameTemplate: "{date}_{slug}_{index}",
			format: "png",
			compression: 90,
			onConflict: "suffix",
			returnImage: "thumbnail",
		});
		const o2 = OutputSpec.create({
			dir: "generated/images",
			filenameTemplate: "{date}_{slug}_{index}",
			format: "png",
			compression: 90,
			onConflict: "suffix",
			returnImage: "thumbnail",
		});
		expect(o1.ok && o2.ok).toBe(true);
		if (!o1.ok || !o2.ok) return;
		expect(o1.value.equals(o2.value)).toBe(true);
		expect(o1.value.hashCode()).toBe(o2.value.hashCode());
	});

	test("TextureSpec and GenerationRequest equals and hashCode", () => {
		const t1 = TextureSpec.create({ material: "mossy stone", resolution: 1024 });
		const t2 = TextureSpec.create({ material: "mossy stone", resolution: 1024 });
		expect(t1.ok && t2.ok).toBe(true);
		if (!t1.ok || !t2.ok) return;
		expect(t1.value.equals(t2.value)).toBe(true);
		expect(t1.value.hashCode()).toBe(t2.value.hashCode());

		const out = OutputSpec.create({
			dir: "generated/images",
			filenameTemplate: "{date}_{slug}_{index}",
			format: "png",
			compression: 90,
			onConflict: "suffix",
			returnImage: "thumbnail",
		});
		if (!out.ok) return;

		const req1 = GenerationRequest.create({
			prompt: "rusty metal panel",
			seed: 42,
			output: out.value,
			texture: t1.value,
		});
		const req2 = GenerationRequest.create({
			prompt: "rusty metal panel",
			seed: 42,
			output: out.value,
			texture: t2.value,
		});
		expect(req1.ok && req2.ok).toBe(true);
		if (!req1.ok || !req2.ok) return;
		expect(req1.value.equals(req2.value)).toBe(true);
		expect(req1.value.hashCode()).toBe(req2.value.hashCode());
	});
});

describe("domain/job — state machine reducer", () => {
	function makeDummyState() {
		const out = OutputSpec.create({
			dir: "generated/images",
			filenameTemplate: "{date}_{slug}_{index}",
			format: "png",
			compression: 90,
			onConflict: "suffix",
			returnImage: "thumbnail",
		});
		if (!out.ok) throw new Error("unexpected");
		const req = GenerationRequest.create({
			prompt: "test prompt",
			seed: 100,
			output: out.value,
		});
		if (!req.ok) throw new Error("unexpected");
		return createInitialJobState({
			id: "01JXA9K3TEST00000000000000",
			request: req.value,
			modelId: "openai/gpt-image-1",
			providerId: "host",
			requestedSize: new Size(1024, 1024),
			producedSize: new Size(1024, 1024),
			createdAt: 1000,
			queuePosition: 2,
		});
	}

	test("full happy path transitions and timing accumulation", () => {
		let state = makeDummyState();
		expect(state.phase).toBe("queued");
		expect(state.queuePosition).toBe(2);

		state = reduceJob(state, { t: "start", at: 1200 });
		expect(state.phase).toBe("preparing");
		expect(state.queuePosition).toBeUndefined();
		expect(state.timings.queued).toBe(200);

		state = reduceJob(state, { t: "phase", phase: "submitting", at: 1500, detail: "sending request" });
		expect(state.phase).toBe("submitting");
		expect(state.timings.preparing).toBe(300);

		state = reduceJob(state, { t: "phase", phase: "generating", at: 1700 });
		expect(state.phase).toBe("generating");
		expect(state.timings.submitting).toBe(200);

		state = reduceJob(state, { t: "provider_progress", fraction: 0.6, step: 18, steps: 30, at: 5000 });
		expect(state.providerProgress?.fraction).toBe(0.6);
		expect(state.providerProgress?.step).toBe(18);

		state = reduceJob(state, { t: "partial", index: 0, thumbB64: "AAAA", at: 5500 });
		expect(state.partials.length).toBe(1);

		state = reduceJob(state, { t: "phase", phase: "postprocess", at: 11700 });
		expect(state.timings.generating).toBe(10000);

		state = reduceJob(state, { t: "phase", phase: "saving", at: 12200 });
		expect(state.timings.postprocess).toBe(500);

		const sidecar: SidecarDocument = {
			schema: SIDECAR_SCHEMA_VERSION,
			job: state.id,
			index: 1,
			createdAt: "2025-06-11T14:02:11.233Z",
			host: "omp",
			provider: "openai",
			model: "gpt-image-1",
			reportedModel: "gpt-image-1",
			prompt: "test prompt",
			negativePrompt: null,
			style: null,
			finalPrompt: "test prompt",
			seed: 100,
			steps: null,
			guidance: null,
			quality: "auto",
			requestedSize: [1024, 1024],
			producedSize: [1024, 1024],
			post: [],
			references: [],
			sha256: "deadbeef",
			bytes: 1024,
			format: "png",
			path: "generated/images/out.png",
			usage: null,
			costUsd: null,
			texture: null,
			tags: [],
			metadata: {},
		};
		const artifact = new Artifact(
			{
				index: 1,
				path: "/tmp/out.png",
				relativePath: "generated/images/out.png",
				bytes: 1024,
				width: 1024,
				height: 1024,
				format: "png",
				sha256: "deadbeef",
			},
			sidecar,
		);
		state = reduceJob(state, { t: "artifact", artifact, at: 12400 });
		state = reduceJob(state, { t: "phase", phase: "done", at: 12500 });
		expect(state.phase).toBe("done");
		expect(state.finishedAt).toBe(12500);
		expect(state.timings.saving).toBe(300);
		expect(state.artifacts.length).toBe(1);

		// Terminal states ignore further events
		const afterDone = reduceJob(state, { t: "cancel", at: 13000 });
		expect(afterDone).toBe(state);
	});

	test("cancel and abort transitions", () => {
		const s1 = reduceJob(makeDummyState(), { t: "cancel", at: 1100 });
		expect(s1.phase).toBe("cancelled");

		const s2 = reduceJob(makeDummyState(), { t: "fail", error: abortedError(), at: 1100 });
		expect(s2.phase).toBe("cancelled");

		const s3 = reduceJob(makeDummyState(), {
			t: "fail",
			error: providerHttp("openai", 429, "rate limited", true),
			at: 1100,
		});
		expect(s3.phase).toBe("failed");
		expect(s3.error?.kind).toBe("provider_http");
	});
});

describe("core/ids — slug, ulid, levenshtein", () => {
	test("slugifies prompts cleanly", () => {
		expect(toSlug("Rusty corroded metal panel, rivets & scratches!")).toBe(
			"rusty-corroded-metal-panel-rivets-scratches",
		);
		expect(toSlug("   ")).toBe("image");
		expect(toSlug("a".repeat(100), 48).length).toBe(48);
	});

	test("fuzzySuggest finds close models", () => {
		const id = newJobId(1700000000000);
		expect(shortJobId(id).length).toBe(8);
		expect(levenshtein("flux-pro", "flux-por")).toBe(2);
		const suggestions = fuzzySuggest("flux-schnel", ["openai/gpt-image-1", "fal/flux-schnell", "fal/flux-dev"]);
		expect(suggestions).toContain("fal/flux-schnell");
	});
});

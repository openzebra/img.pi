import { mock } from "bun:test";
import * as path from "node:path";
import { buildTinySeedPng } from "./png.js";

export interface GenerateCall {
	readonly model: Record<string, unknown>;
	readonly request: Record<string, unknown>;
	readonly options: Record<string, unknown>;
}

/** Recorded `generateImage` calls; tests reset with `generateCalls.length = 0`. */
export const generateCalls: GenerateCall[] = [];

/** Set `failWith` to make the next `generateImage` calls reject with it (the host throws on HTTP failure). */
export const generateControl: { failWith: Error | undefined } = { failWith: undefined };

/** Stand-in for the host `ImageApiError` (oh-my-pi/packages/ai/src/error/classes.ts:18). */
export class StubHttpError extends Error {
	public readonly status: number;
	public readonly headers: Headers | undefined;
	public constructor(message: string, status: number, headers?: Headers) {
		super(message);
		this.name = "ImageApiError";
		this.status = status;
		this.headers = headers;
	}
}

/** Mirrors the host catalog's IMAGE_GENERATION_APIS (oh-my-pi/packages/catalog/src/types.ts:90). */
const OMP_IMAGE_APIS: ReadonlySet<string> = new Set([
	"openai-images",
	"openrouter-images",
	"google-generative-ai",
	"google-gemini-cli",
	"openai-responses",
	"openai-codex-responses",
]);

export const STUB_PNG_B64 = Buffer.from(buildTinySeedPng(5, false)).toString("base64");

/**
 * `@oh-my-pi/pi-ai` is a peer dependency that is not installed here. `mock.module` is
 * process-wide in bun, so every test file installs the same stub through this function.
 */
export function installOmpAiStub(): void {
	void mock.module("@oh-my-pi/pi-ai", () => ({
		NO_AUTH_SENTINEL: "N/A",
		isImageGenerationApi: (api: string): boolean => OMP_IMAGE_APIS.has(api),
		generateImage: (
			model: Record<string, unknown>,
			request: Record<string, unknown>,
			options: Record<string, unknown>,
		) => {
			generateCalls.push({ model, request, options });
			if (generateControl.failWith !== undefined) {
				return Promise.reject(generateControl.failWith);
			}
			return Promise.resolve({
				images: [{ data: STUB_PNG_B64, mimeType: "image/png" }],
				model: "gemini-image-v2",
				usage: { input: 10, output: 20, cost: { total: 0.039 } },
			});
		},
	}));
	// Simplified host classifiers: enough to tell a quota cap from a plain 4xx.
	void mock.module("@oh-my-pi/pi-ai/error", () => ({
		isUsageLimitOutcome: (status: number | undefined, message: string | undefined): boolean =>
			status === 429 && /quota|exhausted/i.test(message ?? ""),
		isTransientStatus: (status: number | undefined): boolean =>
			status !== undefined && (status === 408 || status === 429 || status >= 500),
	}));
	void mock.module("@oh-my-pi/pi-ai/utils/retry-after", () => ({
		getRetryAfterMsFromHeaders: (headers: unknown): number | undefined => {
			const value = headers instanceof Headers ? headers.get("retry-after") : null;
			return value !== null ? Number(value) * 1000 : undefined;
		},
	}));
	void mock.module("@oh-my-pi/pi-catalog/models", () => ({
		getEffectiveTokenCost: (cost: { readonly input: number }) => ({ input: cost.input }),
	}));
	void mock.module("@oh-my-pi/pi-coding-agent/internal-urls/local-protocol", () => ({
		resolveLocalUrlToPath: (input: string, options: { readonly getArtifactsDir?: () => string | null }): string =>
			path.join(options.getArtifactsDir?.() ?? "/tmp", "local", input.slice("local://".length)),
	}));
	void mock.module("@oh-my-pi/pi-tui", () => ({
		Image: class {
			public render(): string[] {
				return ["[[host image]]"];
			}
			public invalidate(): void {
				// Stub
			}
		},
	}));
}

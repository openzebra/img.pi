import { mock } from "bun:test";
import { buildTinySeedPng } from "./png.js";

export interface GenerateCall {
	readonly model: Record<string, unknown>;
	readonly request: Record<string, unknown>;
	readonly options: Record<string, unknown>;
}

/** Recorded `generateImage` calls; tests reset with `generateCalls.length = 0`. */
export const generateCalls: GenerateCall[] = [];

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
			return Promise.resolve({
				images: [{ data: STUB_PNG_B64, mimeType: "image/png" }],
				model: "gemini-image-v2",
				usage: { input: 10, output: 20, cost: { total: 0.039 } },
			});
		},
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

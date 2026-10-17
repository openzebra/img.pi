// Minimal structural declarations for host modules imported at runtime by src/host/*.
// Shapes mirror the host sources cited per item; keep them in sync when the host changes.

// oh-my-pi/packages/ai/src/index.ts → images/index.ts, images/types.ts, auth-retry.ts
declare module "@oh-my-pi/pi-ai" {
	export interface ImageInput {
		readonly data: string;
		readonly mimeType: string;
	}
	export interface ImageGenerationRequest {
		readonly prompt: string;
		readonly inputImages?: readonly ImageInput[];
		readonly aspectRatio?: string;
		readonly imageSize?: string;
		readonly count?: number;
	}
	export interface GeneratedImage {
		readonly data: string;
		readonly mimeType: string;
		readonly size?: string;
		readonly quality?: string;
	}
	export interface ImageGenerationResult {
		readonly images: readonly GeneratedImage[];
		readonly text?: string;
		readonly usage?: unknown;
		readonly model?: string;
	}
	export interface ImageGenerationOptions {
		/** `ApiKey = string | ApiKeyResolver` (auth-retry.ts:78). */
		readonly apiKey: unknown;
		readonly fetch?: unknown;
		readonly signal?: AbortSignal;
		readonly sessionId?: string;
		readonly carrier?: unknown;
	}
	export function generateImage(
		model: unknown,
		request: ImageGenerationRequest,
		options: ImageGenerationOptions,
	): Promise<ImageGenerationResult>;
	export function isImageGenerationApi(api: string): boolean;
	/** Keyless-provider credential marker (auth-retry.ts:81). */
	export const NO_AUTH_SENTINEL: string;
}

// oh-my-pi/packages/ai/src/error/rate-limit.ts:383, error/retryable.ts:20
declare module "@oh-my-pi/pi-ai/error" {
	export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean;
	export function isTransientStatus(status: number | undefined): boolean;
}

// oh-my-pi/packages/ai/src/utils/retry-after.ts:31 (`HeadersLike` = Headers | record | undefined)
declare module "@oh-my-pi/pi-ai/utils/retry-after" {
	export function getRetryAfterMsFromHeaders(headers: unknown): number | undefined;
}

// oh-my-pi/packages/catalog/src/models.ts:81
declare module "@oh-my-pi/pi-catalog/models" {
	export function getEffectiveTokenCost(cost: unknown, timestamp?: number): { readonly input: number };
}

// oh-my-pi/packages/coding-agent/src/internal-urls/local-protocol.ts:28,296
declare module "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol" {
	export interface LocalProtocolOptions {
		readonly getArtifactsDir?: () => string | null;
		readonly getSessionId?: () => string | null;
	}
	export function resolveLocalUrlToPath(input: string, options: LocalProtocolOptions): string;
}

// oh-my-pi/packages/tui/src/components/image.ts
declare module "@oh-my-pi/pi-tui" {
	export interface ImageTheme {
		readonly fallbackColor: (text: string) => string;
	}
	export interface ImageOptions {
		readonly maxWidthCells?: number;
		readonly maxHeightCells?: number;
		readonly filename?: string;
	}
	export class Image {
		public constructor(base64Data: string, mimeType: string, theme: ImageTheme, options?: ImageOptions);
		public render(width: number): string[];
		public invalidate(): void;
	}
	/** Normalized key id for raw terminal input (keys.ts `parseKey`). */
	export function parseKey(data: string): string | undefined;
}

// pi/packages/tui/src/components/image.ts
declare module "@earendil-works/pi-tui" {
	export interface ImageTheme {
		readonly fallbackColor: (text: string) => string;
	}
	export interface ImageOptions {
		readonly maxWidthCells?: number;
		readonly maxHeightCells?: number;
		readonly filename?: string;
	}
	export class Image {
		public constructor(base64Data: string, mimeType: string, theme: ImageTheme, options?: ImageOptions);
		public render(width: number): string[];
		public invalidate(): void;
	}
	/** Normalized key id for raw terminal input (keys.ts `parseKey`). */
	export function parseKey(data: string): string | undefined;
}

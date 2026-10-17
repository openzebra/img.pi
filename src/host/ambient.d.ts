declare module "@oh-my-pi/pi-ai/images" {
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
	export interface ImageGenerationUsage {
		readonly input?: number;
		readonly output?: number;
		readonly totalTokens?: number;
		readonly cost?: {
			readonly total?: number;
		};
	}
	export interface ImageGenerationResult {
		readonly images: readonly GeneratedImage[];
		readonly text?: string;
		readonly usage?: ImageGenerationUsage;
		readonly model?: string;
	}
	export interface ImageGenerationOptions {
		readonly apiKey: string;
		readonly signal?: AbortSignal;
		readonly sessionId?: string;
	}
	export function generateImage(
		model: unknown,
		request: ImageGenerationRequest,
		options: ImageGenerationOptions,
	): Promise<ImageGenerationResult>;
}

declare module "@oh-my-pi/pi-tui" {
	export class ImageBudget {
		public readonly maxBytes: number;
		public constructor(maxBytes: number, requestRender: () => void);
	}
	export interface ImageTheme {
		readonly fallbackColor?: (text: string) => string;
	}
	export interface ImageOptions {
		readonly maxWidthCells?: number;
		readonly maxHeightCells?: number;
		readonly filename?: string;
		readonly sourcePath?: string;
		readonly budget?: ImageBudget;
	}
	export interface ImageDimensions {
		readonly widthPx: number;
		readonly heightPx: number;
	}
	export class Image {
		public constructor(
			base64Data: string,
			mimeType: string,
			theme: ImageTheme,
			options?: ImageOptions,
			dimensions?: ImageDimensions,
		);
		public render(width: number): string[];
		public invalidate(): void;
	}
	export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | undefined;
	export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string;
	export function getCapabilities(): { readonly images?: string | null };
}

declare module "@earendil-works/pi-ai" {
	export type ImagesInputContent =
		| { readonly type: "text"; readonly text: string }
		| { readonly type: "image"; readonly data: string; readonly mimeType: string };
	export interface ImagesContext {
		readonly input: readonly ImagesInputContent[];
	}
	export type ImagesOutputContent =
		| { readonly type: "image"; readonly data: string; readonly mimeType: string }
		| { readonly type: "text"; readonly text: string };
	export interface AssistantImages {
		readonly api: string;
		readonly provider: string;
		readonly model: string;
		readonly output: readonly ImagesOutputContent[];
		readonly stopReason: "stop" | "error" | "aborted";
		readonly errorMessage?: string;
		readonly usage?: {
			readonly input?: number;
			readonly output?: number;
			readonly totalTokens?: number;
			readonly cost?: {
				readonly total?: number;
			};
		};
	}
	export interface ProviderImagesOptions {
		readonly apiKey?: string;
		readonly signal?: AbortSignal;
		readonly aspectRatio?: string;
		readonly size?: string;
		readonly n?: number;
	}
	export function generateImages(
		model: unknown,
		context: ImagesContext,
		options?: ProviderImagesOptions,
	): Promise<AssistantImages>;
	export const Models: {
		getModelOfType?(type: "image", provider: string, modelId: string): unknown;
		getModelsOfType?(type: "image"): readonly unknown[];
	};
}

declare module "@earendil-works/pi-tui" {
	export interface ImageTheme {
		readonly fallbackColor?: (text: string) => string;
	}
	export interface ImageOptions {
		readonly maxWidthCells?: number;
		readonly maxHeightCells?: number;
		readonly filename?: string;
	}
	export interface ImageDimensions {
		readonly widthPx: number;
		readonly heightPx: number;
	}
	export class Image {
		public constructor(
			base64Data: string,
			mimeType: string,
			theme: ImageTheme,
			options?: ImageOptions,
			dimensions?: ImageDimensions,
		);
		public render(width: number): string[];
		public invalidate(): void;
	}
	export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | undefined;
	export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string;
	export function getCapabilities(): { readonly images?: string | null };
}

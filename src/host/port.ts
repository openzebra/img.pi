import type { ImgError } from "../core/errors.js";
import type { Result } from "../core/result.js";

export type HostKind = "omp" | "pi";

export type HostRunMode = "tui" | "rpc" | "json" | "print";

export type ThemeColorToken = "accent" | "muted" | "success" | "warning" | "error" | "border" | "text" | "dim";

export interface PortableTheme {
	fg(color: ThemeColorToken, text: string): string;
	bold(text: string): string;
}

export interface ComponentLike {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
}

export interface TuiHandleLike {
	requestRender(): void;
}

/** Overlay sizing forwarded to the host `showOverlay` (both hosts share these fields). */
export interface OverlayOptionsLike {
	readonly width?: number | string;
	readonly maxHeight?: number | string;
}

export type CustomComponentFactory<T> = (
	tui: TuiHandleLike,
	theme: PortableTheme,
	done: (result: T) => void,
) => ComponentLike;

export interface PortableUIContext {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: readonly string[] | undefined): void;
	/** Shows a component as an overlay until it calls `done`; `undefined` when the host has no UI. */
	custom<T>(factory: CustomComponentFactory<T>, overlay?: OverlayOptionsLike): Promise<T | undefined>;
}

export interface PortableCtx {
	readonly cwd: string;
	readonly mode: HostRunMode;
	readonly hasUI: boolean;
	readonly sessionId?: string;
	readonly ui: PortableUIContext;
	readonly raw: unknown;
}

/**
 * Request knobs a host's image transport honors. A fact about the host API, never a
 * per-model guess: omp `ImageGenerationRequest` carries `aspectRatio`/`imageSize`;
 * pi `ImagesContext` carries only `input`.
 */
export interface HostImageOptions {
	readonly aspectRatio: boolean;
	readonly imageSize: boolean;
}

/** An image model the host reports as available (authenticated) in this session. */
export interface HostImageModel {
	/** `${provider}/${modelId}`, the host's canonical selector. */
	readonly id: string;
	readonly provider: string;
	readonly providerLabel: string;
	readonly label: string;
	/** Model accepts input images (edit / references), from the host's `input` modalities. */
	readonly acceptsImages: boolean;
	readonly options: HostImageOptions;
}

export interface NativeInputImage {
	readonly data: string;
	readonly mimeType: string;
}

export interface NativeRequest {
	readonly model: string;
	readonly prompt: string;
	readonly inputImages?: readonly NativeInputImage[];
	readonly aspectRatio?: string;
	readonly imageSize?: string;
}

export interface NativeGeneratedImage {
	readonly data: string;
	readonly mimeType: string;
}

export interface NativeUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
}

export interface NativeResponse {
	readonly images: readonly NativeGeneratedImage[];
	readonly reportedModel?: string;
	readonly usage?: NativeUsage;
}

export interface ImageBytes {
	readonly base64: string;
	readonly mimeType: string;
}

export interface ImageRenderOpts {
	readonly maxWidthCells?: number;
	readonly maxHeightCells?: number;
	readonly filename?: string;
}

export type AgentToolContentItem =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface PortableToolResult<D> {
	readonly content: readonly AgentToolContentItem[];
	readonly details?: D;
	readonly isError?: boolean;
}

export type PortableToolUpdateCallback<D> = (partial: PortableToolResult<D>) => void;

export interface PortableRenderResultOpts {
	readonly expanded: boolean;
	readonly isPartial: boolean;
}

export type ToolApproval = "read" | "write";

/** Renders an image inline through the host TUI `Image` component (text fallback outside a TUI). */
export type ImageComponentFactory = (data: ImageBytes, theme: PortableTheme, opts?: ImageRenderOpts) => ComponentLike;

export interface PortableTool<P, D> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, unknown>>;
	/** Always visible to the agent (omp `loadMode: "essential"`); otherwise discoverable. */
	readonly essential?: boolean;
	readonly approval?: ToolApproval;
	/** One line for pi's "Available tools" prompt section (pi omits custom tools without it). */
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
	execute(
		toolCallId: string,
		params: P,
		signal: AbortSignal | undefined,
		onUpdate: PortableToolUpdateCallback<D> | undefined,
		ctx: PortableCtx,
	): Promise<PortableToolResult<D>>;
	readonly renderCall?: (args: P, theme: PortableTheme) => ComponentLike;
	readonly renderResult?: (
		result: PortableToolResult<D>,
		opts: PortableRenderResultOpts,
		theme: PortableTheme,
		args?: P,
	) => ComponentLike;
}

export interface PortableCommand {
	readonly description: string;
	handler(args: string, ctx: PortableCtx): Promise<void>;
}

export interface PortableFlag {
	readonly description: string;
	readonly type: "string" | "boolean";
	readonly default?: string | boolean;
}

export interface HostPort {
	readonly kind: HostKind;
	readonly agentDir: string;
	readonly projectDirName: ".omp" | ".pi";
	registerTool<P, D>(def: PortableTool<P, D>): void;
	registerFlag(name: string, spec: PortableFlag): void;
	registerCommand(name: string, spec: PortableCommand): void;
	/** Normalized key name from the host TUI (`"up"`, `"enter"`, `"shift+tab"`, …). */
	parseKey(data: string): string | undefined;
	getFlag(name: string): string | boolean | undefined;
	onSessionStart(fn: (ctx: PortableCtx) => void | Promise<void>): void;
	onSessionShutdown(fn: () => void | Promise<void>): void;
	readonly imageComponent: ImageComponentFactory;
	/** Image model the host session prefers (e.g. omp session model's `imageModel`), if any. */
	configuredImageModel(ctx: PortableCtx): string | undefined;
	/** Available image models, sorted: session provider first, then provider label, then label. */
	nativeImageModels(ctx: PortableCtx): Promise<Result<readonly HostImageModel[], ImgError>>;
	generateNative(ctx: PortableCtx, req: NativeRequest, signal: AbortSignal): Promise<Result<NativeResponse, ImgError>>;
	/** Host-internal URL (e.g. omp `local://`) → absolute file path; `undefined` for schemes the host does not back. */
	resolveHostUrl(ctx: PortableCtx, url: string): Promise<Result<string | undefined, ImgError>>;
	deactivateBuiltinImageTool?(): void;
	logError(msg: string, err?: unknown): void;
}

import type { ImgError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import type { Size } from "../domain/size.js";

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

export interface OverlayOptionsLike {
	readonly width?: number | string;
	readonly maxHeight?: number | string;
	readonly anchor?: "center";
	readonly fullscreen?: boolean;
}

export interface CustomOverlayOptions {
	readonly overlay?: boolean;
	readonly overlayOptions?: OverlayOptionsLike;
	readonly signal?: AbortSignal;
}

export interface PortableUIContext {
	select(
		title: string,
		options: readonly string[],
		opts?: { readonly initialIndex?: number },
	): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWorkingMessage(message?: string): void;
	setWidget(key: string, lines: readonly string[] | undefined): void;
	custom<T>(
		factory: (
			tui: TuiHandleLike,
			theme: PortableTheme,
			done: (result: T) => void,
		) => ComponentLike | Promise<ComponentLike>,
		options?: CustomOverlayOptions,
	): Promise<T | undefined>;
}

export interface PortableCtx {
	readonly cwd: string;
	readonly mode: HostRunMode;
	readonly hasUI: boolean;
	readonly sessionId?: string;
	readonly ui: PortableUIContext;
	readonly raw: unknown;
}

export interface NativeImageModel {
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly label: string;
	readonly api: string;
	readonly hasKey: boolean;
	readonly costHint?: string;
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
	readonly count?: number;
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

export interface ImageBudgetLike {
	readonly cap: number;
	readonly raw: unknown;
}

export interface ImageRenderOpts {
	readonly maxWidthCells?: number;
	readonly maxHeightCells?: number;
	readonly filename?: string;
	readonly sourcePath?: string;
	readonly budget?: ImageBudgetLike;
	readonly fallbackLines?: readonly string[];
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

export interface PortableTool<P, D> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, unknown>>;
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

export interface PortableShortcut {
	readonly description: string;
	handler(ctx: PortableCtx): Promise<void>;
}

export interface PortableFlag {
	readonly description: string;
	readonly type: "string" | "boolean";
	readonly default?: string | boolean;
}

export interface ToolCallPrecheckResult {
	readonly block?: boolean;
	readonly reason?: string;
}

export interface HostPort {
	readonly kind: HostKind;
	readonly agentDir: string;
	readonly projectDirName: ".omp" | ".pi";
	registerTool<P, D>(def: PortableTool<P, D>): void;
	registerCommand(name: string, spec: PortableCommand): void;
	registerShortcut(key: string, spec: PortableShortcut): void;
	registerFlag(name: string, spec: PortableFlag): void;
	getFlag(name: string): string | boolean | undefined;
	onSessionStart(fn: (ctx: PortableCtx) => void | Promise<void>): void;
	onSessionShutdown(fn: () => void | Promise<void>): void;
	onToolCall(
		fn: (toolName: string, args: unknown, ctx: PortableCtx) => Promise<ToolCallPrecheckResult | undefined>,
	): void;
	createImageBudget(cap: number, requestRender: () => void): ImageBudgetLike | undefined;
	hasGraphicsSupport(ctx: PortableCtx): boolean;
	imageComponent(data: ImageBytes, theme: PortableTheme, opts?: ImageRenderOpts, dims?: Size): ComponentLike;
	imageDims(data: ImageBytes): Size | undefined;
	configuredImageModel(ctx: PortableCtx): string | undefined;
	nativeImageModels(ctx: PortableCtx): readonly NativeImageModel[];
	generateNative(ctx: PortableCtx, req: NativeRequest, signal: AbortSignal): Promise<Result<NativeResponse, ImgError>>;
	deactivateBuiltinImageTool?(): void;
	logError(msg: string, err?: unknown): void;
}

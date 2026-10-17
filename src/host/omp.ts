import * as os from "node:os";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { abortedError, fromUnknownError, noApiKey, providerHttp } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import { Size } from "../domain/size.js";
import type {
	ComponentLike,
	CustomOverlayOptions,
	HostPort,
	HostRunMode,
	ImageBudgetLike,
	ImageBytes,
	ImageRenderOpts,
	NativeGeneratedImage,
	NativeImageModel,
	NativeRequest,
	NativeResponse,
	PortableCommand,
	PortableCtx,
	PortableFlag,
	PortableShortcut,
	PortableTheme,
	PortableTool,
	PortableToolResult,
	PortableToolUpdateCallback,
	PortableUIContext,
	ToolCallPrecheckResult,
	TuiHandleLike,
} from "./port.js";
import { toHostRenderers, wrapHostTheme } from "./render-shim.js";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isCallable(v: unknown): v is (...args: readonly unknown[]) => unknown {
	return typeof v === "function";
}

function parseMode(raw: unknown): HostRunMode {
	if (raw === "tui" || raw === "rpc" || raw === "json" || raw === "print") {
		return raw;
	}
	return "print";
}

export function wrapPortableCtx(rawCtx: unknown): PortableCtx {
	const rec = isRecord(rawCtx) ? rawCtx : {};
	const cwd = typeof rec["cwd"] === "string" ? rec["cwd"] : process.cwd();
	const mode = parseMode(rec["mode"]);
	const hasUI = typeof rec["hasUI"] === "boolean" ? rec["hasUI"] : mode === "tui";
	const rawSessionMgr = isRecord(rec["sessionManager"]) ? rec["sessionManager"] : undefined;
	const sessionId =
		typeof rec["sessionId"] === "string"
			? rec["sessionId"]
			: typeof rawSessionMgr?.["sessionId"] === "string"
				? rawSessionMgr["sessionId"]
				: undefined;

	const rawUi = isRecord(rec["ui"]) ? rec["ui"] : {};

	const ui: PortableUIContext = {
		async select(
			title: string,
			options: readonly string[],
			opts?: { readonly initialIndex?: number },
		): Promise<string | undefined> {
			const selectFn = rawUi["select"];
			if (isCallable(selectFn)) {
				const out = await selectFn.call(rawUi, title, [...options], opts);
				return typeof out === "string" ? out : undefined;
			}
			return undefined;
		},
		async confirm(title: string, message: string): Promise<boolean> {
			const confirmFn = rawUi["confirm"];
			if (isCallable(confirmFn)) {
				const out = await confirmFn.call(rawUi, title, message);
				return out === true;
			}
			return false;
		},
		async input(title: string, placeholder?: string): Promise<string | undefined> {
			const inputFn = rawUi["input"];
			if (isCallable(inputFn)) {
				const out = await inputFn.call(rawUi, title, placeholder);
				return typeof out === "string" ? out : undefined;
			}
			return undefined;
		},
		notify(message: string, type?: "info" | "warning" | "error"): void {
			const notifyFn = rawUi["notify"];
			if (isCallable(notifyFn)) {
				notifyFn.call(rawUi, message, type ?? "info");
			}
		},
		setStatus(key: string, text: string | undefined): void {
			const setStatusFn = rawUi["setStatus"];
			if (isCallable(setStatusFn)) {
				setStatusFn.call(rawUi, key, text);
			}
		},
		setWorkingMessage(message?: string): void {
			const setWorkingFn = rawUi["setWorkingMessage"];
			if (isCallable(setWorkingFn)) {
				setWorkingFn.call(rawUi, message);
			}
		},
		setWidget(key: string, lines: readonly string[] | undefined): void {
			const setWidgetFn = rawUi["setWidget"];
			if (isCallable(setWidgetFn)) {
				setWidgetFn.call(rawUi, key, lines !== undefined ? [...lines] : undefined);
			}
		},
		async custom<T>(
			factory: (
				tui: TuiHandleLike,
				theme: PortableTheme,
				done: (result: T) => void,
			) => ComponentLike | Promise<ComponentLike>,
			options?: CustomOverlayOptions,
		): Promise<T | undefined> {
			const customFn = rawUi["custom"];
			if (!isCallable(customFn)) {
				return undefined;
			}
			const hostFactory = (
				rawTui: unknown,
				rawTheme: unknown,
				_keybindings: unknown,
				done: (r: T) => void,
			): ComponentLike | Promise<ComponentLike> => {
				const tuiHandle: TuiHandleLike = {
					requestRender(): void {
						if (isRecord(rawTui)) {
							const reqFn = rawTui["requestRender"];
							if (isCallable(reqFn)) {
								reqFn.call(rawTui);
							}
						}
					},
				};
				return factory(tuiHandle, wrapHostTheme(rawTheme), done);
			};
			const out = await customFn.call(rawUi, hostFactory, options);
			return out as T | undefined;
		},
	};

	return {
		cwd,
		mode,
		hasUI,
		...(sessionId !== undefined ? { sessionId } : {}),
		ui,
		raw: rawCtx,
	};
}

const DEFAULT_OMP_IMAGE_MODELS: readonly {
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly label: string;
	readonly api: string;
	readonly envVars: readonly string[];
	readonly costHint: string;
}[] = Object.freeze([
	{
		id: "openai/gpt-image-1",
		provider: "openai",
		modelId: "gpt-image-1",
		label: "GPT Image 1",
		api: "openai-images",
		envVars: ["OPENAI_API_KEY"],
		costHint: "$0.04",
	},
	{
		id: "google/gemini-2.5-flash-image-preview",
		provider: "google",
		modelId: "gemini-2.5-flash-image-preview",
		label: "Gemini 2.5 Flash Image",
		api: "google-generative-ai",
		envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
		costHint: "$0.04",
	},
	{
		id: "google/imagen-3.0-generate-002",
		provider: "google",
		modelId: "imagen-3.0-generate-002",
		label: "Imagen 3",
		api: "google-generative-ai",
		envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
		costHint: "$0.04",
	},
	{
		id: "openrouter/black-forest-labs/flux-1.1-pro",
		provider: "openrouter",
		modelId: "black-forest-labs/flux-1.1-pro",
		label: "FLUX 1.1 Pro (OpenRouter)",
		api: "openrouter-images",
		envVars: ["OPENROUTER_API_KEY"],
		costHint: "$0.04",
	},
]);

export class OmpHost implements HostPort {
	public readonly kind = "omp" as const;
	public readonly agentDir: string;
	public readonly projectDirName = ".omp" as const;
	private readonly api: Record<string, unknown>;

	public constructor(rawApi: Record<string, unknown>) {
		this.api = rawApi;
		this.agentDir = process.env["OMP_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".omp", "agent");
	}

	public registerTool<P, D>(def: PortableTool<P, D>): void {
		const registerFn = this.api["registerTool"];
		if (typeof registerFn !== "function") {
			return;
		}
		const renderers = toHostRenderers("omp", def);
		const hostDef: Record<string, unknown> = {
			name: def.name,
			label: def.label,
			description: def.description,
			parameters: def.parameters,
			execute: async (
				toolCallId: string,
				params: P,
				signal: AbortSignal | undefined,
				onUpdate: PortableToolUpdateCallback<D> | undefined,
				rawCtx: unknown,
			): Promise<PortableToolResult<D>> => {
				return def.execute(toolCallId, params, signal, onUpdate, wrapPortableCtx(rawCtx));
			},
			...(renderers.renderCall !== undefined ? { renderCall: renderers.renderCall } : {}),
			...(renderers.renderResult !== undefined ? { renderResult: renderers.renderResult } : {}),
		};
		registerFn.call(this.api, hostDef);
	}

	public registerCommand(name: string, spec: PortableCommand): void {
		const registerFn = this.api["registerCommand"];
		if (typeof registerFn !== "function") {
			return;
		}
		registerFn.call(this.api, name, {
			description: spec.description,
			handler: async (args: unknown, rawCtx: unknown): Promise<void> => {
				const argStr = typeof args === "string" ? args : "";
				await spec.handler(argStr, wrapPortableCtx(rawCtx));
			},
		});
	}

	public registerShortcut(key: string, spec: PortableShortcut): void {
		const registerFn = this.api["registerShortcut"];
		if (typeof registerFn !== "function") {
			return;
		}
		registerFn.call(this.api, key, {
			description: spec.description,
			handler: async (rawCtx: unknown): Promise<void> => {
				await spec.handler(wrapPortableCtx(rawCtx));
			},
		});
	}

	public registerFlag(name: string, spec: PortableFlag): void {
		const registerFn = this.api["registerFlag"];
		if (typeof registerFn !== "function") {
			return;
		}
		registerFn.call(this.api, name, {
			description: spec.description,
			type: spec.type,
			...(spec.default !== undefined ? { default: spec.default } : {}),
		});
	}

	public getFlag(name: string): string | boolean | undefined {
		const getFlagFn = this.api["getFlag"];
		if (typeof getFlagFn === "function") {
			const val: unknown = getFlagFn.call(this.api, name);
			if (typeof val === "string" || typeof val === "boolean") {
				return val;
			}
		}
		return undefined;
	}

	public onSessionStart(fn: (ctx: PortableCtx) => void | Promise<void>): void {
		const onFn = this.api["on"];
		if (typeof onFn !== "function") {
			return;
		}
		onFn.call(this.api, "session_start", async (_event: unknown, rawCtx: unknown) => {
			await fn(wrapPortableCtx(rawCtx ?? _event));
		});
	}

	public onSessionShutdown(fn: () => void | Promise<void>): void {
		const onFn = this.api["on"];
		if (typeof onFn !== "function") {
			return;
		}
		onFn.call(this.api, "session_shutdown", async () => {
			await fn();
		});
	}

	public onToolCall(
		fn: (toolName: string, args: unknown, ctx: PortableCtx) => Promise<ToolCallPrecheckResult | undefined>,
	): void {
		const onFn = this.api["on"];
		if (typeof onFn !== "function") {
			return;
		}
		onFn.call(this.api, "tool_call", async (event: unknown, rawCtx: unknown) => {
			if (!isRecord(event)) {
				return undefined;
			}
			const toolName =
				typeof event["toolName"] === "string"
					? event["toolName"]
					: typeof event["name"] === "string"
						? event["name"]
						: "";
			const inputArgs = event["input"] ?? event["args"] ?? {};
			return fn(toolName, inputArgs, wrapPortableCtx(rawCtx));
		});
	}

	public createImageBudget(cap: number, requestRender: () => void): ImageBudgetLike {
		return {
			cap,
			raw: { maxBytes: cap, requestRender },
		};
	}

	public hasGraphicsSupport(ctx: PortableCtx): boolean {
		return ctx.mode === "tui";
	}

	public imageComponent(data: ImageBytes, theme: PortableTheme, opts?: ImageRenderOpts, dims?: Size): ComponentLike {
		const dimText = dims !== undefined ? ` (${dims.width}×${dims.height})` : "";
		const label = opts?.filename ?? "image";
		const fallback = opts?.fallbackLines ?? [theme.fg("muted", `[${label} ${data.mimeType}${dimText}]`)];
		return {
			render(): string[] {
				return [...fallback];
			},
			invalidate(): void {
				// Pure fallback
			},
		};
	}

	public imageDims(data: ImageBytes): Size | undefined {
		try {
			const buf = Buffer.from(data.base64, "base64");
			// PNG header: 89 50 4E 47 0D 0A 1A 0A + IHDR length(4) + 'IHDR'(4) + width(4) + height(4)
			if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
				const w = buf.readUInt32BE(16);
				const h = buf.readUInt32BE(20);
				const s = Size.create(w, h);
				return s.ok ? s.value : undefined;
			}
		} catch {
			// Ignore header parse failure
		}
		return undefined;
	}

	public configuredImageModel(ctx: PortableCtx): string | undefined {
		const raw = isRecord(ctx.raw) ? ctx.raw : {};
		if (typeof raw["configuredImageModel"] === "string") {
			return raw["configuredImageModel"];
		}
		const settings = isRecord(raw["settings"]) ? raw["settings"] : undefined;
		const getFn = settings?.["get"];
		if (isCallable(getFn)) {
			const val = getFn.call(settings, "image.model");
			if (typeof val === "string" && val.length > 0) {
				return val;
			}
		}
		return undefined;
	}

	public nativeImageModels(ctx: PortableCtx): readonly NativeImageModel[] {
		const raw = isRecord(ctx.raw) ? ctx.raw : {};
		if (Array.isArray(raw["nativeImageModels"])) {
			return raw["nativeImageModels"] as readonly NativeImageModel[];
		}
		return DEFAULT_OMP_IMAGE_MODELS.map(m => {
			const hasEnvKey = m.envVars.some(envVar => {
				const v = process.env[envVar];
				return v !== undefined && v.trim().length > 0;
			});
			return {
				id: m.id,
				provider: m.provider,
				modelId: m.modelId,
				label: m.label,
				api: m.api,
				hasKey: hasEnvKey,
				costHint: m.costHint,
			};
		});
	}

	public async generateNative(
		ctx: PortableCtx,
		req: NativeRequest,
		signal: AbortSignal,
	): Promise<Result<NativeResponse, ImgError>> {
		if (signal.aborted) {
			return err(abortedError());
		}
		const raw = isRecord(ctx.raw) ? ctx.raw : {};
		const genFn = raw["generateNative"];
		if (isCallable(genFn)) {
			const res = await tryAsync(() => genFn.call(raw, req, signal) as Promise<NativeResponse>, fromUnknownError);
			return res;
		}

		const modelEntry = DEFAULT_OMP_IMAGE_MODELS.find(m => m.id === req.model || m.modelId === req.model);
		const providerName = modelEntry?.provider ?? req.model.split("/")[0] ?? "openai";
		const envVars = modelEntry?.envVars ?? ["OPENAI_API_KEY"];

		let apiKey: string | undefined;
		const modelRegistry = isRecord(raw["modelRegistry"]) ? raw["modelRegistry"] : undefined;
		const getApiKeyFn = modelRegistry?.["getApiKey"];
		if (isCallable(getApiKeyFn)) {
			const keyOut = await getApiKeyFn.call(
				modelRegistry,
				{ id: modelEntry?.modelId ?? req.model, provider: providerName, api: modelEntry?.api ?? "openai-images" },
				ctx.sessionId,
				{ signal },
			);
			if (typeof keyOut === "string" && keyOut.trim().length > 0) {
				apiKey = keyOut.trim();
			}
		}
		if (apiKey === undefined) {
			for (const envVar of envVars) {
				const v = process.env[envVar];
				if (v !== undefined && v.trim().length > 0) {
					apiKey = v.trim();
					break;
				}
			}
		}
		if (apiKey === undefined) {
			return err(noApiKey(providerName, envVars[0] ?? "OPENAI_API_KEY"));
		}

		const resolvedKey = apiKey;
		const modRes = await tryAsync(
			() => import("@oh-my-pi/pi-ai/images"),
			(e: unknown) =>
				providerHttp(
					providerName,
					0,
					`Host image module '@oh-my-pi/pi-ai/images' unavailable: ${e instanceof Error ? e.message : String(e)}`,
					false,
				),
		);
		if (!modRes.ok) {
			return modRes;
		}

		const genRes = await tryAsync(
			() =>
				modRes.value.generateImage(
					{
						id: modelEntry?.modelId ?? req.model,
						provider: providerName,
						api: modelEntry?.api ?? "openai-images",
					},
					{
						prompt: req.prompt,
						...(req.inputImages !== undefined ? { inputImages: req.inputImages } : {}),
						...(req.aspectRatio !== undefined ? { aspectRatio: req.aspectRatio } : {}),
						...(req.imageSize !== undefined ? { imageSize: req.imageSize } : {}),
						...(req.count !== undefined ? { count: req.count } : {}),
					},
					{
						apiKey: resolvedKey,
						signal,
						...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
					},
				),
			fromUnknownError,
		);
		if (!genRes.ok) {
			return genRes;
		}

		const outImages: NativeGeneratedImage[] = genRes.value.images.map(img => ({
			data: img.data,
			mimeType: img.mimeType,
		}));

		return ok({
			images: outImages,
			...(genRes.value.model !== undefined ? { reportedModel: genRes.value.model } : {}),
			...(genRes.value.usage !== undefined
				? {
						usage: {
							...(genRes.value.usage.input !== undefined ? { inputTokens: genRes.value.usage.input } : {}),
							...(genRes.value.usage.output !== undefined ? { outputTokens: genRes.value.usage.output } : {}),
							...(genRes.value.usage.totalTokens !== undefined
								? { totalTokens: genRes.value.usage.totalTokens }
								: {}),
							...(genRes.value.usage.cost?.total !== undefined
								? { costUsd: genRes.value.usage.cost.total }
								: {}),
						},
					}
				: {}),
		});
	}

	public deactivateBuiltinImageTool(): void {
		const getToolsFn = this.api["getActiveTools"];
		const setToolsFn = this.api["setActiveTools"];
		if (isCallable(getToolsFn) && isCallable(setToolsFn)) {
			const current = getToolsFn.call(this.api);
			if (Array.isArray(current)) {
				const filtered = current.filter((t): t is string => typeof t === "string" && t !== "generate_image");
				setToolsFn.call(this.api, filtered);
			}
		}
	}

	public logError(msg: string, error?: unknown): void {
		const logger = isRecord(this.api["logger"]) ? this.api["logger"] : undefined;
		const errFn = logger?.["error"];
		if (isCallable(errFn)) {
			errFn.call(logger, msg, error);
		}
	}
}

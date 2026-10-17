import type { ImgError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import type {
	ComponentLike,
	HostImageModel,
	HostKind,
	HostPort,
	HostRunMode,
	ImageBytes,
	ImageRenderOpts,
	NativeRequest,
	NativeResponse,
	NativeUsage,
	PortableCtx,
	PortableFlag,
	PortableTheme,
	PortableTool,
	PortableToolResult,
	PortableToolUpdateCallback,
	PortableUIContext,
} from "./port.js";
import { toHostRenderers } from "./render-shim.js";

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function isCallable(v: unknown): v is (...args: readonly unknown[]) => unknown {
	return typeof v === "function";
}

export function readString(rec: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const v = rec[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseMode(raw: unknown): HostRunMode {
	if (raw === "tui" || raw === "rpc" || raw === "json" || raw === "print") {
		return raw;
	}
	return "print";
}

function readSessionId(rec: Readonly<Record<string, unknown>>): string | undefined {
	const direct = readString(rec, "sessionId");
	if (direct !== undefined) {
		return direct;
	}
	const mgr = rec["sessionManager"];
	if (!isRecord(mgr)) {
		return undefined;
	}
	const getFn = mgr["getSessionId"];
	const fromFn: unknown = isCallable(getFn) ? getFn.call(mgr) : undefined;
	return typeof fromFn === "string" ? fromFn : readString(mgr, "sessionId");
}

/** Wraps the host `ExtensionContext` (identical shape on omp and pi for the fields we read). */
export function wrapPortableCtx(rawCtx: unknown): PortableCtx {
	const rec = isRecord(rawCtx) ? rawCtx : {};
	const mode = parseMode(rec["mode"]);
	const rawUi = isRecord(rec["ui"]) ? rec["ui"] : {};
	const callUi = (name: string, ...args: readonly unknown[]): void => {
		const fn = rawUi[name];
		if (isCallable(fn)) {
			fn.call(rawUi, ...args);
		}
	};
	const ui: PortableUIContext = {
		notify(message, type): void {
			callUi("notify", message, type ?? "info");
		},
		setStatus(key, text): void {
			callUi("setStatus", key, text);
		},
		setWidget(key, lines): void {
			callUi("setWidget", key, lines !== undefined ? [...lines] : undefined);
		},
	};
	const sessionId = readSessionId(rec);
	return {
		cwd: readString(rec, "cwd") ?? process.cwd(),
		mode,
		hasUI: typeof rec["hasUI"] === "boolean" ? rec["hasUI"] : mode === "tui",
		...(sessionId !== undefined ? { sessionId } : {}),
		ui,
		raw: rawCtx,
	};
}

/** Host `modelRegistry` from a raw context, if present. */
export function readModelRegistry(ctx: PortableCtx): Record<string, unknown> | undefined {
	const raw = isRecord(ctx.raw) ? ctx.raw : undefined;
	const reg = raw?.["modelRegistry"];
	return isRecord(reg) ? reg : undefined;
}

/** Provider of the session's active chat model; its image models sort first. */
export function readSessionProvider(ctx: PortableCtx): string | undefined {
	const raw = isRecord(ctx.raw) ? ctx.raw : undefined;
	const model = raw?.["model"];
	return isRecord(model) ? readString(model, "provider") : undefined;
}

export function sortImageModels(
	models: readonly HostImageModel[],
	sessionProvider: string | undefined,
): readonly HostImageModel[] {
	const seen = new Set<string>();
	const unique = models.filter(m => {
		if (seen.has(m.id)) {
			return false;
		}
		seen.add(m.id);
		return true;
	});
	const rank = (m: HostImageModel): number => (m.provider === sessionProvider ? 0 : 1);
	return Object.freeze(
		unique.sort(
			(a, b) =>
				rank(a) - rank(b) || a.providerLabel.localeCompare(b.providerLabel) || a.label.localeCompare(b.label),
		),
	);
}

function readNumber(rec: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const v = rec[key];
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Maps a host usage record (`input`/`output`/`totalTokens`/`cost.total`, same on omp and pi). */
export function toNativeUsage(raw: unknown): NativeUsage | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const cost = raw["cost"];
	const inputTokens = readNumber(raw, "input");
	const outputTokens = readNumber(raw, "output");
	const totalTokens = readNumber(raw, "totalTokens");
	const costUsd = isRecord(cost) ? readNumber(cost, "total") : undefined;
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
	};
}

/** Structural view of the host TUI module's `Image` component (omp and pi share the ctor). */
export interface TuiImageModule {
	readonly Image: new (
		base64Data: string,
		mimeType: string,
		theme: { readonly fallbackColor: (text: string) => string },
		options?: ImageRenderOpts,
	) => ComponentLike;
}

/** Host-specific tool definition fields (visibility / prompt metadata). */
export type HostToolFields = Readonly<Record<string, unknown>>;

/**
 * Behavior identical on both hosts. Subclasses supply only what genuinely differs:
 * tool visibility fields, model discovery, generation, and the TUI module.
 */
export abstract class BaseHost implements HostPort {
	public abstract readonly kind: HostKind;
	public abstract readonly agentDir: string;
	public abstract readonly projectDirName: ".omp" | ".pi";
	protected readonly api: Record<string, unknown>;
	private tui: TuiImageModule | undefined;

	protected constructor(rawApi: Record<string, unknown>) {
		this.api = rawApi;
	}

	protected abstract toolFields<P, D>(def: PortableTool<P, D>): HostToolFields;
	protected abstract loadTui(): Promise<TuiImageModule>;
	public abstract configuredImageModel(ctx: PortableCtx): string | undefined;
	public abstract nativeImageModels(ctx: PortableCtx): Promise<Result<readonly HostImageModel[], ImgError>>;
	public abstract generateNative(
		ctx: PortableCtx,
		req: NativeRequest,
		signal: AbortSignal,
	): Promise<Result<NativeResponse, ImgError>>;

	private callApi(name: string, ...args: readonly unknown[]): unknown {
		const fn = this.api[name];
		return isCallable(fn) ? fn.call(this.api, ...args) : undefined;
	}

	public registerTool<P, D>(def: PortableTool<P, D>): void {
		const renderers = toHostRenderers(this.kind, def);
		this.callApi("registerTool", {
			name: def.name,
			label: def.label,
			description: def.description,
			parameters: def.parameters,
			...this.toolFields(def),
			execute: (
				toolCallId: string,
				params: P,
				signal: AbortSignal | undefined,
				onUpdate: PortableToolUpdateCallback<D> | undefined,
				rawCtx: unknown,
			): Promise<PortableToolResult<D>> =>
				def.execute(toolCallId, params, signal, onUpdate, wrapPortableCtx(rawCtx)),
			...(renderers.renderCall !== undefined ? { renderCall: renderers.renderCall } : {}),
			...(renderers.renderResult !== undefined ? { renderResult: renderers.renderResult } : {}),
		});
	}

	public registerFlag(name: string, spec: PortableFlag): void {
		this.callApi("registerFlag", name, {
			description: spec.description,
			type: spec.type,
			...(spec.default !== undefined ? { default: spec.default } : {}),
		});
	}

	public getFlag(name: string): string | boolean | undefined {
		const val = this.callApi("getFlag", name);
		return typeof val === "string" || typeof val === "boolean" ? val : undefined;
	}

	public onSessionStart(fn: (ctx: PortableCtx) => void | Promise<void>): void {
		this.callApi("on", "session_start", async (event: unknown, rawCtx: unknown): Promise<void> => {
			await this.ensureTui();
			await fn(wrapPortableCtx(rawCtx ?? event));
		});
	}

	public onSessionShutdown(fn: () => void | Promise<void>): void {
		this.callApi("on", "session_shutdown", async (): Promise<void> => {
			await fn();
		});
	}

	private async ensureTui(): Promise<void> {
		if (this.tui !== undefined) {
			return;
		}
		try {
			this.tui = await this.loadTui();
		} catch (e: unknown) {
			this.logError("Host TUI module unavailable; images render as text", e);
		}
	}

	public readonly imageComponent = (data: ImageBytes, theme: PortableTheme, opts?: ImageRenderOpts): ComponentLike => {
		const fallbackColor = (text: string): string => theme.fg("muted", text);
		if (this.tui !== undefined) {
			return new this.tui.Image(data.base64, data.mimeType, { fallbackColor }, opts);
		}
		const line = fallbackColor(`[${opts?.filename ?? "image"} · ${data.mimeType}]`);
		return {
			render(): string[] {
				return [line];
			},
			invalidate(): void {
				// Static text fallback
			},
		};
	};

	public logError(_msg: string, _err?: unknown): void {
		// Default: host exposes no logger; never write to stdout (it would corrupt the TUI).
	}
}

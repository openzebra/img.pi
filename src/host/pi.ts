import * as os from "node:os";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { abortedError, fromUnknownError, noApiKey, providerHttp } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import { Size } from "../domain/size.js";
import { wrapPortableCtx } from "./omp.js";
import type {
	ComponentLike,
	HostPort,
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
	ToolCallPrecheckResult,
} from "./port.js";
import { toHostRenderers } from "./render-shim.js";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const DEFAULT_PI_IMAGE_MODELS: readonly {
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
]);

export class PiHost implements HostPort {
	public readonly kind = "pi" as const;
	public readonly agentDir: string;
	public readonly projectDirName = ".pi" as const;
	private readonly api: Record<string, unknown>;

	public constructor(rawApi: Record<string, unknown>) {
		this.api = rawApi;
		this.agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");
	}

	public registerTool<P, D>(def: PortableTool<P, D>): void {
		const registerFn = this.api["registerTool"];
		if (typeof registerFn !== "function") {
			return;
		}
		const renderers = toHostRenderers("pi", def);
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
		return undefined;
	}

	public nativeImageModels(ctx: PortableCtx): readonly NativeImageModel[] {
		const raw = isRecord(ctx.raw) ? ctx.raw : {};
		if (Array.isArray(raw["nativeImageModels"])) {
			return raw["nativeImageModels"] as readonly NativeImageModel[];
		}
		return DEFAULT_PI_IMAGE_MODELS.map(m => {
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
		if (typeof genFn === "function") {
			const res = await tryAsync(() => genFn.call(raw, req, signal) as Promise<NativeResponse>, fromUnknownError);
			return res;
		}

		const modelEntry = DEFAULT_PI_IMAGE_MODELS.find(m => m.id === req.model || m.modelId === req.model);
		const providerName = modelEntry?.provider ?? req.model.split("/")[0] ?? "openai";
		const envVars = modelEntry?.envVars ?? ["OPENAI_API_KEY"];

		let apiKey: string | undefined;
		const modelRegistry = isRecord(raw["modelRegistry"]) ? raw["modelRegistry"] : undefined;
		const getApiKeyFn = modelRegistry?.["getApiKey"];
		if (typeof getApiKeyFn === "function") {
			const keyOut: unknown = await getApiKeyFn.call(
				modelRegistry,
				{
					id: modelEntry?.modelId ?? req.model,
					provider: providerName,
					api: modelEntry?.api ?? "openai-images",
				},
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
			() => import("@earendil-works/pi-ai"),
			(e: unknown) =>
				providerHttp(
					providerName,
					0,
					`Host image module '@earendil-works/pi-ai' unavailable: ${e instanceof Error ? e.message : String(e)}`,
					false,
				),
		);
		if (!modRes.ok) {
			return modRes;
		}

		const inputItems: (
			| { readonly type: "text"; readonly text: string }
			| { readonly type: "image"; readonly data: string; readonly mimeType: string }
		)[] = [{ type: "text", text: req.prompt }];

		if (req.inputImages !== undefined) {
			for (const img of req.inputImages) {
				inputItems.push({
					type: "image",
					data: img.data,
					mimeType: img.mimeType,
				});
			}
		}

		const genRes = await tryAsync(
			() =>
				modRes.value.generateImages(
					{
						id: modelEntry?.modelId ?? req.model,
						provider: providerName,
						api: modelEntry?.api ?? "openai-images",
					},
					{ input: inputItems },
					{
						apiKey: resolvedKey,
						signal,
						...(req.aspectRatio !== undefined ? { aspectRatio: req.aspectRatio } : {}),
						...(req.imageSize !== undefined ? { size: req.imageSize } : {}),
						...(req.count !== undefined ? { n: req.count } : {}),
					},
				),
			fromUnknownError,
		);
		if (!genRes.ok) {
			return genRes;
		}
		if (genRes.value.stopReason === "aborted") {
			return err(abortedError());
		}
		if (genRes.value.stopReason === "error") {
			return err(providerHttp(providerName, 500, genRes.value.errorMessage ?? "Host generateImages failed", false));
		}

		const outImages: NativeGeneratedImage[] = [];
		for (const item of genRes.value.output) {
			if (item.type === "image") {
				outImages.push({
					data: item.data,
					mimeType: item.mimeType,
				});
			}
		}

		return ok({
			images: outImages,
			reportedModel: genRes.value.model,
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

	public logError(msg: string, _error?: unknown): void {
		// pi does not expose logger on ExtensionAPI; avoid stdout pollution
		void msg;
	}
}

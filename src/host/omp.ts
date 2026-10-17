import * as os from "node:os";
import * as path from "node:path";
import type * as OmpAiModule from "@oh-my-pi/pi-ai";
import type * as OmpAiErrorModule from "@oh-my-pi/pi-ai/error";
import type * as OmpRetryAfterModule from "@oh-my-pi/pi-ai/utils/retry-after";
import type * as OmpCatalogModelsModule from "@oh-my-pi/pi-catalog/models";
import type * as OmpLocalProtocolModule from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import type { ImgError, ProviderFailureDetail } from "../core/errors.js";
import {
	abortedError,
	errorMessage,
	fromUnknownError,
	modelNotFound,
	noApiKey,
	providerHttp,
	quotaExhausted,
	readHttpFailure,
	refUnreadable,
} from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync, trySync } from "../core/result.js";
import type { HostToolFields, TuiModule } from "./base.js";
import {
	BaseHost,
	isCallable,
	isRecord,
	readModelRegistry,
	readSessionProvider,
	readString,
	sortImageModels,
	toNativeUsage,
} from "./base.js";
import type {
	HostImageModel,
	HostImageOptions,
	NativeRequest,
	NativeResponse,
	PortableCtx,
	PortableTool,
} from "./port.js";

export { wrapPortableCtx } from "./base.js";

type OmpAi = typeof OmpAiModule;

/** Host failure classifiers (oh-my-pi/packages/ai/src/error/rate-limit.ts:383, retryable.ts:20, utils/retry-after.ts:31). */
interface OmpErrorClassifier {
	readonly isUsageLimitOutcome: typeof OmpAiErrorModule.isUsageLimitOutcome;
	readonly isTransientStatus: typeof OmpAiErrorModule.isTransientStatus;
	readonly getRetryAfterMsFromHeaders: typeof OmpRetryAfterModule.getRetryAfterMsFromHeaders;
}

/** Scheme omp stores pasted images under (oh-my-pi/.../modes/controllers/input-controller.ts:2163). */
const OMP_LOCAL_SCHEME = "local://";

/** omp `ImageGenerationRequest` carries both (oh-my-pi/packages/ai/src/images/types.ts). */
const OMP_IMAGE_OPTIONS: HostImageOptions = deepFreeze({ aspectRatio: true, imageSize: true });

/** omp's built-in image tool; hidden so the agent has one obvious image tool. */
const OMP_BUILTIN_IMAGE_TOOL = "generate_image";

/** Responses-API image models run through a chat "carrier" (oh-my-pi/.../tools/image-gen.ts:276). */
const HOSTED_IMAGE_APIS: ReadonlySet<string> = new Set(["openai-responses", "openai-codex-responses"]);

function modelSelector(m: Readonly<Record<string, unknown>>): string | undefined {
	const provider = readString(m, "provider");
	const id = readString(m, "id");
	return provider !== undefined && id !== undefined ? `${provider}/${id}` : undefined;
}

function callRegistry(reg: Record<string, unknown>, name: string, ...args: readonly unknown[]): unknown {
	const fn = reg[name];
	return isCallable(fn) ? fn.call(reg, ...args) : undefined;
}

function recordList(v: unknown): readonly Record<string, unknown>[] {
	return Array.isArray(v) ? v.filter(isRecord) : [];
}

/**
 * Authenticated image models, exactly the pool omp's `image` role draws from:
 * `getAvailable("all")` filtered by `kind === "image"` (oh-my-pi/.../config/model-roles.ts:72,104),
 * restricted to APIs `generateImage` can dispatch.
 */
function availableImageModels(reg: Record<string, unknown>, ai: OmpAi): readonly Record<string, unknown>[] {
	return recordList(callRegistry(reg, "getAvailable", "all")).filter(m => {
		const api = readString(m, "api");
		return m["kind"] === "image" && api !== undefined && ai.isImageGenerationApi(api);
	});
}

function toHostImageModel(m: Readonly<Record<string, unknown>>): HostImageModel | undefined {
	const id = modelSelector(m);
	const provider = readString(m, "provider");
	if (id === undefined || provider === undefined) {
		return undefined;
	}
	const input = m["input"];
	return {
		id,
		provider,
		providerLabel: provider,
		label: readString(m, "name") ?? id,
		acceptsImages: Array.isArray(input) && input.includes("image"),
		options: OMP_IMAGE_OPTIONS,
	};
}

/**
 * Session model when it can carry the hosted tool on the same provider, else the cheapest
 * available carrier there (oh-my-pi/packages/coding-agent/src/tools/image-gen.ts:145).
 */
function resolveCarrier(
	reg: Record<string, unknown>,
	model: Readonly<Record<string, unknown>>,
	sessionModel: unknown,
	inputCost: (m: Readonly<Record<string, unknown>>) => number,
): Record<string, unknown> | undefined {
	if (model["hostedImage"] === true) {
		return { ...model };
	}
	const provider = model["provider"];
	if (isRecord(sessionModel) && sessionModel["provider"] === provider && sessionModel["hostedImage"] === true) {
		return sessionModel;
	}
	let carrier: Record<string, unknown> | undefined;
	let carrierInput = Infinity;
	for (const c of recordList(callRegistry(reg, "getAvailable"))) {
		if (c["provider"] !== provider || c["hostedImage"] !== true) continue;
		const input = inputCost(c);
		if (carrier === undefined || input < carrierInput) {
			carrier = c;
			carrierInput = input;
		}
	}
	return carrier;
}

/** Maps a thrown host error to the `ImgError` the agent and the failed-request record see. */
function toImageError(
	e: unknown,
	model: string,
	via: string | undefined,
	classifier: OmpErrorClassifier | undefined,
): ImgError {
	const http = readHttpFailure(e);
	if (http === undefined) {
		return fromUnknownError(e);
	}
	const retryAfterMs =
		classifier !== undefined && http.headers !== undefined
			? classifier.getRetryAfterMsFromHeaders(http.headers)
			: undefined;
	const detail: ProviderFailureDetail = {
		...(http.code !== undefined ? { code: http.code } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(via !== undefined ? { via } : {}),
	};
	if (classifier?.isUsageLimitOutcome(http.status, http.message) === true) {
		return quotaExhausted(model, http.status, http.message, detail);
	}
	return providerHttp(model, http.status, http.message, classifier?.isTransientStatus(http.status) ?? false, detail);
}

function withResolvedHeaders(
	reg: Record<string, unknown>,
	model: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	return {
		...model,
		resolveHeaders: (signal?: AbortSignal): unknown => callRegistry(reg, "resolveModelHeaders", model, signal),
	};
}

function loadHostModule<T>(specifier: string, load: () => Promise<T>): Promise<Result<T, ImgError>> {
	return tryAsync(load, (e: unknown) =>
		providerHttp("omp", 0, `'${specifier}' unavailable: ${errorMessage(e)}`, false),
	);
}

export class OmpHost extends BaseHost {
	public readonly kind = "omp" as const;
	public readonly agentDir: string;
	public readonly projectDirName = ".omp" as const;

	public constructor(rawApi: Record<string, unknown>) {
		super(rawApi);
		this.agentDir = process.env["OMP_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".omp", "agent");
	}

	protected toolFields<P, D>(def: PortableTool<P, D>): HostToolFields {
		return {
			...(def.essential === true ? { loadMode: "essential" } : {}),
			...(def.approval !== undefined ? { approval: def.approval } : {}),
		};
	}

	protected async loadTui(): Promise<TuiModule> {
		return import("@oh-my-pi/pi-tui");
	}

	private loadAi(): Promise<Result<OmpAi, ImgError>> {
		return loadHostModule("@oh-my-pi/pi-ai", () => import("@oh-my-pi/pi-ai"));
	}

	/** Absent classifiers degrade to an unclassified `provider_http`; the status is still reported. */
	private async loadErrorClassifier(): Promise<OmpErrorClassifier | undefined> {
		const res = await tryAsync(
			() => Promise.all([import("@oh-my-pi/pi-ai/error"), import("@oh-my-pi/pi-ai/utils/retry-after")]),
			() => undefined,
		);
		if (!res.ok) {
			return undefined;
		}
		const [errors, retryAfter] = res.value;
		return {
			isUsageLimitOutcome: errors.isUsageLimitOutcome,
			isTransientStatus: errors.isTransientStatus,
			getRetryAfterMsFromHeaders: retryAfter.getRetryAfterMsFromHeaders,
		};
	}

	/** omp's `local://` root lives in the session artifacts dir (internal-urls/local-protocol.ts:240,296). */
	public override async resolveHostUrl(ctx: PortableCtx, url: string): Promise<Result<string | undefined, ImgError>> {
		if (!url.startsWith(OMP_LOCAL_SCHEME)) {
			return ok(undefined);
		}
		const modRes = await loadHostModule(
			"@oh-my-pi/pi-coding-agent/internal-urls/local-protocol",
			(): Promise<typeof OmpLocalProtocolModule> => import("@oh-my-pi/pi-coding-agent/internal-urls/local-protocol"),
		);
		if (!modRes.ok) {
			return modRes;
		}
		const raw = isRecord(ctx.raw) ? ctx.raw : {};
		const mgr = isRecord(raw["sessionManager"]) ? raw["sessionManager"] : {};
		const callMgr = (name: string): string | null => {
			const fn = mgr[name];
			const value: unknown = isCallable(fn) ? fn.call(mgr) : undefined;
			return typeof value === "string" ? value : null;
		};
		const local = modRes.value;
		return trySync(
			() =>
				local.resolveLocalUrlToPath(url, {
					getArtifactsDir: () => callMgr("getArtifactsDir"),
					getSessionId: () => callMgr("getSessionId"),
				}),
			(e: unknown) => refUnreadable(url, errorMessage(e)),
		);
	}

	/** The session model's same-provider image swap (`Model.imageModel`, catalog types.ts:1516). */
	public configuredImageModel(ctx: PortableCtx): string | undefined {
		const raw = isRecord(ctx.raw) ? ctx.raw : {};
		const sessionModel = raw["model"];
		if (!isRecord(sessionModel)) {
			return undefined;
		}
		const imageModel = readString(sessionModel, "imageModel")?.trim();
		if (imageModel === undefined || imageModel.length === 0) {
			return undefined;
		}
		const provider = readString(sessionModel, "provider");
		return imageModel.includes("/") || provider === undefined ? imageModel : `${provider}/${imageModel}`;
	}

	public async nativeImageModels(ctx: PortableCtx): Promise<Result<readonly HostImageModel[], ImgError>> {
		const reg = readModelRegistry(ctx);
		if (reg === undefined) {
			return ok([]);
		}
		const aiRes = await this.loadAi();
		if (!aiRes.ok) {
			return aiRes;
		}
		const models = availableImageModels(reg, aiRes.value)
			.map(toHostImageModel)
			.filter((m): m is HostImageModel => m !== undefined);
		return ok(sortImageModels(models, readSessionProvider(ctx)));
	}

	/** Mirrors omp's own `generate_image` flow (oh-my-pi/packages/coding-agent/src/tools/image-gen.ts:238-330). */
	public async generateNative(
		ctx: PortableCtx,
		req: NativeRequest,
		signal: AbortSignal,
	): Promise<Result<NativeResponse, ImgError>> {
		if (signal.aborted) {
			return err(abortedError());
		}
		const reg = readModelRegistry(ctx);
		const aiRes = await this.loadAi();
		if (!aiRes.ok) {
			return aiRes;
		}
		const ai = aiRes.value;
		const model =
			reg !== undefined ? availableImageModels(reg, ai).find(m => modelSelector(m) === req.model) : undefined;
		if (reg === undefined || model === undefined) {
			return err(modelNotFound(req.model));
		}
		const provider = readString(model, "provider") ?? req.model;
		const sessionId = ctx.sessionId;
		const isAuthenticated = async (target: Readonly<Record<string, unknown>>): Promise<boolean> => {
			const key: unknown = await callRegistry(reg, "getApiKey", target, sessionId, { signal });
			return typeof key === "string" && key.length > 0 && key !== ai.NO_AUTH_SENTINEL;
		};
		if (!(await isAuthenticated(model))) {
			return err(noApiKey(provider));
		}

		const raw = isRecord(ctx.raw) ? ctx.raw : {};
		const api = readString(model, "api") ?? "";
		let carrier: Record<string, unknown> | undefined;
		if (HOSTED_IMAGE_APIS.has(api)) {
			const catalogRes = await loadHostModule(
				"@oh-my-pi/pi-catalog/models",
				(): Promise<typeof OmpCatalogModelsModule> => import("@oh-my-pi/pi-catalog/models"),
			);
			if (!catalogRes.ok) {
				return catalogRes;
			}
			const { getEffectiveTokenCost } = catalogRes.value;
			carrier = resolveCarrier(reg, model, raw["model"], m =>
				isRecord(m["cost"]) ? getEffectiveTokenCost(m["cost"]).input : Infinity,
			);
			if (carrier === undefined || !(await isAuthenticated(carrier))) {
				return err(noApiKey(provider));
			}
		}
		const authTarget = carrier ?? model;
		const resolver: unknown = callRegistry(reg, "resolver", authTarget, sessionId);
		const apiKey = resolver ?? (await callRegistry(reg, "getApiKey", authTarget, sessionId, { signal }));
		const hostFetch = raw["fetch"];

		const genRes = await tryAsync(
			() =>
				ai.generateImage(
					withResolvedHeaders(reg, model),
					{
						prompt: req.prompt,
						...(req.inputImages !== undefined ? { inputImages: req.inputImages } : {}),
						...(req.aspectRatio !== undefined ? { aspectRatio: req.aspectRatio } : {}),
						...(req.imageSize !== undefined ? { imageSize: req.imageSize } : {}),
						count: 1,
					},
					{
						apiKey,
						signal,
						...(isCallable(hostFetch) ? { fetch: hostFetch } : {}),
						...(sessionId !== undefined ? { sessionId } : {}),
						...(carrier !== undefined ? { carrier: withResolvedHeaders(reg, carrier) } : {}),
					},
				),
			(e: unknown) => e,
		);
		if (!genRes.ok) {
			const via = carrier !== undefined ? modelSelector(carrier) : undefined;
			return err(toImageError(genRes.error, req.model, via, await this.loadErrorClassifier()));
		}
		const result = genRes.value;
		const usage = toNativeUsage(result.usage);
		return ok({
			images: result.images.map(img => ({ data: img.data, mimeType: img.mimeType })),
			...(result.model !== undefined ? { reportedModel: result.model } : {}),
			...(usage !== undefined ? { usage } : {}),
		});
	}

	public deactivateBuiltinImageTool(): void {
		const current: unknown = this.api["getActiveTools"];
		const setFn = this.api["setActiveTools"];
		if (!isCallable(current) || !isCallable(setFn)) {
			return;
		}
		const active: unknown = current.call(this.api);
		if (Array.isArray(active)) {
			setFn.call(
				this.api,
				active.filter((t): t is string => typeof t === "string" && t !== OMP_BUILTIN_IMAGE_TOOL),
			);
		}
	}

	public override logError(msg: string, error?: unknown): void {
		const logger = this.api["logger"];
		if (isRecord(logger)) {
			const errFn = logger["error"];
			if (isCallable(errFn)) {
				errFn.call(logger, msg, error);
			}
		}
	}
}

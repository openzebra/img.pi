import * as os from "node:os";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { abortedError, fromUnknownError, modelNotFound, providerHttp } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
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
	NativeGeneratedImage,
	NativeRequest,
	NativeResponse,
	PortableCtx,
	PortableTool,
} from "./port.js";

/** pi `ImagesContext` has only `input` (pi/packages/ai/src/types.ts:649); no size knobs. */
const PI_IMAGE_OPTIONS: HostImageOptions = deepFreeze({ aspectRatio: false, imageSize: false });

/** Model type pi's registry filters by (pi/packages/coding-agent/src/core/model-registry.ts:156). */
const PI_IMAGE_MODEL_TYPE = "image";

function callRegistry(reg: Record<string, unknown>, name: string, ...args: readonly unknown[]): unknown {
	const fn = reg[name];
	return isCallable(fn) ? fn.call(reg, ...args) : undefined;
}

async function availableImageModels(reg: Record<string, unknown>): Promise<readonly Record<string, unknown>[]> {
	const list: unknown = await callRegistry(reg, "getAvailableOfType", PI_IMAGE_MODEL_TYPE);
	return Array.isArray(list) ? list.filter(isRecord) : [];
}

function modelSelector(m: Readonly<Record<string, unknown>>): string | undefined {
	const provider = readString(m, "provider");
	const id = readString(m, "id");
	return provider !== undefined && id !== undefined ? `${provider}/${id}` : undefined;
}

export class PiHost extends BaseHost {
	public readonly kind = "pi" as const;
	public readonly agentDir: string;
	public readonly projectDirName = ".pi" as const;

	public constructor(rawApi: Record<string, unknown>) {
		super(rawApi);
		this.agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");
	}

	protected toolFields<P, D>(def: PortableTool<P, D>): HostToolFields {
		return {
			...(def.promptSnippet !== undefined ? { promptSnippet: def.promptSnippet } : {}),
			...(def.promptGuidelines !== undefined ? { promptGuidelines: [...def.promptGuidelines] } : {}),
		};
	}

	protected async loadTui(): Promise<TuiModule> {
		return import("@earendil-works/pi-tui");
	}

	/** pi has no per-session image model preference. */
	public configuredImageModel(_ctx: PortableCtx): string | undefined {
		return undefined;
	}

	public async nativeImageModels(ctx: PortableCtx): Promise<Result<readonly HostImageModel[], ImgError>> {
		const reg = readModelRegistry(ctx);
		if (reg === undefined) {
			return ok([]);
		}
		const listRes = await tryAsync(() => availableImageModels(reg), fromUnknownError);
		if (!listRes.ok) {
			return listRes;
		}
		const models: HostImageModel[] = [];
		for (const m of listRes.value) {
			const id = modelSelector(m);
			const provider = readString(m, "provider");
			if (id === undefined || provider === undefined) {
				continue;
			}
			const displayName: unknown = callRegistry(reg, "getProviderDisplayName", provider);
			const input = m["input"];
			models.push({
				id,
				provider,
				providerLabel: typeof displayName === "string" && displayName.length > 0 ? displayName : provider,
				label: readString(m, "name") ?? id,
				acceptsImages: Array.isArray(input) && input.includes("image"),
				options: PI_IMAGE_OPTIONS,
			});
		}
		return ok(sortImageModels(models, readSessionProvider(ctx)));
	}

	/** `modelRegistry.generateImages` resolves auth at request time and never rejects (model-registry.ts:181). */
	public async generateNative(
		ctx: PortableCtx,
		req: NativeRequest,
		signal: AbortSignal,
	): Promise<Result<NativeResponse, ImgError>> {
		if (signal.aborted) {
			return err(abortedError());
		}
		const reg = readModelRegistry(ctx);
		const listRes = reg !== undefined ? await tryAsync(() => availableImageModels(reg), fromUnknownError) : ok([]);
		if (!listRes.ok) {
			return listRes;
		}
		const model = listRes.value.find(m => modelSelector(m) === req.model);
		if (reg === undefined || model === undefined) {
			return err(modelNotFound(req.model));
		}
		const provider = readString(model, "provider") ?? req.model;
		const input = [
			{ type: "text", text: req.prompt },
			...(req.inputImages ?? []).map(img => ({ type: "image", data: img.data, mimeType: img.mimeType })),
		];

		const genRes = await tryAsync(
			() => Promise.resolve(callRegistry(reg, "generateImages", model, { input }, { signal })),
			fromUnknownError,
		);
		if (!genRes.ok) {
			return genRes;
		}
		const out = genRes.value;
		if (!isRecord(out)) {
			return err(providerHttp(provider, 0, "generateImages returned no result", false));
		}
		if (out["stopReason"] === "aborted") {
			return err(abortedError());
		}
		if (out["stopReason"] === "error") {
			return err(providerHttp(provider, 0, readString(out, "errorMessage") ?? "generateImages failed", false));
		}
		const output = Array.isArray(out["output"]) ? out["output"].filter(isRecord) : [];
		const images: NativeGeneratedImage[] = [];
		for (const item of output) {
			const data = readString(item, "data");
			const mimeType = readString(item, "mimeType");
			if (item["type"] === "image" && data !== undefined && mimeType !== undefined) {
				images.push({ data, mimeType });
			}
		}
		const reportedModel = readString(out, "model");
		const usage = toNativeUsage(out["usage"]);
		return ok({
			images,
			...(reportedModel !== undefined ? { reportedModel } : {}),
			...(usage !== undefined ? { usage } : {}),
		});
	}
}

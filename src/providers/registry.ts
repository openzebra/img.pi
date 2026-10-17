import type { Capability, ImgError } from "../core/errors.js";
import { modelNotFound, noImageModels } from "../core/errors.js";
import { fuzzySuggest } from "../core/ids.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import { HostNativeProvider } from "./host-native.js";
import type { ImageProvider, ProviderCtx, ProviderModel } from "./port.js";

export interface ResolvedModelEntry {
	readonly model: ProviderModel;
	readonly provider: ImageProvider;
}

export interface ModelFilter {
	readonly provider?: string;
	readonly capability?: Capability;
}

/** Selectors meaning "let the host decide" (`host:auto` is the pre-v2 spelling). */
const AUTO_SELECTORS: ReadonlySet<string> = new Set(["auto", "host:auto"]);

const MAX_SUGGESTIONS = 3;

export const IMG_MODEL_FLAG = "img-model";

function explicitSelector(v: string | boolean | undefined): string | undefined {
	if (typeof v !== "string") {
		return undefined;
	}
	const clean = v.trim();
	return clean.length > 0 && !AUTO_SELECTORS.has(clean.toLowerCase()) ? clean : undefined;
}

function matches(model: ProviderModel, selector: string): boolean {
	const want = selector.toLowerCase();
	const id = model.id.toLowerCase();
	return id === want || id.slice(id.indexOf("/") + 1) === want;
}

export class ProviderRegistry {
	private readonly provider: ImageProvider;

	public constructor(provider: ImageProvider = new HostNativeProvider()) {
		this.provider = provider;
	}

	public async listModels(
		ctx: ProviderCtx,
		filter: ModelFilter = {},
	): Promise<Result<readonly ResolvedModelEntry[], ImgError>> {
		const res = await this.provider.models(ctx);
		if (!res.ok) {
			return res;
		}
		const wantProvider = filter.provider?.trim().toLowerCase();
		return ok(
			res.value
				.filter(
					m =>
						wantProvider === undefined || wantProvider.length === 0 || m.provider.toLowerCase() === wantProvider,
				)
				.filter(m => filter.capability === undefined || m.caps.has(filter.capability))
				.map(model => ({ model, provider: this.provider })),
		);
	}

	public async resolveModel(
		requestedModel: string | undefined,
		ctx: ProviderCtx,
	): Promise<Result<ResolvedModelEntry, ImgError>> {
		const catalogRes = await this.listModels(ctx);
		if (!catalogRes.ok) {
			return catalogRes;
		}
		const catalog = catalogRes.value;
		if (catalog.length === 0) {
			return err(noImageModels());
		}
		const find = (selector: string): ResolvedModelEntry | undefined => {
			const target = ctx.config.aliases[selector] ?? selector;
			return catalog.find(e => matches(e.model, target));
		};

		const requested = explicitSelector(requestedModel);
		if (requested !== undefined) {
			const hit = find(requested);
			if (hit !== undefined) {
				return ok(hit);
			}
			const candidates = [...catalog.map(e => e.model.id), ...Object.keys(ctx.config.aliases)];
			return err(modelNotFound(requested, fuzzySuggest(requested, candidates, MAX_SUGGESTIONS)));
		}

		// Preferences that may name a model no longer available fall through to the next source.
		const preferences = [
			explicitSelector(ctx.host.getFlag(IMG_MODEL_FLAG)),
			explicitSelector(ctx.config.defaults.model),
			explicitSelector(ctx.host.configuredImageModel(ctx.hostCtx)),
		];
		for (const pref of preferences) {
			const hit = pref !== undefined ? find(pref) : undefined;
			if (hit !== undefined) {
				return ok(hit);
			}
		}
		const first = catalog[0];
		return first !== undefined ? ok(first) : err(noImageModels());
	}
}

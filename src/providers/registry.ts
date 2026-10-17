import type { Capability, ImgError } from "../core/errors.js";
import { modelNotFound } from "../core/errors.js";
import { fuzzySuggest } from "../core/ids.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import { A1111Provider } from "./a1111.js";
import { ComfyUIProvider } from "./comfyui.js";
import { FalProvider } from "./fal.js";
import { HostNativeProvider } from "./host-native.js";
import { MockProvider } from "./mock.js";
import type { ImageProvider, ProviderCtx, ProviderModel } from "./port.js";
import { ReplicateProvider } from "./replicate.js";
import { StabilityProvider } from "./stability.js";

export interface ResolvedModelEntry {
	readonly model: ProviderModel;
	readonly provider: ImageProvider;
}

export class ProviderRegistry {
	private readonly providers: readonly ImageProvider[];
	private readonly replicateProvider: ReplicateProvider;
	private readonly hostNativeProvider: HostNativeProvider;

	public constructor(customProviders?: readonly ImageProvider[]) {
		this.hostNativeProvider = new HostNativeProvider();
		this.replicateProvider = new ReplicateProvider();
		this.providers =
			customProviders ??
			Object.freeze([
				this.hostNativeProvider,
				new FalProvider(),
				this.replicateProvider,
				new StabilityProvider(),
				new ComfyUIProvider(),
				new A1111Provider(),
				new MockProvider(),
			]);
	}

	public async listModels(
		ctx: ProviderCtx,
		filter?: { readonly provider?: string; readonly capability?: Capability },
	): Promise<Result<readonly ResolvedModelEntry[], ImgError>> {
		const entries: ResolvedModelEntry[] = [];
		for (const prov of this.providers) {
			const res = await prov.models(ctx);
			if (!res.ok) {
				continue;
			}
			for (const m of res.value) {
				if (filter?.provider !== undefined && filter.provider.length > 0) {
					const pf = filter.provider.toLowerCase();
					if (m.provider.toLowerCase() !== pf && prov.id.toLowerCase() !== pf) {
						continue;
					}
				}
				if (filter?.capability !== undefined && !m.caps.has(filter.capability)) {
					continue;
				}
				entries.push({ model: m, provider: prov });
			}
		}
		return ok(entries);
	}

	public async resolveModel(
		requestedModel: string | undefined,
		ctx: ProviderCtx,
	): Promise<Result<ResolvedModelEntry, ImgError>> {
		const allRes = await this.listModels(ctx);
		if (!allRes.ok) {
			return allRes;
		}
		const catalog = allRes.value;

		const findInCatalog = (candidate: string): ResolvedModelEntry | undefined => {
			const clean = candidate.trim();
			if (clean.length === 0 || clean === "host:auto" || clean === "auto") {
				return undefined;
			}
			// 1. Exact ID match
			const exact = catalog.find(e => e.model.id.toLowerCase() === clean.toLowerCase());
			if (exact !== undefined) {
				return exact;
			}
			// 2. Alias lookup
			const aliasTarget = ctx.config.aliases[clean];
			if (aliasTarget !== undefined) {
				const aliased = catalog.find(e => e.model.id.toLowerCase() === aliasTarget.toLowerCase());
				if (aliased !== undefined) {
					return aliased;
				}
			}
			// 3. Short ID match (e.g. "gpt-image-1" -> "openai/gpt-image-1")
			const shortMatch = catalog.find(e => {
				const shortName = e.model.id.split("/").slice(1).join("/");
				return shortName.toLowerCase() === clean.toLowerCase();
			});
			if (shortMatch !== undefined) {
				return shortMatch;
			}
			// 4. Dynamic replicate/<owner>/<name>[:ver] support
			if (clean.startsWith("replicate/") && clean.split("/").length >= 3 && ctx.config.providers.replicate.enabled) {
				const hasKey = ctx.secrets.hasDirectKey("replicate", ctx.config);
				return {
					model: this.replicateProvider.createDynamicModel(clean, hasKey),
					provider: this.replicateProvider,
				};
			}
			return undefined;
		};

		// Step 1 & 2: Explicit model param or alias
		if (
			requestedModel !== undefined &&
			requestedModel.trim().length > 0 &&
			requestedModel.trim() !== "host:auto" &&
			requestedModel.trim() !== "auto"
		) {
			const hit = findInCatalog(requestedModel);
			if (hit !== undefined) {
				return ok(hit);
			}
			const allCandidates = [...catalog.map(e => e.model.id), ...Object.keys(ctx.config.aliases)];
			const suggestions = fuzzySuggest(requestedModel, allCandidates, 3);
			return err(modelNotFound(requestedModel, suggestions));
		}

		// Step 3: Session flag (--img-model) if set
		const flagModel = ctx.host.getFlag("img-model");
		if (typeof flagModel === "string" && flagModel.trim().length > 0) {
			const hit = findInCatalog(flagModel);
			if (hit !== undefined) {
				return ok(hit);
			}
		}

		// Step 4: config.defaults.model (unless "host:auto")
		const defaultModelId = ctx.config.defaults.model;
		if (defaultModelId !== "host:auto" && defaultModelId !== "auto") {
			const hit = findInCatalog(defaultModelId);
			if (hit !== undefined) {
				return ok(hit);
			}
		}

		// Step 5: Host's configured image model
		const hostConfigured = ctx.host.configuredImageModel(ctx.hostCtx);
		if (hostConfigured !== undefined && hostConfigured.trim().length > 0) {
			const hit = findInCatalog(hostConfigured);
			if (hit !== undefined) {
				return ok(hit);
			}
		}

		// Step 6: First available model with a configured key (prefer non-mock first)
		const withKeyNonMock = catalog.find(e => e.model.hasKey === true && e.model.provider !== "mock");
		if (withKeyNonMock !== undefined) {
			return ok(withKeyNonMock);
		}

		// Fallback to first non-mock model in catalog or mock/gradient
		const firstCatalog = catalog[0];
		if (firstCatalog !== undefined) {
			return ok(firstCatalog);
		}

		return err(modelNotFound(requestedModel ?? "host:auto", []));
	}
}

import { formatImgError, fromUnknownError, noImageModels } from "../core/errors.js";
import { tryAsync } from "../core/result.js";
import type {
	ComponentLike,
	PortableCtx,
	PortableRenderResultOpts,
	PortableTheme,
	PortableTool,
	PortableToolResult,
	PortableToolUpdateCallback,
} from "../host/port.js";
import type { ProviderModel } from "../providers/port.js";
import type { ResolvedModelEntry } from "../providers/registry.js";
import { renderCallCard } from "../ui/components/job-card.js";
import { buildCallVM, MemoizedComponent } from "../ui/view-models.js";
import type { ToolRuntimeDeps } from "./result.js";
import { noteForToolResult } from "./result.js";
import type { ImgListModelsParams } from "./schemas.js";
import { IMG_LIST_MODELS_SCHEMA } from "./schemas.js";

export const IMG_LIST_MODELS_DESCRIPTION =
	"List the image generation models available in this session. They come from the providers the user has " +
	"connected in the host, so only usable models appear. The entry marked 'default' is used when no model is given. " +
	"Example: {capability:'img2img'} lists models that can edit images.";

export interface ListModelsDetails {
	readonly models: readonly ProviderModel[];
	readonly defaultModelId?: string;
}

function capabilityLabel(m: ProviderModel): string {
	return m.caps.has("img2img") ? "generate + edit" : "generate";
}

export function formatModelsTable(entries: readonly ResolvedModelEntry[], defaultModelId: string | undefined): string {
	if (entries.length === 0) {
		return formatImgError(noImageModels());
	}
	const lines = [`Image models available (${entries.length}):`];
	let currentProvider: string | undefined;
	for (const { model } of entries) {
		if (model.providerLabel !== currentProvider) {
			currentProvider = model.providerLabel;
			lines.push(currentProvider);
		}
		const marker = model.id === defaultModelId ? "  ← default" : "";
		lines.push(`  - ${model.id} · ${model.label} · ${capabilityLabel(model)}${marker}`);
	}
	return lines.join("\n");
}

export function createImgListModelsTool(deps: ToolRuntimeDeps): PortableTool<ImgListModelsParams, ListModelsDetails> {
	const noColor = process.env["NO_COLOR"] !== undefined;

	return {
		name: "img_list_models",
		label: "List Image Models",
		approval: "read",
		description: IMG_LIST_MODELS_DESCRIPTION,
		parameters: IMG_LIST_MODELS_SCHEMA.jsonSchema,
		async execute(
			_toolCallId: string,
			rawParams: ImgListModelsParams,
			_signal: AbortSignal | undefined,
			_onUpdate: PortableToolUpdateCallback<ListModelsDetails> | undefined,
			ctx: PortableCtx,
		): Promise<PortableToolResult<ListModelsDetails>> {
			const topRes = await tryAsync<PortableToolResult<ListModelsDetails>, ReturnType<typeof fromUnknownError>>(
				async () => {
					const valid = IMG_LIST_MODELS_SCHEMA.validate(rawParams);
					if (!valid.ok) {
						return Object.freeze({
							content: Object.freeze([{ type: "text" as const, text: formatImgError(valid.error) }]),
							isError: true,
						});
					}
					const pDeps = deps.getPipelineDeps(ctx);
					const listRes = await pDeps.registry.listModels(pDeps, {
						...(valid.value.provider !== undefined ? { provider: valid.value.provider } : {}),
						...(valid.value.capability !== undefined ? { capability: valid.value.capability } : {}),
					});
					if (!listRes.ok) {
						return Object.freeze({
							content: Object.freeze([{ type: "text" as const, text: formatImgError(listRes.error) }]),
							isError: true,
						});
					}
					const defaultRes = await pDeps.registry.resolveModel(undefined, pDeps);
					const defaultModelId = defaultRes.ok ? defaultRes.value.model.id : undefined;
					const text = formatModelsTable(listRes.value, defaultModelId);
					const models = Object.freeze(listRes.value.map(e => e.model));
					return Object.freeze({
						content: Object.freeze([{ type: "text" as const, text }]),
						details: Object.freeze({ models, ...(defaultModelId !== undefined ? { defaultModelId } : {}) }),
						isError: false,
					});
				},
				fromUnknownError,
			);

			if (!topRes.ok) {
				return Object.freeze({
					content: Object.freeze([{ type: "text" as const, text: formatImgError(topRes.error) }]),
					isError: true,
				});
			}
			return topRes.value;
		},
		renderCall(args: ImgListModelsParams, theme: PortableTheme): ComponentLike {
			const filterDesc = [
				args.provider !== undefined ? `provider=${args.provider}` : "",
				args.capability !== undefined ? `cap=${args.capability}` : "",
			]
				.filter(s => s.length > 0)
				.join(" ");
			const vm = buildCallVM({
				toolName: "img_list_models",
				prompt: filterDesc.length > 0 ? filterDesc : "all models",
				noColor,
			});
			return new MemoizedComponent(vm, renderCallCard, theme);
		},
		renderResult(
			result: PortableToolResult<ListModelsDetails>,
			_opts: PortableRenderResultOpts,
			theme: PortableTheme,
		): ComponentLike {
			return noteForToolResult("img_list_models", result, theme);
		},
	};
}

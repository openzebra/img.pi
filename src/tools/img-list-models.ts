import { formatImgError, fromUnknownError } from "../core/errors.js";
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
import { getGlyphs } from "../ui/glyphs.js";
import { buildCallVM, MemoizedComponent } from "../ui/view-models.js";
import type { ToolRuntimeDeps } from "./result.js";
import type { ImgListModelsParams } from "./schemas.js";
import { IMG_LIST_MODELS_SCHEMA } from "./schemas.js";

export const IMG_LIST_MODELS_DESCRIPTION =
	"List available image and texture generation models across host-native and direct providers with capabilities, sizes, key status, and cost hints. " +
	"Examples: (1) Photo models: {capability:'txt2img'} (2) Seamless texture models: {capability:'native_tiling'}.";

export interface ListModelsDetails {
	readonly models: readonly ProviderModel[];
}

export function formatModelsTable(entries: readonly ResolvedModelEntry[], noColor = false): string {
	if (entries.length === 0) {
		return "No matching image generation models found.";
	}
	const g = getGlyphs(noColor);
	const lines: string[] = [
		`Found ${entries.length} model(s) [key: ${g.check}=ready ${g.cross}=missing ${g.home}=local]:`,
	];
	for (const entry of entries) {
		const m = entry.model;
		const isLocal = m.provider === "comfyui" || m.provider === "a1111" || m.provider === "mock";
		const keyGlyph = isLocal ? g.home : m.hasKey !== false ? g.check : g.cross;
		const capsList = Array.from(m.caps).join(",");
		const sizesRule = m.sizes;
		let sizesStr: string;
		switch (sizesRule.kind) {
			case "fixed":
				sizesStr = sizesRule.sizes.map(s => `${s.width}×${s.height}`).join(",");
				break;
			case "multiple":
				sizesStr = `${sizesRule.min}..${sizesRule.max} (step ${sizesRule.step})`;
				break;
			case "aspects":
				sizesStr = `aspects:${sizesRule.aspects.join(",")} tiers:${(sizesRule.resolutions ?? ["1K"]).join(",")}`;
				break;
			case "range":
				sizesStr = `${sizesRule.min}..${sizesRule.max}`;
				break;
			case "any":
				sizesStr = `${sizesRule.min ?? 64}..${sizesRule.max ?? 8192}`;
				break;
			default: {
				const _exhaustive: never = sizesRule;
				sizesStr = String(_exhaustive);
			}
		}
		const costStr =
			m.costHint ?? (m.costPerImageUsd !== undefined ? `$${m.costPerImageUsd.toFixed(3)}/img` : "host/local");
		lines.push(
			`- ${keyGlyph} ${m.id} (${m.provider}) · cost: ${costStr} · sizes: [${sizesStr}] · caps: {${capsList}}`,
		);
	}
	return lines.join("\n");
}

export function createImgListModelsTool(deps: ToolRuntimeDeps): PortableTool<ImgListModelsParams, ListModelsDetails> {
	const noColor = process.env["NO_COLOR"] !== undefined;

	return {
		name: "img_list_models",
		label: "List Image Models",
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
					const text = formatModelsTable(listRes.value, noColor);
					const models = Object.freeze(listRes.value.map(e => e.model));
					return Object.freeze({
						content: Object.freeze([{ type: "text" as const, text }]),
						details: Object.freeze({ models }),
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
			const count = result.details?.models.length ?? 0;
			const vm = buildCallVM({
				toolName: "img_list_models",
				prompt: `${count} models available`,
				noColor,
			});
			return new MemoizedComponent(vm, renderCallCard, theme);
		},
	};
}

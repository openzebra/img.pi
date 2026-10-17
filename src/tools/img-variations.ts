import type { ImgConfig } from "../config/schema.js";
import type { ImgError } from "../core/errors.js";
import { configInvalid, fromUnknownError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import type { GenerationRequest } from "../domain/request.js";
import type {
	AgentToolContentItem,
	PortableCtx,
	PortableTool,
	PortableToolResult,
	PortableToolUpdateCallback,
} from "../host/port.js";
import { runVariationsBatch } from "../pipeline/run.js";
import { formatBytes } from "../ui/theme.js";
import type { GenerateDetails, ToolRuntimeDeps } from "./result.js";
import {
	buildErrorToolResult,
	buildGenerateDetails,
	buildGenerateRequest,
	createPortableJobRenderers,
	createProgressReporter,
} from "./result.js";
import type { ImgGenerateParams, ImgVariationsParams, RawVarySpec } from "./schemas.js";
import { IMG_GENERATE_SCHEMA, IMG_VARIATIONS_SCHEMA } from "./schemas.js";

export const IMG_VARIATIONS_DESCRIPTION =
	"Generate a batch of variations across seeds, prompts, models, or styles (cartesian or zip), writing a labeled contact sheet. " +
	"Examples: (1) Photo seed sweep: {base:{prompt:'studio product shot of ceramic mug', style:'photo'}, vary:{seeds:[101,102,103,104]}} " +
	"(2) Texture style sweep: {base:{prompt:'ancient stone wall', width:1024, height:1024}, vary:{styles:['pbr-texture','pixel-art']}, mode:'cartesian'}.";

interface ExpandedVariations {
	readonly requests: readonly GenerationRequest[];
	readonly labels: readonly string[];
	readonly outputDir: string;
	readonly basePrompt: string;
}

export function expandVariations(
	base: ImgGenerateParams,
	vary: RawVarySpec,
	mode: "cartesian" | "zip",
	config: ImgConfig,
): Result<ExpandedVariations, ImgError> {
	const seedsArr = vary.seeds !== undefined && vary.seeds.length > 0 ? vary.seeds : undefined;
	const promptsArr = vary.prompts !== undefined && vary.prompts.length > 0 ? vary.prompts : undefined;
	const modelsArr = vary.models !== undefined && vary.models.length > 0 ? vary.models : undefined;
	const stylesArr = vary.styles !== undefined && vary.styles.length > 0 ? vary.styles : undefined;

	if (seedsArr === undefined && promptsArr === undefined && modelsArr === undefined && stylesArr === undefined) {
		return err(configInvalid("vary", "At least one vary axis (seeds, prompts, models, styles) must be non-empty"));
	}

	const rawCombos: {
		readonly seed?: number;
		readonly prompt: string;
		readonly model?: string;
		readonly style?: string;
		readonly label: string;
	}[] = [];

	if (mode === "zip") {
		const lengths: number[] = [];
		if (seedsArr !== undefined) lengths.push(seedsArr.length);
		if (promptsArr !== undefined) lengths.push(promptsArr.length);
		if (modelsArr !== undefined) lengths.push(modelsArr.length);
		if (stylesArr !== undefined) lengths.push(stylesArr.length);

		const n = lengths[0] ?? 0;
		for (const len of lengths) {
			if (len !== n) {
				return err(configInvalid("vary", "All non-empty vary axes must have equal length when mode='zip'"));
			}
		}

		for (let i = 0; i < n; i++) {
			const s = seedsArr !== undefined ? seedsArr[i] : base.seed;
			const p = (promptsArr !== undefined ? promptsArr[i] : undefined) ?? base.prompt;
			const m = modelsArr !== undefined ? modelsArr[i] : base.model;
			const st = stylesArr !== undefined ? stylesArr[i] : base.style;
			const labelParts: string[] = [`#${i + 1}`];
			if (m !== undefined) labelParts.push(m);
			if (st !== undefined) labelParts.push(st);
			if (s !== undefined) labelParts.push(`s:${s}`);
			rawCombos.push({
				...(s !== undefined ? { seed: s } : {}),
				prompt: p,
				...(m !== undefined ? { model: m } : {}),
				...(st !== undefined ? { style: st } : {}),
				label: labelParts.join(" "),
			});
		}
	} else {
		const seedsAxis: readonly (number | undefined)[] = seedsArr ?? [base.seed];
		const promptsAxis: readonly string[] = promptsArr ?? [base.prompt];
		const modelsAxis: readonly (string | undefined)[] = modelsArr ?? [base.model];
		const stylesAxis: readonly (string | undefined)[] = stylesArr ?? [base.style];

		let idx = 1;
		for (const p of promptsAxis) {
			for (const m of modelsAxis) {
				for (const st of stylesAxis) {
					for (const s of seedsAxis) {
						const labelParts: string[] = [`#${idx}`];
						if (m !== undefined) labelParts.push(m);
						if (st !== undefined) labelParts.push(st);
						if (s !== undefined) labelParts.push(`s:${s}`);
						rawCombos.push({
							...(s !== undefined ? { seed: s } : {}),
							prompt: p,
							...(m !== undefined ? { model: m } : {}),
							...(st !== undefined ? { style: st } : {}),
							label: labelParts.join(" "),
						});
						idx++;
					}
				}
			}
		}
	}

	if (rawCombos.length > config.limits.maxBatch) {
		return err(
			configInvalid(
				"vary",
				`Variation count (${rawCombos.length}) exceeds limits.maxBatch (${config.limits.maxBatch})`,
			),
		);
	}

	const requests = new Array<GenerationRequest>(rawCombos.length);
	const labels = new Array<string>(rawCombos.length);

	for (let i = 0; i < rawCombos.length; i++) {
		const combo = rawCombos[i];
		if (combo === undefined) continue;
		const mergedParams: ImgGenerateParams = {
			...base,
			prompt: combo.prompt,
			...(combo.seed !== undefined ? { seed: combo.seed } : {}),
			...(combo.model !== undefined ? { model: combo.model } : {}),
			...(combo.style !== undefined ? { style: combo.style } : {}),
			count: 1,
		};
		const reqRes = buildGenerateRequest(mergedParams, config);
		if (!reqRes.ok) {
			return reqRes;
		}
		requests[i] = reqRes.value;
		labels[i] = combo.label;
	}

	return ok({
		requests: Object.freeze(requests),
		labels: Object.freeze(labels),
		outputDir: base.output_dir ?? config.output.dir,
		basePrompt: base.prompt,
	});
}

export function createImgVariationsTool(deps: ToolRuntimeDeps): PortableTool<ImgVariationsParams, GenerateDetails> {
	const renderers = createPortableJobRenderers<ImgVariationsParams & Record<string, unknown>>(
		"img_variations",
		deps.ticker,
		deps.stats,
	);

	return {
		name: "img_variations",
		label: "Generate Image Variations",
		description: IMG_VARIATIONS_DESCRIPTION,
		parameters: IMG_VARIATIONS_SCHEMA.jsonSchema,
		async execute(
			_toolCallId: string,
			rawParams: ImgVariationsParams,
			signal: AbortSignal | undefined,
			onUpdate: PortableToolUpdateCallback<GenerateDetails> | undefined,
			ctx: PortableCtx,
		): Promise<PortableToolResult<GenerateDetails>> {
			const topRes = await tryAsync(async () => {
				const validTop = IMG_VARIATIONS_SCHEMA.validate(rawParams);
				if (!validTop.ok) {
					return buildErrorToolResult(validTop.error);
				}
				const validBase = IMG_GENERATE_SCHEMA.validate(validTop.value.base);
				if (!validBase.ok) {
					return buildErrorToolResult(validBase.error);
				}

				const pDeps = deps.getPipelineDeps(ctx);
				const mode = validTop.value.mode ?? "cartesian";
				const expandedRes = expandVariations(validBase.value, validTop.value.vary, mode, pDeps.config);
				if (!expandedRes.ok) {
					return buildErrorToolResult(expandedRes.error);
				}

				const reporter = createProgressReporter(onUpdate);
				try {
					const batchRes = await runVariationsBatch(expandedRes.value, pDeps, {
						...(signal !== undefined ? { signal } : {}),
						onProgress: (_completed, _total, latestJob) => {
							reporter.reportState(latestJob);
						},
					});
					if (!batchRes.ok) {
						return buildErrorToolResult(batchRes.error);
					}

					const { jobs, artifacts, contactSheetRelativePath, contactSheetThumbB64, contactSheetThumbMimeType } =
						batchRes.value;
					const lastJob = jobs[jobs.length - 1];
					if (lastJob === undefined) {
						return buildErrorToolResult(configInvalid("vary", "No variation jobs ran"));
					}

					const lines: string[] = [
						`generated ${artifacts.length} variations (${mode}) · base '${expandedRes.value.basePrompt}'`,
					];
					for (let i = 0; i < artifacts.length; i++) {
						const art = artifacts[i];
						if (art === undefined) continue;
						const label = expandedRes.value.labels[i] ?? `#${i + 1}`;
						lines.push(
							`${i + 1}. [${label}] ${art.summary.relativePath} (${art.summary.width}×${art.summary.height}, ${formatBytes(art.summary.bytes)})`,
						);
					}
					if (contactSheetRelativePath !== undefined) {
						lines.push(`contact sheet: ${contactSheetRelativePath}`);
					}

					const content: AgentToolContentItem[] = [{ type: "text", text: lines.join("\n") }];
					const returnMode = validBase.value.return_image ?? pDeps.config.defaults.returnImage;
					if (
						returnMode !== "none" &&
						contactSheetThumbB64 !== undefined &&
						contactSheetThumbMimeType !== undefined
					) {
						content.push({
							type: "image",
							data: contactSheetThumbB64,
							mimeType: contactSheetThumbMimeType,
						});
					}

					return Object.freeze({
						content: Object.freeze(content),
						details: buildGenerateDetails(lastJob, validBase.value.dry_run === true),
						isError: false,
					});
				} finally {
					reporter.dispose();
				}
			}, fromUnknownError);

			if (!topRes.ok) {
				return buildErrorToolResult(topRes.error);
			}
			return topRes.value;
		},
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
	};
}

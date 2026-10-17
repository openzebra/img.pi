import { fromUnknownError } from "../core/errors.js";
import { tryAsync } from "../core/result.js";
import type { PortableCtx, PortableTool, PortableToolResult, PortableToolUpdateCallback } from "../host/port.js";
import { runGenerationJob } from "../pipeline/run.js";
import type { GenerateDetails, ToolRuntimeDeps } from "./result.js";
import {
	buildErrorToolResult,
	buildGenerateRequest,
	buildSuccessToolResult,
	createPortableJobRenderers,
	createProgressReporter,
} from "./result.js";
import type { ImgGenerateParams } from "./schemas.js";
import { IMG_GENERATE_SCHEMA } from "./schemas.js";

export const IMG_GENERATE_DESCRIPTION =
	"Generate images from a text prompt with optional reference images, exact pixel sizing, post-processing, and reproducible sidecars. " +
	"Examples: (1) Photo: {prompt:'brushed steel espresso machine on marble counter', style:'photo', width:1536, height:1024} " +
	"(2) Texture: {prompt:'weathered oak planks', style:'pbr-texture', width:1024, height:1024}.";

export function createImgGenerateTool(deps: ToolRuntimeDeps): PortableTool<ImgGenerateParams, GenerateDetails> {
	const renderers = createPortableJobRenderers<ImgGenerateParams & Record<string, unknown>>(
		"img_generate",
		deps.ticker,
		deps.stats,
	);

	return {
		name: "img_generate",
		label: "Generate Image",
		description: IMG_GENERATE_DESCRIPTION,
		parameters: IMG_GENERATE_SCHEMA.jsonSchema,
		async execute(
			_toolCallId: string,
			rawParams: ImgGenerateParams,
			signal: AbortSignal | undefined,
			onUpdate: PortableToolUpdateCallback<GenerateDetails> | undefined,
			ctx: PortableCtx,
		): Promise<PortableToolResult<GenerateDetails>> {
			const topRes = await tryAsync(async () => {
				const validParams = IMG_GENERATE_SCHEMA.validate(rawParams);
				if (!validParams.ok) {
					return buildErrorToolResult(validParams.error);
				}

				const pDeps = deps.getPipelineDeps(ctx);
				const reqRes = buildGenerateRequest(validParams.value, pDeps.config);
				if (!reqRes.ok) {
					return buildErrorToolResult(reqRes.error);
				}

				const reporter = createProgressReporter(onUpdate);
				try {
					const execRes = await runGenerationJob(reqRes.value, pDeps, {
						...(signal !== undefined ? { signal } : {}),
						onStateChange: state => {
							reporter.reportState(state);
						},
					});
					if (!execRes.ok) {
						return buildErrorToolResult(execRes.error);
					}
					return buildSuccessToolResult(execRes.value);
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

import { fromUnknownError } from "../core/errors.js";
import { tryAsync } from "../core/result.js";
import type { PortableCtx, PortableTool, PortableToolResult, PortableToolUpdateCallback } from "../host/port.js";
import { runGenerationJob } from "../pipeline/run.js";
import type { GenerateDetails, ToolRuntimeDeps } from "./result.js";
import {
	buildEditRequest,
	buildErrorToolResult,
	buildSuccessToolResult,
	createPortableJobRenderers,
	createProgressReporter,
} from "./result.js";
import type { ImgEditParams } from "./schemas.js";
import { IMG_EDIT_SCHEMA } from "./schemas.js";

export const IMG_EDIT_DESCRIPTION =
	"Edit, inpaint, outpaint, or vary an existing image (file path, URL, data URI, or @last / @job:<id>). " +
	"Examples: (1) Photo edit: {image:'@last', prompt:'replace sky with golden hour sunset', mode:'edit', strength:0.65} " +
	"(2) Texture seam inpaint: {image:'stone.png', mask:'seam_mask.png', prompt:'seamless mossy stone', mode:'inpaint'}.";

export function createImgEditTool(deps: ToolRuntimeDeps): PortableTool<ImgEditParams, GenerateDetails> {
	const renderers = createPortableJobRenderers<ImgEditParams & Record<string, unknown>>(
		"img_edit",
		deps.ticker,
		deps.stats,
	);

	return {
		name: "img_edit",
		label: "Edit Image",
		description: IMG_EDIT_DESCRIPTION,
		parameters: IMG_EDIT_SCHEMA.jsonSchema,
		async execute(
			_toolCallId: string,
			rawParams: ImgEditParams,
			signal: AbortSignal | undefined,
			onUpdate: PortableToolUpdateCallback<GenerateDetails> | undefined,
			ctx: PortableCtx,
		): Promise<PortableToolResult<GenerateDetails>> {
			const topRes = await tryAsync(async () => {
				const validParams = IMG_EDIT_SCHEMA.validate(rawParams);
				if (!validParams.ok) {
					return buildErrorToolResult(validParams.error);
				}

				const pDeps = deps.getPipelineDeps(ctx);
				const reqRes = buildEditRequest(validParams.value, pDeps.config);
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

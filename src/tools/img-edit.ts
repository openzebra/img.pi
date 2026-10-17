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
	"Change an existing image: apply edits, inpaint a masked area, outpaint, or make a variation. Call this whenever " +
	"the user asks to modify, fix, recolor, extend, or restyle an image; '@last' is the most recent result, " +
	"'@job:<id>' a specific job, or pass a file path / URL. Requires a model that accepts input images (img_list_models " +
	"shows 'generate + edit'). The result is saved under .pi/img/images. " +
	"Examples: {image:'@last', prompt:'make the cat black and add a red collar'} · " +
	"{image:'logo.png', prompt:'same logo on a transparent background', mode:'edit'}.";

const IMG_EDIT_SNIPPET = "img_edit: modify an existing image ('@last', a path, or a URL) from a text instruction";

export function createImgEditTool(deps: ToolRuntimeDeps): PortableTool<ImgEditParams, GenerateDetails> {
	const renderers = createPortableJobRenderers<ImgEditParams & Record<string, unknown>>("img_edit", deps);

	return {
		name: "img_edit",
		label: "Edit Image",
		description: IMG_EDIT_DESCRIPTION,
		essential: true,
		approval: "write",
		promptSnippet: IMG_EDIT_SNIPPET,
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

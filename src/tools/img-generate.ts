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
	"Create a new image from a text description. Call this whenever the user asks you to draw, generate, create, " +
	"render, or illustrate a picture, photo, icon, logo, sprite, or artwork; the user never needs a command. " +
	"Write a detailed visual prompt (subject, setting, composition, lighting, style). The model defaults to the best " +
	"one connected in this session; pass `model` only if the user names one (see img_list_models). " +
	"The image is saved under .pi/img/images and its path is returned. " +
	"Examples: {prompt:'a fluffy ginger cat curled on a sunny windowsill, soft morning light, photo'} · " +
	"{prompt:'flat vector app icon of a paper plane', aspect_ratio:'1:1', style:'ui-icon'}.";

const IMG_GENERATE_SNIPPET = "img_generate: create an image from a text prompt (saved under .pi/img/images)";

const IMG_GENERATE_GUIDELINES: readonly string[] = Object.freeze([
	"When the user asks for a picture, drawing, illustration, photo, icon, or artwork, call img_generate yourself with a detailed prompt.",
	"To change an existing image (including one just generated, via '@last'), call img_edit instead.",
]);

export function createImgGenerateTool(deps: ToolRuntimeDeps): PortableTool<ImgGenerateParams, GenerateDetails> {
	const renderers = createPortableJobRenderers<ImgGenerateParams & Record<string, unknown>>("img_generate", deps);

	return {
		name: "img_generate",
		label: "Generate Image",
		description: IMG_GENERATE_DESCRIPTION,
		essential: true,
		approval: "write",
		promptSnippet: IMG_GENERATE_SNIPPET,
		promptGuidelines: IMG_GENERATE_GUIDELINES,
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

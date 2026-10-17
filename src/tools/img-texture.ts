import { fromUnknownError } from "../core/errors.js";
import { tryAsync } from "../core/result.js";
import type { PortableCtx, PortableTool, PortableToolResult, PortableToolUpdateCallback } from "../host/port.js";
import { runGenerationJob } from "../pipeline/run.js";
import type { GenerateDetails, ToolRuntimeDeps } from "./result.js";
import {
	buildErrorToolResult,
	buildSuccessToolResult,
	buildTextureRequest,
	createPortableJobRenderers,
	createProgressReporter,
} from "./result.js";
import type { ImgTextureParams } from "./schemas.js";
import { IMG_TEXTURE_SCHEMA } from "./schemas.js";

export const IMG_TEXTURE_DESCRIPTION =
	"Generate seamless tileable PBR texture sets (albedo, normal, height, roughness, ao, metallic, orm) plus 2x2 preview and glTF material.json. " +
	"Examples: (1) Photo-real stone: {material:'wet mossy cobblestone path', resolution:1024, tileable:true} " +
	"(2) Metal texture: {material:'corroded riveted iron plate', maps:['albedo','normal','roughness','metallic','orm'], orm_pack:true}.";

export function createImgTextureTool(deps: ToolRuntimeDeps): PortableTool<ImgTextureParams, GenerateDetails> {
	const renderers = createPortableJobRenderers<ImgTextureParams & Record<string, unknown>>("img_texture", deps);

	return {
		name: "img_texture",
		label: "Generate PBR Texture",
		description: IMG_TEXTURE_DESCRIPTION,
		approval: "write",
		parameters: IMG_TEXTURE_SCHEMA.jsonSchema,
		async execute(
			_toolCallId: string,
			rawParams: ImgTextureParams,
			signal: AbortSignal | undefined,
			onUpdate: PortableToolUpdateCallback<GenerateDetails> | undefined,
			ctx: PortableCtx,
		): Promise<PortableToolResult<GenerateDetails>> {
			const topRes = await tryAsync(async () => {
				const validParams = IMG_TEXTURE_SCHEMA.validate(rawParams);
				if (!validParams.ok) {
					return buildErrorToolResult(validParams.error);
				}

				const pDeps = deps.getPipelineDeps(ctx);
				const reqRes = buildTextureRequest(validParams.value, pDeps.config);
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

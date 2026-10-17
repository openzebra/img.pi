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
	"Create a seamless, tileable PBR texture set (albedo, normal, height, roughness, ao, metallic, orm) with a 2×2 " +
	"tile preview and a glTF material.json, saved under .pi/img/textures. Call this whenever the user asks for a " +
	"texture, material, tileable/seamless surface, or PBR maps (use img_generate for ordinary pictures). " +
	"Resolution: set `resolution` to the size the user asks for: 4K → 4096, 2K → 2048, 1K → 1024, 512 → 512; " +
	"if they name none, omit it (the configured default applies). " +
	"Be honest about detail: the image model produces its native size (often about 1K) and the maps are resized up " +
	"to `resolution`, so a 4096 set has 4K pixels but roughly the model's native detail. Mention this when the user " +
	"asks for 4K or 2K. " +
	"Examples: {material:'wet mossy cobblestone path', resolution:4096} · " +
	"{material:'corroded riveted iron plate', maps:['albedo','normal','roughness','metallic','orm'], orm_pack:true}.";

const IMG_TEXTURE_SNIPPET = "img_texture: create a seamless PBR texture set (albedo, normal, roughness, …) up to 4096²";

const IMG_TEXTURE_GUIDELINES: readonly string[] = Object.freeze([
	"For textures, materials, or seamless/tileable surfaces, call img_texture (not img_generate).",
	"Map the requested size to img_texture `resolution`: 4K → 4096, 2K → 2048, 1K → 1024. Omit it if no size is named.",
	"When delivering 2K/4K textures, tell the user the maps are upscaled from the image model's native output, so fine detail is limited by the model.",
]);

export function createImgTextureTool(deps: ToolRuntimeDeps): PortableTool<ImgTextureParams, GenerateDetails> {
	const renderers = createPortableJobRenderers<ImgTextureParams & Record<string, unknown>>("img_texture", deps);

	return {
		name: "img_texture",
		label: "Generate PBR Texture",
		description: IMG_TEXTURE_DESCRIPTION,
		approval: "write",
		promptSnippet: IMG_TEXTURE_SNIPPET,
		promptGuidelines: IMG_TEXTURE_GUIDELINES,
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

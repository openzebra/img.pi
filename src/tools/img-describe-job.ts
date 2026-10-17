import { formatImgError, fromUnknownError } from "../core/errors.js";
import { tryAsync } from "../core/result.js";
import type { SidecarDocument } from "../domain/artifact.js";
import type {
	ComponentLike,
	PortableCtx,
	PortableRenderResultOpts,
	PortableTheme,
	PortableTool,
	PortableToolResult,
	PortableToolUpdateCallback,
} from "../host/port.js";
import { renderCallCard } from "../ui/components/job-card.js";
import { buildCallVM, MemoizedComponent } from "../ui/view-models.js";
import type { ToolRuntimeDeps } from "./result.js";
import { noteForToolResult } from "./result.js";
import type { ImgDescribeJobParams } from "./schemas.js";
import { IMG_DESCRIBE_JOB_SCHEMA } from "./schemas.js";

export const IMG_DESCRIBE_JOB_DESCRIPTION =
	"Return the full sidecar JSON metadata (prompt, finalPrompt, seed, model, sizes, SHA-256, PBR settings) for a job ID or '@last' to reproduce or refine an earlier generation. " +
	"Examples: (1) Inspect latest photo generation: {job:'@last'} (2) Inspect texture job by ID prefix: {job:'01JA8'}.";

export interface DescribeJobDetails {
	readonly sidecars: readonly SidecarDocument[];
}

export function createImgDescribeJobTool(
	deps: ToolRuntimeDeps,
): PortableTool<ImgDescribeJobParams, DescribeJobDetails> {
	const noColor = process.env["NO_COLOR"] !== undefined;

	return {
		name: "img_describe_job",
		label: "Describe Image Job",
		description: IMG_DESCRIBE_JOB_DESCRIPTION,
		approval: "read",
		parameters: IMG_DESCRIBE_JOB_SCHEMA.jsonSchema,
		async execute(
			_toolCallId: string,
			rawParams: ImgDescribeJobParams,
			_signal: AbortSignal | undefined,
			_onUpdate: PortableToolUpdateCallback<DescribeJobDetails> | undefined,
			ctx: PortableCtx,
		): Promise<PortableToolResult<DescribeJobDetails>> {
			const topRes = await tryAsync(async () => {
				const valid = IMG_DESCRIBE_JOB_SCHEMA.validate(rawParams);
				if (!valid.ok) {
					return Object.freeze({
						content: Object.freeze([{ type: "text" as const, text: formatImgError(valid.error) }]),
						isError: true,
					});
				}
				const pDeps = deps.getPipelineDeps(ctx);
				const descRes = await pDeps.manifest.describeJob(ctx.cwd, pDeps.config.output.manifest, valid.value.job);
				if (!descRes.ok) {
					return Object.freeze({
						content: Object.freeze([{ type: "text" as const, text: formatImgError(descRes.error) }]),
						isError: true,
					});
				}
				const payload = descRes.value.length === 1 ? descRes.value[0] : descRes.value;
				const text = JSON.stringify(payload, null, 2);
				return Object.freeze({
					content: Object.freeze([{ type: "text" as const, text }]),
					details: Object.freeze({ sidecars: descRes.value }),
					isError: false,
				});
			}, fromUnknownError);

			if (!topRes.ok) {
				return Object.freeze({
					content: Object.freeze([{ type: "text" as const, text: formatImgError(topRes.error) }]),
					isError: true,
				});
			}
			return topRes.value;
		},
		renderCall(args: ImgDescribeJobParams, theme: PortableTheme): ComponentLike {
			const vm = buildCallVM({
				toolName: "img_describe_job",
				prompt: args.job,
				noColor,
			});
			return new MemoizedComponent(vm, renderCallCard, theme);
		},
		renderResult(
			result: PortableToolResult<DescribeJobDetails>,
			_opts: PortableRenderResultOpts,
			theme: PortableTheme,
			args?: ImgDescribeJobParams,
		): ComponentLike {
			const first = result.details?.sidecars[0];
			const summary =
				first !== undefined ? `${first.job} · ${first.model} · seed ${first.seed}` : (args?.job ?? "@last");
			return noteForToolResult("img_describe_job", result, theme, result.isError === true ? undefined : summary);
		},
	};
}

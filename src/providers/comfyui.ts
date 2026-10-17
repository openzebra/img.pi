import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Capability, ImgError } from "../core/errors.js";
import { providerHttp } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import type { SizeRule } from "../domain/size.js";
import type { ImageProvider, ProviderCtx, ProviderIO, ProviderModel, RawImage, ResolvedJob } from "./port.js";

const COMFY_SIZE_RULE: SizeRule = deepFreeze({
	kind: "multiple",
	step: 8,
	min: 64,
	max: 4096,
});

const COMFY_CAPS: ReadonlySet<Capability> = new Set<Capability>([
	"txt2img",
	"img2img",
	"inpaint",
	"multi_ref",
	"seed",
	"negative_prompt",
	"arbitrary_size",
	"steps",
	"guidance",
	"partial_previews",
	"native_tiling",
	"count",
]);

const DEFAULT_SDXL_PBR_WORKFLOW_TEMPLATE = JSON.stringify({
	"3": {
		inputs: {
			seed: "{{seed}}",
			steps: "{{steps}}",
			cfg: "{{cfg}}",
			sampler_name: "euler",
			scheduler: "normal",
			denoise: 1,
			model: ["4", 0],
			positive: ["6", 0],
			negative: ["7", 0],
			latent_image: ["5", 0],
		},
		class_type: "KSampler",
	},
	"4": {
		inputs: {
			ckpt_name: "sd_xl_base_1.0.safetensors",
			tiling: "{{tiling}}",
		},
		class_type: "CheckpointLoaderSimple",
	},
	"5": {
		inputs: {
			width: "{{width}}",
			height: "{{height}}",
			batch_size: "{{batch_size}}",
		},
		class_type: "EmptyLatentImage",
	},
	"6": {
		inputs: {
			text: "{{prompt}}",
			clip: ["4", 1],
		},
		class_type: "CLIPTextEncode",
	},
	"7": {
		inputs: {
			text: "{{negative_prompt}}",
			clip: ["4", 1],
		},
		class_type: "CLIPTextEncode",
	},
	"8": {
		inputs: {
			samples: ["3", 0],
			vae: ["4", 2],
		},
		class_type: "VAEDecode",
	},
	"9": {
		inputs: {
			filename_prefix: "img_pi",
			images: ["8", 0],
		},
		class_type: "SaveImage",
	},
});

function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function substituteComfyWorkflowPlaceholders(
	rawTemplate: string,
	vars: {
		readonly prompt: string;
		readonly negativePrompt: string;
		readonly seed: number;
		readonly width: number;
		readonly height: number;
		readonly steps: number;
		readonly cfg: number;
		readonly batchSize: number;
		readonly tiling: boolean;
	},
): unknown {
	const escapeString = (s: string): string => JSON.stringify(s).slice(1, -1);
	const replaced = rawTemplate
		.replace(/"\{\{seed\}\}"/g, String(vars.seed))
		.replace(/\{\{seed\}\}/g, String(vars.seed))
		.replace(/"\{\{width\}\}"/g, String(vars.width))
		.replace(/\{\{width\}\}/g, String(vars.width))
		.replace(/"\{\{height\}\}"/g, String(vars.height))
		.replace(/\{\{height\}\}/g, String(vars.height))
		.replace(/"\{\{steps\}\}"/g, String(vars.steps))
		.replace(/\{\{steps\}\}/g, String(vars.steps))
		.replace(/"\{\{cfg\}\}"/g, String(vars.cfg))
		.replace(/\{\{cfg\}\}/g, String(vars.cfg))
		.replace(/"\{\{batch_size\}\}"/g, String(vars.batchSize))
		.replace(/\{\{batch_size\}\}/g, String(vars.batchSize))
		.replace(/"\{\{tiling\}\}"/g, String(vars.tiling))
		.replace(/\{\{tiling\}\}/g, String(vars.tiling))
		.replace(/\{\{prompt\}\}/g, escapeString(vars.prompt))
		.replace(/\{\{negative_prompt\}\}/g, escapeString(vars.negativePrompt));

	const parsed: unknown = JSON.parse(replaced);
	return parsed;
}

function extractComfyHistoryImages(
	historyData: unknown,
	promptId: string,
): readonly { readonly filename: string; readonly subfolder: string; readonly type: string }[] | undefined {
	if (!isRecord(historyData)) return undefined;
	const entry = historyData[promptId];
	if (!isRecord(entry)) return undefined;
	const outputs = entry["outputs"];
	if (!isRecord(outputs)) return undefined;

	const files: { readonly filename: string; readonly subfolder: string; readonly type: string }[] = [];
	for (const nodeOut of Object.values(outputs)) {
		if (!isRecord(nodeOut) || !Array.isArray(nodeOut["images"])) continue;
		for (const img of nodeOut["images"]) {
			if (isRecord(img) && typeof img["filename"] === "string") {
				files.push({
					filename: img["filename"],
					subfolder: typeof img["subfolder"] === "string" ? img["subfolder"] : "",
					type: typeof img["type"] === "string" ? img["type"] : "output",
				});
			}
		}
	}
	return files.length > 0 ? files : undefined;
}

export class ComfyUIProvider implements ImageProvider {
	public readonly id = "comfyui";

	public async models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>> {
		if (!ctx.config.providers.comfyui.enabled) {
			return ok([]);
		}
		const wfDirRaw = ctx.config.providers.comfyui.workflowsDir;
		const models: ProviderModel[] = [
			Object.freeze({
				id: "comfyui/sdxl-pbr",
				provider: "comfyui",
				label: "ComfyUI SDXL PBR",
				caps: COMFY_CAPS,
				sizes: COMFY_SIZE_RULE,
				maxRefs: 4,
				maxCount: 8,
				costHint: "local",
				costPerImageUsd: 0,
				hasKey: true,
			}),
		];

		if (typeof wfDirRaw === "string" && wfDirRaw.trim().length > 0) {
			const absDir = expandHome(wfDirRaw.trim());
			const entriesRes = await tryAsync(
				() => fs.readdir(absDir),
				(): string[] => [],
			);
			if (entriesRes.ok) {
				for (const name of entriesRes.value) {
					if (!name.endsWith(".json")) continue;
					const wfName = name.slice(0, -5);
					const id = `comfyui/${wfName}`;
					if (models.some(m => m.id === id)) continue;
					models.push(
						Object.freeze({
							id,
							provider: "comfyui",
							label: `ComfyUI ${wfName}`,
							caps: COMFY_CAPS,
							sizes: COMFY_SIZE_RULE,
							maxRefs: 4,
							maxCount: 8,
							costHint: "local",
							costPerImageUsd: 0,
							hasKey: true,
						}),
					);
				}
			}
		}

		return ok(models);
	}

	public async generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>> {
		const baseUrl = (io.config.providers.comfyui.baseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
		const wfSlug = job.model.id.replace(/^comfyui\//, "");
		let rawTemplate = DEFAULT_SDXL_PBR_WORKFLOW_TEMPLATE;

		const wfDirRaw = io.config.providers.comfyui.workflowsDir;
		if (typeof wfDirRaw === "string" && wfDirRaw.trim().length > 0) {
			const wfPath = path.join(expandHome(wfDirRaw.trim()), `${wfSlug}.json`);
			const readRes = await tryAsync(
				() => fs.readFile(wfPath, "utf8"),
				() => undefined,
			);
			if (readRes.ok) {
				rawTemplate = readRes.value;
			}
		}

		let workflowGraph: unknown;
		try {
			workflowGraph = substituteComfyWorkflowPlaceholders(rawTemplate, {
				prompt: job.finalPrompt,
				negativePrompt: job.negativePrompt ?? "",
				seed: job.seed,
				width: job.size.width,
				height: job.size.height,
				steps: job.steps ?? 28,
				cfg: job.guidance ?? 6.5,
				batchSize: job.count,
				tiling: job.tileable === true,
			});
		} catch (e: unknown) {
			return err(
				providerHttp(
					"comfyui",
					400,
					`Failed to build ComfyUI workflow JSON: ${e instanceof Error ? e.message : String(e)}`,
					false,
				),
			);
		}

		const submitRes = await io.http.requestJson({
			provider: "comfyui",
			url: `${baseUrl}/prompt`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: workflowGraph,
				client_id: job.jobId,
			}),
			signal: io.signal,
		});
		if (!submitRes.ok) {
			return submitRes;
		}
		const submitData = submitRes.value.data;
		const promptId =
			isRecord(submitData) && typeof submitData["prompt_id"] === "string" ? submitData["prompt_id"] : undefined;
		if (promptId === undefined) {
			return err(providerHttp("comfyui", 502, "ComfyUI /prompt did not return prompt_id", false));
		}

		let outputFiles:
			| readonly { readonly filename: string; readonly subfolder: string; readonly type: string }[]
			| undefined;

		for (let poll = 0; poll < 180; poll++) {
			const histRes = await io.http.requestJson({
				provider: "comfyui",
				url: `${baseUrl}/history/${encodeURIComponent(promptId)}`,
				method: "GET",
				signal: io.signal,
			});
			if (!histRes.ok) {
				return histRes;
			}
			outputFiles = extractComfyHistoryImages(histRes.value.data, promptId);
			if (outputFiles !== undefined && outputFiles.length > 0) {
				break;
			}
			const totalSteps = job.steps ?? 28;
			const currentStep = Math.min(totalSteps - 1, poll + 1);
			io.emit({
				t: "provider_progress",
				fraction: currentStep / totalSteps,
				step: currentStep,
				steps: totalSteps,
				at: Date.now(),
			});
		}

		if (outputFiles === undefined || outputFiles.length === 0) {
			return err(providerHttp("comfyui", 504, "ComfyUI job produced no output images", false));
		}

		const outImages: RawImage[] = [];
		for (const file of outputFiles) {
			const query = new URLSearchParams({
				filename: file.filename,
				subfolder: file.subfolder,
				type: file.type,
			});
			const viewRes = await io.http.requestBytes({
				provider: "comfyui",
				url: `${baseUrl}/view?${query.toString()}`,
				method: "GET",
				signal: io.signal,
			});
			if (!viewRes.ok) {
				return viewRes;
			}
			outImages.push({
				buffer: viewRes.value.buffer,
				mimeType: viewRes.value.mimeType,
				seed: job.seed,
				reportedModel: wfSlug,
			});
		}

		return ok(outImages);
	}
}

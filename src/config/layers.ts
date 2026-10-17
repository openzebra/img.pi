import { deepFreeze } from "../core/freeze";
import { DEFAULT_CONFIG, type ImgConfig, type PartialConfig } from "./schema";

export type ConfigScope = "default" | "user" | "project" | "session" | "call";

export interface ConfigLayerSet {
	readonly user?: PartialConfig;
	readonly project?: PartialConfig;
	readonly session?: PartialConfig;
	readonly call?: PartialConfig;
}

export function applyPartialConfig(base: ImgConfig, patch: PartialConfig | undefined): ImgConfig {
	if (!patch) return base;

	const nextStyle = patch.defaults?.style === null ? undefined : (patch.defaults?.style ?? base.defaults.style);

	const nextBlenderPath =
		patch.integrations?.blender?.path === null
			? undefined
			: (patch.integrations?.blender?.path ?? base.integrations.blender.path);

	return deepFreeze({
		version: 1,
		defaults: {
			model: patch.defaults?.model ?? base.defaults.model,
			size: {
				width: patch.defaults?.size?.width ?? base.defaults.size.width,
				height: patch.defaults?.size?.height ?? base.defaults.size.height,
			},
			format: patch.defaults?.format ?? base.defaults.format,
			compression: patch.defaults?.compression ?? base.defaults.compression,
			quality: patch.defaults?.quality ?? base.defaults.quality,
			...(nextStyle !== undefined ? { style: nextStyle } : {}),
			returnImage: patch.defaults?.returnImage ?? base.defaults.returnImage,
			timeoutMs: patch.defaults?.timeoutMs ?? base.defaults.timeoutMs,
		},
		aliases: {
			...base.aliases,
			...(patch.aliases ?? {}),
		},
		output: {
			dir: patch.output?.dir ?? base.output.dir,
			textureDir: patch.output?.textureDir ?? base.output.textureDir,
			filename: patch.output?.filename ?? base.output.filename,
			textureFilename: patch.output?.textureFilename ?? base.output.textureFilename,
			onConflict: patch.output?.onConflict ?? base.output.onConflict,
			allowOutsideCwd: patch.output?.allowOutsideCwd ?? base.output.allowOutsideCwd,
			sidecar: patch.output?.sidecar ?? base.output.sidecar,
			manifest: patch.output?.manifest ?? base.output.manifest,
			embedMetadata: patch.output?.embedMetadata ?? base.output.embedMetadata,
		},
		textures: {
			resolution: patch.textures?.resolution ?? base.textures.resolution,
			maps: patch.textures?.maps ? [...patch.textures.maps] : [...base.textures.maps],
			normalConvention: patch.textures?.normalConvention ?? base.textures.normalConvention,
			normalStrength: patch.textures?.normalStrength ?? base.textures.normalStrength,
			tilingMethod: patch.textures?.tilingMethod ?? base.textures.tilingMethod,
		},
		queue: {
			maxConcurrent: patch.queue?.maxConcurrent ?? base.queue.maxConcurrent,
		},
		limits: {
			maxBatch: patch.limits?.maxBatch ?? base.limits.maxBatch,
			maxPixels: patch.limits?.maxPixels ?? base.limits.maxPixels,
		},
		ui: {
			inlinePreview: patch.ui?.inlinePreview ?? base.ui.inlinePreview,
			thumbMaxCells: {
				w: patch.ui?.thumbMaxCells?.w ?? base.ui.thumbMaxCells.w,
				h: patch.ui?.thumbMaxCells?.h ?? base.ui.thumbMaxCells.h,
			},
			spinnerMs: patch.ui?.spinnerMs ?? base.ui.spinnerMs,
			statusSegment: patch.ui?.statusSegment ?? base.ui.statusSegment,
			queueWidget: patch.ui?.queueWidget ?? base.ui.queueWidget,
			policyHints: patch.ui?.policyHints ?? base.ui.policyHints,
			progressWeights: {
				preparing: patch.ui?.progressWeights?.preparing ?? base.ui.progressWeights.preparing,
				submitting: patch.ui?.progressWeights?.submitting ?? base.ui.progressWeights.submitting,
				generating: patch.ui?.progressWeights?.generating ?? base.ui.progressWeights.generating,
				postprocess: patch.ui?.progressWeights?.postprocess ?? base.ui.progressWeights.postprocess,
				saving: patch.ui?.progressWeights?.saving ?? base.ui.progressWeights.saving,
			},
		},
		presets: {
			...base.presets,
			...(patch.presets ?? {}),
		},
		integrations: {
			blender: {
				...(nextBlenderPath !== undefined ? { path: nextBlenderPath } : {}),
			},
		},
		compat: {
			hideBuiltin: patch.compat?.hideBuiltin ?? base.compat.hideBuiltin,
		},
	});
}

/**
 * Resolve effective config from layers in precedence order (§8.1):
 * defaults < user < project < session < call
 */
export function resolveConfigLayers(layers: ConfigLayerSet): ImgConfig {
	let result = DEFAULT_CONFIG;
	result = applyPartialConfig(result, layers.user);
	result = applyPartialConfig(result, layers.project);
	result = applyPartialConfig(result, layers.session);
	result = applyPartialConfig(result, layers.call);
	return result;
}

function readNestedPath(obj: unknown, dotPath: string): unknown {
	const parts = dotPath.split(".");
	let current: unknown = obj;
	for (const part of parts) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export function getFieldProvenance(
	layers: ConfigLayerSet,
	dotPath: string,
): {
	readonly source: ConfigScope;
	readonly overrides: readonly ConfigScope[];
} {
	const order: readonly { readonly scope: ConfigScope; readonly layer: PartialConfig | undefined }[] = [
		{ scope: "call", layer: layers.call },
		{ scope: "session", layer: layers.session },
		{ scope: "project", layer: layers.project },
		{ scope: "user", layer: layers.user },
	];
	const present: ConfigScope[] = [];
	for (const entry of order) {
		if (entry.layer !== undefined && readNestedPath(entry.layer, dotPath) !== undefined) {
			present.push(entry.scope);
		}
	}
	if (present.length === 0) {
		return Object.freeze({ source: "default", overrides: Object.freeze([]) });
	}
	const top = present[0] ?? "default";
	const rest = present.slice(1);
	return Object.freeze({
		source: top,
		overrides: Object.freeze([...rest, "default" as const]),
	});
}

import { type } from "arktype";
import { configInvalid, type ImgError } from "../core/errors";
import { deepFreeze } from "../core/freeze";
import { err, ok, type Result } from "../core/result";
import {
	type ConflictPolicy,
	type ImageFormat,
	type QualityTier,
	type ReturnImageMode,
	validateTemplateTokens,
} from "../domain/output";
import {
	ALLOWED_TEXTURE_RESOLUTIONS,
	DEFAULT_TEXTURE_MAPS,
	type NormalConvention,
	type TextureMapKind,
	type TextureResolution,
	type TilingMethod,
} from "../domain/texture";

export interface ProviderConfigEntry {
	readonly enabled: boolean;
	readonly apiKeyEnv?: string;
	readonly apiKeyCommand?: string;
	readonly baseUrl?: string;
	readonly workflowsDir?: string;
	readonly maxConcurrent?: number;
}

export interface StylePreset {
	readonly style: string;
	readonly negative?: string;
}

export interface ProgressWeights {
	readonly preparing: number;
	readonly submitting: number;
	readonly generating: number;
	readonly postprocess: number;
	readonly saving: number;
}

export interface ImgConfig {
	readonly version: 1;
	readonly defaults: {
		readonly model: string;
		readonly size: { readonly width: number; readonly height: number };
		readonly format: ImageFormat;
		readonly compression: number;
		readonly quality: QualityTier;
		readonly style?: string;
		readonly returnImage: ReturnImageMode;
		readonly timeoutMs: number;
	};
	readonly aliases: Readonly<Record<string, string>>;
	readonly providers: {
		readonly host: ProviderConfigEntry;
		readonly fal: ProviderConfigEntry;
		readonly replicate: ProviderConfigEntry;
		readonly stability: ProviderConfigEntry;
		readonly comfyui: ProviderConfigEntry;
		readonly a1111: ProviderConfigEntry;
	};
	readonly output: {
		readonly dir: string;
		readonly textureDir: string;
		readonly filename: string;
		readonly textureFilename: string;
		readonly onConflict: ConflictPolicy;
		readonly allowOutsideCwd: boolean;
		readonly sidecar: boolean;
		readonly manifest: string;
		readonly embedMetadata: boolean;
	};
	readonly textures: {
		readonly resolution: TextureResolution;
		readonly maps: readonly TextureMapKind[];
		readonly normalConvention: NormalConvention;
		readonly normalStrength: number;
		readonly tilingMethod: TilingMethod;
	};
	readonly queue: {
		readonly maxConcurrent: number;
	};
	readonly limits: {
		readonly maxBatch: number;
		readonly maxCostPerCallUsd: number;
		readonly maxPixels: number;
	};
	readonly ui: {
		readonly inlinePreview: boolean;
		readonly thumbMaxCells: { readonly w: number; readonly h: number };
		readonly spinnerMs: number;
		readonly statusSegment: boolean;
		readonly queueWidget: boolean;
		readonly policyHints: boolean;
		readonly progressWeights: ProgressWeights;
	};
	readonly presets: Readonly<Record<string, StylePreset>>;
	readonly integrations: {
		readonly blender: {
			readonly path?: string;
		};
	};
	readonly compat: {
		readonly hideBuiltin: boolean;
	};
}

export interface PartialConfig {
	readonly version?: number;
	readonly defaults?: {
		readonly model?: string;
		readonly size?: { readonly width?: number; readonly height?: number };
		readonly format?: ImageFormat;
		readonly compression?: number;
		readonly quality?: QualityTier;
		readonly style?: string | null;
		readonly returnImage?: ReturnImageMode;
		readonly timeoutMs?: number;
	};
	readonly aliases?: Readonly<Record<string, string>>;
	readonly providers?: Readonly<Record<string, Partial<ProviderConfigEntry>>>;
	readonly output?: {
		readonly dir?: string;
		readonly textureDir?: string;
		readonly filename?: string;
		readonly textureFilename?: string;
		readonly onConflict?: ConflictPolicy;
		readonly allowOutsideCwd?: boolean;
		readonly sidecar?: boolean;
		readonly manifest?: string;
		readonly embedMetadata?: boolean;
	};
	readonly textures?: {
		readonly resolution?: TextureResolution;
		readonly maps?: readonly TextureMapKind[];
		readonly normalConvention?: NormalConvention;
		readonly normalStrength?: number;
		readonly tilingMethod?: TilingMethod;
	};
	readonly queue?: {
		readonly maxConcurrent?: number;
	};
	readonly limits?: {
		readonly maxBatch?: number;
		readonly maxCostPerCallUsd?: number;
		readonly maxPixels?: number;
	};
	readonly ui?: {
		readonly inlinePreview?: boolean;
		readonly thumbMaxCells?: { readonly w?: number; readonly h?: number };
		readonly spinnerMs?: number;
		readonly statusSegment?: boolean;
		readonly queueWidget?: boolean;
		readonly policyHints?: boolean;
		readonly progressWeights?: Partial<ProgressWeights>;
	};
	readonly presets?: Readonly<Record<string, StylePreset>>;
	readonly integrations?: {
		readonly blender?: {
			readonly path?: string | null;
		};
	};
	readonly compat?: {
		readonly hideBuiltin?: boolean;
	};
}

export const DEFAULT_PROGRESS_WEIGHTS: ProgressWeights = deepFreeze({
	preparing: 0.05,
	submitting: 0.05,
	generating: 0.75,
	postprocess: 0.1,
	saving: 0.05,
});

export const DEFAULT_PRESETS: Readonly<Record<string, StylePreset>> = deepFreeze({
	photo: {
		style: "photorealistic DSLR photograph, natural lighting, sharp focus, 35mm lens",
		negative: "cartoon, illustration, CGI, blurry, watermark, text",
	},
	"concept-art": {
		style: "digital concept art, painterly brushwork, atmospheric lighting, rich detail",
		negative: "blurry, low quality, watermark, text",
	},
	"pixel-art": {
		style: "crisp 16-bit pixel art sprite, clean pixel grid, limited color palette, no anti-aliasing",
		negative: "blurry, photorealistic, smooth gradients, 3d render",
	},
	"pbr-texture": {
		style: "seamless tileable texture, top-down orthographic, flat even lighting, no shadows, no perspective, no vignette, fills entire frame",
		negative: "perspective, shadows, specular highlights, vignette, depth of field, border, text",
	},
	"ui-icon": {
		style: "clean modern UI icon, centered composition, clear silhouette, crisp edges",
		negative: "cluttered background, blurry, text, watermark",
	},
	"flat-vector": {
		style: "flat vector illustration, geometric shapes, bold solid colors, clean lines",
		negative: "photorealistic, noisy, blurry, 3d shading",
	},
});

export const DEFAULT_CONFIG: ImgConfig = deepFreeze({
	version: 1,
	defaults: {
		model: "host:auto",
		size: { width: 1024, height: 1024 },
		format: "png",
		compression: 90,
		quality: "auto",
		returnImage: "thumbnail",
		timeoutMs: 180000,
	},
	aliases: {
		fast: "fal/flux-schnell",
		best: "openai/gpt-image-1",
		tex: "comfyui/sdxl-pbr",
	},
	providers: {
		host: { enabled: true },
		fal: { enabled: true, apiKeyEnv: "FAL_KEY", maxConcurrent: 4 },
		replicate: { enabled: false, apiKeyEnv: "REPLICATE_API_TOKEN", maxConcurrent: 2 },
		stability: { enabled: false, apiKeyEnv: "STABILITY_API_KEY", maxConcurrent: 2 },
		comfyui: {
			enabled: false,
			baseUrl: "http://127.0.0.1:8188",
			workflowsDir: "~/.omp/agent/img-pi/workflows",
			maxConcurrent: 1,
		},
		a1111: {
			enabled: false,
			baseUrl: "http://127.0.0.1:7860",
			maxConcurrent: 1,
		},
	},
	output: {
		dir: "generated/images",
		textureDir: "generated/textures",
		filename: "{date}_{slug}_{index}",
		textureFilename: "{slug}/{slug}_{map}",
		onConflict: "suffix",
		allowOutsideCwd: false,
		sidecar: true,
		manifest: ".img-pi/manifest.jsonl",
		embedMetadata: true,
	},
	textures: {
		resolution: 1024,
		maps: DEFAULT_TEXTURE_MAPS,
		normalConvention: "opengl",
		normalStrength: 2.0,
		tilingMethod: "auto",
	},
	queue: {
		maxConcurrent: 2,
	},
	limits: {
		maxBatch: 32,
		maxCostPerCallUsd: 2.0,
		maxPixels: 16777216,
	},
	ui: {
		inlinePreview: true,
		thumbMaxCells: { w: 40, h: 14 },
		spinnerMs: 80,
		statusSegment: true,
		queueWidget: true,
		policyHints: true,
		progressWeights: DEFAULT_PROGRESS_WEIGHTS,
	},
	presets: DEFAULT_PRESETS,
	integrations: {
		blender: {},
	},
	compat: {
		hideBuiltin: false,
	},
});

const providerEntrySchema = type({
	"enabled?": "boolean",
	"apiKeyEnv?": "string",
	"apiKeyCommand?": "string",
	"baseUrl?": "string",
	"workflowsDir?": "string",
	"maxConcurrent?": "number.integer >= 1",
});

const partialConfigArkSchema = type({
	"version?": "number.integer >= 1",
	"defaults?": {
		"model?": "string",
		"size?": {
			"width?": "64 <= number.integer <= 8192",
			"height?": "64 <= number.integer <= 8192",
		},
		"format?": "'png' | 'jpeg' | 'webp' | 'avif'",
		"compression?": "0 <= number.integer <= 100",
		"quality?": "'auto' | 'low' | 'medium' | 'high'",
		"style?": "string | null",
		"returnImage?": "'none' | 'thumbnail' | 'full'",
		"timeoutMs?": "5000 <= number.integer <= 900000",
	},
	"aliases?": "Record<string, string>",
	"providers?": {
		"host?": providerEntrySchema,
		"fal?": providerEntrySchema,
		"replicate?": providerEntrySchema,
		"stability?": providerEntrySchema,
		"comfyui?": providerEntrySchema,
		"a1111?": providerEntrySchema,
	},
	"output?": {
		"dir?": "string",
		"textureDir?": "string",
		"filename?": "string",
		"textureFilename?": "string",
		"onConflict?": "'suffix' | 'overwrite' | 'error'",
		"allowOutsideCwd?": "boolean",
		"sidecar?": "boolean",
		"manifest?": "string",
		"embedMetadata?": "boolean",
	},
	"textures?": {
		"resolution?": "256 | 512 | 1024 | 2048 | 4096",
		"maps?": "('albedo' | 'normal' | 'height' | 'roughness' | 'ao' | 'metallic' | 'orm')[]",
		"normalConvention?": "'opengl' | 'directx'",
		"normalStrength?": "0.1 <= number <= 10",
		"tilingMethod?": "'native' | 'offset_blend' | 'mirror' | 'auto'",
	},
	"queue?": {
		"maxConcurrent?": "1 <= number.integer <= 32",
	},
	"limits?": {
		"maxBatch?": "1 <= number.integer <= 128",
		"maxCostPerCallUsd?": "0 <= number <= 1000",
		"maxPixels?": "4096 <= number.integer <= 67108864",
	},
	"ui?": {
		"inlinePreview?": "boolean",
		"thumbMaxCells?": {
			"w?": "4 <= number.integer <= 200",
			"h?": "2 <= number.integer <= 100",
		},
		"spinnerMs?": "20 <= number.integer <= 1000",
		"statusSegment?": "boolean",
		"queueWidget?": "boolean",
		"policyHints?": "boolean",
		"progressWeights?": {
			"preparing?": "0 <= number <= 1",
			"submitting?": "0 <= number <= 1",
			"generating?": "0 <= number <= 1",
			"postprocess?": "0 <= number <= 1",
			"saving?": "0 <= number <= 1",
		},
	},
	"presets?": type.Record("string", {
		style: "string",
		"negative?": "string",
	}),
	"integrations?": {
		"blender?": {
			"path?": "string | null",
		},
	},
	"compat?": {
		"hideBuiltin?": "boolean",
	},
});

const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set([
	"version",
	"defaults",
	"aliases",
	"providers",
	"output",
	"textures",
	"queue",
	"limits",
	"ui",
	"presets",
	"integrations",
	"compat",
]);

export function validatePartialConfig(input: unknown): Result<PartialConfig, ImgError> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return err(configInvalid("root", "Config must be a JSON object"));
	}
	const record = input as Record<string, unknown>;
	const keys = Object.keys(record);
	for (const k of keys) {
		if (!ALLOWED_TOP_KEYS.has(k)) {
			return err(configInvalid(k, `Unknown config section '${k}'`));
		}
	}

	if ("textures" in record && typeof record["textures"] === "object" && record["textures"] !== null) {
		const tex = record["textures"] as Record<string, unknown>;
		if ("resolution" in tex && typeof tex["resolution"] === "number") {
			if (!ALLOWED_TEXTURE_RESOLUTIONS.has(tex["resolution"])) {
				return err(configInvalid("textures.resolution", "Resolution must be 256, 512, 1024, 2048, or 4096"));
			}
		}
	}

	const out = partialConfigArkSchema(input);
	if (out instanceof type.errors) {
		const first = out[0];
		const pathStr = first?.path ? first.path.map(p => String(p)).join(".") : "config";
		const msg = first?.message ?? out.summary;
		return err(configInvalid(pathStr || "config", msg));
	}

	if (out.output?.filename !== undefined) {
		const check = validateTemplateTokens(out.output.filename, "output.filename");
		if (!check.ok) return check;
	}
	if (out.output?.textureFilename !== undefined) {
		const check = validateTemplateTokens(out.output.textureFilename, "output.textureFilename");
		if (!check.ok) return check;
	}

	return ok(deepFreeze(out as PartialConfig));
}

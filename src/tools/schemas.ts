import { type } from "arktype";
import type { Capability, ImgError } from "../core/errors.js";
import { configInvalid } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { BackgroundMode, ConflictPolicy, ImageFormat, QualityTier, ReturnImageMode } from "../domain/output.js";
import type { ReferenceRole } from "../domain/reference.js";
import type { EditMode } from "../domain/request.js";
import type { FitMode, ResolutionTier, SizeMode } from "../domain/size.js";
import type {
	BitDepth,
	HeightSource,
	NormalConvention,
	TextureMapKind,
	TextureResolution,
	TilingMethod,
} from "../domain/texture.js";

export interface FieldDescriptor<T, R extends boolean = false> {
	readonly jsonSchema: Readonly<Record<string, unknown>>;
	readonly arkDef: unknown;
	readonly required: R;
	readonly _phantom?: T;
}

export function defineField<T, R extends boolean = false>(spec: {
	readonly jsonSchema: Readonly<Record<string, unknown>>;
	readonly arkDef: unknown;
	readonly required?: R;
}): FieldDescriptor<T, R> {
	const req: R = (spec.required ?? false) as R;
	return deepFreeze({
		jsonSchema: spec.jsonSchema,
		arkDef: spec.arkDef,
		required: req,
	});
}

export type InferFields<F extends Readonly<Record<string, FieldDescriptor<unknown, boolean>>>> = {
	readonly [K in keyof F as F[K]["required"] extends true ? K : never]: F[K] extends FieldDescriptor<infer T, boolean>
		? T
		: never;
} & {
	readonly [K in keyof F as F[K]["required"] extends true ? never : K]?: F[K] extends FieldDescriptor<infer T, boolean>
		? T
		: never;
};

export interface CompiledToolSchema<T> {
	readonly jsonSchema: Readonly<Record<string, unknown>>;
	readonly allowedKeys: ReadonlySet<string>;
	validate(input: unknown): Result<T, ImgError>;
}

export function compileToolSchema<F extends Readonly<Record<string, FieldDescriptor<unknown, boolean>>>>(
	fields: F,
): CompiledToolSchema<InferFields<F>> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	const arkShape: Record<string, unknown> = {};
	const allowedKeys = new Set<string>();

	for (const [key, desc] of Object.entries(fields)) {
		allowedKeys.add(key);
		properties[key] = desc.jsonSchema;
		if (desc.required) {
			required.push(key);
			arkShape[key] = desc.arkDef;
		} else {
			arkShape[`${key}?`] = desc.arkDef;
		}
	}

	const jsonSchema = deepFreeze({
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	});

	const arkValidator = type(arkShape as Record<string, never>);

	return {
		jsonSchema,
		allowedKeys,
		validate(input: unknown): Result<InferFields<F>, ImgError> {
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				return err(configInvalid("params", "Tool arguments must be a JSON object"));
			}
			const rec = input as Record<string, unknown>;
			for (const k of Object.keys(rec)) {
				if (!allowedKeys.has(k)) {
					return err(configInvalid(k, `Unknown parameter '${k}'`));
				}
			}
			const parsed = arkValidator(input);
			if (parsed instanceof type.errors) {
				const first = parsed[0];
				const fieldPath = first?.path ? first.path.map(p => String(p)).join(".") : "params";
				return err(configInvalid(fieldPath || "params", first?.message ?? parsed.summary));
			}
			return ok(parsed as InferFields<F>);
		},
	};
}

// ============================================================================
// Shared Parameter Fragments (Single Source of Truth — §6.1)
// ============================================================================

export interface RawReferenceInput {
	readonly source: string;
	readonly role?: ReferenceRole;
	readonly weight?: number;
	readonly label?: string;
}

export interface RawPostInput {
	readonly trim?: boolean;
	readonly remove_background?: boolean;
	readonly upscale?: 2 | 4;
	readonly sharpen?: number;
	readonly grayscale?: boolean;
	readonly palette?: number;
}

export interface RawOutpaintInput {
	readonly left?: number;
	readonly right?: number;
	readonly top?: number;
	readonly bottom?: number;
}

export const PROMPT_FIELDS = {
	prompt: defineField<string, true>({
		required: true,
		jsonSchema: {
			type: "string",
			minLength: 1,
			maxLength: 32000,
			description: "Subject and scene description (1..32000 chars).",
		},
		arkDef: "1 <= string <= 32000",
	}),
	negative_prompt: defineField<string>({
		jsonSchema: {
			type: "string",
			description: "Elements to exclude (ignored with warning if model lacks negative_prompt).",
		},
		arkDef: "string",
	}),
	style: defineField<string>({
		jsonSchema: {
			type: "string",
			description:
				"Style preset ('photo', 'concept-art', 'pixel-art', 'pbr-texture', 'ui-icon', 'flat-vector') or free text.",
		},
		arkDef: "string",
	}),
} as const;

export const MODEL_FIELDS = {
	model: defineField<string>({
		jsonSchema: {
			type: "string",
			description:
				"Optional model id from img_list_models (e.g. 'google/<model>'). Omit to use the session default.",
		},
		arkDef: "string",
	}),
} as const;

export const REF_FIELDS = {
	references: defineField<readonly RawReferenceInput[]>({
		jsonSchema: {
			type: "array",
			maxItems: 16,
			description:
				"Up to 16 reference images. source: cwd-relative path, http(s):// URL, data: URI, a host URL such as a pasted image's local://…, or '@last'/'@job:<id>[#n]'.",
			items: {
				type: "object",
				properties: {
					source: { type: "string" },
					role: {
						type: "string",
						enum: ["content", "style", "subject", "composition", "init", "mask"],
					},
					weight: { type: "number", minimum: 0, maximum: 2 },
					label: { type: "string" },
				},
				required: ["source"],
				additionalProperties: false,
			},
		},
		arkDef: type({
			source: "string >= 1",
			"role?": "'content' | 'style' | 'subject' | 'composition' | 'init' | 'mask'",
			"weight?": "0 <= number <= 2",
			"label?": "string",
		}).array(),
	}),
} as const;

export const SIZE_FIELDS = {
	width: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 64,
			maximum: 8192,
			description: "Target width in pixels (64..8192).",
		},
		arkDef: "64 <= number.integer <= 8192",
	}),
	height: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 64,
			maximum: 8192,
			description: "Target height in pixels (64..8192).",
		},
		arkDef: "64 <= number.integer <= 8192",
	}),
	aspect_ratio: defineField<string>({
		jsonSchema: {
			type: "string",
			description: "Aspect ratio 'W:H' (default '1:1') when width/height are omitted.",
		},
		arkDef: "string",
	}),
	image_size: defineField<string>({
		jsonSchema: {
			type: "string",
			description:
				"Provider-native size token passed to the model verbatim (e.g. '1024x1536' or '2K'). Usually omit.",
		},
		arkDef: "string",
	}),
	resolution: defineField<ResolutionTier>({
		jsonSchema: {
			type: "string",
			enum: ["0.5K", "1K", "2K", "4K"],
			description: "Long-side resolution tier (default '1K' = 1024px).",
		},
		arkDef: "'0.5K' | '1K' | '2K' | '4K'",
	}),
	size_mode: defineField<SizeMode>({
		jsonSchema: {
			type: "string",
			enum: ["snap", "exact"],
			description: "Size handling: 'exact' post-resizes to exact px (default 'exact').",
		},
		arkDef: "'snap' | 'exact'",
	}),
	fit: defineField<FitMode>({
		jsonSchema: {
			type: "string",
			enum: ["cover", "contain", "fill"],
			description: "Resize fit mode when size_mode='exact' (default 'cover').",
		},
		arkDef: "'cover' | 'contain' | 'fill'",
	}),
} as const;

export const SAMPLING_FIELDS = {
	seed: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 0,
			description: "Non-negative integer seed (default random, always recorded).",
		},
		arkDef: "number.integer >= 0",
	}),
	steps: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 1,
			maximum: 150,
			description: "Sampling steps (1..150, default model specific).",
		},
		arkDef: "1 <= number.integer <= 150",
	}),
	guidance: defineField<number>({
		jsonSchema: {
			type: "number",
			minimum: 0,
			maximum: 30,
			description: "Classifier-free guidance scale (0..30).",
		},
		arkDef: "0 <= number <= 30",
	}),
	quality: defineField<QualityTier>({
		jsonSchema: {
			type: "string",
			enum: ["auto", "low", "medium", "high"],
			description: "Quality tier (default 'auto').",
		},
		arkDef: "'auto' | 'low' | 'medium' | 'high'",
	}),
	background: defineField<BackgroundMode>({
		jsonSchema: {
			type: "string",
			enum: ["auto", "opaque", "transparent"],
			description: "Background mode (default 'auto'; 'transparent' forces PNG/WebP).",
		},
		arkDef: "'auto' | 'opaque' | 'transparent'",
	}),
} as const;

export const OUTPUT_FIELDS = {
	format: defineField<ImageFormat>({
		jsonSchema: {
			type: "string",
			enum: ["png", "jpeg", "webp", "avif"],
			description: "Output image format (default 'png').",
		},
		arkDef: "'png' | 'jpeg' | 'webp' | 'avif'",
	}),
	compression: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 0,
			maximum: 100,
			description: "Compression quality 0..100 for jpeg/webp/avif (default 90).",
		},
		arkDef: "0 <= number.integer <= 100",
	}),
	output_dir: defineField<string>({
		jsonSchema: {
			type: "string",
			description:
				"Output directory inside the project (default '.pi/img/images'). Paths outside the project are rejected unless output.allowOutsideCwd is set; to deliver elsewhere, generate here and copy the file.",
		},
		arkDef: "string",
	}),
	filename: defineField<string>({
		jsonSchema: {
			type: "string",
			description:
				"Filename template using {date},{time},{slug},{index},{seed},{model},{map} (default '{date}_{slug}_{index}').",
		},
		arkDef: "string",
	}),
	on_conflict: defineField<ConflictPolicy>({
		jsonSchema: {
			type: "string",
			enum: ["suffix", "overwrite", "error"],
			description: "Existing file conflict policy (default 'suffix').",
		},
		arkDef: "'suffix' | 'overwrite' | 'error'",
	}),
	tags: defineField<readonly string[]>({
		jsonSchema: {
			type: "array",
			items: { type: "string" },
			description: "Tags saved to sidecar & manifest for gallery filtering.",
		},
		arkDef: "string[]",
	}),
	metadata: defineField<Readonly<Record<string, string>>>({
		jsonSchema: {
			type: "object",
			additionalProperties: { type: "string" },
			description: "Custom key-value metadata written to sidecar JSON.",
		},
		arkDef: "Record<string, string>",
	}),
} as const;

export const POST_FIELDS = {
	post: defineField<RawPostInput>({
		jsonSchema: {
			type: "object",
			description: "Worker post-processing operations.",
			properties: {
				trim: { type: "boolean" },
				remove_background: { type: "boolean" },
				upscale: { type: "integer", enum: [2, 4] },
				sharpen: { type: "number", minimum: 0.1, maximum: 10 },
				grayscale: { type: "boolean" },
				palette: { type: "integer", minimum: 2, maximum: 256 },
			},
			additionalProperties: false,
		},
		arkDef: {
			"trim?": "boolean",
			"remove_background?": "boolean",
			"upscale?": "2 | 4",
			"sharpen?": "0.1 <= number <= 10",
			"grayscale?": "boolean",
			"palette?": "2 <= number.integer <= 256",
		},
	}),
} as const;

export const RETURN_FIELDS = {
	return_image: defineField<ReturnImageMode>({
		jsonSchema: {
			type: "string",
			enum: ["none", "thumbnail", "full"],
			description: "Image returned into model context ('thumbnail' = 512px JPEG q80, default 'thumbnail').",
		},
		arkDef: "'none' | 'thumbnail' | 'full'",
	}),
	timeout_ms: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 5000,
			maximum: 900000,
			description: "Job timeout in milliseconds (5000..900000, default 180000).",
		},
		arkDef: "5000 <= number.integer <= 900000",
	}),
	dry_run: defineField<boolean>({
		jsonSchema: {
			type: "boolean",
			description: "Validate, snap size, and estimate cost without calling provider (default false).",
		},
		arkDef: "boolean",
	}),
} as const;

// ============================================================================
// Compiled Tool Schemas (§6.2 – §6.7)
// ============================================================================

const GENERATE_COUNT_FIELD = {
	count: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 1,
			maximum: 16,
			description: "Number of images to generate (1..16, default 1).",
		},
		arkDef: "1 <= number.integer <= 16",
	}),
} as const;

export const IMG_GENERATE_FIELDS = {
	...PROMPT_FIELDS,
	...MODEL_FIELDS,
	...REF_FIELDS,
	...SIZE_FIELDS,
	...GENERATE_COUNT_FIELD,
	...SAMPLING_FIELDS,
	...OUTPUT_FIELDS,
	...POST_FIELDS,
	...RETURN_FIELDS,
} as const;

export const IMG_GENERATE_SCHEMA = compileToolSchema(IMG_GENERATE_FIELDS);
export type ImgGenerateParams = InferFields<typeof IMG_GENERATE_FIELDS>;

const EDIT_SPECIFIC_FIELDS = {
	image: defineField<string, true>({
		required: true,
		jsonSchema: {
			type: "string",
			minLength: 1,
			description:
				"Source image to edit (path relative to cwd, URL, data: URI, a host URL such as local://…, or @last / @job:<id>).",
		},
		arkDef: "string >= 1",
	}),
	mask: defineField<string>({
		jsonSchema: {
			type: "string",
			description: "Optional inpaint mask image (white = edit region, black = preserve).",
		},
		arkDef: "string",
	}),
	strength: defineField<number>({
		jsonSchema: {
			type: "number",
			minimum: 0,
			maximum: 1,
			description: "Denoising strength 0..1 for img2img (default 0.75).",
		},
		arkDef: "0 <= number <= 1",
	}),
	mode: defineField<EditMode>({
		jsonSchema: {
			type: "string",
			enum: ["edit", "inpaint", "outpaint", "variation"],
			description: "Edit operation mode (default 'edit').",
		},
		arkDef: "'edit' | 'inpaint' | 'outpaint' | 'variation'",
	}),
	outpaint: defineField<RawOutpaintInput>({
		jsonSchema: {
			type: "object",
			description: "Outpaint padding in pixels per side when mode='outpaint'.",
			properties: {
				left: { type: "integer", minimum: 0, maximum: 4096 },
				right: { type: "integer", minimum: 0, maximum: 4096 },
				top: { type: "integer", minimum: 0, maximum: 4096 },
				bottom: { type: "integer", minimum: 0, maximum: 4096 },
			},
			additionalProperties: false,
		},
		arkDef: {
			"left?": "0 <= number.integer <= 4096",
			"right?": "0 <= number.integer <= 4096",
			"top?": "0 <= number.integer <= 4096",
			"bottom?": "0 <= number.integer <= 4096",
		},
	}),
	count: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 1,
			maximum: 4,
			description: "Number of edited images (1..4, default 1).",
		},
		arkDef: "1 <= number.integer <= 4",
	}),
} as const;

export const IMG_EDIT_FIELDS = {
	...PROMPT_FIELDS,
	...MODEL_FIELDS,
	...REF_FIELDS,
	...SIZE_FIELDS,
	...EDIT_SPECIFIC_FIELDS,
	...SAMPLING_FIELDS,
	...OUTPUT_FIELDS,
	...POST_FIELDS,
	...RETURN_FIELDS,
} as const;

export const IMG_EDIT_SCHEMA = compileToolSchema(IMG_EDIT_FIELDS);
export type ImgEditParams = InferFields<typeof IMG_EDIT_FIELDS>;

const TEXTURE_SPECIFIC_FIELDS = {
	material: defineField<string, true>({
		required: true,
		jsonSchema: {
			type: "string",
			minLength: 1,
			maxLength: 32000,
			description: "Material surface description (e.g. 'wet mossy cobblestone path').",
		},
		arkDef: "1 <= string <= 32000",
	}),
	maps: defineField<readonly TextureMapKind[]>({
		jsonSchema: {
			type: "array",
			items: {
				type: "string",
				enum: ["albedo", "normal", "height", "roughness", "ao", "metallic", "orm"],
			},
			description: "PBR maps to generate (default ['albedo','normal','roughness','ao','height']).",
		},
		arkDef: "('albedo' | 'normal' | 'height' | 'roughness' | 'ao' | 'metallic' | 'orm')[]",
	}),
	resolution: defineField<TextureResolution>({
		jsonSchema: {
			type: "integer",
			enum: [256, 512, 1024, 2048, 4096],
			description:
				"Square map size in pixels. 4K = 4096, 2K = 2048, 1K = 1024. Omit to use the configured default (textures.resolution). Maps are resized up from the model's native output.",
		},
		arkDef: "256 | 512 | 1024 | 2048 | 4096",
	}),
	tileable: defineField<boolean>({
		jsonSchema: {
			type: "boolean",
			description: "Enforce seamless wrap-around tileability (default true).",
		},
		arkDef: "boolean",
	}),
	tiling_method: defineField<TilingMethod>({
		jsonSchema: {
			type: "string",
			enum: ["native", "offset_blend", "mirror", "auto"],
			description: "Seamless tiling algorithm (default 'auto').",
		},
		arkDef: "'native' | 'offset_blend' | 'mirror' | 'auto'",
	}),
	seam_blend_px: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 0,
			maximum: 512,
			description: "Cross-seam blend width in pixels (default resolution/8).",
		},
		arkDef: "0 <= number.integer <= 512",
	}),
	normal_convention: defineField<NormalConvention>({
		jsonSchema: {
			type: "string",
			enum: ["opengl", "directx"],
			description:
				"Normal map Y channel convention ('opengl' for Blender/Godot, 'directx' for Unreal/Unity, default 'opengl').",
		},
		arkDef: "'opengl' | 'directx'",
	}),
	normal_strength: defineField<number>({
		jsonSchema: {
			type: "number",
			minimum: 0.1,
			maximum: 10,
			description: "Sobel normal map slope strength 0.1..10 (default 2.0).",
		},
		arkDef: "0.1 <= number <= 10",
	}),
	height_source: defineField<HeightSource>({
		jsonSchema: {
			type: "string",
			enum: ["luminance", "model"],
			description: "Height map derivation source (default 'luminance').",
		},
		arkDef: "'luminance' | 'model'",
	}),
	roughness_range: defineField<readonly [number, number]>({
		jsonSchema: {
			type: "array",
			minItems: 2,
			maxItems: 2,
			items: { type: "number", minimum: 0, maximum: 1 },
			description: "Roughness output range [min, max] within 0..1 (default [0.3, 0.9]).",
		},
		arkDef: ["0 <= number <= 1", "0 <= number <= 1"],
	}),
	metallic: defineField<number | "auto">({
		jsonSchema: {
			oneOf: [
				{ type: "number", minimum: 0, maximum: 1 },
				{ type: "string", enum: ["auto"] },
			],
			description: "Constant metallic value 0..1 or 'auto' k-means estimation (default 0).",
		},
		arkDef: "(0 <= number <= 1) | 'auto'",
	}),
	orm_pack: defineField<boolean>({
		jsonSchema: {
			type: "boolean",
			description: "Also output packed ORM texture (R=AO, G=Roughness, B=Metallic, default false).",
		},
		arkDef: "boolean",
	}),
	bit_depth: defineField<BitDepth>({
		jsonSchema: {
			type: "integer",
			enum: [8, 16],
			description: "Channel bit depth 8 or 16 (default 8; 16 recommended for normal/height).",
		},
		arkDef: "8 | 16",
	}),
	preview_tiles: defineField<number>({
		jsonSchema: {
			type: "integer",
			minimum: 1,
			maximum: 4,
			description: "Generate N×N tiled preview PNG (1..4, default 2 -> 2x2 preview).",
		},
		arkDef: "1 <= number.integer <= 4",
	}),
} as const;

export const IMG_TEXTURE_FIELDS = {
	...TEXTURE_SPECIFIC_FIELDS,
	negative_prompt: PROMPT_FIELDS.negative_prompt,
	style: PROMPT_FIELDS.style,
	...MODEL_FIELDS,
	...REF_FIELDS,
	seed: SAMPLING_FIELDS.seed,
	steps: SAMPLING_FIELDS.steps,
	guidance: SAMPLING_FIELDS.guidance,
	quality: SAMPLING_FIELDS.quality,
	...OUTPUT_FIELDS,
	...POST_FIELDS,
	...RETURN_FIELDS,
} as const;

export const IMG_TEXTURE_SCHEMA = compileToolSchema(IMG_TEXTURE_FIELDS);
export type ImgTextureParams = InferFields<typeof IMG_TEXTURE_FIELDS>;

export interface RawVarySpec {
	readonly seeds?: readonly number[];
	readonly prompts?: readonly string[];
	readonly models?: readonly string[];
	readonly styles?: readonly string[];
}

export const IMG_VARIATIONS_FIELDS = {
	base: defineField<ImgGenerateParams, true>({
		required: true,
		jsonSchema: IMG_GENERATE_SCHEMA.jsonSchema,
		arkDef: "object",
	}),
	vary: defineField<RawVarySpec, true>({
		required: true,
		jsonSchema: {
			type: "object",
			description: "Axes to vary across batch jobs (capped at limits.maxBatch = 32).",
			properties: {
				seeds: { type: "array", items: { type: "integer", minimum: 0 } },
				prompts: { type: "array", items: { type: "string", minLength: 1 } },
				models: { type: "array", items: { type: "string", minLength: 1 } },
				styles: { type: "array", items: { type: "string", minLength: 1 } },
			},
			additionalProperties: false,
		},
		arkDef: {
			"seeds?": "(number.integer >= 0)[]",
			"prompts?": "(string >= 1)[]",
			"models?": "(string >= 1)[]",
			"styles?": "(string >= 1)[]",
		},
	}),
	mode: defineField<"cartesian" | "zip">({
		jsonSchema: {
			type: "string",
			enum: ["cartesian", "zip"],
			description: "Combination mode across vary axes (default 'cartesian').",
		},
		arkDef: "'cartesian' | 'zip'",
	}),
} as const;

export const IMG_VARIATIONS_SCHEMA = compileToolSchema(IMG_VARIATIONS_FIELDS);
export type ImgVariationsParams = InferFields<typeof IMG_VARIATIONS_FIELDS>;

export const IMG_LIST_MODELS_FIELDS = {
	provider: defineField<string>({
		jsonSchema: {
			type: "string",
			description: "Optional provider id filter, as shown in the list (e.g. 'google').",
		},
		arkDef: "string",
	}),
	capability: defineField<Capability>({
		jsonSchema: {
			type: "string",
			enum: ["txt2img", "img2img", "multi_ref"],
			description: "Optional filter: 'img2img' lists models that can edit images.",
		},
		arkDef: "'txt2img' | 'img2img' | 'multi_ref'",
	}),
} as const;

export const IMG_LIST_MODELS_SCHEMA = compileToolSchema(IMG_LIST_MODELS_FIELDS);
export type ImgListModelsParams = InferFields<typeof IMG_LIST_MODELS_FIELDS>;

export const IMG_DESCRIBE_JOB_FIELDS = {
	job: defineField<string, true>({
		required: true,
		jsonSchema: {
			type: "string",
			minLength: 1,
			description: "Job ID (full or prefix) or '@last' to inspect full sidecar JSON.",
		},
		arkDef: "string >= 1",
	}),
} as const;

export const IMG_DESCRIBE_JOB_SCHEMA = compileToolSchema(IMG_DESCRIBE_JOB_FIELDS);
export type ImgDescribeJobParams = InferFields<typeof IMG_DESCRIBE_JOB_FIELDS>;

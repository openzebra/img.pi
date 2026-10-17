import { computeHashCode, structuralEquals, type ValueObject } from "../core/equals";
import { configInvalid, type ImgError } from "../core/errors";
import { deepFreeze } from "../core/freeze";
import { err, ok, type Result } from "../core/result";

export type ImageFormat = "png" | "jpeg" | "webp" | "avif";
export type ConflictPolicy = "suffix" | "overwrite" | "error";
export type ReturnImageMode = "none" | "thumbnail" | "full";
export type BackgroundMode = "auto" | "opaque" | "transparent";
export type QualityTier = "auto" | "low" | "medium" | "high";

export const ALLOWED_TEMPLATE_TOKENS: ReadonlySet<string> = new Set([
	"date",
	"time",
	"slug",
	"index",
	"seed",
	"model",
	"provider",
	"w",
	"h",
	"map",
	"job",
	"tag",
]);

export const FORMAT_MIME_TYPES: Readonly<Record<ImageFormat, string>> = deepFreeze({
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	avif: "image/avif",
});

export interface PostSpec {
	readonly trim?: boolean;
	readonly removeBackground?: boolean;
	readonly upscale?: 2 | 4;
	readonly sharpen?: number;
	readonly grayscale?: boolean;
	readonly palette?: number;
}

export function validateTemplateTokens(template: string, pathName = "filename"): Result<string, ImgError> {
	const trimmed = template.trim();
	if (trimmed.length === 0) {
		return err(configInvalid(pathName, "Filename template cannot be empty"));
	}
	const tokenRegex = /\{([^{}]*)\}/g;
	let match = tokenRegex.exec(trimmed);
	while (match !== null) {
		const token = match[1] ?? "";
		if (!ALLOWED_TEMPLATE_TOKENS.has(token)) {
			return err(configInvalid(pathName, `Unknown filename template token '{${token}}'`));
		}
		match = tokenRegex.exec(trimmed);
	}
	return ok(trimmed);
}

export interface OutputSpecInit {
	readonly dir: string;
	readonly filenameTemplate: string;
	readonly format: ImageFormat;
	readonly compression: number;
	readonly onConflict: ConflictPolicy;
	readonly returnImage: ReturnImageMode;
}

export class OutputSpec implements ValueObject<OutputSpec> {
	public readonly dir: string;
	public readonly filenameTemplate: string;
	public readonly format: ImageFormat;
	public readonly compression: number;
	public readonly onConflict: ConflictPolicy;
	public readonly returnImage: ReturnImageMode;
	#hash: string | undefined;

	public constructor(init: OutputSpecInit) {
		this.dir = init.dir;
		this.filenameTemplate = init.filenameTemplate;
		this.format = init.format;
		this.compression = init.compression;
		this.onConflict = init.onConflict;
		this.returnImage = init.returnImage;
		Object.freeze(this);
	}

	public static create(init: OutputSpecInit): Result<OutputSpec, ImgError> {
		if (init.dir.trim().length === 0) {
			return err(configInvalid("output.dir", "Output directory cannot be empty"));
		}
		const tplCheck = validateTemplateTokens(init.filenameTemplate, "output.filename");
		if (!tplCheck.ok) {
			return tplCheck;
		}
		if (!Number.isInteger(init.compression) || init.compression < 0 || init.compression > 100) {
			return err(configInvalid("output.compression", "Compression must be an integer between 0 and 100"));
		}
		return ok(
			new OutputSpec({
				dir: init.dir.trim(),
				filenameTemplate: tplCheck.value,
				format: init.format,
				compression: init.compression,
				onConflict: init.onConflict,
				returnImage: init.returnImage,
			}),
		);
	}

	public toPlain(): OutputSpecInit {
		return {
			dir: this.dir,
			filenameTemplate: this.filenameTemplate,
			format: this.format,
			compression: this.compression,
			onConflict: this.onConflict,
			returnImage: this.returnImage,
		};
	}

	public equals(other: OutputSpec): boolean {
		return structuralEquals(this.toPlain(), other.toPlain());
	}

	public hashCode(): string {
		this.#hash ??= computeHashCode(this.toPlain());
		return this.#hash;
	}
}

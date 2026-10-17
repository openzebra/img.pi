import { computeHashCode, structuralEquals, type ValueObject } from "../core/equals";
import { configInvalid, type ImgError } from "../core/errors";
import { deepFreeze } from "../core/freeze";
import { err, ok, type Result } from "../core/result";

export type TextureMapKind = "albedo" | "normal" | "height" | "roughness" | "ao" | "metallic" | "orm";
export type TextureResolution = 256 | 512 | 1024 | 2048 | 4096;
export type TilingMethod = "native" | "offset_blend" | "mirror" | "auto";
export type NormalConvention = "opengl" | "directx";
export type HeightSource = "luminance" | "model";
export type BitDepth = 8 | 16;

export const DEFAULT_TEXTURE_MAPS: readonly TextureMapKind[] = deepFreeze([
	"albedo",
	"normal",
	"roughness",
	"ao",
	"height",
]);

export const ALLOWED_TEXTURE_RESOLUTIONS: ReadonlySet<number> = new Set([256, 512, 1024, 2048, 4096]);

export function isTextureResolution(val: number): val is TextureResolution {
	return ALLOWED_TEXTURE_RESOLUTIONS.has(val);
}

export interface TextureSpecInit {
	readonly material: string;
	readonly maps?: readonly TextureMapKind[];
	readonly resolution?: TextureResolution;
	readonly tileable?: boolean;
	readonly tilingMethod?: TilingMethod;
	readonly seamBlendPx?: number;
	readonly normalConvention?: NormalConvention;
	readonly normalStrength?: number;
	readonly heightSource?: HeightSource;
	readonly roughnessRange?: readonly [number, number];
	readonly metallic?: number | "auto";
	readonly ormPack?: boolean;
	readonly bitDepth?: BitDepth;
	readonly previewTiles?: number;
}

export class TextureSpec implements ValueObject<TextureSpec> {
	public readonly material: string;
	public readonly maps: readonly TextureMapKind[];
	public readonly resolution: TextureResolution;
	public readonly tileable: boolean;
	public readonly tilingMethod: TilingMethod;
	public readonly seamBlendPx: number;
	public readonly normalConvention: NormalConvention;
	public readonly normalStrength: number;
	public readonly heightSource: HeightSource;
	public readonly roughnessRange: readonly [number, number];
	public readonly metallic: number | "auto";
	public readonly ormPack: boolean;
	public readonly bitDepth: BitDepth;
	public readonly previewTiles: number;
	#hash: string | undefined;

	public constructor(props: {
		readonly material: string;
		readonly maps: readonly TextureMapKind[];
		readonly resolution: TextureResolution;
		readonly tileable: boolean;
		readonly tilingMethod: TilingMethod;
		readonly seamBlendPx: number;
		readonly normalConvention: NormalConvention;
		readonly normalStrength: number;
		readonly heightSource: HeightSource;
		readonly roughnessRange: readonly [number, number];
		readonly metallic: number | "auto";
		readonly ormPack: boolean;
		readonly bitDepth: BitDepth;
		readonly previewTiles: number;
	}) {
		this.material = props.material;
		this.maps = Object.freeze([...props.maps]);
		this.resolution = props.resolution;
		this.tileable = props.tileable;
		this.tilingMethod = props.tilingMethod;
		this.seamBlendPx = props.seamBlendPx;
		this.normalConvention = props.normalConvention;
		this.normalStrength = props.normalStrength;
		this.heightSource = props.heightSource;
		this.roughnessRange = Object.freeze([props.roughnessRange[0], props.roughnessRange[1]]);
		this.metallic = props.metallic;
		this.ormPack = props.ormPack;
		this.bitDepth = props.bitDepth;
		this.previewTiles = props.previewTiles;
		Object.freeze(this);
	}

	public static create(init: TextureSpecInit): Result<TextureSpec, ImgError> {
		const material = init.material.trim();
		if (material.length === 0) {
			return err(configInvalid("texture.material", "Texture material prompt cannot be empty"));
		}
		const resolution: TextureResolution = init.resolution ?? 1024;
		if (!isTextureResolution(resolution)) {
			return err(configInvalid("texture.resolution", "Resolution must be 256, 512, 1024, 2048, or 4096"));
		}
		const maps = init.maps && init.maps.length > 0 ? init.maps : DEFAULT_TEXTURE_MAPS;
		const seamBlendPx = init.seamBlendPx ?? Math.round(resolution / 8);
		if (!Number.isInteger(seamBlendPx) || seamBlendPx < 0 || seamBlendPx > 512) {
			return err(configInvalid("texture.seam_blend_px", "seam_blend_px must be an integer in [0, 512]"));
		}
		const normalStrength = init.normalStrength ?? 2.0;
		if (!Number.isFinite(normalStrength) || normalStrength < 0.1 || normalStrength > 10) {
			return err(configInvalid("texture.normal_strength", "normal_strength must be in [0.1, 10]"));
		}
		const roughnessRange: readonly [number, number] = init.roughnessRange ?? [0.3, 0.9];
		if (
			roughnessRange[0] < 0 ||
			roughnessRange[0] > 1 ||
			roughnessRange[1] < 0 ||
			roughnessRange[1] > 1 ||
			roughnessRange[0] > roughnessRange[1]
		) {
			return err(configInvalid("texture.roughness_range", "roughness_range must be [min, max] within [0, 1]"));
		}
		const metallic = init.metallic ?? 0;
		if (metallic !== "auto" && (!Number.isFinite(metallic) || metallic < 0 || metallic > 1)) {
			return err(configInvalid("texture.metallic", "metallic must be 'auto' or a number in [0, 1]"));
		}
		const previewTiles = init.previewTiles ?? 2;
		if (!Number.isInteger(previewTiles) || previewTiles < 1 || previewTiles > 4) {
			return err(configInvalid("texture.preview_tiles", "preview_tiles must be an integer in [1, 4]"));
		}
		return ok(
			new TextureSpec({
				material,
				maps,
				resolution,
				tileable: init.tileable ?? true,
				tilingMethod: init.tilingMethod ?? "auto",
				seamBlendPx,
				normalConvention: init.normalConvention ?? "opengl",
				normalStrength,
				heightSource: init.heightSource ?? "luminance",
				roughnessRange,
				metallic,
				ormPack: init.ormPack ?? false,
				bitDepth: init.bitDepth ?? 8,
				previewTiles,
			}),
		);
	}

	public toPlain(): Record<string, unknown> {
		return {
			material: this.material,
			maps: this.maps,
			resolution: this.resolution,
			tileable: this.tileable,
			tilingMethod: this.tilingMethod,
			seamBlendPx: this.seamBlendPx,
			normalConvention: this.normalConvention,
			normalStrength: this.normalStrength,
			heightSource: this.heightSource,
			roughnessRange: this.roughnessRange,
			metallic: this.metallic,
			ormPack: this.ormPack,
			bitDepth: this.bitDepth,
			previewTiles: this.previewTiles,
		};
	}

	public equals(other: TextureSpec): boolean {
		return structuralEquals(this.toPlain(), other.toPlain());
	}

	public hashCode(): string {
		this.#hash ??= computeHashCode(this.toPlain());
		return this.#hash;
	}
}

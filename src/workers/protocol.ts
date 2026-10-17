import type { WorkerOp } from "../core/errors.js";
import type { ImageFormat } from "../domain/output.js";
import type { FitMode } from "../domain/size.js";
import type { NormalConvention } from "../domain/texture.js";

export type WorkerPayload =
	| { readonly op: "decode_b64"; readonly b64: string }
	| { readonly op: "encode_b64"; readonly buffer: ArrayBuffer }
	| { readonly op: "probe"; readonly buffer: ArrayBuffer }
	| {
			readonly op: "resize";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
			readonly fit: FitMode;
			readonly format?: ImageFormat;
			readonly compression?: number;
	  }
	| {
			readonly op: "convert";
			readonly buffer: ArrayBuffer;
			readonly format: ImageFormat;
			readonly compression: number;
			readonly bitDepth?: 8 | 16;
			readonly grayscale?: boolean;
			readonly sharpen?: number;
	  }
	| {
			readonly op: "thumbnail";
			readonly buffer: ArrayBuffer;
			readonly maxSide: number;
			readonly quality: number;
	  }
	| {
			readonly op: "halfblock_preview";
			readonly buffer: ArrayBuffer;
			readonly maxCols: number;
			readonly maxRows: number;
	  }
	| {
			readonly op: "contact_sheet";
			readonly buffers: readonly ArrayBuffer[];
			readonly labels?: readonly string[];
			readonly cols?: number;
			readonly thumbSize?: number;
	  }
	| {
			readonly op: "roll";
			readonly buffer: ArrayBuffer;
			readonly dx?: number;
			readonly dy?: number;
	  }
	| {
			readonly op: "multiband_blend";
			readonly buffer: ArrayBuffer;
			readonly seamBlendPx: number;
			readonly patchBuffer?: ArrayBuffer;
	  }
	| {
			readonly op: "mirror_quad";
			readonly buffer: ArrayBuffer;
	  }
	| {
			readonly op: "seam_score";
			readonly buffer: ArrayBuffer;
	  }
	| {
			readonly op: "height";
			readonly buffer: ArrayBuffer;
			readonly bitDepth: 8 | 16;
			readonly sigmaDivisor?: number;
	  }
	| {
			readonly op: "normal";
			readonly heightFloat: ArrayBuffer;
			readonly width: number;
			readonly height: number;
			readonly strength: number;
			readonly convention: NormalConvention;
			readonly bitDepth: 8 | 16;
	  }
	| {
			readonly op: "ao";
			readonly heightFloat: ArrayBuffer;
			readonly width: number;
			readonly height: number;
			readonly bitDepth: 8 | 16;
	  }
	| {
			readonly op: "roughness";
			readonly heightFloat: ArrayBuffer;
			readonly width: number;
			readonly height: number;
			readonly range: readonly [number, number];
			readonly bitDepth: 8 | 16;
	  }
	| {
			readonly op: "metallic";
			readonly albedoBuffer: ArrayBuffer;
			readonly mode: number | "auto";
			readonly bitDepth: 8 | 16;
	  }
	| {
			readonly op: "orm_pack";
			readonly aoFloat: ArrayBuffer;
			readonly roughFloat: ArrayBuffer;
			readonly metalFloat: ArrayBuffer;
			readonly width: number;
			readonly height: number;
			readonly bitDepth: 8 | 16;
	  }
	| {
			readonly op: "trim";
			readonly buffer: ArrayBuffer;
			readonly threshold?: number;
	  }
	| {
			readonly op: "palette";
			readonly buffer: ArrayBuffer;
			readonly colors: number;
	  }
	| {
			readonly op: "embed_metadata";
			readonly buffer: ArrayBuffer;
			readonly format: ImageFormat;
			readonly metadata: Readonly<Record<string, string>>;
	  }
	| {
			readonly op: "json_parse_large";
			readonly text: string;
			readonly jsonl?: boolean;
	  }
	| {
			readonly op: "remove_bg";
			readonly buffer: ArrayBuffer;
			readonly tolerance?: number;
	  }
	| {
			readonly op: "outpaint_canvas";
			readonly buffer: ArrayBuffer;
			readonly left: number;
			readonly right: number;
			readonly top: number;
			readonly bottom: number;
	  }
	| {
			readonly op: "tile_grid";
			readonly buffer: ArrayBuffer;
			readonly tiles: number;
			readonly showGrid?: boolean;
	  };

export type WorkerSuccessPayload =
	| {
			readonly op: "decode_b64";
			readonly buffer: ArrayBuffer;
			readonly sha256: string;
	  }
	| {
			readonly op: "encode_b64";
			readonly b64: string;
			readonly sha256: string;
	  }
	| {
			readonly op: "probe";
			readonly width: number;
			readonly height: number;
			readonly format: string;
			readonly channels: number;
			readonly sha256: string;
	  }
	| {
			readonly op: "resize";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "convert";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
			readonly sha256: string;
	  }
	| {
			readonly op: "thumbnail";
			readonly b64: string;
			readonly mimeType: string;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "halfblock_preview";
			readonly lines: readonly string[];
			readonly cols: number;
			readonly rows: number;
	  }
	| {
			readonly op: "contact_sheet";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "roll";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "multiband_blend";
			readonly buffer: ArrayBuffer;
			readonly seamScore: number;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "mirror_quad";
			readonly buffer: ArrayBuffer;
			readonly seamScore: number;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "seam_score";
			readonly score: number;
			readonly horizontalScore: number;
			readonly verticalScore: number;
	  }
	| {
			readonly op: "height";
			readonly buffer: ArrayBuffer;
			readonly floatHeight: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "normal";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "ao";
			readonly buffer: ArrayBuffer;
			readonly aoFloat: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "roughness";
			readonly buffer: ArrayBuffer;
			readonly roughFloat: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "metallic";
			readonly buffer: ArrayBuffer;
			readonly metalFloat: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "orm_pack";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "trim";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "palette";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "embed_metadata";
			readonly buffer: ArrayBuffer;
			readonly sha256: string;
	  }
	| {
			readonly op: "json_parse_large";
			readonly data: unknown;
	  }
	| {
			readonly op: "remove_bg";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "outpaint_canvas";
			readonly canvasBuffer: ArrayBuffer;
			readonly maskBuffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  }
	| {
			readonly op: "tile_grid";
			readonly buffer: ArrayBuffer;
			readonly width: number;
			readonly height: number;
	  };

export type ResponseForOp<O extends WorkerOp> = Extract<WorkerSuccessPayload, { readonly op: O }>;
export type RequestForOp<O extends WorkerOp> = Extract<WorkerPayload, { readonly op: O }>;

export interface WorkerRequestMessage {
	readonly id: string;
	readonly payload: WorkerPayload;
}

export type WorkerResponseMessage =
	| {
			readonly id: string;
			readonly ok: true;
			readonly result: WorkerSuccessPayload;
	  }
	| {
			readonly id: string;
			readonly ok: false;
			readonly op: WorkerOp;
			readonly message: string;
	  };

export function collectRequestTransferables(payload: WorkerPayload): ArrayBuffer[] {
	switch (payload.op) {
		case "decode_b64":
		case "json_parse_large":
			return [];
		case "encode_b64":
		case "probe":
		case "resize":
		case "convert":
		case "thumbnail":
		case "halfblock_preview":
		case "roll":
		case "mirror_quad":
		case "seam_score":
		case "height":
		case "trim":
		case "palette":
		case "embed_metadata":
		case "remove_bg":
		case "outpaint_canvas":
		case "tile_grid":
			return [payload.buffer];
		case "multiband_blend":
			return payload.patchBuffer !== undefined ? [payload.buffer, payload.patchBuffer] : [payload.buffer];
		case "contact_sheet":
			return [...payload.buffers];
		case "normal":
		case "ao":
		case "roughness":
			return [payload.heightFloat];
		case "metallic":
			return [payload.albedoBuffer];
		case "orm_pack":
			return [payload.aoFloat, payload.roughFloat, payload.metalFloat];
		default: {
			const _exhaustive: never = payload;
			return _exhaustive;
		}
	}
}

export function collectResponseTransferables(result: WorkerSuccessPayload): ArrayBuffer[] {
	switch (result.op) {
		case "encode_b64":
		case "probe":
		case "thumbnail":
		case "halfblock_preview":
		case "seam_score":
		case "json_parse_large":
			return [];
		case "decode_b64":
		case "resize":
		case "convert":
		case "contact_sheet":
		case "roll":
		case "multiband_blend":
		case "mirror_quad":
		case "normal":
		case "orm_pack":
		case "trim":
		case "palette":
		case "embed_metadata":
		case "remove_bg":
		case "tile_grid":
			return [result.buffer];
		case "height":
			return [result.buffer, result.floatHeight];
		case "ao":
			return [result.buffer, result.aoFloat];
		case "roughness":
			return [result.buffer, result.roughFloat];
		case "metallic":
			return [result.buffer, result.metalFloat];
		case "outpaint_canvas":
			return [result.canvasBuffer, result.maskBuffer];
		default: {
			const _exhaustive: never = result;
			return _exhaustive;
		}
	}
}

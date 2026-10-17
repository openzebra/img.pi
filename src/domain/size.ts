import { computeHashCode, structuralEquals, type ValueObject } from "../core/equals";
import { configInvalid, type ImgError } from "../core/errors";
import { deepFreeze } from "../core/freeze";
import { err, ok, type Result } from "../core/result";

export type ResolutionTier = "0.5K" | "1K" | "2K" | "4K";
export type SizeMode = "snap" | "exact";
export type FitMode = "cover" | "contain" | "fill";

export const RESOLUTION_LONG_SIDE: Readonly<Record<ResolutionTier, number>> = deepFreeze({
	"0.5K": 512,
	"1K": 1024,
	"2K": 2048,
	"4K": 4096,
});

export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 8192;

export class Size implements ValueObject<Size> {
	public readonly width: number;
	public readonly height: number;
	#hash: string | undefined;

	public constructor(width: number, height: number) {
		this.width = Math.round(width);
		this.height = Math.round(height);
		Object.freeze(this);
	}

	public static create(width: number, height: number): Result<Size, ImgError> {
		if (!Number.isFinite(width) || !Number.isFinite(height)) {
			return err(configInvalid("size", "width and height must be finite numbers"));
		}
		const w = Math.round(width);
		const h = Math.round(height);
		if (w < MIN_DIMENSION || w > MAX_DIMENSION || h < MIN_DIMENSION || h > MAX_DIMENSION) {
			return err(
				configInvalid("size", `dimensions ${w}x${h} out of allowed range [${MIN_DIMENSION}..${MAX_DIMENSION}]`),
			);
		}
		return ok(new Size(w, h));
	}

	public get pixels(): number {
		return this.width * this.height;
	}

	public get aspect(): number {
		return this.width / this.height;
	}

	public format(): string {
		return `${this.width}×${this.height}`;
	}

	public formatAscii(): string {
		return `${this.width}x${this.height}`;
	}

	public equals(other: Size): boolean {
		return this.width === other.width && this.height === other.height;
	}

	public hashCode(): string {
		this.#hash ??= computeHashCode({ width: this.width, height: this.height });
		return this.#hash;
	}
}

export type SizeRule =
	| { readonly kind: "fixed"; readonly sizes: readonly Size[] }
	| { readonly kind: "multiple"; readonly step: number; readonly min: number; readonly max: number }
	| {
			readonly kind: "aspects";
			readonly aspects: readonly string[];
			readonly resolutions?: readonly ResolutionTier[];
	  }
	| { readonly kind: "range"; readonly min: number; readonly max: number }
	| { readonly kind: "any"; readonly min?: number; readonly max?: number };

export interface SizeRequest {
	readonly width?: number;
	readonly height?: number;
	readonly aspectRatio?: string;
	readonly resolution?: ResolutionTier;
}

export interface SnapResult {
	readonly requested: Size;
	readonly size: Size;
	readonly aspectRatio: string;
	readonly resolution: ResolutionTier;
	readonly exact: boolean;
	readonly note?: string;
}

export function parseAspectRatio(ar: string): Result<{ readonly w: number; readonly h: number }, ImgError> {
	const trimmed = ar.trim();
	const parts = trimmed.split(":");
	if (parts.length !== 2) {
		return err(configInvalid("aspect_ratio", `Invalid aspect ratio '${ar}', expected 'W:H'`));
	}
	const wStr = parts[0] ?? "";
	const hStr = parts[1] ?? "";
	const w = Number(wStr);
	const h = Number(hStr);
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		return err(configInvalid("aspect_ratio", `Invalid aspect ratio '${ar}', W and H must be positive numbers`));
	}
	return ok(Object.freeze({ w, h }));
}

function gcd(a: number, b: number): number {
	let x = Math.abs(Math.round(a));
	let y = Math.abs(Math.round(b));
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x || 1;
}

export function inferAspectString(size: Size): string {
	const d = gcd(size.width, size.height);
	const rw = size.width / d;
	const rh = size.height / d;
	if (rw <= 32 && rh <= 32) {
		return `${rw}:${rh}`;
	}
	const knownAspects = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"];
	const targetLog = Math.log(size.aspect);
	let best = "1:1";
	let bestDiff = Infinity;
	for (const cand of knownAspects) {
		const parsed = parseAspectRatio(cand);
		if (!parsed.ok) continue;
		const diff = Math.abs(targetLog - Math.log(parsed.value.w / parsed.value.h));
		if (diff < bestDiff) {
			bestDiff = diff;
			best = cand;
		}
	}
	return best;
}

export function sizeFromAspectAndResolution(
	wRatio: number,
	hRatio: number,
	resolution: ResolutionTier,
	step = 8,
): Size {
	const longSide = RESOLUTION_LONG_SIDE[resolution];
	let width: number;
	let height: number;
	if (wRatio >= hRatio) {
		width = longSide;
		height = Math.round((longSide * hRatio) / wRatio);
	} else {
		height = longSide;
		width = Math.round((longSide * wRatio) / hRatio);
	}
	const snapW = Math.max(MIN_DIMENSION, Math.round(width / step) * step);
	const snapH = Math.max(MIN_DIMENSION, Math.round(height / step) * step);
	return new Size(snapW, snapH);
}

export function resolveRequestedSize(
	req: SizeRequest,
	fallback: Size = new Size(1024, 1024),
): Result<{ readonly size: Size; readonly aspectRatio: string; readonly resolution: ResolutionTier }, ImgError> {
	const resolution: ResolutionTier = req.resolution ?? "1K";
	if (req.width !== undefined && req.height !== undefined) {
		const created = Size.create(req.width, req.height);
		if (!created.ok) return created;
		const ar = req.aspectRatio ?? inferAspectString(created.value);
		return ok(Object.freeze({ size: created.value, aspectRatio: ar, resolution }));
	}
	if (req.width !== undefined && req.height === undefined) {
		if (req.aspectRatio !== undefined) {
			const parsed = parseAspectRatio(req.aspectRatio);
			if (!parsed.ok) return parsed;
			const h = Math.round((req.width * parsed.value.h) / parsed.value.w);
			const created = Size.create(req.width, h);
			if (!created.ok) return created;
			return ok(Object.freeze({ size: created.value, aspectRatio: req.aspectRatio, resolution }));
		}
		const created = Size.create(req.width, req.width);
		if (!created.ok) return created;
		return ok(Object.freeze({ size: created.value, aspectRatio: "1:1", resolution }));
	}
	if (req.height !== undefined && req.width === undefined) {
		if (req.aspectRatio !== undefined) {
			const parsed = parseAspectRatio(req.aspectRatio);
			if (!parsed.ok) return parsed;
			const w = Math.round((req.height * parsed.value.w) / parsed.value.h);
			const created = Size.create(w, req.height);
			if (!created.ok) return created;
			return ok(Object.freeze({ size: created.value, aspectRatio: req.aspectRatio, resolution }));
		}
		const created = Size.create(req.height, req.height);
		if (!created.ok) return created;
		return ok(Object.freeze({ size: created.value, aspectRatio: "1:1", resolution }));
	}
	if (req.aspectRatio !== undefined || req.resolution !== undefined) {
		const arStr = req.aspectRatio ?? inferAspectString(fallback);
		const parsed = parseAspectRatio(arStr);
		if (!parsed.ok) return parsed;
		const computed = sizeFromAspectAndResolution(parsed.value.w, parsed.value.h, resolution, 8);
		return ok(Object.freeze({ size: computed, aspectRatio: arStr, resolution }));
	}
	return ok(
		Object.freeze({
			size: fallback,
			aspectRatio: inferAspectString(fallback),
			resolution,
		}),
	);
}

function clampDim(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(value)));
}

function roundToMultiple(value: number, step: number, min: number, max: number): number {
	const clamped = clampDim(value, min, max);
	const rounded = Math.round(clamped / step) * step;
	if (rounded < min) {
		return Math.ceil(min / step) * step;
	}
	if (rounded > max) {
		return Math.floor(max / step) * step;
	}
	return rounded;
}

export function snapSize(
	req: SizeRequest,
	rule: SizeRule,
	fallback: Size = new Size(1024, 1024),
): Result<SnapResult, ImgError> {
	const resolved = resolveRequestedSize(req, fallback);
	if (!resolved.ok) {
		return resolved;
	}
	const requested = resolved.value.size;
	let produced: Size = requested;
	let snappedAspect = resolved.value.aspectRatio;
	let snappedRes = resolved.value.resolution;

	switch (rule.kind) {
		case "fixed": {
			if (rule.sizes.length === 0) {
				produced = requested;
				break;
			}
			const reqLogAspect = Math.log(requested.aspect);
			const reqArea = requested.pixels;
			let best = rule.sizes[0] ?? requested;
			let bestAspectDiff = Infinity;
			let bestAreaDiff = Infinity;
			for (const candidate of rule.sizes) {
				const aspectDiff = Math.abs(reqLogAspect - Math.log(candidate.aspect));
				const areaDiff = Math.abs(reqArea - candidate.pixels);
				if (
					aspectDiff < bestAspectDiff - 1e-6 ||
					(Math.abs(aspectDiff - bestAspectDiff) <= 1e-6 && areaDiff < bestAreaDiff)
				) {
					best = candidate;
					bestAspectDiff = aspectDiff;
					bestAreaDiff = areaDiff;
				}
			}
			produced = best;
			snappedAspect = inferAspectString(produced);
			break;
		}
		case "multiple": {
			const w = roundToMultiple(requested.width, rule.step, rule.min, rule.max);
			const h = roundToMultiple(requested.height, rule.step, rule.min, rule.max);
			produced = new Size(w, h);
			break;
		}
		case "aspects": {
			const reqLogAspect = Math.log(requested.aspect);
			let bestAspectStr = rule.aspects[0] ?? "1:1";
			let bestRatio = { w: 1, h: 1 };
			let bestDiff = Infinity;
			for (const candStr of rule.aspects) {
				const parsed = parseAspectRatio(candStr);
				if (!parsed.ok) continue;
				const diff = Math.abs(reqLogAspect - Math.log(parsed.value.w / parsed.value.h));
				if (diff < bestDiff - 1e-6) {
					bestDiff = diff;
					bestAspectStr = candStr;
					bestRatio = parsed.value;
				}
			}
			snappedAspect = bestAspectStr;
			if (rule.resolutions !== undefined && rule.resolutions.length > 0) {
				if (!rule.resolutions.includes(snappedRes)) {
					const targetLong = Math.max(requested.width, requested.height);
					let bestRes = rule.resolutions[0] ?? "1K";
					let bestResDiff = Infinity;
					for (const r of rule.resolutions) {
						const d = Math.abs(RESOLUTION_LONG_SIDE[r] - targetLong);
						if (d < bestResDiff) {
							bestResDiff = d;
							bestRes = r;
						}
					}
					snappedRes = bestRes;
				}
			}
			produced = sizeFromAspectAndResolution(bestRatio.w, bestRatio.h, snappedRes, 8);
			break;
		}
		case "range": {
			const w = clampDim(requested.width, rule.min, rule.max);
			const h = clampDim(requested.height, rule.min, rule.max);
			produced = new Size(w, h);
			break;
		}
		case "any": {
			const min = rule.min ?? MIN_DIMENSION;
			const max = rule.max ?? MAX_DIMENSION;
			const w = clampDim(requested.width, min, max);
			const h = clampDim(requested.height, min, max);
			produced = new Size(w, h);
			break;
		}
		default: {
			const _exhaustive: never = rule;
			return _exhaustive;
		}
	}

	const exact = structuralEquals(
		{ w: requested.width, h: requested.height },
		{ w: produced.width, h: produced.height },
	);
	const note = exact ? undefined : `${produced.format()} → ${requested.format()} (resized)`;

	return ok(
		Object.freeze({
			requested,
			size: produced,
			aspectRatio: snappedAspect,
			resolution: snappedRes,
			exact,
			...(note !== undefined ? { note } : {}),
		}),
	);
}

import type { ImgError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { BackgroundMode, ImageFormat, PostSpec, ReturnImageMode } from "../domain/output.js";
import type { FitMode, Size, SizeMode } from "../domain/size.js";
import type { WorkerPool } from "../workers/pool.js";

export interface PostProcessInput {
	readonly buffer: ArrayBuffer;
	readonly requestedSize: Size;
	readonly sizeMode: SizeMode;
	readonly fit: FitMode;
	readonly post: PostSpec;
	readonly background: BackgroundMode;
	readonly modelSupportsTransparentBg: boolean;
	readonly format: ImageFormat;
	readonly compression: number;
	readonly bitDepth?: 8 | 16;
	readonly embedMetadata: boolean;
	readonly metadataToEmbed?: Readonly<Record<string, string>>;
	readonly returnImage: ReturnImageMode;
	readonly pool: WorkerPool;
}

export interface PostProcessResult {
	readonly buffer: ArrayBuffer;
	readonly width: number;
	readonly height: number;
	readonly format: ImageFormat;
	readonly sha256: string;
	readonly appliedOps: readonly string[];
	readonly thumbB64?: string;
	readonly thumbMimeType?: string;
}

function formatToMime(format: ImageFormat): string {
	switch (format) {
		case "png":
			return "image/png";
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "avif":
			return "image/avif";
		default: {
			const _exhaustive: never = format;
			return _exhaustive;
		}
	}
}

export async function runPostProcess(input: PostProcessInput): Promise<Result<PostProcessResult, ImgError>> {
	let currentBuffer = input.buffer;
	const appliedOps: string[] = [];

	// 1. Probe initial dimensions
	const probeRes = await input.pool.run({
		op: "probe",
		buffer: currentBuffer.slice(0),
	});
	if (!probeRes.ok) {
		return probeRes;
	}
	let currentWidth = probeRes.value.width;
	let currentHeight = probeRes.value.height;

	// 2. Exact size resize if produced dimensions differ from requestedSize
	if (
		input.sizeMode === "exact" &&
		(currentWidth !== input.requestedSize.width || currentHeight !== input.requestedSize.height)
	) {
		const resizeRes = await input.pool.run({
			op: "resize",
			buffer: currentBuffer,
			width: input.requestedSize.width,
			height: input.requestedSize.height,
			fit: input.fit,
		});
		if (!resizeRes.ok) {
			return resizeRes;
		}
		currentBuffer = resizeRes.value.buffer;
		currentWidth = resizeRes.value.width;
		currentHeight = resizeRes.value.height;
		appliedOps.push("resize_exact");
	}

	// 3. Background removal
	const shouldRemoveBg =
		input.post.removeBackground === true ||
		(input.background === "transparent" &&
			!input.modelSupportsTransparentBg &&
			input.post.removeBackground !== false);

	if (shouldRemoveBg) {
		const bgRes = await input.pool.run({
			op: "remove_bg",
			buffer: currentBuffer,
		});
		if (!bgRes.ok) {
			return bgRes;
		}
		currentBuffer = bgRes.value.buffer;
		currentWidth = bgRes.value.width;
		currentHeight = bgRes.value.height;
		appliedOps.push("remove_background");
	}

	// 4. Trim whitespace/transparent borders
	if (input.post.trim === true) {
		const trimRes = await input.pool.run({
			op: "trim",
			buffer: currentBuffer,
		});
		if (!trimRes.ok) {
			return trimRes;
		}
		currentBuffer = trimRes.value.buffer;
		currentWidth = trimRes.value.width;
		currentHeight = trimRes.value.height;
		appliedOps.push("trim");
	}

	// 5. Upscale (2x / 4x)
	if (input.post.upscale === 2 || input.post.upscale === 4) {
		const scale = input.post.upscale;
		const upRes = await input.pool.run({
			op: "resize",
			buffer: currentBuffer,
			width: currentWidth * scale,
			height: currentHeight * scale,
			fit: "fill",
		});
		if (!upRes.ok) {
			return upRes;
		}
		currentBuffer = upRes.value.buffer;
		currentWidth = upRes.value.width;
		currentHeight = upRes.value.height;
		appliedOps.push(`upscale_${scale}x`);
	}

	// 6. Palette quantization
	if (input.post.palette !== undefined) {
		const palRes = await input.pool.run({
			op: "palette",
			buffer: currentBuffer,
			colors: input.post.palette,
		});
		if (!palRes.ok) {
			return palRes;
		}
		currentBuffer = palRes.value.buffer;
		currentWidth = palRes.value.width;
		currentHeight = palRes.value.height;
		appliedOps.push(`palette_${input.post.palette}`);
	}

	if (input.post.grayscale === true) {
		appliedOps.push("grayscale");
	}
	if (input.post.sharpen !== undefined) {
		appliedOps.push("sharpen");
	}

	// 7. Convert format + sharpen + grayscale
	const effectiveFormat: ImageFormat =
		input.background === "transparent" && input.format === "jpeg" ? "png" : input.format;

	const convertRes = await input.pool.run({
		op: "convert",
		buffer: currentBuffer,
		format: effectiveFormat,
		compression: input.compression,
		...(input.bitDepth !== undefined ? { bitDepth: input.bitDepth } : {}),
		...(input.post.grayscale !== undefined ? { grayscale: input.post.grayscale } : {}),
		...(input.post.sharpen !== undefined ? { sharpen: input.post.sharpen } : {}),
	});
	if (!convertRes.ok) {
		return convertRes;
	}
	currentBuffer = convertRes.value.buffer;
	currentWidth = convertRes.value.width;
	currentHeight = convertRes.value.height;
	let sha256 = convertRes.value.sha256;

	// 8. Embed metadata if enabled
	if (input.embedMetadata && input.metadataToEmbed !== undefined && Object.keys(input.metadataToEmbed).length > 0) {
		const metaRes = await input.pool.run({
			op: "embed_metadata",
			buffer: currentBuffer,
			format: effectiveFormat,
			metadata: input.metadataToEmbed,
		});
		if (!metaRes.ok) {
			return metaRes;
		}
		currentBuffer = metaRes.value.buffer;
		sha256 = metaRes.value.sha256;
	}

	// 9. Context thumbnail / full image base64
	let thumbB64: string | undefined;
	let thumbMimeType: string | undefined;

	if (input.returnImage === "thumbnail") {
		const thumbRes = await input.pool.run({
			op: "thumbnail",
			buffer: currentBuffer.slice(0),
			maxSide: 512,
			quality: 80,
		});
		if (!thumbRes.ok) {
			return thumbRes;
		}
		thumbB64 = thumbRes.value.b64;
		thumbMimeType = thumbRes.value.mimeType;
	} else if (input.returnImage === "full") {
		const encRes = await input.pool.run({
			op: "encode_b64",
			buffer: currentBuffer.slice(0),
		});
		if (!encRes.ok) {
			return encRes;
		}
		thumbB64 = encRes.value.b64;
		thumbMimeType = formatToMime(effectiveFormat);
	}

	return ok(
		Object.freeze({
			buffer: currentBuffer,
			width: currentWidth,
			height: currentHeight,
			format: effectiveFormat,
			sha256,
			appliedOps: Object.freeze(appliedOps),
			...(thumbB64 !== undefined ? { thumbB64 } : {}),
			...(thumbMimeType !== undefined ? { thumbMimeType } : {}),
		}),
	);
}

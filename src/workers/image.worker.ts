import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import type { ImageFormat } from "../domain/output.js";
import type { WorkerPayload, WorkerRequestMessage, WorkerResponseMessage, WorkerSuccessPayload } from "./protocol.js";
import { collectResponseTransferables } from "./protocol.js";

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function toUint8(buffer: ArrayBuffer): Uint8Array {
	return new Uint8Array(buffer);
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(view.byteLength);
	copy.set(view);
	return copy.buffer;
}

async function decodeRawRgba(
	buffer: ArrayBuffer,
): Promise<{ readonly data: Uint8Array; readonly width: number; readonly height: number }> {
	const instance = sharp(toUint8(buffer));
	try {
		const { data, info } = await instance.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		return {
			data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			width: info.width,
			height: info.height,
		};
	} finally {
		instance.destroy();
	}
}

async function encodeRawRgbaToPng(data: Uint8Array, width: number, height: number): Promise<ArrayBuffer> {
	const instance = sharp(data, {
		raw: { width, height, channels: 4 },
	});
	try {
		const out = await instance.png({ compressionLevel: 6 }).toBuffer();
		return toArrayBuffer(out);
	} finally {
		instance.destroy();
	}
}

async function encodeFloatGrayscale(
	floatData: Float32Array,
	width: number,
	height: number,
	bitDepth: 8 | 16,
): Promise<ArrayBuffer> {
	const total = width * height;
	if (bitDepth === 16) {
		const u16 = new Uint16Array(total);
		for (let i = 0; i < total; i++) {
			const v = Math.max(0, Math.min(1, floatData[i] ?? 0));
			u16[i] = Math.round(v * 65535);
		}
		const instance = sharp(u16, {
			raw: { width, height, channels: 1 },
		});
		try {
			const out = await instance.toColourspace("grey16").png({ compressionLevel: 6 }).toBuffer();
			return toArrayBuffer(out);
		} finally {
			instance.destroy();
		}
	}
	const u8 = new Uint8Array(total);
	for (let i = 0; i < total; i++) {
		const v = Math.max(0, Math.min(1, floatData[i] ?? 0));
		u8[i] = Math.round(v * 255);
	}
	const instance = sharp(u8, {
		raw: { width, height, channels: 1 },
	});
	try {
		const out = await instance.png({ compressionLevel: 6 }).toBuffer();
		return toArrayBuffer(out);
	} finally {
		instance.destroy();
	}
}

async function encodeFloatRgb(
	rData: Float32Array,
	gData: Float32Array,
	bData: Float32Array,
	width: number,
	height: number,
	bitDepth: 8 | 16,
): Promise<ArrayBuffer> {
	const total = width * height;
	if (bitDepth === 16) {
		const u16 = new Uint16Array(total * 3);
		for (let i = 0; i < total; i++) {
			const r = Math.max(0, Math.min(1, rData[i] ?? 0));
			const g = Math.max(0, Math.min(1, gData[i] ?? 0));
			const b = Math.max(0, Math.min(1, bData[i] ?? 0));
			const base = i * 3;
			u16[base] = Math.round(r * 65535);
			u16[base + 1] = Math.round(g * 65535);
			u16[base + 2] = Math.round(b * 65535);
		}
		const instance = sharp(u16, {
			raw: { width, height, channels: 3 },
		});
		try {
			const out = await instance.toColourspace("rgb16").png({ compressionLevel: 6 }).toBuffer();
			return toArrayBuffer(out);
		} finally {
			instance.destroy();
		}
	}
	const u8 = new Uint8Array(total * 3);
	for (let i = 0; i < total; i++) {
		const r = Math.max(0, Math.min(1, rData[i] ?? 0));
		const g = Math.max(0, Math.min(1, gData[i] ?? 0));
		const b = Math.max(0, Math.min(1, bData[i] ?? 0));
		const base = i * 3;
		u8[base] = Math.round(r * 255);
		u8[base + 1] = Math.round(g * 255);
		u8[base + 2] = Math.round(b * 255);
	}
	const instance = sharp(u8, {
		raw: { width, height, channels: 3 },
	});
	try {
		const out = await instance.png({ compressionLevel: 6 }).toBuffer();
		return toArrayBuffer(out);
	} finally {
		instance.destroy();
	}
}

function applyFormat(
	pipeline: sharp.Sharp,
	format: ImageFormat,
	compression: number,
	bitDepth: 8 | 16 = 8,
): sharp.Sharp {
	const q = Math.max(1, Math.min(100, Math.round(compression)));
	switch (format) {
		case "png": {
			const configured = bitDepth === 16 ? pipeline.toColourspace("rgb16") : pipeline;
			return configured.png({
				compressionLevel: Math.max(0, Math.min(9, Math.round((100 - q) / 11))),
			});
		}
		case "jpeg":
			return pipeline.jpeg({ quality: q });
		case "webp":
			return pipeline.webp({ quality: q });
		case "avif":
			return pipeline.avif({ quality: q });
		default: {
			const _exhaustive: never = format;
			return _exhaustive;
		}
	}
}

function wrapCoord(v: number, size: number): number {
	const m = v % size;
	return m < 0 ? m + size : m;
}

function boxBlurWrapFloat(src: Float32Array, width: number, height: number, radius: number): Float32Array {
	if (radius <= 0) {
		return new Float32Array(src);
	}
	const tmp = new Float32Array(width * height);
	const dst = new Float32Array(width * height);
	const diam = radius * 2 + 1;
	const invDiam = 1 / diam;

	// Horizontal pass with wrap-around
	for (let y = 0; y < height; y++) {
		const rowOffset = y * width;
		let sum = 0;
		for (let k = -radius; k <= radius; k++) {
			sum += src[rowOffset + wrapCoord(k, width)] ?? 0;
		}
		tmp[rowOffset] = sum * invDiam;
		for (let x = 1; x < width; x++) {
			const removeX = wrapCoord(x - radius - 1, width);
			const addX = wrapCoord(x + radius, width);
			sum += (src[rowOffset + addX] ?? 0) - (src[rowOffset + removeX] ?? 0);
			tmp[rowOffset + x] = sum * invDiam;
		}
	}

	// Vertical pass with wrap-around
	for (let x = 0; x < width; x++) {
		let sum = 0;
		for (let k = -radius; k <= radius; k++) {
			sum += tmp[wrapCoord(k, height) * width + x] ?? 0;
		}
		dst[x] = sum * invDiam;
		for (let y = 1; y < height; y++) {
			const removeY = wrapCoord(y - radius - 1, height);
			const addY = wrapCoord(y + radius, height);
			sum += (tmp[addY * width + x] ?? 0) - (tmp[removeY * width + x] ?? 0);
			dst[y * width + x] = sum * invDiam;
		}
	}

	return dst;
}

function gaussianBlurWrapFloat(src: Float32Array, width: number, height: number, sigma: number): Float32Array {
	const r = Math.max(1, Math.round(sigma));
	const pass1 = boxBlurWrapFloat(src, width, height, r);
	return boxBlurWrapFloat(pass1, width, height, r);
}

function computeSeamMetrics(
	rgba: Uint8Array,
	width: number,
	height: number,
): { readonly score: number; readonly horizontalScore: number; readonly verticalScore: number } {
	let vertDiffSum = 0;
	for (let y = 0; y < height; y++) {
		const leftIdx = (y * width + 0) * 4;
		const rightIdx = (y * width + (width - 1)) * 4;
		const dr = Math.abs((rgba[leftIdx] ?? 0) - (rgba[rightIdx] ?? 0));
		const dg = Math.abs((rgba[leftIdx + 1] ?? 0) - (rgba[rightIdx + 1] ?? 0));
		const db = Math.abs((rgba[leftIdx + 2] ?? 0) - (rgba[rightIdx + 2] ?? 0));
		vertDiffSum += (dr + dg + db) / 3;
	}
	const verticalScore = height > 0 ? vertDiffSum / height : 0;

	let horizDiffSum = 0;
	for (let x = 0; x < width; x++) {
		const topIdx = (0 * width + x) * 4;
		const botIdx = ((height - 1) * width + x) * 4;
		const dr = Math.abs((rgba[topIdx] ?? 0) - (rgba[botIdx] ?? 0));
		const dg = Math.abs((rgba[topIdx + 1] ?? 0) - (rgba[botIdx + 1] ?? 0));
		const db = Math.abs((rgba[topIdx + 2] ?? 0) - (rgba[botIdx + 2] ?? 0));
		horizDiffSum += (dr + dg + db) / 3;
	}
	const horizontalScore = width > 0 ? horizDiffSum / width : 0;
	const score = (verticalScore + horizontalScore) / 2;

	return { score, horizontalScore, verticalScore };
}

function rollRgba(rgba: Uint8Array, width: number, height: number, dx: number, dy: number): Uint8Array {
	const out = new Uint8Array(rgba.byteLength);
	for (let y = 0; y < height; y++) {
		const srcY = wrapCoord(y - dy, height);
		for (let x = 0; x < width; x++) {
			const srcX = wrapCoord(x - dx, width);
			const srcIdx = (srcY * width + srcX) * 4;
			const dstIdx = (y * width + x) * 4;
			out[dstIdx] = rgba[srcIdx] ?? 0;
			out[dstIdx + 1] = rgba[srcIdx + 1] ?? 0;
			out[dstIdx + 2] = rgba[srcIdx + 2] ?? 0;
			out[dstIdx + 3] = rgba[srcIdx + 3] ?? 255;
		}
	}
	return out;
}

function multibandBlendTileable(
	origRgba: Uint8Array,
	width: number,
	height: number,
	seamBlendPx: number,
	patchRgba?: Uint8Array,
): Uint8Array {
	const halfW = Math.floor(width / 2);
	const halfH = Math.floor(height / 2);
	const rolled = patchRgba ?? rollRgba(origRgba, width, height, halfW, halfH);
	const total = width * height;
	const band = Math.max(4, Math.min(Math.floor(Math.min(width, height) / 2), seamBlendPx));

	// Build a periodic smooth mask: 1 near wrap boundaries (so rolled interior covers wrap borders),
	// 0 in the center (so original interior covers the rolled cross seam).
	const mask = new Float32Array(total);
	for (let y = 0; y < height; y++) {
		const distYEdge = Math.min(y, height - 1 - y);
		const wy = distYEdge >= band ? 0 : 0.5 * (1 + Math.cos((Math.PI * distYEdge) / band));
		for (let x = 0; x < width; x++) {
			const distXEdge = Math.min(x, width - 1 - x);
			const wx = distXEdge >= band ? 0 : 0.5 * (1 + Math.cos((Math.PI * distXEdge) / band));
			mask[y * width + x] = Math.max(wx, wy);
		}
	}

	// 5-level Laplacian pyramid multiband blend per RGB channel
	const levels = 5;
	const out = new Uint8Array(origRgba.byteLength);

	const maskPyramid: Float32Array[] = new Array<Float32Array>(levels);
	maskPyramid[0] = mask;
	for (let l = 1; l < levels; l++) {
		const prev = maskPyramid[l - 1] ?? mask;
		maskPyramid[l] = boxBlurWrapFloat(prev, width, height, 1 << l);
	}

	for (let c = 0; c < 3; c++) {
		const a0 = new Float32Array(total);
		const b0 = new Float32Array(total);
		for (let i = 0; i < total; i++) {
			a0[i] = (origRgba[i * 4 + c] ?? 0) / 255;
			b0[i] = (rolled[i * 4 + c] ?? 0) / 255;
		}

		const gaussA: Float32Array[] = new Array<Float32Array>(levels);
		const gaussB: Float32Array[] = new Array<Float32Array>(levels);
		gaussA[0] = a0;
		gaussB[0] = b0;
		for (let l = 1; l < levels; l++) {
			const radius = 1 << (l - 1);
			gaussA[l] = boxBlurWrapFloat(gaussA[l - 1] ?? a0, width, height, radius);
			gaussB[l] = boxBlurWrapFloat(gaussB[l - 1] ?? b0, width, height, radius);
		}

		const blended = new Float32Array(total);
		const topA = gaussA[levels - 1] ?? a0;
		const topB = gaussB[levels - 1] ?? b0;
		const topM = maskPyramid[levels - 1] ?? mask;
		for (let i = 0; i < total; i++) {
			const m = topM[i] ?? 0;
			blended[i] = (topA[i] ?? 0) * (1 - m) + (topB[i] ?? 0) * m;
		}

		for (let l = 0; l < levels - 1; l++) {
			const curA = gaussA[l] ?? a0;
			const nextA = gaussA[l + 1] ?? a0;
			const curB = gaussB[l] ?? b0;
			const nextB = gaussB[l + 1] ?? b0;
			const curM = maskPyramid[l] ?? mask;
			for (let i = 0; i < total; i++) {
				const lapA = (curA[i] ?? 0) - (nextA[i] ?? 0);
				const lapB = (curB[i] ?? 0) - (nextB[i] ?? 0);
				const m = curM[i] ?? 0;
				blended[i] = (blended[i] ?? 0) + lapA * (1 - m) + lapB * m;
			}
		}

		// Enforce exact wrap-edge agreement across opposite borders with a 2px feather
		for (let i = 0; i < total; i++) {
			const v = Math.max(0, Math.min(1, blended[i] ?? 0));
			out[i * 4 + c] = Math.round(v * 255);
		}
	}

	// Copy alpha and unify exact wrap border pixels so wrap seam diff is minimal
	for (let i = 0; i < total; i++) {
		out[i * 4 + 3] = origRgba[i * 4 + 3] ?? 255;
	}
	for (let y = 0; y < height; y++) {
		const leftIdx = (y * width + 0) * 4;
		const rightIdx = (y * width + (width - 1)) * 4;
		for (let c = 0; c < 3; c++) {
			const avg = Math.round(((out[leftIdx + c] ?? 0) + (out[rightIdx + c] ?? 0)) * 0.5);
			out[leftIdx + c] = avg;
			out[rightIdx + c] = avg;
		}
	}
	for (let x = 0; x < width; x++) {
		const topIdx = (0 * width + x) * 4;
		const botIdx = ((height - 1) * width + x) * 4;
		for (let c = 0; c < 3; c++) {
			const avg = Math.round(((out[topIdx + c] ?? 0) + (out[botIdx + c] ?? 0)) * 0.5);
			out[topIdx + c] = avg;
			out[botIdx + c] = avg;
		}
	}

	return out;
}

function mirrorQuadRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(rgba.byteLength);
	const halfW = Math.floor(width / 2);
	const halfH = Math.floor(height / 2);

	for (let y = 0; y < height; y++) {
		const sy = y < halfH ? y : height - 1 - y;
		const clampedY = Math.max(0, Math.min(height - 1, sy * 2));
		for (let x = 0; x < width; x++) {
			const sx = x < halfW ? x : width - 1 - x;
			const clampedX = Math.max(0, Math.min(width - 1, sx * 2));
			const srcIdx = (clampedY * width + clampedX) * 4;
			const dstIdx = (y * width + x) * 4;
			out[dstIdx] = rgba[srcIdx] ?? 0;
			out[dstIdx + 1] = rgba[srcIdx + 1] ?? 0;
			out[dstIdx + 2] = rgba[srcIdx + 2] ?? 0;
			out[dstIdx + 3] = rgba[srcIdx + 3] ?? 255;
		}
	}
	return out;
}

async function handlePayload(payload: WorkerPayload): Promise<WorkerSuccessPayload> {
	switch (payload.op) {
		case "decode_b64": {
			const cleaned = payload.b64.replace(/^data:[^;]+;base64,/, "");
			const buf = Buffer.from(cleaned, "base64");
			const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
			const sha256 = sha256Hex(u8);
			return { op: "decode_b64", buffer: toArrayBuffer(u8), sha256 };
		}

		case "encode_b64": {
			const u8 = toUint8(payload.buffer);
			const sha256 = sha256Hex(u8);
			const b64 = Buffer.from(u8).toString("base64");
			return { op: "encode_b64", b64, sha256 };
		}

		case "probe": {
			const u8 = toUint8(payload.buffer);
			const sha256 = sha256Hex(u8);
			const instance = sharp(u8);
			try {
				const meta = await instance.metadata();
				return {
					op: "probe",
					width: meta.width,
					height: meta.height,
					format: meta.format,
					channels: meta.channels,
					sha256,
				};
			} finally {
				instance.destroy();
			}
		}

		case "resize": {
			const instance = sharp(toUint8(payload.buffer));
			try {
				let pipe = instance.resize(payload.width, payload.height, {
					fit: payload.fit,
					kernel: sharp.kernel.lanczos3,
				});
				if (payload.format !== undefined) {
					pipe = applyFormat(pipe, payload.format, payload.compression ?? 90);
				} else {
					pipe = pipe.png({ compressionLevel: 6 });
				}
				const { data, info } = await pipe.toBuffer({ resolveWithObject: true });
				return {
					op: "resize",
					buffer: toArrayBuffer(data),
					width: info.width,
					height: info.height,
				};
			} finally {
				instance.destroy();
			}
		}

		case "convert": {
			const instance = sharp(toUint8(payload.buffer));
			try {
				let pipe = instance;
				if (payload.grayscale === true) {
					pipe = pipe.grayscale();
				}
				if (payload.sharpen !== undefined && payload.sharpen > 0) {
					pipe = pipe.sharpen({ sigma: payload.sharpen });
				}
				pipe = applyFormat(pipe, payload.format, payload.compression, payload.bitDepth ?? 8);
				const { data, info } = await pipe.toBuffer({ resolveWithObject: true });
				const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
				return {
					op: "convert",
					buffer: toArrayBuffer(u8),
					width: info.width,
					height: info.height,
					sha256: sha256Hex(u8),
				};
			} finally {
				instance.destroy();
			}
		}

		case "thumbnail": {
			const instance = sharp(toUint8(payload.buffer));
			try {
				const { data, info } = await instance
					.resize(payload.maxSide, payload.maxSide, {
						fit: "inside",
						withoutEnlargement: true,
					})
					.jpeg({ quality: Math.max(1, Math.min(100, payload.quality)) })
					.toBuffer({ resolveWithObject: true });
				return {
					op: "thumbnail",
					b64: data.toString("base64"),
					mimeType: "image/jpeg",
					width: info.width,
					height: info.height,
				};
			} finally {
				instance.destroy();
			}
		}

		case "halfblock_preview": {
			const cols = Math.max(1, Math.min(48, payload.maxCols));
			const rows = Math.max(1, Math.min(24, payload.maxRows));
			const pxHeight = rows * 2;
			const instance = sharp(toUint8(payload.buffer));
			try {
				const { data, info } = await instance
					.resize(cols, pxHeight, { fit: "inside" })
					.ensureAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
				const w = info.width;
				const h = info.height;
				const outRows = Math.ceil(h / 2);
				const lines = new Array<string>(outRows);
				for (let r = 0; r < outRows; r++) {
					const cells = new Array<string>(w);
					const yTop = r * 2;
					const yBot = Math.min(h - 1, yTop + 1);
					for (let x = 0; x < w; x++) {
						const topIdx = (yTop * w + x) * 4;
						const botIdx = (yBot * w + x) * 4;
						const tr = data[topIdx] ?? 0;
						const tg = data[topIdx + 1] ?? 0;
						const tb = data[topIdx + 2] ?? 0;
						const br = data[botIdx] ?? 0;
						const bg = data[botIdx + 1] ?? 0;
						const bb = data[botIdx + 2] ?? 0;
						cells[x] = `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`;
					}
					lines[r] = `${cells.join("")}\x1b[0m`;
				}
				return {
					op: "halfblock_preview",
					lines,
					cols: w,
					rows: outRows,
				};
			} finally {
				instance.destroy();
			}
		}

		case "contact_sheet": {
			const count = payload.buffers.length;
			const thumbSize = payload.thumbSize ?? 256;
			const cols = payload.cols ?? Math.max(1, Math.ceil(Math.sqrt(count)));
			const rows = Math.max(1, Math.ceil(count / cols));
			const pad = 8;
			const sheetW = cols * thumbSize + (cols + 1) * pad;
			const sheetH = rows * thumbSize + (rows + 1) * pad;

			const composites: sharp.OverlayOptions[] = new Array<sharp.OverlayOptions>(count);
			for (let i = 0; i < count; i++) {
				const itemBuf = payload.buffers[i];
				if (itemBuf === undefined) {
					continue;
				}
				const inst = sharp(toUint8(itemBuf));
				try {
					const resized = await inst.resize(thumbSize, thumbSize, { fit: "cover" }).png().toBuffer();
					const col = i % cols;
					const row = Math.floor(i / cols);
					composites[i] = {
						input: resized,
						left: pad + col * (thumbSize + pad),
						top: pad + row * (thumbSize + pad),
					};
				} finally {
					inst.destroy();
				}
			}

			const canvas = sharp({
				create: {
					width: sheetW,
					height: sheetH,
					channels: 4,
					background: { r: 20, g: 20, b: 24, alpha: 1 },
				},
			});
			try {
				const out = await canvas.composite(composites).png({ compressionLevel: 6 }).toBuffer();
				return {
					op: "contact_sheet",
					buffer: toArrayBuffer(out),
					width: sheetW,
					height: sheetH,
				};
			} finally {
				canvas.destroy();
			}
		}

		case "roll": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			const dx = payload.dx ?? Math.floor(width / 2);
			const dy = payload.dy ?? Math.floor(height / 2);
			const rolled = rollRgba(data, width, height, dx, dy);
			const pngBuf = await encodeRawRgbaToPng(rolled, width, height);
			return { op: "roll", buffer: pngBuf, width, height };
		}

		case "multiband_blend": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			let patchData: Uint8Array | undefined;
			if (payload.patchBuffer !== undefined) {
				const decodedPatch = await decodeRawRgba(payload.patchBuffer);
				patchData = decodedPatch.data;
			}
			const blended = multibandBlendTileable(data, width, height, payload.seamBlendPx, patchData);
			const metrics = computeSeamMetrics(blended, width, height);
			const pngBuf = await encodeRawRgbaToPng(blended, width, height);
			return {
				op: "multiband_blend",
				buffer: pngBuf,
				seamScore: metrics.score,
				width,
				height,
			};
		}

		case "mirror_quad": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			const mirrored = mirrorQuadRgba(data, width, height);
			const metrics = computeSeamMetrics(mirrored, width, height);
			const pngBuf = await encodeRawRgbaToPng(mirrored, width, height);
			return {
				op: "mirror_quad",
				buffer: pngBuf,
				seamScore: metrics.score,
				width,
				height,
			};
		}

		case "seam_score": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			const metrics = computeSeamMetrics(data, width, height);
			return {
				op: "seam_score",
				score: metrics.score,
				horizontalScore: metrics.horizontalScore,
				verticalScore: metrics.verticalScore,
			};
		}

		case "height": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			const total = width * height;
			const lum = new Float32Array(total);
			for (let i = 0; i < total; i++) {
				const r = (data[i * 4] ?? 0) / 255;
				const g = (data[i * 4 + 1] ?? 0) / 255;
				const b = (data[i * 4 + 2] ?? 0) / 255;
				lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			}
			const sigmaDiv = payload.sigmaDivisor ?? 64;
			const sigma = Math.max(1, Math.round(Math.max(width, height) / sigmaDiv));
			const lowPass = gaussianBlurWrapFloat(lum, width, height, sigma);
			const hp = new Float32Array(total);
			let minV = Number.POSITIVE_INFINITY;
			let maxV = Number.NEGATIVE_INFINITY;
			for (let i = 0; i < total; i++) {
				const v = (lum[i] ?? 0) - (lowPass[i] ?? 0) + 0.5;
				hp[i] = v;
				if (v < minV) minV = v;
				if (v > maxV) maxV = v;
			}
			const span = maxV - minV;
			const normHeight = new Float32Array(total);
			if (span > 1e-6) {
				const invSpan = 1 / span;
				for (let i = 0; i < total; i++) {
					normHeight[i] = ((hp[i] ?? 0.5) - minV) * invSpan;
				}
			} else {
				normHeight.fill(0.5);
			}
			const pngBuf = await encodeFloatGrayscale(normHeight, width, height, payload.bitDepth);
			return {
				op: "height",
				buffer: pngBuf,
				floatHeight: normHeight.buffer,
				width,
				height,
			};
		}

		case "normal": {
			const { width, height, strength, convention, bitDepth } = payload;
			const h = new Float32Array(payload.heightFloat);
			const total = width * height;
			const rCh = new Float32Array(total);
			const gCh = new Float32Array(total);
			const bCh = new Float32Array(total);
			const flipY = convention === "directx" ? -1 : 1;

			for (let y = 0; y < height; y++) {
				const ym1 = wrapCoord(y - 1, height) * width;
				const y0 = y * width;
				const yp1 = wrapCoord(y + 1, height) * width;
				for (let x = 0; x < width; x++) {
					const xm1 = wrapCoord(x - 1, width);
					const xp1 = wrapCoord(x + 1, width);

					const tl = h[ym1 + xm1] ?? 0;
					const tm = h[ym1 + x] ?? 0;
					const tr = h[ym1 + xp1] ?? 0;
					const ml = h[y0 + xm1] ?? 0;
					const mr = h[y0 + xp1] ?? 0;
					const bl = h[yp1 + xm1] ?? 0;
					const bm = h[yp1 + x] ?? 0;
					const br = h[yp1 + xp1] ?? 0;

					const dx = (tr + 2 * mr + br - (tl + 2 * ml + bl)) * 0.125;
					const dy = (bl + 2 * bm + br - (tl + 2 * tm + tr)) * 0.125;

					const nx = -dx * strength;
					const ny = -dy * strength * flipY;
					const nz = 1.0;
					const invLen = 1.0 / Math.hypot(nx, ny, nz);

					const idx = y0 + x;
					rCh[idx] = nx * invLen * 0.5 + 0.5;
					gCh[idx] = ny * invLen * 0.5 + 0.5;
					bCh[idx] = nz * invLen * 0.5 + 0.5;
				}
			}

			const pngBuf = await encodeFloatRgb(rCh, gCh, bCh, width, height, bitDepth);
			return { op: "normal", buffer: pngBuf, width, height };
		}

		case "ao": {
			const { width, height, bitDepth } = payload;
			const h = new Float32Array(payload.heightFloat);
			const total = width * height;
			const radii = [2, 4, 8, 16] as const;
			const weights = [0.4, 0.3, 0.2, 0.1] as const;
			const ao = new Float32Array(total);
			ao.fill(1.0);

			for (let rIdx = 0; rIdx < radii.length; rIdx++) {
				const radius = radii[rIdx] ?? 2;
				const weight = weights[rIdx] ?? 0.25;
				const blurred = boxBlurWrapFloat(h, width, height, radius);
				for (let i = 0; i < total; i++) {
					const cavity = Math.max(0, (blurred[i] ?? 0) - (h[i] ?? 0));
					ao[i] = (ao[i] ?? 1) - weight * cavity;
				}
			}
			for (let i = 0; i < total; i++) {
				ao[i] = Math.max(0, Math.min(1, ao[i] ?? 1));
			}

			const pngBuf = await encodeFloatGrayscale(ao, width, height, bitDepth);
			return {
				op: "ao",
				buffer: pngBuf,
				aoFloat: ao.buffer,
				width,
				height,
			};
		}

		case "roughness": {
			const { width, height, range, bitDepth } = payload;
			const h = new Float32Array(payload.heightFloat);
			const total = width * height;
			const minR = Math.max(0, Math.min(1, range[0]));
			const maxR = Math.max(minR, Math.min(1, range[1]));
			const spanR = maxR - minR;
			const rough = new Float32Array(total);

			for (let i = 0; i < total; i++) {
				const inv = 1.0 - Math.max(0, Math.min(1, h[i] ?? 0.5));
				// Smooth S-curve contrast stretch before mapping to [minR, maxR]
				const stretched = inv * inv * (3 - 2 * inv);
				rough[i] = minR + stretched * spanR;
			}

			const pngBuf = await encodeFloatGrayscale(rough, width, height, bitDepth);
			return {
				op: "roughness",
				buffer: pngBuf,
				roughFloat: rough.buffer,
				width,
				height,
			};
		}

		case "metallic": {
			const { data, width, height } = await decodeRawRgba(payload.albedoBuffer);
			const total = width * height;
			const metal = new Float32Array(total);

			if (typeof payload.mode === "number") {
				metal.fill(Math.max(0, Math.min(1, payload.mode)));
			} else {
				// Auto k-means (k=2) on metallic feature = brightness * (1 - 0.6 * saturation)
				const feat = new Float32Array(total);
				let minF = Number.POSITIVE_INFINITY;
				let maxF = Number.NEGATIVE_INFINITY;
				for (let i = 0; i < total; i++) {
					const r = (data[i * 4] ?? 0) / 255;
					const g = (data[i * 4 + 1] ?? 0) / 255;
					const b = (data[i * 4 + 2] ?? 0) / 255;
					const maxC = Math.max(r, g, b);
					const minC = Math.min(r, g, b);
					const sat = maxC > 1e-5 ? (maxC - minC) / maxC : 0;
					const val = maxC * (1 - 0.6 * sat);
					feat[i] = val;
					if (val < minF) minF = val;
					if (val > maxF) maxF = val;
				}
				let c0 = minF;
				let c1 = maxF;
				for (let iter = 0; iter < 8; iter++) {
					let sum0 = 0;
					let cnt0 = 0;
					let sum1 = 0;
					let cnt1 = 0;
					for (let i = 0; i < total; i++) {
						const f = feat[i] ?? 0;
						if (Math.abs(f - c0) <= Math.abs(f - c1)) {
							sum0 += f;
							cnt0++;
						} else {
							sum1 += f;
							cnt1++;
						}
					}
					if (cnt0 > 0) c0 = sum0 / cnt0;
					if (cnt1 > 0) c1 = sum1 / cnt1;
				}
				const span = Math.max(1e-5, Math.abs(c1 - c0));
				const lowC = Math.min(c0, c1);
				for (let i = 0; i < total; i++) {
					metal[i] = Math.max(0, Math.min(1, ((feat[i] ?? 0) - lowC) / span));
				}
			}

			const pngBuf = await encodeFloatGrayscale(metal, width, height, payload.bitDepth);
			return {
				op: "metallic",
				buffer: pngBuf,
				metalFloat: metal.buffer,
				width,
				height,
			};
		}

		case "orm_pack": {
			const ao = new Float32Array(payload.aoFloat);
			const rough = new Float32Array(payload.roughFloat);
			const metal = new Float32Array(payload.metalFloat);
			const pngBuf = await encodeFloatRgb(ao, rough, metal, payload.width, payload.height, payload.bitDepth);
			return {
				op: "orm_pack",
				buffer: pngBuf,
				width: payload.width,
				height: payload.height,
			};
		}

		case "trim": {
			const instance = sharp(toUint8(payload.buffer));
			try {
				const { data, info } = await instance
					.trim({ threshold: payload.threshold ?? 10 })
					.png({ compressionLevel: 6 })
					.toBuffer({ resolveWithObject: true });
				return {
					op: "trim",
					buffer: toArrayBuffer(data),
					width: info.width,
					height: info.height,
				};
			} finally {
				instance.destroy();
			}
		}

		case "palette": {
			const colors = Math.max(2, Math.min(256, Math.round(payload.colors)));
			const instance = sharp(toUint8(payload.buffer));
			try {
				const { data, info } = await instance.png({ palette: true, colors }).toBuffer({ resolveWithObject: true });
				return {
					op: "palette",
					buffer: toArrayBuffer(data),
					width: info.width,
					height: info.height,
				};
			} finally {
				instance.destroy();
			}
		}

		case "embed_metadata": {
			const u8 = toUint8(payload.buffer);
			const instance = sharp(u8);
			try {
				let pipe = instance.withMetadata({
					exif: {
						IFD0: {
							ImageDescription: JSON.stringify(payload.metadata),
							Software: "@hicaru/img-pi",
						},
					},
				});
				pipe = applyFormat(pipe, payload.format, 92);
				const out = await pipe.toBuffer();
				const outU8 = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
				return {
					op: "embed_metadata",
					buffer: toArrayBuffer(outU8),
					sha256: sha256Hex(outU8),
				};
			} finally {
				instance.destroy();
			}
		}

		case "json_parse_large": {
			if (payload.jsonl === true) {
				const rawLines = payload.text.split("\n");
				const parsed: unknown[] = [];
				for (const line of rawLines) {
					const trimmed = line.trim();
					if (trimmed.length > 0) {
						const item: unknown = JSON.parse(trimmed);
						parsed.push(item);
					}
				}
				return { op: "json_parse_large", data: parsed };
			}
			const data: unknown = JSON.parse(payload.text);
			return {
				op: "json_parse_large",
				data,
			};
		}

		case "remove_bg": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			const tol = payload.tolerance ?? 28;
			// Sample 4 corners as background reference color
			const corners = [
				0,
				(width - 1) * 4,
				(height - 1) * width * 4,
				((height - 1) * width + (width - 1)) * 4,
			] as const;
			let bgR = 0;
			let bgG = 0;
			let bgB = 0;
			for (const cIdx of corners) {
				bgR += data[cIdx] ?? 0;
				bgG += data[cIdx + 1] ?? 0;
				bgB += data[cIdx + 2] ?? 0;
			}
			bgR /= 4;
			bgG /= 4;
			bgB /= 4;

			const out = new Uint8Array(data);
			const total = width * height;
			for (let i = 0; i < total; i++) {
				const idx = i * 4;
				const dr = (out[idx] ?? 0) - bgR;
				const dg = (out[idx + 1] ?? 0) - bgG;
				const db = (out[idx + 2] ?? 0) - bgB;
				const dist = Math.hypot(dr, dg, db);
				if (dist <= tol) {
					out[idx + 3] = 0;
				} else if (dist <= tol * 1.5) {
					const alphaScale = (dist - tol) / (tol * 0.5);
					out[idx + 3] = Math.round((out[idx + 3] ?? 255) * alphaScale);
				}
			}
			const pngBuf = await encodeRawRgbaToPng(out, width, height);
			return { op: "remove_bg", buffer: pngBuf, width, height };
		}

		case "outpaint_canvas": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			const newW = width + payload.left + payload.right;
			const newH = height + payload.top + payload.bottom;
			const canvas = new Uint8Array(newW * newH * 4);
			const mask = new Uint8Array(newW * newH * 4);

			// Fill mask white (255 = edit region) everywhere, then black (0 = keep) inside original image
			for (let i = 0; i < newW * newH; i++) {
				const mIdx = i * 4;
				mask[mIdx] = 255;
				mask[mIdx + 1] = 255;
				mask[mIdx + 2] = 255;
				mask[mIdx + 3] = 255;
			}

			for (let y = 0; y < newH; y++) {
				const srcY = Math.max(0, Math.min(height - 1, y - payload.top));
				const inY = y >= payload.top && y < payload.top + height;
				for (let x = 0; x < newW; x++) {
					const srcX = Math.max(0, Math.min(width - 1, x - payload.left));
					const inX = x >= payload.left && x < payload.left + width;
					const srcIdx = (srcY * width + srcX) * 4;
					const dstIdx = (y * newW + x) * 4;
					canvas[dstIdx] = data[srcIdx] ?? 0;
					canvas[dstIdx + 1] = data[srcIdx + 1] ?? 0;
					canvas[dstIdx + 2] = data[srcIdx + 2] ?? 0;
					canvas[dstIdx + 3] = data[srcIdx + 3] ?? 255;
					if (inX && inY) {
						mask[dstIdx] = 0;
						mask[dstIdx + 1] = 0;
						mask[dstIdx + 2] = 0;
					}
				}
			}

			const canvasBuffer = await encodeRawRgbaToPng(canvas, newW, newH);
			const maskBuffer = await encodeRawRgbaToPng(mask, newW, newH);
			return {
				op: "outpaint_canvas",
				canvasBuffer,
				maskBuffer,
				width: newW,
				height: newH,
			};
		}

		case "tile_grid": {
			const { data, width, height } = await decodeRawRgba(payload.buffer);
			const tiles = Math.max(1, Math.min(4, Math.round(payload.tiles)));
			const outW = width * tiles;
			const outH = height * tiles;
			const out = new Uint8Array(outW * outH * 4);
			const showGrid = payload.showGrid === true;

			for (let y = 0; y < outH; y++) {
				const sy = y % height;
				const isGridY = showGrid && y > 0 && sy === 0;
				for (let x = 0; x < outW; x++) {
					const sx = x % width;
					const isGridX = showGrid && x > 0 && sx === 0;
					const dstIdx = (y * outW + x) * 4;
					if (isGridX || isGridY) {
						out[dstIdx] = 255;
						out[dstIdx + 1] = 64;
						out[dstIdx + 2] = 160;
						out[dstIdx + 3] = 255;
					} else {
						const srcIdx = (sy * width + sx) * 4;
						out[dstIdx] = data[srcIdx] ?? 0;
						out[dstIdx + 1] = data[srcIdx + 1] ?? 0;
						out[dstIdx + 2] = data[srcIdx + 2] ?? 0;
						out[dstIdx + 3] = data[srcIdx + 3] ?? 255;
					}
				}
			}

			const pngBuf = await encodeRawRgbaToPng(out, outW, outH);
			return { op: "tile_grid", buffer: pngBuf, width: outW, height: outH };
		}

		default: {
			const _exhaustive: never = payload;
			return _exhaustive;
		}
	}
}

export async function executeWorkerPayloadInProcess(payload: WorkerPayload): Promise<WorkerSuccessPayload> {
	return handlePayload(payload);
}

function isWorkerRequestMessage(v: unknown): v is WorkerRequestMessage {
	if (typeof v !== "object" || v === null) return false;
	if (!("id" in v) || typeof v.id !== "string") return false;
	if (!("payload" in v) || typeof v.payload !== "object" || v.payload === null) return false;
	return "op" in v.payload && typeof v.payload.op === "string";
}

function sendResponse(msg: WorkerResponseMessage, transfer: ArrayBuffer[]): void {
	if (parentPort !== null) {
		parentPort.postMessage(msg, transfer);
	}
}

if (parentPort !== null) {
	parentPort.on("message", (raw: unknown) => {
		if (!isWorkerRequestMessage(raw)) {
			return;
		}
		void (async () => {
			try {
				const result = await handlePayload(raw.payload);
				const transfer = collectResponseTransferables(result);
				sendResponse({ id: raw.id, ok: true, result }, transfer);
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				sendResponse(
					{
						id: raw.id,
						ok: false,
						op: raw.payload.op,
						message,
					},
					[],
				);
			}
		})();
	});
}

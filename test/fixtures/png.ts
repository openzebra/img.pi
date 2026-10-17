import { deflateSync } from "node:zlib";

/** Deterministic 32×32 RGBA PNG for tests (stands in for host-generated image bytes). */
const CRC_TABLE: Uint32Array = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) {
		const idx = (c ^ b) & 0xff;
		c = (CRC_TABLE[idx] ?? 0) ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(typeAscii: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.byteLength, false);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = typeAscii.charCodeAt(i);
	}
	out.set(data, 8);
	const crcInput = out.subarray(4, 8 + data.byteLength);
	view.setUint32(8 + data.byteLength, crc32(crcInput), false);
	return out;
}

export function buildTinySeedPng(seed: number, transparent: boolean): ArrayBuffer {
	const w = 32;
	const h = 32;
	const rawScanlines = new Uint8Array(h * (1 + w * 4));
	const s1 = (seed * 2654435761) >>> 0;

	for (let y = 0; y < h; y++) {
		const rowOffset = y * (1 + w * 4);
		rawScanlines[rowOffset] = 0; // filter type 0 (None)
		for (let x = 0; x < w; x++) {
			// Periodic sin/cos pattern so mock textures are smooth and deterministic
			const nx = (x / w) * Math.PI * 2;
			const ny = (y / h) * Math.PI * 2;
			const r = Math.round(127 + 90 * Math.sin(nx + (s1 & 0xff) * 0.05) * Math.cos(ny));
			const g = Math.round(127 + 90 * Math.cos(nx * 2 + ((s1 >>> 8) & 0xff) * 0.05) * Math.sin(ny));
			const b = Math.round(127 + 90 * Math.sin(nx + ny + ((s1 >>> 16) & 0xff) * 0.05));
			const a = transparent && x < 4 && y < 4 ? 0 : 255;
			const px = rowOffset + 1 + x * 4;
			rawScanlines[px] = Math.max(0, Math.min(255, r));
			rawScanlines[px + 1] = Math.max(0, Math.min(255, g));
			rawScanlines[px + 2] = Math.max(0, Math.min(255, b));
			rawScanlines[px + 3] = a;
		}
	}

	const ihdr = new Uint8Array(13);
	const ihdrView = new DataView(ihdr.buffer);
	ihdrView.setUint32(0, w, false);
	ihdrView.setUint32(4, h, false);
	ihdr[8] = 8; // bit depth 8
	ihdr[9] = 6; // color type RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const compressed = new Uint8Array(deflateSync(rawScanlines));
	const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdrChunk = makePngChunk("IHDR", ihdr);
	const idatChunk = makePngChunk("IDAT", compressed);
	const iendChunk = makePngChunk("IEND", new Uint8Array(0));

	const totalLen = signature.byteLength + ihdrChunk.byteLength + idatChunk.byteLength + iendChunk.byteLength;
	const full = new Uint8Array(totalLen);
	let offset = 0;
	full.set(signature, offset);
	offset += signature.byteLength;
	full.set(ihdrChunk, offset);
	offset += ihdrChunk.byteLength;
	full.set(idatChunk, offset);
	offset += idatChunk.byteLength;
	full.set(iendChunk, offset);

	return full.buffer;
}

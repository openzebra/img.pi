import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { monitorEventLoopDelay } from "node:perf_hooks";
import sharp from "sharp";
import { WorkerPool } from "../../src/workers/pool.js";

async function createSolidOrPatternPng(
	width: number,
	height: number,
	pixelFn: (x: number, y: number) => readonly [number, number, number, number],
): Promise<ArrayBuffer> {
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = pixelFn(x, y);
			const idx = (y * width + x) * 4;
			rgba[idx] = r;
			rgba[idx + 1] = g;
			rgba[idx + 2] = b;
			rgba[idx + 3] = a;
		}
	}
	const instance = sharp(rgba, { raw: { width, height, channels: 4 } });
	try {
		const buf = await instance.png({ compressionLevel: 6 }).toBuffer();
		const copy = new Uint8Array(buf.byteLength);
		copy.set(buf);
		return copy.buffer;
	} finally {
		instance.destroy();
	}
}

async function decodeRgbBytes(pngBuffer: ArrayBuffer): Promise<{
	readonly data: Uint8Array;
	readonly width: number;
	readonly height: number;
	readonly channels: number;
}> {
	const instance = sharp(new Uint8Array(pngBuffer));
	try {
		const { data, info } = await instance.raw().toBuffer({ resolveWithObject: true });
		return {
			data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			width: info.width,
			height: info.height,
			channels: info.channels,
		};
	} finally {
		instance.destroy();
	}
}

describe("workers/pool and image.worker ops", () => {
	let pool: WorkerPool;

	beforeAll(() => {
		pool = new WorkerPool({ size: 2 });
	});

	afterAll(async () => {
		await pool.terminate();
	});

	test("normal map golden: hemisphere height field matches analytical Sobel normal within ε = 1/255", async () => {
		const width = 64;
		const height = 64;
		const cx = 32;
		const cy = 32;
		const radius = 24;
		const strength = 2.0;

		const heightField = new Float32Array(width * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const dx = x - cx;
				const dy = y - cy;
				const r2 = dx * dx + dy * dy;
				heightField[y * width + x] = r2 < radius * radius ? Math.sqrt(radius * radius - r2) / radius : 0;
			}
		}

		// Copy heightField so we can verify analytical Sobel after transferring heightField.buffer
		const refHeight = new Float32Array(heightField);

		const resGl = await pool.run({
			op: "normal",
			heightFloat: heightField.buffer.slice(0),
			width,
			height,
			strength,
			convention: "opengl",
			bitDepth: 8,
		});
		expect(resGl.ok).toBe(true);
		if (!resGl.ok) return;

		const decodedGl = await decodeRgbBytes(resGl.value.buffer);
		expect(decodedGl.width).toBe(width);
		expect(decodedGl.height).toBe(height);

		const eps = 1 / 255 + 1e-5;
		for (let y = 10; y < height - 10; y++) {
			for (let x = 10; x < width - 10; x++) {
				const tl = refHeight[(y - 1) * width + (x - 1)] ?? 0;
				const tm = refHeight[(y - 1) * width + x] ?? 0;
				const tr = refHeight[(y - 1) * width + (x + 1)] ?? 0;
				const ml = refHeight[y * width + (x - 1)] ?? 0;
				const mr = refHeight[y * width + (x + 1)] ?? 0;
				const bl = refHeight[(y + 1) * width + (x - 1)] ?? 0;
				const bm = refHeight[(y + 1) * width + x] ?? 0;
				const br = refHeight[(y + 1) * width + (x + 1)] ?? 0;

				const sx = (tr + 2 * mr + br - (tl + 2 * ml + bl)) * 0.125;
				const sy = (bl + 2 * bm + br - (tl + 2 * tm + tr)) * 0.125;
				const nx = -sx * strength;
				const ny = -sy * strength;
				const nz = 1.0;
				const invLen = 1 / Math.hypot(nx, ny, nz);

				const expectedR = nx * invLen * 0.5 + 0.5;
				const expectedG = ny * invLen * 0.5 + 0.5;
				const expectedB = nz * invLen * 0.5 + 0.5;

				const base = (y * width + x) * decodedGl.channels;
				const actualR = (decodedGl.data[base] ?? 0) / 255;
				const actualG = (decodedGl.data[base + 1] ?? 0) / 255;
				const actualB = (decodedGl.data[base + 2] ?? 0) / 255;

				expect(Math.abs(actualR - expectedR)).toBeLessThanOrEqual(eps);
				expect(Math.abs(actualG - expectedG)).toBeLessThanOrEqual(eps);
				expect(Math.abs(actualB - expectedB)).toBeLessThanOrEqual(eps);
			}
		}

		// DirectX flips G relative to OpenGL
		const resDx = await pool.run({
			op: "normal",
			heightFloat: refHeight.buffer.slice(0),
			width,
			height,
			strength,
			convention: "directx",
			bitDepth: 8,
		});
		expect(resDx.ok).toBe(true);
		if (!resDx.ok) return;
		const decodedDx = await decodeRgbBytes(resDx.value.buffer);
		const testX = 24;
		const testY = 24;
		const idx = (testY * width + testX) * 3;
		const gGl = (decodedGl.data[idx + 1] ?? 0) / 255;
		const gDx = (decodedDx.data[idx + 1] ?? 0) / 255;
		expect(Math.abs(gGl + gDx - 1.0)).toBeLessThanOrEqual(2 / 255 + 1e-4);
	});

	test("seam score of mirror_quad / periodic noise is 0 and multiband_blend scores < 6 across 10 materials", async () => {
		// 1. Periodic rolled noise where opposite wrap edges match exactly → seam_score = 0
		const w = 64;
		const h = 64;
		const periodicNoise = await createSolidOrPatternPng(w, h, (x, y) => {
			const px = x === w - 1 ? 0 : x;
			const py = y === h - 1 ? 0 : y;
			const v = (px * 37 + py * 91 + px * py * 13) & 0xff;
			return [v, (v * 3) & 0xff, (v * 7) & 0xff, 255];
		});

		const scoreRes = await pool.run({
			op: "seam_score",
			buffer: periodicNoise.slice(0),
		});
		expect(scoreRes.ok).toBe(true);
		if (scoreRes.ok) {
			expect(scoreRes.value.score).toBe(0);
			expect(scoreRes.value.horizontalScore).toBe(0);
			expect(scoreRes.value.verticalScore).toBe(0);
		}

		// Mirror quad on non-periodic gradient also yields seamScore = 0
		const nonPeriodic = await createSolidOrPatternPng(w, h, (x, y) => [
			Math.round((x / w) * 255),
			Math.round((y / h) * 255),
			128,
			255,
		]);
		const mirrorRes = await pool.run({
			op: "mirror_quad",
			buffer: nonPeriodic.slice(0),
		});
		expect(mirrorRes.ok).toBe(true);
		if (mirrorRes.ok) {
			expect(mirrorRes.value.seamScore).toBe(0);
		}

		// 10 synthetic non-periodic materials through multiband_blend must all achieve seamScore < 6
		for (let m = 0; m < 10; m++) {
			const matBuf = await createSolidOrPatternPng(64, 64, (x, y) => {
				const r = Math.min(255, Math.max(0, Math.round(120 + 80 * Math.sin((x + m * 7) * 0.15) + (x / 64) * 50)));
				const g = Math.min(255, Math.max(0, Math.round(100 + 70 * Math.cos((y + m * 11) * 0.18) + (y / 64) * 40)));
				const b = Math.min(255, Math.max(0, Math.round(90 + 60 * Math.sin((x + y + m) * 0.12))));
				return [r, g, b, 255];
			});
			const blendRes = await pool.run({
				op: "multiband_blend",
				buffer: matBuf,
				seamBlendPx: 8,
			});
			expect(blendRes.ok).toBe(true);
			if (blendRes.ok) {
				expect(blendRes.value.seamScore).toBeLessThan(6);
			}
		}
	});

	test("AO is strictly monotonic with cavity depth", async () => {
		const width = 32;
		const height = 32;
		const centerIdx = 16 * width + 16;
		const depths = [0.0, 0.2, 0.5, 0.8] as const;
		const aoAtCenter: number[] = [];

		for (const depth of depths) {
			const hField = new Float32Array(width * height);
			hField.fill(1.0);
			hField[centerIdx] = 1.0 - depth;

			const res = await pool.run({
				op: "ao",
				heightFloat: hField.buffer,
				width,
				height,
				bitDepth: 8,
			});
			expect(res.ok).toBe(true);
			if (res.ok) {
				const aoArr = new Float32Array(res.value.aoFloat);
				aoAtCenter.push(aoArr[centerIdx] ?? 1);
			}
		}

		expect(aoAtCenter.length).toBe(4);
		for (let i = 1; i < aoAtCenter.length; i++) {
			const prev = aoAtCenter[i - 1] ?? 1;
			const cur = aoAtCenter[i] ?? 1;
			expect(cur).toBeLessThan(prev);
		}
	});

	test("ORM pack maps R=AO, G=Roughness, B=Metallic accurately", async () => {
		const width = 8;
		const height = 8;
		const total = width * height;
		const ao = new Float32Array(total).fill(0.25);
		const rough = new Float32Array(total).fill(0.5);
		const metal = new Float32Array(total).fill(0.75);

		const res = await pool.run({
			op: "orm_pack",
			aoFloat: ao.buffer,
			roughFloat: rough.buffer,
			metalFloat: metal.buffer,
			width,
			height,
			bitDepth: 8,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const decoded = await decodeRgbBytes(res.value.buffer);
		expect(decoded.data[0]).toBe(Math.round(0.25 * 255));
		expect(decoded.data[1]).toBe(Math.round(0.5 * 255));
		expect(decoded.data[2]).toBe(Math.round(0.75 * 255));
	});

	test("post-processing ops: probe, resize, convert, thumbnail, halfblock, contact_sheet, outpaint, tile_grid", async () => {
		const basePng = await createSolidOrPatternPng(32, 32, (x, y) => [x * 4, y * 4, 180, 255]);

		const probeRes = await pool.run({ op: "probe", buffer: basePng.slice(0) });
		expect(probeRes.ok).toBe(true);
		if (probeRes.ok) {
			expect(probeRes.value.width).toBe(32);
			expect(probeRes.value.height).toBe(32);
			expect(probeRes.value.format).toBe("png");
		}

		const resizeRes = await pool.run({
			op: "resize",
			buffer: basePng.slice(0),
			width: 48,
			height: 24,
			fit: "cover",
		});
		expect(resizeRes.ok).toBe(true);
		if (resizeRes.ok) {
			expect(resizeRes.value.width).toBe(48);
			expect(resizeRes.value.height).toBe(24);
		}

		const thumbRes = await pool.run({
			op: "thumbnail",
			buffer: basePng.slice(0),
			maxSide: 16,
			quality: 80,
		});
		expect(thumbRes.ok).toBe(true);
		if (thumbRes.ok) {
			expect(thumbRes.value.width).toBe(16);
			expect(thumbRes.value.mimeType).toBe("image/jpeg");
			expect(thumbRes.value.b64.length).toBeGreaterThan(10);
		}

		const hbRes = await pool.run({
			op: "halfblock_preview",
			buffer: basePng.slice(0),
			maxCols: 16,
			maxRows: 8,
		});
		expect(hbRes.ok).toBe(true);
		if (hbRes.ok) {
			expect(hbRes.value.lines.length).toBeGreaterThan(0);
			expect(hbRes.value.lines[0]?.includes("▀")).toBe(true);
		}

		const sheetRes = await pool.run({
			op: "contact_sheet",
			buffers: [basePng.slice(0), basePng.slice(0)],
			cols: 2,
			thumbSize: 32,
		});
		expect(sheetRes.ok).toBe(true);
		if (sheetRes.ok) {
			expect(sheetRes.value.width).toBeGreaterThan(64);
		}

		const tileRes = await pool.run({
			op: "tile_grid",
			buffer: basePng.slice(0),
			tiles: 2,
			showGrid: true,
		});
		expect(tileRes.ok).toBe(true);
		if (tileRes.ok) {
			expect(tileRes.value.width).toBe(64);
			expect(tileRes.value.height).toBe(64);
		}

		const outpaintRes = await pool.run({
			op: "outpaint_canvas",
			buffer: basePng.slice(0),
			left: 8,
			right: 8,
			top: 4,
			bottom: 4,
		});
		expect(outpaintRes.ok).toBe(true);
		if (outpaintRes.ok) {
			expect(outpaintRes.value.width).toBe(48);
			expect(outpaintRes.value.height).toBe(40);
		}
	});

	test("perf: 32-job batch keeps main thread event-loop delay p99 < 20 ms", async () => {
		const samplePng = await createSolidOrPatternPng(64, 64, (x, y) => [
			(x * 7) & 0xff,
			(y * 11) & 0xff,
			((x + y) * 5) & 0xff,
			255,
		]);

		const histogram = monitorEventLoopDelay({ resolution: 10 });
		histogram.enable();
		try {
			const tasks = Array.from({ length: 32 }, (_, idx) =>
				idx % 2 === 0
					? pool.run({
							op: "height",
							buffer: samplePng.slice(0),
							bitDepth: 8,
						})
					: pool.run({
							op: "multiband_blend",
							buffer: samplePng.slice(0),
							seamBlendPx: 8,
						}),
			);
			const results = await Promise.all(tasks);
			for (const r of results) {
				expect(r.ok).toBe(true);
			}
		} finally {
			histogram.disable();
		}

		const p99Ms = histogram.percentile(99) / 1e6;
		expect(p99Ms).toBeLessThan(20);
	});
});

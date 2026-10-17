import * as path from "node:path";
import type { ImgConfig } from "../config/schema.js";
import type { ImgError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type {
	Artifact,
	ReferenceMetadata,
	SidecarDocument,
	TextureSidecarMeta,
	UsageSummary,
} from "../domain/artifact.js";
import { SIDECAR_SCHEMA_VERSION } from "../domain/artifact.js";
import type { GenerationRequest } from "../domain/request.js";
import { Size } from "../domain/size.js";
import type { TextureMapKind, TextureSpec } from "../domain/texture.js";
import type { HostKind } from "../host/port.js";
import type { ManifestStore } from "../storage/manifest.js";
import { expandFilenameTemplate, resolveSafeOutputPath } from "../storage/paths.js";
import { atomicWriteBytes, writeArtifact, writeGltfMaterialJson } from "../storage/writer.js";
import type { WorkerPool } from "../workers/pool.js";
import { runPostProcess } from "./post.js";

export interface TexturePipelineInput {
	readonly jobId: string;
	readonly albedoRawBuffer: ArrayBuffer;
	readonly request: GenerationRequest;
	readonly texSpec: TextureSpec;
	readonly modelId: string;
	readonly reportedModel: string;
	readonly providerId: string;
	readonly finalPrompt: string;
	readonly negativePrompt?: string;
	readonly resolvedStyle?: string;
	readonly requestedSize: Size;
	readonly seed: number;
	readonly referencesMeta: readonly ReferenceMetadata[];
	readonly usage?: UsageSummary;
	readonly cwd: string;
	readonly hostKind: HostKind;
	readonly config: ImgConfig;
	readonly pool: WorkerPool;
	readonly manifest: ManifestStore;
	readonly onProgressDetail?: (detail: string) => void;
}

export interface TexturePipelineResult {
	readonly artifacts: readonly Artifact[];
	readonly seamScore?: number;
	readonly tilingMethodUsed: string;
	readonly previewRelativePath?: string;
	readonly previewThumbB64?: string;
	readonly previewThumbMimeType?: string;
	readonly materialJsonPath?: string;
}

export async function runTexturePipeline(
	input: TexturePipelineInput,
): Promise<Result<TexturePipelineResult, ImgError>> {
	const { texSpec, pool, request, config } = input;
	const res = texSpec.resolution;
	const targetSize = new Size(res, res);

	// 1. Resize albedo to resolution x resolution
	input.onProgressDetail?.("resizing albedo…");
	const resizeRes = await pool.run({
		op: "resize",
		buffer: input.albedoRawBuffer,
		width: res,
		height: res,
		fit: "cover",
	});
	if (!resizeRes.ok) {
		return resizeRes;
	}
	let albedoBuffer = resizeRes.value.buffer;

	// 2. Enforce tileability if requested
	let tilingMethodUsed: string = texSpec.tilingMethod;
	if (tilingMethodUsed === "auto") {
		tilingMethodUsed = "offset_blend";
	}

	let seamScore: number | undefined;
	if (texSpec.tileable) {
		if (tilingMethodUsed === "offset_blend") {
			input.onProgressDetail?.("blending seams (multiband)…");
			const blendRes = await pool.run({
				op: "multiband_blend",
				buffer: albedoBuffer,
				seamBlendPx: texSpec.seamBlendPx,
			});
			if (!blendRes.ok) {
				return blendRes;
			}
			albedoBuffer = blendRes.value.buffer;
			seamScore = blendRes.value.seamScore;
		} else if (tilingMethodUsed === "mirror") {
			input.onProgressDetail?.("mirroring quadrants…");
			const mirrorRes = await pool.run({
				op: "mirror_quad",
				buffer: albedoBuffer,
			});
			if (!mirrorRes.ok) {
				return mirrorRes;
			}
			albedoBuffer = mirrorRes.value.buffer;
			seamScore = mirrorRes.value.seamScore;
		} else {
			const scoreRes = await pool.run({
				op: "seam_score",
				buffer: albedoBuffer.slice(0),
			});
			if (!scoreRes.ok) {
				return scoreRes;
			}
			seamScore = scoreRes.value.score;
		}
	}

	const mapsSet = new Set<TextureMapKind>(texSpec.maps);
	if (texSpec.ormPack) {
		mapsSet.add("orm");
	}

	const needsHeight =
		mapsSet.has("height") ||
		mapsSet.has("normal") ||
		mapsSet.has("ao") ||
		mapsSet.has("roughness") ||
		mapsSet.has("orm");

	const mapBuffers = new Map<TextureMapKind, { readonly buffer: ArrayBuffer; readonly bitDepth: 8 | 16 }>();
	if (mapsSet.has("albedo")) {
		mapBuffers.set("albedo", { buffer: albedoBuffer.slice(0), bitDepth: 8 });
	}

	let heightFloat: ArrayBuffer | undefined;
	if (needsHeight) {
		input.onProgressDetail?.("deriving height map…");
		const heightBitDepth: 8 | 16 = texSpec.bitDepth;
		const heightRes = await pool.run({
			op: "height",
			buffer: albedoBuffer.slice(0),
			bitDepth: heightBitDepth,
		});
		if (!heightRes.ok) {
			return heightRes;
		}
		heightFloat = heightRes.value.floatHeight;
		if (mapsSet.has("height")) {
			mapBuffers.set("height", { buffer: heightRes.value.buffer, bitDepth: heightBitDepth });
		}
	}

	if (mapsSet.has("normal") && heightFloat !== undefined) {
		input.onProgressDetail?.("deriving normal map…");
		const normalBitDepth: 8 | 16 = texSpec.bitDepth;
		const normRes = await pool.run({
			op: "normal",
			heightFloat: heightFloat.slice(0),
			width: res,
			height: res,
			strength: texSpec.normalStrength,
			convention: texSpec.normalConvention,
			bitDepth: normalBitDepth,
		});
		if (!normRes.ok) {
			return normRes;
		}
		mapBuffers.set("normal", { buffer: normRes.value.buffer, bitDepth: normalBitDepth });
	}

	let aoFloat: ArrayBuffer | undefined;
	if ((mapsSet.has("ao") || mapsSet.has("orm")) && heightFloat !== undefined) {
		input.onProgressDetail?.("deriving ambient occlusion…");
		const aoRes = await pool.run({
			op: "ao",
			heightFloat: heightFloat.slice(0),
			width: res,
			height: res,
			bitDepth: 8,
		});
		if (!aoRes.ok) {
			return aoRes;
		}
		aoFloat = aoRes.value.aoFloat;
		if (mapsSet.has("ao")) {
			mapBuffers.set("ao", { buffer: aoRes.value.buffer, bitDepth: 8 });
		}
	}

	let roughFloat: ArrayBuffer | undefined;
	if ((mapsSet.has("roughness") || mapsSet.has("orm")) && heightFloat !== undefined) {
		input.onProgressDetail?.("deriving roughness map…");
		const roughRes = await pool.run({
			op: "roughness",
			heightFloat: heightFloat.slice(0),
			width: res,
			height: res,
			range: texSpec.roughnessRange,
			bitDepth: 8,
		});
		if (!roughRes.ok) {
			return roughRes;
		}
		roughFloat = roughRes.value.roughFloat;
		if (mapsSet.has("roughness")) {
			mapBuffers.set("roughness", { buffer: roughRes.value.buffer, bitDepth: 8 });
		}
	}

	let metalFloat: ArrayBuffer | undefined;
	if (mapsSet.has("metallic") || mapsSet.has("orm")) {
		input.onProgressDetail?.("deriving metallic map…");
		const metalRes = await pool.run({
			op: "metallic",
			albedoBuffer: albedoBuffer.slice(0),
			mode: texSpec.metallic,
			bitDepth: 8,
		});
		if (!metalRes.ok) {
			return metalRes;
		}
		metalFloat = metalRes.value.metalFloat;
		if (mapsSet.has("metallic")) {
			mapBuffers.set("metallic", { buffer: metalRes.value.buffer, bitDepth: 8 });
		}
	}

	if (mapsSet.has("orm") && aoFloat !== undefined && roughFloat !== undefined && metalFloat !== undefined) {
		input.onProgressDetail?.("packing ORM channels…");
		const ormRes = await pool.run({
			op: "orm_pack",
			aoFloat: aoFloat.slice(0),
			roughFloat: roughFloat.slice(0),
			metalFloat: metalFloat.slice(0),
			width: res,
			height: res,
			bitDepth: 8,
		});
		if (!ormRes.ok) {
			return ormRes;
		}
		mapBuffers.set("orm", { buffer: ormRes.value.buffer, bitDepth: 8 });
	}

	// 3. Save all maps as artifacts
	const orderedMaps: TextureMapKind[] = [];
	for (const m of texSpec.maps) {
		if (mapBuffers.has(m) && !orderedMaps.includes(m)) {
			orderedMaps.push(m);
		}
	}
	if (texSpec.ormPack && mapBuffers.has("orm") && !orderedMaps.includes("orm")) {
		orderedMaps.push("orm");
	}

	const artifacts: Artifact[] = [];
	const sidecarsToAppend: SidecarDocument[] = [];
	const savedMapFiles: Partial<Record<TextureMapKind, string>> = {};
	let primaryDirAbs: string | undefined;
	let albedoStemAbs: string | undefined;

	const now = new Date();
	const createdAtIso = now.toISOString();

	for (let i = 0; i < orderedMaps.length; i++) {
		const mapKind = orderedMaps[i];
		if (mapKind === undefined) continue;
		const entry = mapBuffers.get(mapKind);
		if (entry === undefined) continue;

		const index = i + 1;
		const postRes = await runPostProcess({
			buffer: entry.buffer,
			requestedSize: targetSize,
			sizeMode: "snap",
			fit: "cover",
			post: request.post,
			background: "opaque",
			modelSupportsTransparentBg: true,
			format: request.output.format,
			compression: request.output.compression,
			bitDepth: entry.bitDepth,
			embedMetadata: config.output.embedMetadata,
			metadataToEmbed: {
				prompt: request.prompt,
				seed: String(input.seed),
				model: input.modelId,
				map: mapKind,
			},
			returnImage: mapKind === "albedo" ? request.output.returnImage : "none",
			pool,
		});
		if (!postRes.ok) {
			return postRes;
		}

		const stemRes = expandFilenameTemplate(request.output.filenameTemplate, {
			prompt: texSpec.material,
			index,
			seed: input.seed,
			model: input.modelId,
			provider: input.providerId,
			width: res,
			height: res,
			map: mapKind,
			jobId: input.jobId,
			tags: request.tags,
			now,
		});
		if (!stemRes.ok) {
			return stemRes;
		}

		const pathRes = await resolveSafeOutputPath({
			cwd: input.cwd,
			outputDir: request.output.dir,
			relativeStem: stemRes.value,
			format: postRes.value.format,
			allowOutsideCwd: config.output.allowOutsideCwd,
			onConflict: request.output.onConflict,
		});
		if (!pathRes.ok) {
			return pathRes;
		}

		primaryDirAbs ??= path.dirname(pathRes.value.absolutePath);
		if (mapKind === "albedo") {
			const parsed = path.parse(pathRes.value.absolutePath);
			albedoStemAbs = path.join(parsed.dir, parsed.name);
		}

		const texSidecar: TextureSidecarMeta = {
			material: texSpec.material,
			mapKind,
			resolution: res,
			tileable: texSpec.tileable,
			tilingMethod: tilingMethodUsed,
			normalConvention: texSpec.normalConvention,
			seamScore: seamScore !== undefined ? Number(seamScore.toFixed(2)) : null,
		};

		const artifactRes = await writeArtifact({
			absolutePath: pathRes.value.absolutePath,
			relativePath: pathRes.value.relativePath,
			imageBuffer: postRes.value.buffer,
			writeSidecar: config.output.sidecar,
			summary: {
				index,
				width: postRes.value.width,
				height: postRes.value.height,
				format: postRes.value.format,
				sha256: postRes.value.sha256,
				mapKind,
				...(seamScore !== undefined ? { seamScore: Number(seamScore.toFixed(2)) } : {}),
				...(postRes.value.thumbB64 !== undefined ? { thumbB64: postRes.value.thumbB64 } : {}),
				...(postRes.value.thumbMimeType !== undefined ? { thumbMimeType: postRes.value.thumbMimeType } : {}),
			},
			sidecar: {
				schema: SIDECAR_SCHEMA_VERSION,
				job: input.jobId,
				index,
				createdAt: createdAtIso,
				host: input.hostKind,
				provider: input.providerId,
				model: input.modelId,
				reportedModel: input.reportedModel,
				prompt: request.prompt,
				negativePrompt: input.negativePrompt ?? null,
				style: input.resolvedStyle ?? null,
				finalPrompt: input.finalPrompt,
				seed: input.seed,
				steps: request.steps ?? null,
				guidance: request.guidance ?? null,
				quality: request.quality,
				requestedSize: [input.requestedSize.width, input.requestedSize.height],
				producedSize: [postRes.value.width, postRes.value.height],
				post: postRes.value.appliedOps,
				references: input.referencesMeta,
				sha256: postRes.value.sha256,
				format: postRes.value.format,
				usage:
					input.usage !== undefined
						? {
								...(input.usage.inputTokens !== undefined ? { input: input.usage.inputTokens } : {}),
								...(input.usage.outputTokens !== undefined ? { output: input.usage.outputTokens } : {}),
								...(input.usage.images !== undefined ? { images: input.usage.images } : {}),
							}
						: null,
				costUsd: i === 0 && input.usage?.costUsd !== undefined ? input.usage.costUsd : null,
				texture: texSidecar,
				tags: request.tags,
				metadata: request.metadata,
			},
		});
		if (!artifactRes.ok) {
			return artifactRes;
		}

		artifacts.push(artifactRes.value);
		sidecarsToAppend.push(artifactRes.value.sidecar);
		savedMapFiles[mapKind] = pathRes.value.relativePath;
	}

	// 4. Generate 2x2 (or N×N) preview PNG and glTF material.json
	let previewRelativePath: string | undefined;
	let previewThumbB64: string | undefined;
	let previewThumbMimeType: string | undefined;
	let materialJsonPath: string | undefined;

	if (texSpec.previewTiles >= 1 && primaryDirAbs !== undefined) {
		const tileGridRes = await pool.run({
			op: "tile_grid",
			buffer: albedoBuffer.slice(0),
			tiles: texSpec.previewTiles,
			showGrid: false,
		});
		if (tileGridRes.ok) {
			const previewAbs =
				albedoStemAbs !== undefined
					? `${albedoStemAbs.replace(/_albedo$/, "")}_preview.png`
					: path.join(primaryDirAbs, "preview.png");
			const writePrev = await atomicWriteBytes(previewAbs, new Uint8Array(tileGridRes.value.buffer.slice(0)));
			if (writePrev.ok) {
				previewRelativePath = path.relative(input.cwd, previewAbs).split(path.sep).join("/");
			}
			if (request.output.returnImage !== "none") {
				const thumbRes = await pool.run({
					op: "thumbnail",
					buffer: tileGridRes.value.buffer,
					maxSide: 512,
					quality: 80,
				});
				if (thumbRes.ok) {
					previewThumbB64 = thumbRes.value.b64;
					previewThumbMimeType = thumbRes.value.mimeType;
				}
			}
		}
	}

	if (primaryDirAbs !== undefined) {
		const matRes = await writeGltfMaterialJson({
			directory: primaryDirAbs,
			materialName: texSpec.material,
			mapFiles: savedMapFiles,
			normalStrength: texSpec.normalStrength,
			normalConvention: texSpec.normalConvention,
			resolution: res,
		});
		if (matRes.ok) {
			materialJsonPath = path.relative(input.cwd, matRes.value).split(path.sep).join("/");
		}
	}

	const manifestRes = await input.manifest.append(input.cwd, config.output.manifest, sidecarsToAppend);
	if (!manifestRes.ok) {
		return manifestRes;
	}

	return ok(
		Object.freeze({
			artifacts: Object.freeze(artifacts),
			...(seamScore !== undefined ? { seamScore: Number(seamScore.toFixed(2)) } : {}),
			tilingMethodUsed,
			...(previewRelativePath !== undefined ? { previewRelativePath } : {}),
			...(previewThumbB64 !== undefined ? { previewThumbB64 } : {}),
			...(previewThumbMimeType !== undefined ? { previewThumbMimeType } : {}),
			...(materialJsonPath !== undefined ? { materialJsonPath } : {}),
		}),
	);
}

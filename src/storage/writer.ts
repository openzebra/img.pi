import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { internalError, pathForbidden } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { ok, tryAsync } from "../core/result.js";
import type { ArtifactSummary, SidecarDocument } from "../domain/artifact.js";
import { Artifact } from "../domain/artifact.js";
import { failedRequestRelPath } from "../domain/artifact-paths.js";
import type { NormalConvention, TextureMapKind } from "../domain/texture.js";

export async function atomicWriteBytes(targetPath: string, bytes: Uint8Array): Promise<Result<void, ImgError>> {
	const dir = path.dirname(targetPath);
	const mkdirRes = await tryAsync(
		() => fs.mkdir(dir, { recursive: true }),
		() => pathForbidden(targetPath, "not_writable"),
	);
	if (!mkdirRes.ok) {
		return mkdirRes;
	}

	const rand = crypto.randomBytes(6).toString("hex");
	const tmpPath = `${targetPath}.tmp-${rand}`;
	const writeRes = await tryAsync(
		async () => {
			const handle = await fs.open(tmpPath, "w", 0o644);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(tmpPath, targetPath);
		},
		(e: unknown) => {
			void fs.unlink(tmpPath).catch(() => undefined);
			return internalError(
				`Failed to atomically write '${targetPath}': ${e instanceof Error ? e.message : String(e)}`,
			);
		},
	);
	return writeRes;
}

export async function atomicWriteJson(targetPath: string, data: unknown): Promise<Result<void, ImgError>> {
	const serialized = `${JSON.stringify(data, null, "\t")}\n`;
	const bytes = new TextEncoder().encode(serialized);
	return atomicWriteBytes(targetPath, bytes);
}

export interface WriteArtifactInput {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly imageBuffer: ArrayBuffer;
	readonly writeSidecar: boolean;
	readonly summary: Omit<ArtifactSummary, "path" | "relativePath" | "sidecarPath" | "bytes">;
	readonly sidecar: Omit<SidecarDocument, "path" | "bytes">;
}

export async function writeArtifact(input: WriteArtifactInput): Promise<Result<Artifact, ImgError>> {
	const u8 = new Uint8Array(input.imageBuffer);
	const writeImg = await atomicWriteBytes(input.absolutePath, u8);
	if (!writeImg.ok) {
		return writeImg;
	}

	const sidecarAbs = `${input.absolutePath}.json`;
	const sidecarRel = `${input.relativePath}.json`;

	const fullSidecar: SidecarDocument = {
		...input.sidecar,
		path: input.relativePath,
		bytes: u8.byteLength,
	};

	if (input.writeSidecar) {
		const writeSc = await atomicWriteJson(sidecarAbs, fullSidecar);
		if (!writeSc.ok) {
			return writeSc;
		}
	}

	const fullSummary: ArtifactSummary = {
		...input.summary,
		path: input.absolutePath,
		relativePath: input.relativePath,
		...(input.writeSidecar ? { sidecarPath: sidecarRel } : {}),
		bytes: u8.byteLength,
	};

	return ok(new Artifact(fullSummary, fullSidecar));
}

export interface GltfMaterialInput {
	readonly directory: string;
	readonly materialName: string;
	readonly mapFiles: Readonly<Partial<Record<TextureMapKind, string>>>;
	readonly normalStrength: number;
	readonly normalConvention: NormalConvention;
	readonly resolution: number;
}

export async function writeGltfMaterialJson(input: GltfMaterialInput): Promise<Result<string, ImgError>> {
	const targetPath = path.join(input.directory, "material.json");
	const doc = {
		asset: {
			version: "2.0",
			generator: "@hicaru/img-pi",
		},
		name: input.materialName,
		resolution: input.resolution,
		normalConvention: input.normalConvention,
		pbrMetallicRoughness: {
			...(input.mapFiles.albedo !== undefined
				? { baseColorTexture: { uri: path.basename(input.mapFiles.albedo) } }
				: {}),
			...(input.mapFiles.orm !== undefined
				? {
						metallicRoughnessTexture: { uri: path.basename(input.mapFiles.orm) },
						occlusionTexture: { uri: path.basename(input.mapFiles.orm) },
					}
				: {
						...(input.mapFiles.roughness !== undefined
							? { roughnessTexture: { uri: path.basename(input.mapFiles.roughness) } }
							: {}),
						...(input.mapFiles.metallic !== undefined
							? { metallicTexture: { uri: path.basename(input.mapFiles.metallic) } }
							: {}),
						...(input.mapFiles.ao !== undefined
							? { occlusionTexture: { uri: path.basename(input.mapFiles.ao) } }
							: {}),
					}),
		},
		...(input.mapFiles.normal !== undefined
			? {
					normalTexture: {
						uri: path.basename(input.mapFiles.normal),
						scale: input.normalStrength,
						convention: input.normalConvention,
					},
				}
			: {}),
		...(input.mapFiles.height !== undefined
			? {
					displacementTexture: {
						uri: path.basename(input.mapFiles.height),
					},
				}
			: {}),
	};

	const res = await atomicWriteJson(targetPath, doc);
	if (!res.ok) {
		return res;
	}
	return ok(targetPath);
}

export async function saveFailedJobRequest(
	cwd: string,
	jobId: string,
	requestData: unknown,
	errorData: unknown,
): Promise<Result<string, ImgError>> {
	const relPath = failedRequestRelPath(jobId);
	const absPath = path.resolve(cwd, relPath);
	const res = await atomicWriteJson(absPath, {
		jobId,
		failedAt: new Date().toISOString(),
		request: requestData,
		error: errorData,
	});
	if (!res.ok) {
		return res;
	}
	return ok(relPath);
}

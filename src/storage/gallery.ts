import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { internalError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { ok, tryAsync } from "../core/result.js";
import type { SidecarDocument } from "../domain/artifact.js";
import type { WorkerPool } from "../workers/pool.js";
import type { ManifestStore } from "./manifest.js";

export interface GalleryFilter {
	readonly tag?: string;
	readonly model?: string;
	readonly query?: string;
	readonly texturesOnly?: boolean;
	readonly limit?: number;
	readonly offset?: number;
}

export interface GalleryPage {
	readonly items: readonly SidecarDocument[];
	readonly total: number;
	readonly offset: number;
	readonly limit: number;
}

export class GalleryStore {
	private readonly manifest: ManifestStore;
	private readonly pool: WorkerPool | undefined;

	public constructor(manifest: ManifestStore, pool?: WorkerPool) {
		this.manifest = manifest;
		this.pool = pool;
	}

	public async query(
		cwd: string,
		manifestRelPath: string,
		filter: GalleryFilter = {},
	): Promise<Result<GalleryPage, ImgError>> {
		const allRes = await this.manifest.readAll(cwd, manifestRelPath, this.pool);
		if (!allRes.ok) {
			return allRes;
		}
		// Reverse chronological order (newest first)
		const reversed = [...allRes.value].reverse();

		const cleanTag =
			filter.tag !== undefined
				? filter.tag.startsWith("#")
					? filter.tag.slice(1).toLowerCase()
					: filter.tag.toLowerCase()
				: undefined;
		const cleanModel = filter.model?.toLowerCase();
		const cleanQuery = filter.query?.toLowerCase();

		const filtered = reversed.filter(doc => {
			if (cleanTag !== undefined && cleanTag.length > 0) {
				const hasTag = doc.tags.some(t => t.toLowerCase() === cleanTag);
				if (!hasTag) return false;
			}
			if (cleanModel !== undefined && cleanModel.length > 0) {
				const fullModel = `${doc.provider}/${doc.model}`.toLowerCase();
				if (!fullModel.includes(cleanModel) && !doc.model.toLowerCase().includes(cleanModel)) {
					return false;
				}
			}
			if (filter.texturesOnly === true && doc.texture === null) {
				return false;
			}
			if (cleanQuery !== undefined && cleanQuery.length > 0) {
				const inPrompt = doc.prompt.toLowerCase().includes(cleanQuery);
				const inPath = doc.path.toLowerCase().includes(cleanQuery);
				const inTags = doc.tags.some(t => t.toLowerCase().includes(cleanQuery));
				if (!inPrompt && !inPath && !inTags) {
					return false;
				}
			}
			return true;
		});

		const offset = Math.max(0, filter.offset ?? 0);
		const limit = Math.max(1, filter.limit ?? 20);
		const items = filtered.slice(offset, offset + limit);

		return ok({
			items,
			total: filtered.length,
			offset,
			limit,
		});
	}

	public async addTag(cwd: string, doc: SidecarDocument, tag: string): Promise<Result<SidecarDocument, ImgError>> {
		const normalizedTag = tag.startsWith("#") ? tag.slice(1) : tag;
		if (doc.tags.includes(normalizedTag)) {
			return ok(doc);
		}
		const updated: SidecarDocument = {
			...doc,
			tags: [...doc.tags, normalizedTag],
		};
		const sidecarAbs = `${path.resolve(cwd, doc.path)}.json`;
		const writeRes = await tryAsync(
			() => fs.writeFile(sidecarAbs, `${JSON.stringify(updated, null, "\t")}\n`, "utf8"),
			(e: unknown) => internalError(`Failed to update sidecar tags: ${e instanceof Error ? e.message : String(e)}`),
		);
		if (!writeRes.ok) {
			return writeRes;
		}
		return ok(updated);
	}
}

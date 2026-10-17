import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { pathForbidden, refUnreadable } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import type { ReferenceImage } from "../domain/reference.js";
import { classifyReferenceSource } from "../domain/reference.js";
import type { HttpClient } from "../providers/http.js";
import type { PreparedReference } from "../providers/port.js";
import type { ManifestStore } from "../storage/manifest.js";
import type { WorkerPool } from "../workers/pool.js";

export interface LoadReferencesContext {
	readonly cwd: string;
	readonly allowOutsideCwd: boolean;
	readonly manifestRelPath: string;
	readonly http: HttpClient;
	readonly manifest: ManifestStore;
	readonly pool: WorkerPool;
	readonly signal: AbortSignal;
}

function guessMimeFromPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".avif")) return "image/avif";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/png";
}

function parseDataUri(uri: string): Result<{ readonly mimeType: string; readonly b64: string }, ImgError> {
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
	if (match === null) {
		return err(refUnreadable(uri.slice(0, 64), "Invalid data:image/*;base64 URI"));
	}
	const mimeType = match[1] ?? "image/png";
	const b64 = (match[2] ?? "").replace(/\s+/g, "");
	if (b64.length === 0) {
		return err(refUnreadable(uri.slice(0, 64), "Empty base64 payload in data URI"));
	}
	return ok({ mimeType, b64 });
}

async function readLocalImageFile(
	source: string,
	targetPath: string,
	cwd: string,
	allowOutsideCwd: boolean,
): Promise<Result<{ readonly buffer: ArrayBuffer; readonly mimeType: string }, ImgError>> {
	const realCwdRes = await tryAsync(
		() => fs.realpath(cwd),
		() => path.resolve(cwd),
	);
	const realCwd = realCwdRes.ok ? realCwdRes.value : path.resolve(cwd);

	const resolvedAbs = path.resolve(realCwd, targetPath);
	const realTargetRes = await tryAsync(
		() => fs.realpath(resolvedAbs),
		() => undefined,
	);
	if (!realTargetRes.ok) {
		return err(refUnreadable(source, `File not found: '${targetPath}'`));
	}
	const realTarget = realTargetRes.value;
	const relToCwd = path.relative(realCwd, realTarget);
	const isOutside = relToCwd.startsWith("..") || path.isAbsolute(relToCwd);
	if (isOutside && !allowOutsideCwd) {
		return err(pathForbidden(targetPath, "outside_root"));
	}

	const bytesRes = await tryAsync(
		() => fs.readFile(realTarget),
		(e: unknown) =>
			refUnreadable(source, `Cannot read file '${targetPath}': ${e instanceof Error ? e.message : String(e)}`),
	);
	if (!bytesRes.ok) {
		return bytesRes;
	}
	const u8 = bytesRes.value;
	const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
	return ok({
		buffer: ab,
		mimeType: guessMimeFromPath(realTarget),
	});
}

export async function prepareSingleReference(
	ref: ReferenceImage,
	ctx: LoadReferencesContext,
): Promise<Result<PreparedReference, ImgError>> {
	const kind = classifyReferenceSource(ref.source);

	switch (kind) {
		case "data_uri": {
			const parsed = parseDataUri(ref.source);
			if (!parsed.ok) {
				return parsed;
			}
			const decRes = await ctx.pool.run({
				op: "decode_b64",
				b64: parsed.value.b64,
			});
			if (!decRes.ok) {
				return decRes;
			}
			return ok(
				Object.freeze({
					source: "data:image/...",
					role: ref.role,
					weight: ref.weight,
					buffer: decRes.value.buffer,
					b64: parsed.value.b64,
					mimeType: parsed.value.mimeType,
					sha256: decRes.value.sha256,
				}),
			);
		}
		case "url": {
			const fetched = await ctx.http.fetchReferenceUrl(ref.source, ctx.signal);
			if (!fetched.ok) {
				return fetched;
			}
			const encRes = await ctx.pool.run({
				op: "encode_b64",
				buffer: fetched.value.buffer.slice(0),
			});
			if (!encRes.ok) {
				return encRes;
			}
			return ok(
				Object.freeze({
					source: ref.source,
					role: ref.role,
					weight: ref.weight,
					buffer: fetched.value.buffer,
					b64: encRes.value.b64,
					mimeType: fetched.value.mimeType,
					sha256: encRes.value.sha256,
				}),
			);
		}
		case "job_ref": {
			const jobDocRes = await ctx.manifest.resolveJobReference(ctx.cwd, ctx.manifestRelPath, ref.source, ctx.pool);
			if (!jobDocRes.ok) {
				return jobDocRes;
			}
			const fileRes = await readLocalImageFile(ref.source, jobDocRes.value.path, ctx.cwd, ctx.allowOutsideCwd);
			if (!fileRes.ok) {
				return fileRes;
			}
			const encRes = await ctx.pool.run({
				op: "encode_b64",
				buffer: fileRes.value.buffer.slice(0),
			});
			if (!encRes.ok) {
				return encRes;
			}
			return ok(
				Object.freeze({
					source: ref.source,
					role: ref.role,
					weight: ref.weight,
					buffer: fileRes.value.buffer,
					b64: encRes.value.b64,
					mimeType: fileRes.value.mimeType,
					sha256: encRes.value.sha256,
				}),
			);
		}
		case "path": {
			const fileRes = await readLocalImageFile(ref.source, ref.source, ctx.cwd, ctx.allowOutsideCwd);
			if (!fileRes.ok) {
				return fileRes;
			}
			const encRes = await ctx.pool.run({
				op: "encode_b64",
				buffer: fileRes.value.buffer.slice(0),
			});
			if (!encRes.ok) {
				return encRes;
			}
			return ok(
				Object.freeze({
					source: ref.source,
					role: ref.role,
					weight: ref.weight,
					buffer: fileRes.value.buffer,
					b64: encRes.value.b64,
					mimeType: fileRes.value.mimeType,
					sha256: encRes.value.sha256,
				}),
			);
		}
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

export async function prepareReferences(
	refs: readonly ReferenceImage[],
	ctx: LoadReferencesContext,
): Promise<Result<readonly PreparedReference[], ImgError>> {
	if (refs.length === 0) {
		return ok(Object.freeze([]));
	}
	const prepared = new Array<PreparedReference>(refs.length);
	for (let i = 0; i < refs.length; i++) {
		const ref = refs[i];
		if (ref === undefined) continue;
		const res = await prepareSingleReference(ref, ctx);
		if (!res.ok) {
			return res;
		}
		prepared[i] = res.value;
	}
	return ok(Object.freeze(prepared));
}

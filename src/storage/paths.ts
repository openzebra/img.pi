import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { configInvalid, pathForbidden } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import { toSlug } from "../core/ids.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import { ARTIFACT_ROOT } from "../domain/artifact-paths.js";
import type { ConflictPolicy, ImageFormat } from "../domain/output.js";
import { validateTemplateTokens } from "../domain/output.js";

/** Never written into, anywhere in the path. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Host config dirs: forbidden except for img.pi's own artifact root (`.pi/img`). */
const HOST_DIR_SEGMENTS: ReadonlySet<string> = new Set([".omp", ".pi"]);

function isInsideArtifactRoot(posixRel: string): boolean {
	return posixRel === ARTIFACT_ROOT || posixRel.startsWith(`${ARTIFACT_ROOT}/`);
}

export const FORMAT_EXTENSIONS: Readonly<Record<ImageFormat, string>> = deepFreeze({
	png: ".png",
	jpeg: ".jpg",
	webp: ".webp",
	avif: ".avif",
});

export interface TemplateContext {
	readonly prompt: string;
	readonly index: number;
	readonly seed?: number;
	readonly model: string;
	readonly provider: string;
	readonly width: number;
	readonly height: number;
	readonly map?: string;
	readonly jobId: string;
	readonly tags?: readonly string[];
	readonly now?: Date;
}

function formatDateYmd(date: Date): string {
	const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatTimeHms(date: Date): string {
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const mi = String(date.getUTCMinutes()).padStart(2, "0");
	const ss = String(date.getUTCSeconds()).padStart(2, "0");
	return `${hh}${mi}${ss}`;
}

function sanitizeSegment(raw: string): string {
	return raw
		.replace(/[<>:"\\|?*\x00-\x1f]/g, "-")
		.replace(/\.{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function expandFilenameTemplate(template: string, ctx: TemplateContext): Result<string, ImgError> {
	const valid = validateTemplateTokens(template);
	if (!valid.ok) {
		return valid;
	}
	const now = ctx.now ?? new Date();
	const shortModel = ctx.model.includes("/") ? (ctx.model.split("/").pop() ?? ctx.model) : ctx.model;
	const firstTag = ctx.tags?.[0] ?? "untagged";

	const replacements: Readonly<Record<string, string>> = {
		date: formatDateYmd(now),
		time: formatTimeHms(now),
		slug: toSlug(ctx.prompt, 48),
		index: String(ctx.index),
		seed: ctx.seed !== undefined ? String(ctx.seed) : "random",
		model: toSlug(shortModel, 32),
		provider: toSlug(ctx.provider, 24),
		w: String(ctx.width),
		h: String(ctx.height),
		map: ctx.map !== undefined ? toSlug(ctx.map, 24) : "image",
		job: ctx.jobId.slice(0, 8),
		tag: toSlug(firstTag, 24),
	};

	const expanded = valid.value.replace(/\{([^{}]+)\}/g, (_full, key: string) => {
		return replacements[key] ?? "unknown";
	});

	const subparts = expanded.split("/").filter(part => part.length > 0);
	if (subparts.length === 0) {
		return err(configInvalid("filename", "Expanded filename template produced an empty path"));
	}
	const safeParts = new Array<string>(subparts.length);
	for (let i = 0; i < subparts.length; i++) {
		const rawPart = subparts[i] ?? "";
		if (rawPart === "." || rawPart === "..") {
			return err(pathForbidden(expanded, "outside_root"));
		}
		const clean = sanitizeSegment(rawPart);
		safeParts[i] = clean.length > 0 ? clean : "image";
	}

	return ok(safeParts.join("/"));
}

async function resolveRealExistingAncestor(targetPath: string): Promise<string> {
	let current = path.resolve(targetPath);
	for (let depth = 0; depth < 64; depth++) {
		const realRes = await tryAsync(
			() => fs.realpath(current),
			() => undefined,
		);
		if (realRes.ok) {
			const relRemainder = path.relative(current, path.resolve(targetPath));
			return relRemainder.length > 0 ? path.join(realRes.value, relRemainder) : realRes.value;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return path.resolve(targetPath);
}

async function fileExists(filePath: string): Promise<boolean> {
	const res = await tryAsync(
		() => fs.access(filePath),
		() => false,
	);
	return res.ok;
}

export interface ResolveOutputPathOptions {
	readonly cwd: string;
	readonly outputDir: string;
	readonly relativeStem: string;
	readonly format: ImageFormat;
	readonly allowOutsideCwd: boolean;
	readonly onConflict: ConflictPolicy;
}

export interface ResolvedOutputPath {
	readonly absolutePath: string;
	readonly relativePath: string;
}

export async function resolveSafeOutputPath(
	opts: ResolveOutputPathOptions,
): Promise<Result<ResolvedOutputPath, ImgError>> {
	const realCwdRes = await tryAsync(
		() => fs.realpath(opts.cwd),
		() => path.resolve(opts.cwd),
	);
	const realCwd = realCwdRes.ok ? realCwdRes.value : path.resolve(opts.cwd);

	const ext = FORMAT_EXTENSIONS[opts.format];
	const stemHasExt =
		opts.relativeStem.endsWith(".png") ||
		opts.relativeStem.endsWith(".jpg") ||
		opts.relativeStem.endsWith(".jpeg") ||
		opts.relativeStem.endsWith(".webp") ||
		opts.relativeStem.endsWith(".avif");
	const baseRelFile = stemHasExt ? opts.relativeStem : `${opts.relativeStem}${ext}`;

	const baseDirAbs = path.resolve(realCwd, opts.outputDir);
	const candidateAbs = path.resolve(baseDirAbs, baseRelFile);
	const realCandidate = await resolveRealExistingAncestor(candidateAbs);

	const relToCwd = path.relative(realCwd, realCandidate);
	const isOutsideCwd = relToCwd.startsWith("..") || path.isAbsolute(relToCwd);

	if (isOutsideCwd && !opts.allowOutsideCwd) {
		return err(pathForbidden(candidateAbs, "outside_root"));
	}

	const checkRel = isOutsideCwd ? realCandidate : relToCwd;
	const segments = checkRel.split(path.sep);
	const allowHostDir = !isOutsideCwd && isInsideArtifactRoot(segments.join("/"));
	for (const seg of segments) {
		if (FORBIDDEN_SEGMENTS.has(seg) || (!allowHostDir && HOST_DIR_SEGMENTS.has(seg))) {
			return err(pathForbidden(candidateAbs, "not_writable"));
		}
	}

	let finalAbs = realCandidate;
	const exists = await fileExists(finalAbs);
	if (exists) {
		switch (opts.onConflict) {
			case "error":
				return err(pathForbidden(relToCwd, "exists"));
			case "overwrite":
				break;
			case "suffix": {
				const parsed = path.parse(realCandidate);
				let suffixNum = 2;
				while (await fileExists(finalAbs)) {
					finalAbs = path.join(parsed.dir, `${parsed.name}_${suffixNum}${parsed.ext}`);
					suffixNum++;
				}
				break;
			}
			default: {
				const _exhaustive: never = opts.onConflict;
				return _exhaustive;
			}
		}
	}

	const finalRel = path.relative(realCwd, finalAbs).split(path.sep).join("/");
	return ok({
		absolutePath: finalAbs,
		relativePath: finalRel,
	});
}

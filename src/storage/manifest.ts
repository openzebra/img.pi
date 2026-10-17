import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImgError } from "../core/errors.js";
import { internalError, refUnreadable } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import type { SidecarDocument } from "../domain/artifact.js";
import { SIDECAR_SCHEMA_VERSION } from "../domain/artifact.js";
import { parseJobRef } from "../domain/reference.js";
import type { WorkerPool } from "../workers/pool.js";

const LARGE_MANIFEST_THRESHOLD_BYTES = 1_048_576;

function isSidecarDocument(v: unknown): v is SidecarDocument {
	if (typeof v !== "object" || v === null) return false;
	if (!("schema" in v) || v.schema !== SIDECAR_SCHEMA_VERSION) return false;
	if (!("job" in v) || typeof v.job !== "string") return false;
	if (!("path" in v) || typeof v.path !== "string") return false;
	return true;
}

export class ManifestStore {
	private writeChain: Promise<void> = Promise.resolve();

	public async append(
		cwd: string,
		manifestRelPath: string,
		entries: readonly SidecarDocument[],
	): Promise<Result<void, ImgError>> {
		if (entries.length === 0) {
			return ok(undefined);
		}
		const absPath = path.resolve(cwd, manifestRelPath);
		const lines = new Array<string>(entries.length);
		for (let i = 0; i < entries.length; i++) {
			lines[i] = JSON.stringify(entries[i]);
		}
		const payload = `${lines.join("\n")}\n`;

		const task = this.writeChain.then(async () => {
			await fs.mkdir(path.dirname(absPath), { recursive: true });
			await fs.appendFile(absPath, payload, "utf8");
		});
		this.writeChain = task.catch(() => undefined);

		return tryAsync(
			() => task,
			(e: unknown) =>
				internalError(
					`Failed to append to manifest '${manifestRelPath}': ${e instanceof Error ? e.message : String(e)}`,
				),
		);
	}

	public async flush(): Promise<void> {
		await this.writeChain;
	}

	public async readAll(
		cwd: string,
		manifestRelPath: string,
		pool?: WorkerPool,
	): Promise<Result<readonly SidecarDocument[], ImgError>> {
		const absPath = path.resolve(cwd, manifestRelPath);
		const statRes = await tryAsync(
			() => fs.stat(absPath),
			() => undefined,
		);
		if (!statRes.ok) {
			return ok([]);
		}

		const textRes = await tryAsync(
			() => fs.readFile(absPath, "utf8"),
			(e: unknown) =>
				internalError(
					`Failed to read manifest '${manifestRelPath}': ${e instanceof Error ? e.message : String(e)}`,
				),
		);
		if (!textRes.ok) {
			return textRes;
		}
		const text = textRes.value;
		if (text.trim().length === 0) {
			return ok([]);
		}

		if (statRes.value.size > LARGE_MANIFEST_THRESHOLD_BYTES && pool !== undefined) {
			const workerRes = await pool.run({
				op: "json_parse_large",
				text,
				jsonl: true,
			});
			if (!workerRes.ok) {
				return workerRes;
			}
			const arr = Array.isArray(workerRes.value.data) ? workerRes.value.data : [];
			const docs: SidecarDocument[] = [];
			for (const item of arr) {
				if (isSidecarDocument(item)) {
					docs.push(item);
				}
			}
			return ok(docs);
		}

		const rawLines = text.split("\n");
		const docs: SidecarDocument[] = [];
		for (const line of rawLines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isSidecarDocument(parsed)) {
					docs.push(parsed);
				}
			} catch {
				// Skip malformed line gracefully
			}
		}
		return ok(docs);
	}

	public async resolveJobReference(
		cwd: string,
		manifestRelPath: string,
		source: string,
		pool?: WorkerPool,
	): Promise<Result<SidecarDocument, ImgError>> {
		const parsedRef = parseJobRef(source);
		if (parsedRef === undefined) {
			return err(refUnreadable(source, "Invalid job reference syntax; expected @last or @job:<id>[#n]"));
		}

		const allRes = await this.readAll(cwd, manifestRelPath, pool);
		if (!allRes.ok) {
			return allRes;
		}
		const all = allRes.value;
		if (all.length === 0) {
			return err(refUnreadable(source, "Manifest is empty; no previous jobs found"));
		}

		if (parsedRef.kind === "last") {
			const lastEntry = all[all.length - 1];
			if (lastEntry === undefined) {
				return err(refUnreadable(source, "No last job found"));
			}
			const targetJobId = lastEntry.job;
			const jobEntries = all.filter(d => d.job === targetJobId);
			const targetIndex = parsedRef.index;
			const found = jobEntries.find(d => d.index === targetIndex) ?? jobEntries[targetIndex - 1];
			if (found === undefined) {
				return err(refUnreadable(source, `No artifact #${targetIndex} in last job ${targetJobId}`));
			}
			return ok(found);
		}

		const matches = all.filter(d => d.job === parsedRef.jobId || d.job.startsWith(parsedRef.jobId));
		if (matches.length === 0) {
			return err(refUnreadable(source, `Job '${parsedRef.jobId}' not found in manifest`));
		}
		const targetIndex = parsedRef.index;
		const found = matches.find(d => d.index === targetIndex) ?? matches[targetIndex - 1];
		if (found === undefined) {
			return err(refUnreadable(source, `Artifact #${targetIndex} not found for job '${parsedRef.jobId}'`));
		}
		return ok(found);
	}

	public async describeJob(
		cwd: string,
		manifestRelPath: string,
		jobSpec: string,
		pool?: WorkerPool,
	): Promise<Result<readonly SidecarDocument[], ImgError>> {
		const allRes = await this.readAll(cwd, manifestRelPath, pool);
		if (!allRes.ok) {
			return allRes;
		}
		const all = allRes.value;
		if (all.length === 0) {
			return err(refUnreadable(jobSpec, "No jobs recorded in manifest"));
		}

		const trimmed = jobSpec.trim();
		if (trimmed === "@last" || trimmed === "last") {
			const last = all[all.length - 1];
			if (last === undefined) {
				return err(refUnreadable(jobSpec, "No last job recorded"));
			}
			return ok(all.filter(d => d.job === last.job));
		}

		const cleanId = trimmed.startsWith("@job:") ? trimmed.slice(5) : trimmed;
		const matched = all.filter(d => d.job === cleanId || d.job.startsWith(cleanId));
		if (matched.length === 0) {
			return err(refUnreadable(jobSpec, `Job '${cleanId}' not found in manifest`));
		}
		return ok(matched);
	}
}

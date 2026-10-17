import * as fs from "node:fs/promises";
import * as path from "node:path";
import { configInvalid, fromUnknownError, type ImgError } from "../core/errors";
import { type Disposer, TypedEmitter } from "../core/events";
import { err, ok, type Result, tryAsync } from "../core/result";
import { type ConfigLayerSet, resolveConfigLayers } from "./layers";
import { migrateConfig } from "./migrate";
import { type ImgConfig, type PartialConfig, validatePartialConfig } from "./schema";

export interface ConfigPaths {
	readonly userPath: string;
	readonly projectPath: string;
}

export function resolveConfigPaths(agentDir: string, cwd: string, projectDirName: ".omp" | ".pi"): ConfigPaths {
	return Object.freeze({
		userPath: path.join(agentDir, "img-pi.json"),
		projectPath: path.join(cwd, projectDirName, "img-pi.json"),
	});
}

async function readPartialConfigFile(filePath: string): Promise<Result<PartialConfig | undefined, ImgError>> {
	let rawText: string;
	try {
		rawText = await fs.readFile(filePath, "utf8");
	} catch (e: unknown) {
		if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") {
			return ok(undefined);
		}
		return err(fromUnknownError(e));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return err(configInvalid(filePath, `Invalid JSON: ${msg}`));
	}

	return migrateConfig(parsed);
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<Result<void, ImgError>> {
	return tryAsync(
		async () => {
			const dir = path.dirname(filePath);
			await fs.mkdir(dir, { recursive: true });
			const rand = Math.random().toString(36).slice(2, 10);
			const tmpPath = `${filePath}.tmp-${process.pid}-${rand}`;
			const serialized = `${JSON.stringify(data, null, "\t")}\n`;
			const handle = await fs.open(tmpPath, "w", 0o600);
			try {
				await handle.writeFile(serialized, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(tmpPath, filePath);
		},
		e => fromUnknownError(e),
	);
}

export class ConfigStore {
	readonly #agentDir: string;
	readonly #projectDirName: ".omp" | ".pi";
	readonly #changeEmitter = new TypedEmitter<ImgConfig>();
	#cwd: string;
	#userLayer: PartialConfig | undefined;
	#projectLayer: PartialConfig | undefined;
	#sessionLayer: PartialConfig | undefined;

	public constructor(opts: {
		readonly agentDir: string;
		readonly cwd: string;
		readonly projectDirName: ".omp" | ".pi";
	}) {
		this.#agentDir = opts.agentDir;
		this.#cwd = opts.cwd;
		this.#projectDirName = opts.projectDirName;
	}

	public onChange(fn: (cfg: ImgConfig) => void): Disposer {
		return this.#changeEmitter.on(fn);
	}

	public setCwd(cwd: string): void {
		this.#cwd = cwd;
	}

	public get paths(): ConfigPaths {
		return resolveConfigPaths(this.#agentDir, this.#cwd, this.#projectDirName);
	}

	public async load(): Promise<Result<ImgConfig, ImgError>> {
		const { userPath, projectPath } = this.paths;
		const userRes = await readPartialConfigFile(userPath);
		if (!userRes.ok) return userRes;
		const projRes = await readPartialConfigFile(projectPath);
		if (!projRes.ok) return projRes;

		this.#userLayer = userRes.value;
		this.#projectLayer = projRes.value;
		const eff = this.getEffective();
		this.#changeEmitter.emit(eff);
		return ok(eff);
	}

	public getLayers(callLayer?: PartialConfig): ConfigLayerSet {
		return Object.freeze({
			...(this.#userLayer !== undefined ? { user: this.#userLayer } : {}),
			...(this.#projectLayer !== undefined ? { project: this.#projectLayer } : {}),
			...(this.#sessionLayer !== undefined ? { session: this.#sessionLayer } : {}),
			...(callLayer !== undefined ? { call: callLayer } : {}),
		});
	}

	public getEffective(callLayer?: PartialConfig): ImgConfig {
		return resolveConfigLayers(this.getLayers(callLayer));
	}

	public setSessionLayer(patch: PartialConfig | undefined): Result<ImgConfig, ImgError> {
		if (patch !== undefined) {
			const validated = validatePartialConfig(patch);
			if (!validated.ok) return validated;
			this.#sessionLayer = validated.value;
		} else {
			this.#sessionLayer = undefined;
		}
		const eff = this.getEffective();
		this.#changeEmitter.emit(eff);
		return ok(eff);
	}

	public setScopeLayer(scope: "user" | "project", patch: PartialConfig | undefined): Result<ImgConfig, ImgError> {
		if (patch !== undefined) {
			const validated = validatePartialConfig(patch);
			if (!validated.ok) return validated;
			if (scope === "user") {
				this.#userLayer = validated.value;
			} else {
				this.#projectLayer = validated.value;
			}
		} else {
			if (scope === "user") {
				this.#userLayer = undefined;
			} else {
				this.#projectLayer = undefined;
			}
		}
		const eff = this.getEffective();
		this.#changeEmitter.emit(eff);
		return ok(eff);
	}

	public async saveScope(scope: "user" | "project", config: PartialConfig): Promise<Result<ImgConfig, ImgError>> {
		const validated = validatePartialConfig({ ...config, version: 1 });
		if (!validated.ok) return validated;

		const targetPath = scope === "user" ? this.paths.userPath : this.paths.projectPath;
		const writeRes = await atomicWriteJson(targetPath, validated.value);
		if (!writeRes.ok) return writeRes;

		if (scope === "user") {
			this.#userLayer = validated.value;
		} else {
			this.#projectLayer = validated.value;
		}
		const eff = this.getEffective();
		this.#changeEmitter.emit(eff);
		return ok(eff);
	}
}

import { spawn } from "node:child_process";
import type { ImgConfig } from "../config/schema.js";
import type { Capability, ImgError } from "../core/errors.js";
import { noApiKey } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import type { UsageSummary } from "../domain/artifact.js";
import type { JobEvent } from "../domain/job.js";
import type { BackgroundMode, QualityTier } from "../domain/output.js";
import type { ReferenceRole } from "../domain/reference.js";
import type { ResolutionTier, Size, SizeRule } from "../domain/size.js";
import type { HostPort, PortableCtx } from "../host/port.js";
import type { WorkerPool } from "../workers/pool.js";
import type { HttpClient } from "./http.js";

export interface ProviderModel {
	readonly id: string;
	readonly provider: string;
	readonly label: string;
	readonly caps: ReadonlySet<Capability>;
	readonly sizes: SizeRule;
	readonly maxRefs: number;
	readonly maxCount: number;
	readonly costHint?: string;
	readonly costPerImageUsd?: number;
	readonly hasKey?: boolean;
}

export interface PreparedReference {
	readonly source: string;
	readonly role: ReferenceRole;
	readonly weight: number;
	readonly buffer: ArrayBuffer;
	readonly b64: string;
	readonly mimeType: string;
	readonly sha256: string;
}

export interface ResolvedJob {
	readonly jobId: string;
	readonly model: ProviderModel;
	readonly prompt: string;
	readonly finalPrompt: string;
	readonly negativePrompt?: string;
	readonly size: Size;
	readonly requestedSize: Size;
	readonly aspectRatio?: string;
	readonly resolutionTier?: ResolutionTier;
	readonly count: number;
	readonly seed: number;
	readonly steps?: number;
	readonly guidance?: number;
	readonly quality: QualityTier;
	readonly background: BackgroundMode;
	readonly strength?: number;
	readonly mode?: "generate" | "edit" | "inpaint" | "outpaint" | "variation" | "texture";
	readonly tileable?: boolean;
	readonly references: readonly PreparedReference[];
	readonly initImage?: PreparedReference;
	readonly maskImage?: PreparedReference;
}

export interface RawImage {
	readonly buffer: ArrayBuffer;
	readonly mimeType: string;
	readonly seed?: number;
	readonly reportedModel?: string;
	readonly usage?: UsageSummary;
}

export interface ProviderCtx {
	readonly host: HostPort;
	readonly hostCtx: PortableCtx;
	readonly config: ImgConfig;
	readonly http: HttpClient;
	readonly secrets: SecretResolver;
}

export interface ProviderIO {
	readonly signal: AbortSignal;
	readonly emit: (ev: JobEvent) => void;
	readonly http: HttpClient;
	readonly secrets: SecretResolver;
	readonly host: HostPort;
	readonly hostCtx: PortableCtx;
	readonly config: ImgConfig;
	readonly pool: WorkerPool;
}

export interface ImageProvider {
	readonly id: string;
	models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>>;
	generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>>;
}

const DEFAULT_PROVIDER_ENV: Readonly<Record<string, string>> = Object.freeze({
	fal: "FAL_KEY",
	replicate: "REPLICATE_API_TOKEN",
	stability: "STABILITY_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
});

export class SecretResolver {
	private readonly commandCache = new Map<string, string>();
	private readonly envSource: Readonly<Record<string, string | undefined>>;

	public constructor(envSource: Readonly<Record<string, string | undefined>> = process.env) {
		this.envSource = envSource;
	}

	public envHintFor(provider: string, config: ImgConfig): string | undefined {
		const providersRec: Readonly<Record<string, { readonly apiKeyEnv?: string | null } | undefined>> =
			config.providers;
		const configuredEnv = providersRec[provider]?.apiKeyEnv;
		if (typeof configuredEnv === "string" && configuredEnv.trim().length > 0) {
			return configuredEnv.trim();
		}
		return DEFAULT_PROVIDER_ENV[provider];
	}

	public hasDirectKey(provider: string, config: ImgConfig): boolean {
		const envName = this.envHintFor(provider, config);
		if (envName !== undefined) {
			const val = this.envSource[envName];
			if (typeof val === "string" && val.trim().length > 0) {
				return true;
			}
		}
		const providersRec: Readonly<Record<string, { readonly apiKeyCommand?: string | null } | undefined>> =
			config.providers;
		const cmd = providersRec[provider]?.apiKeyCommand;
		if (typeof cmd === "string" && cmd.trim().length > 0) {
			return true;
		}
		return false;
	}

	public async resolveKey(provider: string, config: ImgConfig): Promise<Result<string, ImgError>> {
		const envName = this.envHintFor(provider, config);
		if (envName !== undefined) {
			const val = this.envSource[envName];
			if (typeof val === "string" && val.trim().length > 0) {
				return ok(val.trim());
			}
		}

		const providersRec: Readonly<Record<string, { readonly apiKeyCommand?: string | null } | undefined>> =
			config.providers;
		const cmd = providersRec[provider]?.apiKeyCommand;
		if (typeof cmd === "string" && cmd.trim().length > 0) {
			const cached = this.commandCache.get(cmd);
			if (cached !== undefined) {
				return ok(cached);
			}
			const cmdRes = await this.execKeyCommand(cmd, provider, envName);
			if (cmdRes.ok) {
				this.commandCache.set(cmd, cmdRes.value);
			}
			return cmdRes;
		}

		return err(noApiKey(provider, envName));
	}

	private async execKeyCommand(
		command: string,
		provider: string,
		envHint: string | undefined,
	): Promise<Result<string, ImgError>> {
		return tryAsync(
			() =>
				new Promise<string>((resolve, reject) => {
					const child = spawn("sh", ["-c", command], {
						stdio: ["ignore", "pipe", "pipe"],
					});
					const chunks: Buffer[] = [];
					child.stdout.on("data", (chunk: Buffer) => {
						chunks.push(chunk);
					});
					child.on("error", reject);
					child.on("close", code => {
						if (code !== 0) {
							reject(new Error(`Key command exited with status ${code ?? -1}`));
							return;
						}
						const output = Buffer.concat(chunks).toString("utf8").trim();
						if (output.length === 0) {
							reject(new Error("Key command returned empty output"));
							return;
						}
						resolve(output);
					});
				}),
			() => noApiKey(provider, envHint),
		);
	}
}

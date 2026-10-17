import type { ImgConfig } from "../config/schema.js";
import type { Capability, ImgError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import type { UsageSummary } from "../domain/artifact.js";
import type { JobEvent } from "../domain/job.js";
import type { BackgroundMode, QualityTier } from "../domain/output.js";
import type { ReferenceRole } from "../domain/reference.js";
import type { Size, SizeRule } from "../domain/size.js";
import type { HostImageOptions, HostPort, PortableCtx } from "../host/port.js";
import type { WorkerPool } from "../workers/pool.js";

/** A model that is listed is usable: the host only reports authenticated models. */
export interface ProviderModel {
	readonly id: string;
	readonly provider: string;
	readonly providerLabel: string;
	readonly label: string;
	readonly caps: ReadonlySet<Capability>;
	readonly sizes: SizeRule;
	readonly options: HostImageOptions;
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
	/** Provider-native size token from the caller, passed through verbatim. */
	readonly imageSize?: string;
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
}

export interface ProviderIO extends ProviderCtx {
	readonly signal: AbortSignal;
	readonly emit: (ev: JobEvent) => void;
	readonly pool: WorkerPool;
}

export interface ImageProvider {
	readonly id: string;
	models(ctx: ProviderCtx): Promise<Result<readonly ProviderModel[], ImgError>>;
	generate(job: ResolvedJob, io: ProviderIO): Promise<Result<readonly RawImage[], ImgError>>;
}

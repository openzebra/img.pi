import { computeHashCode, structuralEquals, type ValueObject } from "../core/equals";
import { deepFreeze } from "../core/freeze";
import { type ImageFormat, type QualityTier } from "./output";
import { type ReferenceRole } from "./reference";
import { type TextureMapKind } from "./texture";

export const SIDECAR_SCHEMA_VERSION = "img-pi/artifact@1";

export interface UsageSummary {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly images?: number;
	readonly costUsd?: number;
}

export interface ReferenceMetadata {
	readonly source: string;
	readonly sha256: string;
	readonly role: ReferenceRole;
	readonly weight: number;
}

export interface ArtifactSummary {
	readonly index: number;
	readonly path: string;
	readonly relativePath: string;
	readonly sidecarPath?: string;
	readonly bytes: number;
	readonly width: number;
	readonly height: number;
	readonly format: ImageFormat;
	readonly sha256: string;
	readonly mapKind?: TextureMapKind;
	readonly seamScore?: number;
	readonly thumbB64?: string;
	readonly thumbMimeType?: string;
}

export interface TextureSidecarMeta {
	readonly material: string;
	readonly mapKind: TextureMapKind;
	readonly resolution: number;
	readonly tileable: boolean;
	readonly tilingMethod: string;
	readonly normalConvention: string;
	readonly seamScore: number | null;
}

/**
 * Serialized sidecar JSON document (§8.4).
 * Uses `null` for absent values in serialized JSON per AGENTS.md §3.
 */
export interface SidecarDocument {
	readonly schema: typeof SIDECAR_SCHEMA_VERSION;
	readonly job: string;
	readonly index: number;
	readonly createdAt: string;
	readonly host: "omp" | "pi";
	readonly provider: string;
	readonly model: string;
	readonly reportedModel: string;
	readonly prompt: string;
	readonly negativePrompt: string | null;
	readonly style: string | null;
	readonly finalPrompt: string;
	readonly seed: number;
	readonly steps: number | null;
	readonly guidance: number | null;
	readonly quality: QualityTier;
	readonly requestedSize: readonly [number, number];
	readonly producedSize: readonly [number, number];
	readonly post: readonly string[];
	readonly references: readonly ReferenceMetadata[];
	readonly sha256: string;
	readonly bytes: number;
	readonly format: ImageFormat;
	readonly path: string;
	readonly usage: { readonly input?: number; readonly output?: number; readonly images?: number } | null;
	readonly costUsd: number | null;
	readonly texture: TextureSidecarMeta | null;
	readonly tags: readonly string[];
	readonly metadata: Readonly<Record<string, string>>;
}

export class Artifact implements ValueObject<Artifact> {
	public readonly summary: ArtifactSummary;
	public readonly sidecar: SidecarDocument;
	#hash: string | undefined;

	public constructor(summary: ArtifactSummary, sidecar: SidecarDocument) {
		this.summary = deepFreeze({ ...summary });
		this.sidecar = deepFreeze({ ...sidecar });
		Object.freeze(this);
	}

	public equals(other: Artifact): boolean {
		return structuralEquals(
			{ summary: this.summary, sidecar: this.sidecar },
			{ summary: other.summary, sidecar: other.sidecar },
		);
	}

	public hashCode(): string {
		this.#hash ??= computeHashCode({ summary: this.summary, sidecar: this.sidecar });
		return this.#hash;
	}
}

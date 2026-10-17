import { computeHashCode, structuralEquals, type ValueObject } from "../core/equals";
import { configInvalid, type ImgError } from "../core/errors";
import { err, ok, type Result } from "../core/result";

export type ReferenceRole = "content" | "style" | "subject" | "composition" | "init" | "mask";
export type ReferenceSourceKind = "path" | "url" | "data_uri" | "job_ref";

export type JobRefTarget =
	| { readonly kind: "last"; readonly index: number }
	| { readonly kind: "job"; readonly jobId: string; readonly index: number };

export function parseJobRef(source: string): JobRefTarget | undefined {
	const trimmed = source.trim();
	if (trimmed === "@last") {
		return Object.freeze({ kind: "last", index: 1 });
	}
	const lastMatch = /^@last#(\d+)$/.exec(trimmed);
	if (lastMatch !== null) {
		const idx = Number(lastMatch[1]);
		if (Number.isInteger(idx) && idx >= 1) {
			return Object.freeze({ kind: "last", index: idx });
		}
		return undefined;
	}
	const jobMatch = /^@job:([A-Za-z0-9_-]+)(?:#(\d+))?$/.exec(trimmed);
	if (jobMatch !== null) {
		const jobId = jobMatch[1] ?? "";
		const idx = jobMatch[2] !== undefined ? Number(jobMatch[2]) : 1;
		if (jobId.length > 0 && Number.isInteger(idx) && idx >= 1) {
			return Object.freeze({ kind: "job", jobId, index: idx });
		}
	}
	return undefined;
}

export function classifyReferenceSource(source: string): ReferenceSourceKind {
	const trimmed = source.trim();
	if (trimmed.startsWith("data:")) {
		return "data_uri";
	}
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return "url";
	}
	if (trimmed.startsWith("@last") || trimmed.startsWith("@job:")) {
		return "job_ref";
	}
	return "path";
}

export interface ReferenceImageInit {
	readonly source: string;
	readonly role?: ReferenceRole;
	readonly weight?: number;
	readonly label?: string;
}

export class ReferenceImage implements ValueObject<ReferenceImage> {
	public readonly source: string;
	public readonly kind: ReferenceSourceKind;
	public readonly role: ReferenceRole;
	public readonly weight: number;
	public readonly label?: string;
	#hash: string | undefined;

	public constructor(init: {
		readonly source: string;
		readonly kind: ReferenceSourceKind;
		readonly role: ReferenceRole;
		readonly weight: number;
		readonly label?: string;
	}) {
		this.source = init.source;
		this.kind = init.kind;
		this.role = init.role;
		this.weight = init.weight;
		if (init.label !== undefined) {
			this.label = init.label;
		}
		Object.freeze(this);
	}

	public static create(init: ReferenceImageInit): Result<ReferenceImage, ImgError> {
		const trimmed = init.source.trim();
		if (trimmed.length === 0) {
			return err(configInvalid("references.source", "Reference source cannot be empty"));
		}
		const weight = init.weight ?? 1.0;
		if (!Number.isFinite(weight) || weight < 0 || weight > 2) {
			return err(configInvalid("references.weight", "Reference weight must be in [0, 2]"));
		}
		const kind = classifyReferenceSource(trimmed);
		if (kind === "job_ref" && parseJobRef(trimmed) === undefined) {
			return err(
				configInvalid("references.source", `Invalid job reference '${trimmed}', expected @last or @job:<id>[#n]`),
			);
		}
		const role: ReferenceRole = init.role ?? "content";
		return ok(
			new ReferenceImage({
				source: trimmed,
				kind,
				role,
				weight,
				...(init.label !== undefined ? { label: init.label } : {}),
			}),
		);
	}

	public toPlain(): Record<string, unknown> {
		return {
			source: this.source,
			kind: this.kind,
			role: this.role,
			weight: this.weight,
			...(this.label !== undefined ? { label: this.label } : {}),
		};
	}

	public equals(other: ReferenceImage): boolean {
		return structuralEquals(this.toPlain(), other.toPlain());
	}

	public hashCode(): string {
		this.#hash ??= computeHashCode(this.toPlain());
		return this.#hash;
	}
}

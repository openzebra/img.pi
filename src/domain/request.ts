import { computeHashCode, structuralEquals, type ValueObject } from "../core/equals";
import { configInvalid, type ImgError } from "../core/errors";
import { deepFreeze } from "../core/freeze";
import { err, ok, type Result } from "../core/result";
import { type BackgroundMode, type OutputSpec, type PostSpec, type QualityTier } from "./output";
import { type ReferenceImage } from "./reference";
import { type FitMode, type SizeMode, type SizeRequest } from "./size";
import { type TextureSpec } from "./texture";

export type JobKind = "generate" | "edit" | "texture" | "variation";
export type EditMode = "edit" | "inpaint" | "outpaint" | "variation";

export interface OutpaintSpec {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

export interface EditSpec {
	readonly image: ReferenceImage;
	readonly mask?: ReferenceImage;
	readonly strength: number;
	readonly mode: EditMode;
	readonly outpaint?: OutpaintSpec;
}

export interface GenerationRequestInit {
	readonly kind?: JobKind;
	readonly prompt: string;
	readonly negativePrompt?: string;
	readonly style?: string;
	readonly model?: string;
	readonly references?: readonly ReferenceImage[];
	readonly sizeRequest?: SizeRequest;
	readonly sizeMode?: SizeMode;
	readonly fit?: FitMode;
	readonly count?: number;
	readonly seed?: number;
	readonly steps?: number;
	readonly guidance?: number;
	readonly quality?: QualityTier;
	readonly background?: BackgroundMode;
	readonly output: OutputSpec;
	readonly post?: PostSpec;
	readonly tags?: readonly string[];
	readonly metadata?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly dryRun?: boolean;
	readonly texture?: TextureSpec;
	readonly edit?: EditSpec;
}

export class GenerationRequest implements ValueObject<GenerationRequest> {
	public readonly kind: JobKind;
	public readonly prompt: string;
	public readonly negativePrompt?: string;
	public readonly style?: string;
	public readonly model?: string;
	public readonly references: readonly ReferenceImage[];
	public readonly sizeRequest: SizeRequest;
	public readonly sizeMode: SizeMode;
	public readonly fit: FitMode;
	public readonly count: number;
	public readonly seed: number;
	public readonly steps?: number;
	public readonly guidance?: number;
	public readonly quality: QualityTier;
	public readonly background: BackgroundMode;
	public readonly output: OutputSpec;
	public readonly post: PostSpec;
	public readonly tags: readonly string[];
	public readonly metadata: Readonly<Record<string, string>>;
	public readonly timeoutMs: number;
	public readonly dryRun: boolean;
	public readonly texture?: TextureSpec;
	public readonly edit?: EditSpec;
	#hash: string | undefined;

	public constructor(props: {
		readonly kind: JobKind;
		readonly prompt: string;
		readonly negativePrompt?: string;
		readonly style?: string;
		readonly model?: string;
		readonly references: readonly ReferenceImage[];
		readonly sizeRequest: SizeRequest;
		readonly sizeMode: SizeMode;
		readonly fit: FitMode;
		readonly count: number;
		readonly seed: number;
		readonly steps?: number;
		readonly guidance?: number;
		readonly quality: QualityTier;
		readonly background: BackgroundMode;
		readonly output: OutputSpec;
		readonly post: PostSpec;
		readonly tags: readonly string[];
		readonly metadata: Readonly<Record<string, string>>;
		readonly timeoutMs: number;
		readonly dryRun: boolean;
		readonly texture?: TextureSpec;
		readonly edit?: EditSpec;
	}) {
		this.kind = props.kind;
		this.prompt = props.prompt;
		if (props.negativePrompt !== undefined) this.negativePrompt = props.negativePrompt;
		if (props.style !== undefined) this.style = props.style;
		if (props.model !== undefined) this.model = props.model;
		this.references = Object.freeze([...props.references]);
		this.sizeRequest = deepFreeze({ ...props.sizeRequest });
		this.sizeMode = props.sizeMode;
		this.fit = props.fit;
		this.count = props.count;
		this.seed = props.seed;
		if (props.steps !== undefined) this.steps = props.steps;
		if (props.guidance !== undefined) this.guidance = props.guidance;
		this.quality = props.quality;
		this.background = props.background;
		this.output = props.output;
		this.post = deepFreeze({ ...props.post });
		this.tags = Object.freeze([...props.tags]);
		this.metadata = deepFreeze({ ...props.metadata });
		this.timeoutMs = props.timeoutMs;
		this.dryRun = props.dryRun;
		if (props.texture !== undefined) this.texture = props.texture;
		if (props.edit !== undefined) this.edit = deepFreeze({ ...props.edit });
		Object.freeze(this);
	}

	public static create(init: GenerationRequestInit): Result<GenerationRequest, ImgError> {
		const prompt = init.prompt.trim();
		if (prompt.length === 0 || prompt.length > 32000) {
			return err(configInvalid("prompt", "Prompt must be between 1 and 32000 characters"));
		}
		const kind: JobKind = init.kind ?? "generate";
		const maxCount = kind === "edit" ? 4 : 16;
		const count = init.count ?? 1;
		if (!Number.isInteger(count) || count < 1 || count > maxCount) {
			return err(configInvalid("count", `count must be an integer between 1 and ${maxCount}`));
		}
		const refs = init.references ?? [];
		if (refs.length > 16) {
			return err(configInvalid("references", "At most 16 reference images are allowed"));
		}
		const seed = init.seed !== undefined ? Math.floor(init.seed) : Math.floor(Math.random() * 2147483647);
		if (!Number.isInteger(seed) || seed < 0) {
			return err(configInvalid("seed", "seed must be a non-negative integer"));
		}
		if (init.steps !== undefined && (!Number.isInteger(init.steps) || init.steps < 1 || init.steps > 150)) {
			return err(configInvalid("steps", "steps must be an integer between 1 and 150"));
		}
		if (init.guidance !== undefined && (!Number.isFinite(init.guidance) || init.guidance < 0 || init.guidance > 30)) {
			return err(configInvalid("guidance", "guidance must be a number between 0 and 30"));
		}
		const timeoutMs = init.timeoutMs ?? 180000;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 900000) {
			return err(configInvalid("timeout_ms", "timeout_ms must be between 5000 and 900000"));
		}
		return ok(
			new GenerationRequest({
				kind,
				prompt,
				...(init.negativePrompt !== undefined ? { negativePrompt: init.negativePrompt } : {}),
				...(init.style !== undefined ? { style: init.style } : {}),
				...(init.model !== undefined ? { model: init.model } : {}),
				references: refs,
				sizeRequest: init.sizeRequest ?? {},
				sizeMode: init.sizeMode ?? "exact",
				fit: init.fit ?? "cover",
				count,
				seed,
				...(init.steps !== undefined ? { steps: init.steps } : {}),
				...(init.guidance !== undefined ? { guidance: init.guidance } : {}),
				quality: init.quality ?? "auto",
				background: init.background ?? "auto",
				output: init.output,
				post: init.post ?? {},
				tags: init.tags ?? [],
				metadata: init.metadata ?? {},
				timeoutMs,
				dryRun: init.dryRun ?? false,
				...(init.texture !== undefined ? { texture: init.texture } : {}),
				...(init.edit !== undefined ? { edit: init.edit } : {}),
			}),
		);
	}

	public toPlain(): Record<string, unknown> {
		return {
			kind: this.kind,
			prompt: this.prompt,
			...(this.negativePrompt !== undefined ? { negativePrompt: this.negativePrompt } : {}),
			...(this.style !== undefined ? { style: this.style } : {}),
			...(this.model !== undefined ? { model: this.model } : {}),
			references: this.references.map(r => r.toPlain()),
			sizeRequest: this.sizeRequest,
			sizeMode: this.sizeMode,
			fit: this.fit,
			count: this.count,
			seed: this.seed,
			...(this.steps !== undefined ? { steps: this.steps } : {}),
			...(this.guidance !== undefined ? { guidance: this.guidance } : {}),
			quality: this.quality,
			background: this.background,
			output: this.output.toPlain(),
			post: this.post,
			tags: this.tags,
			metadata: this.metadata,
			timeoutMs: this.timeoutMs,
			dryRun: this.dryRun,
			...(this.texture !== undefined ? { texture: this.texture.toPlain() } : {}),
			...(this.edit !== undefined
				? {
						edit: {
							image: this.edit.image.toPlain(),
							...(this.edit.mask !== undefined ? { mask: this.edit.mask.toPlain() } : {}),
							strength: this.edit.strength,
							mode: this.edit.mode,
							...(this.edit.outpaint !== undefined ? { outpaint: this.edit.outpaint } : {}),
						},
					}
				: {}),
		};
	}

	public equals(other: GenerationRequest): boolean {
		return structuralEquals(this.toPlain(), other.toPlain());
	}

	public hashCode(): string {
		this.#hash ??= computeHashCode(this.toPlain());
		return this.#hash;
	}
}

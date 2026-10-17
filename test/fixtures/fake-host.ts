import type { ImgError } from "../../src/core/errors.js";
import { modelNotFound } from "../../src/core/errors.js";
import type { Result } from "../../src/core/result.js";
import { err, ok } from "../../src/core/result.js";
import { wrapPortableCtx } from "../../src/host/base.js";
import type {
	ComponentLike,
	HostImageModel,
	HostPort,
	NativeRequest,
	NativeResponse,
	PortableCommand,
	PortableCtx,
	PortableFlag,
	PortableTool,
} from "../../src/host/port.js";
import { buildTinySeedPng } from "./png.js";

export const GOOGLE_IMAGE_MODEL: HostImageModel = Object.freeze({
	id: "google/gemini-image",
	provider: "google",
	providerLabel: "Google",
	label: "Gemini Image",
	acceptsImages: true,
	options: Object.freeze({ aspectRatio: true, imageSize: true }),
});

export const TEXT_ONLY_IMAGE_MODEL: HostImageModel = Object.freeze({
	id: "google/imagen",
	provider: "google",
	providerLabel: "Google",
	label: "Imagen",
	acceptsImages: false,
	options: Object.freeze({ aspectRatio: true, imageSize: true }),
});

export const KEY_SEQ = Object.freeze({
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
});

const FAKE_KEYS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(Object.entries(KEY_SEQ).map(([name, seq]) => [seq, name])),
);

/** In-memory HostPort: records registrations and generation requests, returns a PNG per call. */
export class FakeHost implements HostPort {
	public readonly kind = "omp" as const;
	public readonly agentDir: string;
	public readonly projectDirName = ".omp" as const;
	public readonly tools = new Map<
		string,
		Pick<PortableTool<unknown, unknown>, "essential" | "approval" | "promptSnippet">
	>();
	public readonly requests: NativeRequest[] = [];
	public models: readonly HostImageModel[];
	public configured: string | undefined;
	public flags = new Map<string, string>();
	public costPerCallUsd: number | undefined;
	/** Host-internal URLs the fake resolves (`local://x.png` → absolute path). */
	public readonly hostUrls = new Map<string, string>();
	/** When set, every `generateNative` call fails with this error. */
	public failWith: ImgError | undefined;

	public constructor(agentDir: string, models: readonly HostImageModel[] = [GOOGLE_IMAGE_MODEL]) {
		this.agentDir = agentDir;
		this.models = models;
	}

	public registerTool<P, D>(def: PortableTool<P, D>): void {
		this.tools.set(def.name, {
			...(def.essential !== undefined ? { essential: def.essential } : {}),
			...(def.approval !== undefined ? { approval: def.approval } : {}),
			...(def.promptSnippet !== undefined ? { promptSnippet: def.promptSnippet } : {}),
		});
	}

	public readonly commands = new Map<string, PortableCommand>();

	public registerCommand(name: string, spec: PortableCommand): void {
		this.commands.set(name, spec);
	}

	/** Minimal stand-in for the host TUI `parseKey` (legacy escape sequences only). */
	public parseKey(data: string): string | undefined {
		return FAKE_KEYS[data];
	}

	public registerFlag(_name: string, _spec: PortableFlag): void {
		// Flags are read from `this.flags`.
	}

	public getFlag(name: string): string | undefined {
		return this.flags.get(name);
	}

	public onSessionStart(_fn: (ctx: PortableCtx) => void | Promise<void>): void {
		// Not driven in unit tests.
	}

	public onSessionShutdown(_fn: () => void | Promise<void>): void {
		// Not driven in unit tests.
	}

	public readonly imageComponent = (): ComponentLike => ({
		render: (): string[] => ["[image]"],
		invalidate: (): void => undefined,
	});

	public configuredImageModel(): string | undefined {
		return this.configured;
	}

	public nativeImageModels(): Promise<Result<readonly HostImageModel[], ImgError>> {
		return Promise.resolve(ok(this.models));
	}

	public generateNative(
		_ctx: PortableCtx,
		req: NativeRequest,
		_signal: AbortSignal,
	): Promise<Result<NativeResponse, ImgError>> {
		this.requests.push(req);
		if (this.failWith !== undefined) {
			return Promise.resolve(err(this.failWith));
		}
		if (!this.models.some(m => m.id === req.model)) {
			return Promise.resolve(err(modelNotFound(req.model)));
		}
		const png = Buffer.from(buildTinySeedPng(this.requests.length, false)).toString("base64");
		return Promise.resolve(
			ok({
				images: [{ data: png, mimeType: "image/png" }],
				reportedModel: req.model,
				...(this.costPerCallUsd !== undefined ? { usage: { costUsd: this.costPerCallUsd } } : {}),
			}),
		);
	}

	public resolveHostUrl(_ctx: PortableCtx, url: string): Promise<Result<string | undefined, ImgError>> {
		return Promise.resolve(ok(this.hostUrls.get(url)));
	}

	public logError(): void {
		// Silent in tests.
	}
}

export function fakeCtx(cwd: string): PortableCtx {
	return wrapPortableCtx({ cwd, mode: "print" });
}

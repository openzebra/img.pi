export type Capability =
	| "txt2img"
	| "img2img"
	| "inpaint"
	| "multi_ref"
	| "seed"
	| "negative_prompt"
	| "transparent_bg"
	| "arbitrary_size"
	| "steps"
	| "guidance"
	| "partial_previews"
	| "native_tiling"
	| "count";

export type WorkerOp =
	| "decode_b64"
	| "encode_b64"
	| "probe"
	| "resize"
	| "convert"
	| "thumbnail"
	| "halfblock_preview"
	| "contact_sheet"
	| "roll"
	| "multiband_blend"
	| "seam_score"
	| "height"
	| "normal"
	| "ao"
	| "roughness"
	| "metallic"
	| "orm_pack"
	| "trim"
	| "palette"
	| "embed_metadata"
	| "json_parse_large"
	| "remove_bg"
	| "outpaint_canvas"
	| "mirror_quad"
	| "tile_grid";

export type PathForbiddenReason = "outside_root" | "exists" | "not_writable";

export type ImgError =
	| { readonly kind: "config_invalid"; readonly path: string; readonly message: string }
	| { readonly kind: "no_api_key"; readonly provider: string }
	| { readonly kind: "no_image_models" }
	| { readonly kind: "model_not_found"; readonly model: string; readonly suggestions: readonly string[] }
	| { readonly kind: "unsupported"; readonly model: string; readonly feature: Capability }
	| { readonly kind: "ref_unreadable"; readonly source: string; readonly reason: string }
	| { readonly kind: "path_forbidden"; readonly path: string; readonly reason: PathForbiddenReason }
	| {
			readonly kind: "provider_http";
			readonly provider: string;
			readonly status: number;
			readonly body: string;
			readonly retryable: boolean;
	  }
	| { readonly kind: "content_policy"; readonly provider: string; readonly message: string }
	| { readonly kind: "timeout"; readonly afterMs: number }
	| { readonly kind: "aborted" }
	| { readonly kind: "worker_failed"; readonly op: WorkerOp; readonly message: string }
	| { readonly kind: "internal"; readonly message: string };

export function configInvalid(path: string, message: string): ImgError {
	return Object.freeze({ kind: "config_invalid", path, message });
}

export function noApiKey(provider: string): ImgError {
	return Object.freeze({ kind: "no_api_key", provider });
}

const NO_IMAGE_MODELS_SINGLETON: ImgError = Object.freeze({ kind: "no_image_models" });

export function noImageModels(): ImgError {
	return NO_IMAGE_MODELS_SINGLETON;
}

export function modelNotFound(model: string, suggestions: readonly string[] = []): ImgError {
	return Object.freeze({
		kind: "model_not_found",
		model,
		suggestions: Object.freeze([...suggestions]),
	});
}

export function unsupportedFeature(model: string, feature: Capability): ImgError {
	return Object.freeze({ kind: "unsupported", model, feature });
}

export function refUnreadable(source: string, reason: string): ImgError {
	return Object.freeze({ kind: "ref_unreadable", source, reason });
}

export function pathForbidden(path: string, reason: PathForbiddenReason): ImgError {
	return Object.freeze({ kind: "path_forbidden", path, reason });
}

export function providerHttp(provider: string, status: number, body: string, retryable: boolean): ImgError {
	return Object.freeze({ kind: "provider_http", provider, status, body, retryable });
}

export function contentPolicy(provider: string, message: string): ImgError {
	return Object.freeze({ kind: "content_policy", provider, message });
}

export function timeoutError(afterMs: number): ImgError {
	return Object.freeze({ kind: "timeout", afterMs });
}

const ABORTED_SINGLETON: ImgError = Object.freeze({ kind: "aborted" });

export function abortedError(): ImgError {
	return ABORTED_SINGLETON;
}

export function workerFailed(op: WorkerOp, message: string): ImgError {
	return Object.freeze({ kind: "worker_failed", op, message });
}

export function internalError(message: string): ImgError {
	return Object.freeze({ kind: "internal", message });
}

export function isAbortLike(e: unknown): boolean {
	if (typeof e === "object" && e !== null) {
		if ("name" in e && (e.name === "AbortError" || e.name === "TimeoutError")) {
			return e.name === "AbortError";
		}
		if ("kind" in e && e.kind === "aborted") {
			return true;
		}
	}
	return false;
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) {
		return e.message;
	}
	if (typeof e === "string") {
		return e;
	}
	if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
		return e.message;
	}
	return String(e);
}

export function fromUnknownError(e: unknown): ImgError {
	if (isAbortLike(e)) {
		return abortedError();
	}
	if (typeof e === "object" && e !== null && "name" in e && e.name === "TimeoutError") {
		return timeoutError(0);
	}
	return internalError(errorMessage(e));
}

export function formatImgError(error: ImgError): string {
	switch (error.kind) {
		case "config_invalid":
			return `config_invalid (${error.path}): ${error.message}`;
		case "no_api_key":
			return `no_api_key (${error.provider}): credentials unavailable — log in to ${error.provider} in the host (/login)`;
		case "no_image_models":
			return "no_image_models: the host has no connected provider with image models — connect one via /login";
		case "model_not_found": {
			const hint = error.suggestions.length > 0 ? ` (did you mean: ${error.suggestions.join(", ")}?)` : "";
			return `model_not_found: '${error.model}'${hint}`;
		}
		case "unsupported":
			return `unsupported: model '${error.model}' does not support '${error.feature}'`;
		case "ref_unreadable":
			return `ref_unreadable (${error.source}): ${error.reason}`;
		case "path_forbidden":
			return `path_forbidden (${error.reason}): ${error.path}`;
		case "provider_http":
			return `provider_http ${error.status} · ${error.provider} · ${error.body}`;
		case "content_policy":
			return `content_policy (${error.provider}): ${error.message}`;
		case "timeout":
			return `timeout after ${error.afterMs}ms`;
		case "aborted":
			return "cancelled";
		case "worker_failed":
			return `worker_failed (${error.op}): ${error.message}`;
		case "internal":
			return `internal: ${error.message}`;
		default: {
			const _exhaustive: never = error;
			return String(_exhaustive);
		}
	}
}

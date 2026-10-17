import type { ImgError } from "../core/errors.js";
import { configInvalid } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import { OmpHost } from "./omp.js";
import { PiHost } from "./pi.js";
import type { HostPort } from "./port.js";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/**
 * Runtime host detection (§4.2):
 * 1. Primary check: omp exposes `arktype`, `zod`, and `logger` on ExtensionAPI;
 *    `@earendil-works/pi-coding-agent` does not.
 * 2. Secondary check: `OMP_CODING_AGENT_DIR` vs `PI_CODING_AGENT_DIR` environment variables.
 * 3. Fallback: `import.meta.resolve("@oh-my-pi/pi-ai/images")`.
 */
export function detectHost(api: unknown): Result<HostPort, ImgError> {
	if (!isRecord(api)) {
		return err(configInvalid("host", "Extension API object is missing or invalid"));
	}

	if ("arktype" in api || "zod" in api || "logger" in api) {
		return ok(new OmpHost(api));
	}

	if ("typebox" in api && !("arktype" in api)) {
		return ok(new PiHost(api));
	}

	if (process.env["OMP_CODING_AGENT_DIR"] !== undefined) {
		return ok(new OmpHost(api));
	}
	if (process.env["PI_CODING_AGENT_DIR"] !== undefined) {
		return ok(new PiHost(api));
	}

	try {
		if (typeof import.meta.resolve === "function") {
			import.meta.resolve("@oh-my-pi/pi-ai/images");
			return ok(new OmpHost(api));
		}
	} catch {
		// Fall through to PiHost if @oh-my-pi is not resolvable
	}

	return ok(new PiHost(api));
}

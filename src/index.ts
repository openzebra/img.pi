import { detectHost } from "./host/detect.js";
import type { WiredExtension } from "./wire.js";
import { wireExtension } from "./wire.js";

/**
 * Universal extension entrypoint for both omp (`@oh-my-pi/pi-coding-agent`)
 * and pi (`@earendil-works/pi-coding-agent`).
 */
export default function imgPiExtension(api: unknown): WiredExtension | undefined {
	const hostRes = detectHost(api);
	if (!hostRes.ok) {
		return undefined;
	}
	return wireExtension(hostRes.value);
}

export { detectHost } from "./host/detect.js";
export type { HostPort } from "./host/port.js";
export type { WiredExtension } from "./wire.js";
export { wireExtension } from "./wire.js";

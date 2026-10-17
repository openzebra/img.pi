import type { ImgError } from "../core/errors.js";
import { abortedError, refUnreadable, timeoutError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";

/** AGENTS.md §12: reference URLs are http(s) only, 30 s timeout, 50 MB cap, `image/*`. */
const MAX_IMAGE_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const REF_FETCH_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
	readonly fetchImpl?: FetchLike;
}

/** Fetches reference images by URL. Image generation itself goes through the host, never through here. */
export class HttpClient {
	private readonly fetchFn: FetchLike;

	public constructor(options: HttpClientOptions = {}) {
		this.fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	public async fetchReferenceUrl(
		url: string,
		signal?: AbortSignal,
	): Promise<Result<{ readonly buffer: ArrayBuffer; readonly mimeType: string }, ImgError>> {
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			return err(refUnreadable(url, "Malformed URL"));
		}
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			return err(refUnreadable(url, `Unsupported URL protocol '${parsedUrl.protocol}'; only http(s) allowed`));
		}

		const timeoutSignal = AbortSignal.timeout(REF_FETCH_TIMEOUT_MS);
		const combinedSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

		const fetchRes = await tryAsync(
			() => this.fetchFn(url, { method: "GET", signal: combinedSignal }),
			(e: unknown) => {
				if (signal?.aborted === true) {
					return abortedError();
				}
				if (timeoutSignal.aborted) {
					return timeoutError(REF_FETCH_TIMEOUT_MS);
				}
				return refUnreadable(url, e instanceof Error ? e.message : String(e));
			},
		);
		if (!fetchRes.ok) {
			return fetchRes;
		}
		const response = fetchRes.value;
		if (!response.ok) {
			return err(refUnreadable(url, `HTTP ${response.status}`));
		}

		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		const mimeType = contentType.split(";")[0]?.trim() ?? "";
		if (!mimeType.startsWith("image/")) {
			return err(refUnreadable(url, `Content-Type must be image/*, got '${contentType}'`));
		}

		const contentLengthHeader = response.headers.get("content-length");
		if (contentLengthHeader !== null) {
			const len = Number(contentLengthHeader);
			if (Number.isFinite(len) && len > MAX_IMAGE_DOWNLOAD_BYTES) {
				return err(refUnreadable(url, `Image exceeds 50 MB limit (${len} bytes)`));
			}
		}

		const bufRes = await tryAsync(
			() => response.arrayBuffer(),
			(e: unknown) => refUnreadable(url, e instanceof Error ? e.message : String(e)),
		);
		if (!bufRes.ok) {
			return bufRes;
		}
		if (bufRes.value.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) {
			return err(refUnreadable(url, `Image exceeds 50 MB limit (${bufRes.value.byteLength} bytes)`));
		}

		return ok({ buffer: bufRes.value, mimeType });
	}
}

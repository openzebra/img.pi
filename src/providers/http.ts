import type { ImgError } from "../core/errors.js";
import { abortedError, contentPolicy, providerHttp, refUnreadable, timeoutError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import type { WorkerPool } from "../workers/pool.js";

const LARGE_JSON_BYTES = 1_048_576;
const MAX_IMAGE_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const REF_FETCH_TIMEOUT_MS = 30_000;

const POLICY_KEYWORDS: readonly string[] = Object.freeze([
	"content_policy",
	"content_policy_violation",
	"moderation_blocked",
	"safety_system",
	"nsfw",
	"violates our safety",
	"flagged by moderation",
]);

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface HttpClientOptions {
	readonly fetchImpl?: FetchLike;
	readonly sleepImpl?: SleepLike;
	readonly pool?: WorkerPool;
	readonly maxAttempts?: number;
	readonly baseDelayMs?: number;
}

export interface HttpRequestSpec {
	readonly provider: string;
	readonly url: string;
	readonly method?: "GET" | "POST" | "PUT" | "DELETE";
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string | Uint8Array | FormData;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly maxAttempts?: number;
}

export interface HttpJsonResponse<T = unknown> {
	readonly status: number;
	readonly headers: Headers;
	readonly data: T;
}

export interface HttpBinaryResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly buffer: ArrayBuffer;
	readonly mimeType: string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			if (onAbort !== undefined && signal !== undefined) {
				signal.removeEventListener("abort", onAbort);
			}
			resolve();
		}, ms);
		let onAbort: (() => void) | undefined;
		if (signal !== undefined) {
			onAbort = (): void => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfterMs(headers: Headers): number | undefined {
	const raw = headers.get("retry-after");
	if (raw === null || raw.trim().length === 0) {
		return undefined;
	}
	const seconds = Number(raw.trim());
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1000);
	}
	const dateMs = Date.parse(raw);
	if (!Number.isNaN(dateMs)) {
		const diff = dateMs - Date.now();
		return diff > 0 ? diff : 0;
	}
	return undefined;
}

function detectContentPolicyMessage(status: number, bodyText: string): string | undefined {
	if (status !== 400 && status !== 422 && status !== 403) {
		return undefined;
	}
	const lower = bodyText.toLowerCase();
	for (const kw of POLICY_KEYWORDS) {
		if (lower.includes(kw)) {
			return bodyText.slice(0, 500);
		}
	}
	return undefined;
}

export class HttpClient {
	private readonly fetchFn: FetchLike;
	private readonly sleepFn: SleepLike;
	private readonly pool: WorkerPool | undefined;
	private readonly defaultMaxAttempts: number;
	private readonly baseDelayMs: number;

	public constructor(options: HttpClientOptions = {}) {
		this.fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.sleepFn = options.sleepImpl ?? defaultSleep;
		this.pool = options.pool;
		this.defaultMaxAttempts = options.maxAttempts ?? 3;
		this.baseDelayMs = options.baseDelayMs ?? 500;
	}

	public async requestJson(spec: HttpRequestSpec): Promise<Result<HttpJsonResponse, ImgError>> {
		const respRes = await this.performWithRetries(spec);
		if (!respRes.ok) {
			return respRes;
		}
		const response = respRes.value;
		const textRes = await tryAsync(
			() => response.text(),
			(e: unknown) =>
				providerHttp(spec.provider, response.status, e instanceof Error ? e.message : String(e), false),
		);
		if (!textRes.ok) {
			return textRes;
		}

		const text = textRes.value;
		if (text.length > LARGE_JSON_BYTES && this.pool !== undefined) {
			const workerParsed = await this.pool.run({
				op: "json_parse_large",
				text,
			});
			if (!workerParsed.ok) {
				return workerParsed;
			}
			return ok({
				status: response.status,
				headers: response.headers,
				data: workerParsed.value.data,
			});
		}

		try {
			const parsed: unknown = text.trim().length > 0 ? JSON.parse(text) : {};
			return ok({
				status: response.status,
				headers: response.headers,
				data: parsed,
			});
		} catch (e: unknown) {
			return err(
				providerHttp(
					spec.provider,
					response.status,
					`Invalid JSON response: ${e instanceof Error ? e.message : String(e)}`,
					false,
				),
			);
		}
	}

	public async requestBytes(spec: HttpRequestSpec): Promise<Result<HttpBinaryResponse, ImgError>> {
		const respRes = await this.performWithRetries(spec);
		if (!respRes.ok) {
			return respRes;
		}
		const response = respRes.value;
		const bufRes = await tryAsync(
			() => response.arrayBuffer(),
			(e: unknown) =>
				providerHttp(spec.provider, response.status, e instanceof Error ? e.message : String(e), false),
		);
		if (!bufRes.ok) {
			return bufRes;
		}
		const rawCt = response.headers.get("content-type") ?? "image/png";
		const mimeType = rawCt.split(";")[0]?.trim() ?? "image/png";
		return ok({
			status: response.status,
			headers: response.headers,
			buffer: bufRes.value,
			mimeType,
		});
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

	private async performWithRetries(spec: HttpRequestSpec): Promise<Result<Response, ImgError>> {
		const maxAttempts = Math.max(1, spec.maxAttempts ?? this.defaultMaxAttempts);
		const timeoutMs = spec.timeoutMs ?? 60_000;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (spec.signal?.aborted === true) {
				return err(abortedError());
			}
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const activeSignal = spec.signal !== undefined ? AbortSignal.any([spec.signal, timeoutSignal]) : timeoutSignal;

			const requestInit: RequestInit = {
				method: spec.method ?? "GET",
				signal: activeSignal,
				...(spec.headers !== undefined ? { headers: { ...spec.headers } } : {}),
				...(spec.body !== undefined ? { body: spec.body } : {}),
			};

			const res = await tryAsync(
				() => this.fetchFn(spec.url, requestInit),
				(e: unknown) => {
					if (spec.signal?.aborted === true) {
						return abortedError();
					}
					if (timeoutSignal.aborted) {
						return timeoutError(timeoutMs);
					}
					return providerHttp(spec.provider, 0, e instanceof Error ? e.message : String(e), true);
				},
			);

			if (!res.ok) {
				if (res.error.kind === "aborted" || res.error.kind === "timeout") {
					return res;
				}
				if (attempt + 1 < maxAttempts) {
					const waitRes = await this.backoff(attempt, undefined, spec.signal);
					if (!waitRes.ok) return waitRes;
					continue;
				}
				return res;
			}

			const response = res.value;
			if (response.ok) {
				return ok(response);
			}

			const bodyText = await response.text().catch(() => "");
			const policyMsg = detectContentPolicyMessage(response.status, bodyText);
			if (policyMsg !== undefined) {
				return err(contentPolicy(spec.provider, policyMsg));
			}

			const retryable = isRetryableStatus(response.status);
			if (retryable && attempt + 1 < maxAttempts) {
				const retryAfterMs = parseRetryAfterMs(response.headers);
				const waitRes = await this.backoff(attempt, retryAfterMs, spec.signal);
				if (!waitRes.ok) return waitRes;
				continue;
			}

			return err(providerHttp(spec.provider, response.status, bodyText.slice(0, 1000), retryable));
		}

		return err(providerHttp(spec.provider, 500, "Exhausted retry attempts", true));
	}

	private async backoff(
		attempt: number,
		retryAfterMs: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<Result<void, ImgError>> {
		const jitter = Math.floor(Math.random() * 100);
		const computed = this.baseDelayMs * (1 << attempt) + jitter;
		const delay = retryAfterMs !== undefined ? Math.max(retryAfterMs, computed) : computed;

		return tryAsync(
			() => this.sleepFn(delay, signal),
			() => abortedError(),
		);
	}
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProgressWeights } from "../config/schema.js";
import { DEFAULT_PROGRESS_WEIGHTS } from "../config/schema.js";
import type { ImgError } from "../core/errors.js";
import { deepFreeze } from "../core/freeze.js";
import type { Result } from "../core/result.js";
import { ok, tryAsync } from "../core/result.js";
import type { JobPhase, JobState } from "../domain/job.js";
import type { Size } from "../domain/size.js";
import { atomicWriteJson } from "../storage/writer.js";

const DEFAULT_TAU_MS = 12_000;
const MOCK_TAU_MS = 400;
const EWMA_ALPHA = 0.3;
const MAX_INCOMPLETE_FRACTION = 0.95;

export interface JobProgressSnapshot {
	readonly fraction: number;
	readonly percent: number;
	readonly estimated: boolean;
	readonly elapsedMs: number;
	readonly etaMs?: number;
	readonly step?: number;
	readonly steps?: number;
}

export const PHASE_ORDER: readonly JobPhase[] = deepFreeze([
	"preparing",
	"submitting",
	"generating",
	"postprocess",
	"saving",
]);

function isNumberRecord(v: unknown): v is Record<string, number> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		return false;
	}
	for (const val of Object.values(v)) {
		if (typeof val !== "number" || !Number.isFinite(val)) {
			return false;
		}
	}
	return true;
}

export function formatStatsKey(provider: string, model: string, size: Size): string {
	return `${provider}:${model}:${size.width}x${size.height}`;
}

export class DurationStatsStore {
	private readonly table = new Map<string, number>();
	private readonly statsFilePath: string | undefined;

	public constructor(agentDir?: string) {
		this.statsFilePath = agentDir !== undefined ? path.join(agentDir, "img-pi", "stats.json") : undefined;
	}

	public getTauMs(provider: string, model: string, size: Size): number {
		const key = formatStatsKey(provider, model, size);
		const exact = this.table.get(key);
		if (exact !== undefined && exact > 50) {
			return exact;
		}
		if (provider === "mock" || model.startsWith("mock/")) {
			return MOCK_TAU_MS;
		}
		return DEFAULT_TAU_MS;
	}

	public recordDuration(provider: string, model: string, size: Size, durationMs: number): number {
		const clamped = Math.max(50, Math.round(durationMs));
		const key = formatStatsKey(provider, model, size);
		const prev = this.table.get(key);
		const next = prev === undefined ? clamped : Math.round(prev * (1 - EWMA_ALPHA) + clamped * EWMA_ALPHA);
		this.table.set(key, next);
		return next;
	}

	public async load(): Promise<Result<void, ImgError>> {
		const filePath = this.statsFilePath;
		if (filePath === undefined) {
			return ok(undefined);
		}
		const readRes = await tryAsync(
			() => fs.readFile(filePath, "utf8"),
			() => undefined,
		);
		if (!readRes.ok) {
			return ok(undefined);
		}
		try {
			const parsed: unknown = JSON.parse(readRes.value);
			if (isNumberRecord(parsed)) {
				for (const [k, v] of Object.entries(parsed)) {
					if (v > 0) {
						this.table.set(k, v);
					}
				}
			}
		} catch {
			// Ignore corrupted stats file
		}
		return ok(undefined);
	}

	public async save(): Promise<Result<void, ImgError>> {
		const filePath = this.statsFilePath;
		if (filePath === undefined || this.table.size === 0) {
			return ok(undefined);
		}
		const obj: Record<string, number> = {};
		for (const [k, v] of this.table.entries()) {
			obj[k] = v;
		}
		return atomicWriteJson(filePath, obj);
	}

	public snapshot(): ReadonlyMap<string, number> {
		return new Map(this.table);
	}
}

export function computeJobProgress(
	state: JobState,
	nowMs: number,
	weights: ProgressWeights = DEFAULT_PROGRESS_WEIGHTS,
	tauMs: number = DEFAULT_TAU_MS,
): JobProgressSnapshot {
	const startedAt = state.startedAt ?? state.createdAt;
	const endRef = state.finishedAt ?? nowMs;
	const elapsedMs = Math.max(0, endRef - startedAt);

	if (state.phase === "done") {
		return Object.freeze({
			fraction: 1,
			percent: 100,
			estimated: false,
			elapsedMs,
		});
	}

	if (state.phase === "queued" || state.phase === "cancelled" || state.phase === "failed") {
		return Object.freeze({
			fraction: 0,
			percent: 0,
			estimated: false,
			elapsedMs,
		});
	}

	const totalWeight =
		weights.preparing + weights.submitting + weights.generating + weights.postprocess + weights.saving;
	const norm = totalWeight > 0 ? totalWeight : 1;

	const wPrep = weights.preparing / norm;
	const wSub = weights.submitting / norm;
	const wGen = weights.generating / norm;
	const wPost = weights.postprocess / norm;
	const wSave = weights.saving / norm;

	const phaseElapsed = Math.max(0, nowMs - state.phaseStartedAt);
	const safeTau = Math.max(100, tauMs);

	let rawFraction = 0;
	let estimated = true;

	switch (state.phase) {
		case "preparing": {
			const subFrac = 1 - Math.exp(-phaseElapsed / Math.max(200, safeTau * 0.08));
			rawFraction = wPrep * subFrac;
			break;
		}
		case "submitting": {
			const subFrac = 1 - Math.exp(-phaseElapsed / Math.max(200, safeTau * 0.08));
			rawFraction = wPrep + wSub * subFrac;
			break;
		}
		case "generating": {
			const pp = state.providerProgress;
			if (pp?.fraction !== undefined) {
				rawFraction = wPrep + wSub + wGen * Math.min(1, Math.max(0, pp.fraction));
				estimated = false;
			} else if (pp?.step !== undefined && pp.steps !== undefined && pp.steps > 0) {
				const stepFrac = Math.min(1, Math.max(0, pp.step / pp.steps));
				rawFraction = wPrep + wSub + wGen * stepFrac;
				estimated = false;
			} else {
				const estGen = 1 - Math.exp(-phaseElapsed / safeTau);
				rawFraction = wPrep + wSub + wGen * estGen;
				estimated = true;
			}
			break;
		}
		case "postprocess": {
			const subFrac = 1 - Math.exp(-phaseElapsed / Math.max(250, safeTau * 0.15));
			rawFraction = wPrep + wSub + wGen + wPost * subFrac;
			estimated = state.providerProgress?.fraction === undefined;
			break;
		}
		case "saving": {
			const subFrac = 1 - Math.exp(-phaseElapsed / 250);
			rawFraction = wPrep + wSub + wGen + wPost + wSave * subFrac;
			estimated = state.providerProgress?.fraction === undefined;
			break;
		}
		default: {
			break;
		}
	}

	const fraction = Math.min(MAX_INCOMPLETE_FRACTION, Math.max(0, rawFraction));
	const percent = Math.round(fraction * 100);

	let etaMs: number;
	if (!estimated && fraction > 0.02 && elapsedMs > 100) {
		const totalEst = elapsedMs / fraction;
		etaMs = Math.max(0, Math.round(totalEst - elapsedMs));
	} else {
		etaMs = Math.max(0, Math.round(safeTau - elapsedMs));
	}

	const pp = state.providerProgress;
	return Object.freeze({
		fraction,
		percent,
		estimated,
		elapsedMs,
		etaMs,
		...(pp?.step !== undefined ? { step: pp.step } : {}),
		...(pp?.steps !== undefined ? { steps: pp.steps } : {}),
	});
}

export interface ThrottledEmitter<T> {
	emit(value: T): void;
	flush(value?: T): void;
	dispose(): void;
}

/**
 * Throttles invocations to at most once per `intervalMs` (default 100ms = 10 Hz).
 */
export function createThrottledEmitter<T>(fn: (value: T) => void, intervalMs = 100): ThrottledEmitter<T> {
	let lastSentAt = 0;
	let pendingValue: T | undefined;
	let hasPending = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const clearTimer = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const invokeNow = (val: T): void => {
		lastSentAt = Date.now();
		hasPending = false;
		pendingValue = undefined;
		try {
			fn(val);
		} catch {
			// Never throw out of throttled emitter
		}
	};

	return {
		emit(value: T): void {
			if (disposed) return;
			const now = Date.now();
			const elapsed = now - lastSentAt;
			if (elapsed >= intervalMs && timer === undefined) {
				invokeNow(value);
				return;
			}
			pendingValue = value;
			hasPending = true;
			if (timer === undefined) {
				const waitMs = Math.max(1, intervalMs - elapsed);
				timer = setTimeout(() => {
					timer = undefined;
					if (!disposed && hasPending && pendingValue !== undefined) {
						invokeNow(pendingValue);
					}
				}, waitMs);
			}
		},
		flush(value?: T): void {
			if (disposed) return;
			clearTimer();
			if (value !== undefined) {
				invokeNow(value);
			} else if (hasPending && pendingValue !== undefined) {
				invokeNow(pendingValue);
			}
		},
		dispose(): void {
			disposed = true;
			clearTimer();
			hasPending = false;
			pendingValue = undefined;
		},
	};
}

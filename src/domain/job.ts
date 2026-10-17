import { type ImgError } from "../core/errors";
import { deepFreeze } from "../core/freeze";
import { type Artifact, type UsageSummary } from "./artifact";
import { type GenerationRequest } from "./request";
import { type Size } from "./size";

export type JobPhase =
	| "queued"
	| "preparing"
	| "submitting"
	| "generating"
	| "postprocess"
	| "saving"
	| "done"
	| "failed"
	| "cancelled";

export const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set(["done", "failed", "cancelled"]);

export function isTerminalPhase(phase: JobPhase): boolean {
	return TERMINAL_PHASES.has(phase);
}

export interface ProviderProgressInfo {
	readonly fraction?: number;
	readonly step?: number;
	readonly steps?: number;
	readonly updatedAt: number;
}

export interface PartialPreview {
	readonly index: number;
	readonly thumbB64: string;
	readonly at: number;
}

export type JobEvent =
	| { readonly t: "start"; readonly at: number }
	| { readonly t: "phase"; readonly phase: JobPhase; readonly at: number; readonly detail?: string }
	| {
			readonly t: "provider_progress";
			readonly fraction?: number;
			readonly step?: number;
			readonly steps?: number;
			readonly at: number;
	  }
	| { readonly t: "partial"; readonly index: number; readonly thumbB64: string; readonly at: number }
	| { readonly t: "artifact"; readonly artifact: Artifact; readonly at: number }
	| { readonly t: "warning"; readonly message: string; readonly at: number }
	| { readonly t: "usage"; readonly usage: UsageSummary; readonly at: number }
	| { readonly t: "fail"; readonly error: ImgError; readonly at: number }
	| { readonly t: "cancel"; readonly at: number };

export interface JobState {
	readonly id: string;
	readonly request: GenerationRequest;
	readonly modelId: string;
	readonly providerId: string;
	readonly requestedSize: Size;
	readonly producedSize: Size;
	readonly phase: JobPhase;
	readonly detail?: string;
	readonly queuePosition?: number;
	readonly createdAt: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly phaseStartedAt: number;
	readonly timings: Readonly<Record<JobPhase, number>>;
	readonly providerProgress?: ProviderProgressInfo;
	readonly partials: readonly PartialPreview[];
	readonly artifacts: readonly Artifact[];
	readonly warnings: readonly string[];
	readonly usage?: UsageSummary;
	readonly error?: ImgError;
	/** Phase the job was in when it failed (debug: where it broke). */
	readonly failedPhase?: JobPhase;
}

const ZERO_TIMINGS: Readonly<Record<JobPhase, number>> = deepFreeze({
	queued: 0,
	preparing: 0,
	submitting: 0,
	generating: 0,
	postprocess: 0,
	saving: 0,
	done: 0,
	failed: 0,
	cancelled: 0,
});

export function createInitialJobState(init: {
	readonly id: string;
	readonly request: GenerationRequest;
	readonly modelId: string;
	readonly providerId: string;
	readonly requestedSize: Size;
	readonly producedSize: Size;
	readonly createdAt: number;
	readonly queuePosition?: number;
	readonly warnings?: readonly string[];
}): JobState {
	return Object.freeze({
		id: init.id,
		request: init.request,
		modelId: init.modelId,
		providerId: init.providerId,
		requestedSize: init.requestedSize,
		producedSize: init.producedSize,
		phase: "queued",
		...(init.queuePosition !== undefined ? { queuePosition: init.queuePosition } : {}),
		createdAt: init.createdAt,
		phaseStartedAt: init.createdAt,
		timings: ZERO_TIMINGS,
		partials: Object.freeze([]),
		artifacts: Object.freeze([]),
		warnings: Object.freeze([...(init.warnings ?? [])]),
	});
}

function accumulateTiming(state: JobState, at: number): Readonly<Record<JobPhase, number>> {
	const elapsed = Math.max(0, at - state.phaseStartedAt);
	const current = state.timings[state.phase];
	return Object.freeze({
		...state.timings,
		[state.phase]: current + elapsed,
	});
}

export function reduceJob(state: JobState, ev: JobEvent): JobState {
	if (isTerminalPhase(state.phase)) {
		return state;
	}

	switch (ev.t) {
		case "start": {
			const timings = accumulateTiming(state, ev.at);
			const next: JobState = {
				...state,
				phase: "preparing",
				startedAt: state.startedAt ?? ev.at,
				phaseStartedAt: ev.at,
				timings,
			};
			const { queuePosition: _qp, detail: _d, ...rest } = next;
			return Object.freeze(rest);
		}
		case "phase": {
			const timings = accumulateTiming(state, ev.at);
			const isTerm = isTerminalPhase(ev.phase);
			const { detail: _oldDetail, ...withoutDetail } = state;
			return Object.freeze({
				...withoutDetail,
				phase: ev.phase,
				...(ev.detail !== undefined ? { detail: ev.detail } : {}),
				startedAt: state.startedAt ?? ev.at,
				...(isTerm ? { finishedAt: ev.at } : {}),
				phaseStartedAt: ev.at,
				timings,
			});
		}
		case "provider_progress": {
			const prog: ProviderProgressInfo = Object.freeze({
				...(ev.fraction !== undefined ? { fraction: Math.min(1, Math.max(0, ev.fraction)) } : {}),
				...(ev.step !== undefined ? { step: ev.step } : {}),
				...(ev.steps !== undefined ? { steps: ev.steps } : {}),
				updatedAt: ev.at,
			});
			return Object.freeze({
				...state,
				providerProgress: prog,
			});
		}
		case "partial": {
			const existingIdx = state.partials.findIndex(p => p.index === ev.index);
			const preview: PartialPreview = Object.freeze({
				index: ev.index,
				thumbB64: ev.thumbB64,
				at: ev.at,
			});
			let nextPartials: PartialPreview[];
			if (existingIdx >= 0) {
				nextPartials = Array.from({ length: state.partials.length }, (_, i) =>
					i === existingIdx ? preview : (state.partials[i] ?? preview),
				);
			} else {
				nextPartials = [...state.partials, preview];
			}
			return Object.freeze({
				...state,
				partials: Object.freeze(nextPartials),
			});
		}
		case "artifact": {
			return Object.freeze({
				...state,
				artifacts: Object.freeze([...state.artifacts, ev.artifact]),
			});
		}
		case "warning": {
			if (state.warnings.includes(ev.message)) {
				return state;
			}
			return Object.freeze({
				...state,
				warnings: Object.freeze([...state.warnings, ev.message]),
			});
		}
		case "usage": {
			return Object.freeze({
				...state,
				usage: Object.freeze({ ...ev.usage }),
			});
		}
		case "fail": {
			const timings = accumulateTiming(state, ev.at);
			// A terminal job has no live step; a stale "generating…" would read as still running.
			const { detail: _staleDetail, ...settled } = state;
			if (ev.error.kind === "aborted") {
				return Object.freeze({
					...settled,
					phase: "cancelled",
					finishedAt: ev.at,
					phaseStartedAt: ev.at,
					timings,
				});
			}
			return Object.freeze({
				...settled,
				phase: "failed",
				error: ev.error,
				failedPhase: state.phase,
				finishedAt: ev.at,
				phaseStartedAt: ev.at,
				timings,
			});
		}
		case "cancel": {
			const timings = accumulateTiming(state, ev.at);
			const { detail: _staleDetail, ...settled } = state;
			return Object.freeze({
				...settled,
				phase: "cancelled",
				finishedAt: ev.at,
				phaseStartedAt: ev.at,
				timings,
			});
		}
		default: {
			const _exhaustive: never = ev;
			return _exhaustive;
		}
	}
}

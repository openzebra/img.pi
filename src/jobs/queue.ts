import type { ImgConfig } from "../config/schema.js";
import type { ImgError } from "../core/errors.js";
import { abortedError, internalError, timeoutError } from "../core/errors.js";
import type { Disposer, Listener } from "../core/events.js";
import { TypedEmitter } from "../core/events.js";
import { deepFreeze } from "../core/freeze.js";
import { newJobId } from "../core/ids.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { JobEvent, JobState } from "../domain/job.js";
import { createInitialJobState, isTerminalPhase, reduceJob } from "../domain/job.js";
import type { GenerationRequest } from "../domain/request.js";
import type { Size } from "../domain/size.js";

const DEFAULT_PROVIDER_LIMITS: Readonly<Record<string, number>> = deepFreeze({
	openai: 2,
	google: 2,
	openrouter: 2,
	host: 2,
	fal: 4,
	replicate: 2,
	stability: 2,
	comfyui: 1,
	a1111: 1,
	mock: 8,
});

const MAX_HISTORY_JOBS = 100;

export interface JobExecutionContext {
	readonly jobId: string;
	readonly signal: AbortSignal;
	readonly emit: (ev: JobEvent) => void;
	readonly getState: () => JobState;
}

export type JobRunner = (ctx: JobExecutionContext) => Promise<Result<void, ImgError>>;

export interface EnqueueJobSpec {
	readonly id?: string;
	readonly request: GenerationRequest;
	readonly modelId: string;
	readonly providerId: string;
	readonly requestedSize: Size;
	readonly producedSize: Size;
	readonly warnings?: readonly string[];
	readonly signal?: AbortSignal;
	readonly onStateChange?: (state: JobState, ev: JobEvent) => void;
	readonly run: JobRunner;
}

export interface QueueSnapshot {
	readonly jobs: readonly JobState[];
	readonly runningCount: number;
	readonly queuedCount: number;
	readonly failedCount: number;
	readonly maxConcurrent: number;
	readonly paused: boolean;
	readonly lastFinishedAt?: number;
}

interface InternalJobRecord {
	readonly id: string;
	readonly spec: EnqueueJobSpec;
	state: JobState;
	readonly ac: AbortController;
	readonly resolve: (res: Result<JobState, ImgError>) => void;
	cleanupSignalListener?: () => void;
	timedOut: boolean;
}

export class JobQueue {
	private maxConcurrent: number;
	private readonly providerLimits = new Map<string, number>();
	private readonly runningByProvider = new Map<string, number>();
	private runningTotal = 0;
	private paused = false;
	private lastFinishedAt: number | undefined;

	private readonly jobs = new Map<string, InternalJobRecord>();
	private readonly pendingQueue: InternalJobRecord[] = [];
	private readonly updateEmitter = new TypedEmitter<QueueSnapshot>();
	private readonly jobEventEmitter = new TypedEmitter<{
		readonly job: JobState;
		readonly event: JobEvent;
	}>();

	public constructor(config?: ImgConfig) {
		this.maxConcurrent = config?.queue.maxConcurrent ?? 2;
		for (const [k, v] of Object.entries(DEFAULT_PROVIDER_LIMITS)) {
			this.providerLimits.set(k, v);
		}
		if (config !== undefined) {
			this.applyConfig(config);
		}
	}

	public applyConfig(config: ImgConfig): void {
		this.maxConcurrent = Math.max(1, config.queue.maxConcurrent);
		const providersRec: Readonly<Record<string, { readonly maxConcurrent?: number } | undefined>> = config.providers;
		for (const [provId, entry] of Object.entries(providersRec)) {
			if (entry?.maxConcurrent !== undefined && entry.maxConcurrent >= 1) {
				this.providerLimits.set(provId, entry.maxConcurrent);
			}
		}
		this.pump();
	}

	public setMaxConcurrent(limit: number): void {
		this.maxConcurrent = Math.max(1, Math.min(32, Math.floor(limit)));
		this.emitSnapshot();
		this.pump();
	}

	public getMaxConcurrent(): number {
		return this.maxConcurrent;
	}

	public pause(): void {
		if (!this.paused) {
			this.paused = true;
			this.emitSnapshot();
		}
	}

	public resume(): void {
		if (this.paused) {
			this.paused = false;
			this.emitSnapshot();
			this.pump();
		}
	}

	public togglePause(): boolean {
		if (this.paused) {
			this.resume();
		} else {
			this.pause();
		}
		return this.paused;
	}

	public isPaused(): boolean {
		return this.paused;
	}

	public onUpdate(listener: Listener<QueueSnapshot>): Disposer {
		return this.updateEmitter.on(listener);
	}

	public onJobEvent(listener: Listener<{ readonly job: JobState; readonly event: JobEvent }>): Disposer {
		return this.jobEventEmitter.on(listener);
	}

	public getJob(jobId: string): JobState | undefined {
		return this.jobs.get(jobId)?.state;
	}

	public listJobs(): readonly JobState[] {
		const list: JobState[] = [];
		for (const rec of this.jobs.values()) {
			list.push(rec.state);
		}
		return list;
	}

	public snapshot(): QueueSnapshot {
		const jobs: JobState[] = [];
		let queuedCount = 0;
		let failedCount = 0;
		for (const rec of this.jobs.values()) {
			jobs.push(rec.state);
			if (rec.state.phase === "queued") {
				queuedCount++;
			} else if (rec.state.phase === "failed") {
				failedCount++;
			}
		}
		return Object.freeze({
			jobs: Object.freeze(jobs),
			runningCount: this.runningTotal,
			queuedCount,
			failedCount,
			maxConcurrent: this.maxConcurrent,
			paused: this.paused,
			...(this.lastFinishedAt !== undefined ? { lastFinishedAt: this.lastFinishedAt } : {}),
		});
	}

	public enqueue(spec: EnqueueJobSpec): Promise<Result<JobState, ImgError>> {
		return new Promise<Result<JobState, ImgError>>(resolve => {
			const id = spec.id ?? newJobId();
			const now = Date.now();
			const ac = new AbortController();

			if (spec.signal?.aborted === true) {
				const initial = createInitialJobState({
					id,
					request: spec.request,
					modelId: spec.modelId,
					providerId: spec.providerId,
					requestedSize: spec.requestedSize,
					producedSize: spec.producedSize,
					createdAt: now,
					...(spec.warnings !== undefined ? { warnings: spec.warnings } : {}),
				});
				const cancelledState = reduceJob(initial, { t: "cancel", at: now });
				resolve(err(abortedError()));
				spec.onStateChange?.(cancelledState, { t: "cancel", at: now });
				return;
			}

			const queuePosition = this.pendingQueue.length + 1;
			const initialState = createInitialJobState({
				id,
				request: spec.request,
				modelId: spec.modelId,
				providerId: spec.providerId,
				requestedSize: spec.requestedSize,
				producedSize: spec.producedSize,
				createdAt: now,
				queuePosition,
				...(spec.warnings !== undefined ? { warnings: spec.warnings } : {}),
			});

			const record: InternalJobRecord = {
				id,
				spec,
				state: initialState,
				ac,
				resolve,
				timedOut: false,
			};

			if (spec.signal !== undefined) {
				const extSignal = spec.signal;
				const onExternalAbort = (): void => {
					this.cancel(id);
				};
				extSignal.addEventListener("abort", onExternalAbort, { once: true });
				record.cleanupSignalListener = () => {
					extSignal.removeEventListener("abort", onExternalAbort);
				};
			}

			this.jobs.set(id, record);
			this.pendingQueue.push(record);
			this.trimHistory();
			this.emitSnapshot();
			this.pump();
		});
	}

	public cancel(jobId: string): boolean {
		const record = this.jobs.get(jobId);
		if (record === undefined || isTerminalPhase(record.state.phase)) {
			return false;
		}

		const queueIdx = this.pendingQueue.findIndex(r => r.id === jobId);
		if (queueIdx >= 0) {
			this.pendingQueue.splice(queueIdx, 1);
			this.recomputeQueuePositions();
		}

		record.ac.abort();
		record.cleanupSignalListener?.();
		delete record.cleanupSignalListener;

		const ev: JobEvent = { t: "cancel", at: Date.now() };
		this.applyJobEvent(record, ev);

		if (queueIdx >= 0) {
			record.resolve(err(abortedError()));
		}
		this.emitSnapshot();
		this.pump();
		return true;
	}

	public cancelAll(): void {
		const pending = [...this.pendingQueue];
		this.pendingQueue.length = 0;
		const now = Date.now();

		for (const rec of pending) {
			rec.ac.abort();
			rec.cleanupSignalListener?.();
			delete rec.cleanupSignalListener;
			this.applyJobEvent(rec, { t: "cancel", at: now });
			rec.resolve(err(abortedError()));
		}

		for (const rec of this.jobs.values()) {
			if (!isTerminalPhase(rec.state.phase)) {
				rec.ac.abort();
				rec.cleanupSignalListener?.();
				delete rec.cleanupSignalListener;
				this.applyJobEvent(rec, { t: "cancel", at: now });
			}
		}

		this.emitSnapshot();
	}

	public retry(jobId: string): Promise<Result<JobState, ImgError>> | undefined {
		const existing = this.jobs.get(jobId);
		if (existing === undefined || (existing.state.phase !== "failed" && existing.state.phase !== "cancelled")) {
			return undefined;
		}
		const { id: _oldId, signal: _oldSig, ...restSpec } = existing.spec;
		return this.enqueue(restSpec);
	}

	public dispose(): void {
		this.cancelAll();
		this.updateEmitter.clear();
		this.jobEventEmitter.clear();
	}

	private getProviderLimit(providerId: string): number {
		return this.providerLimits.get(providerId) ?? 2;
	}

	private canStartJob(record: InternalJobRecord): boolean {
		if (this.paused) {
			return false;
		}
		if (this.runningTotal >= this.maxConcurrent) {
			return false;
		}
		const provCount = this.runningByProvider.get(record.spec.providerId) ?? 0;
		const provLimit = this.getProviderLimit(record.spec.providerId);
		return provCount < provLimit;
	}

	private pump(): void {
		if (this.paused || this.pendingQueue.length === 0) {
			return;
		}

		let idx = 0;
		while (idx < this.pendingQueue.length && this.runningTotal < this.maxConcurrent) {
			const candidate = this.pendingQueue[idx];
			if (candidate === undefined) {
				idx++;
				continue;
			}
			if (!this.canStartJob(candidate)) {
				idx++;
				continue;
			}
			this.pendingQueue.splice(idx, 1);
			this.recomputeQueuePositions();
			void this.startRecord(candidate);
		}
	}

	private recomputeQueuePositions(): void {
		for (let i = 0; i < this.pendingQueue.length; i++) {
			const rec = this.pendingQueue[i];
			if (rec !== undefined && rec.state.phase === "queued") {
				rec.state = Object.freeze({
					...rec.state,
					queuePosition: i + 1,
				});
			}
		}
	}

	private async startRecord(record: InternalJobRecord): Promise<void> {
		const provId = record.spec.providerId;
		this.runningTotal++;
		this.runningByProvider.set(provId, (this.runningByProvider.get(provId) ?? 0) + 1);

		const startEv: JobEvent = { t: "start", at: Date.now() };
		this.applyJobEvent(record, startEv);
		this.emitSnapshot();

		const timeoutMs = record.spec.request.timeoutMs;
		const timeoutAc = new AbortController();
		const timeoutHandle = setTimeout(() => {
			record.timedOut = true;
			timeoutAc.abort();
		}, timeoutMs);

		const signals: AbortSignal[] = [record.ac.signal, timeoutAc.signal];
		if (record.spec.signal !== undefined) {
			signals.push(record.spec.signal);
		}
		const combinedSignal = AbortSignal.any(signals);

		const execCtx: JobExecutionContext = {
			jobId: record.id,
			signal: combinedSignal,
			emit: (ev: JobEvent): void => {
				this.applyJobEvent(record, ev);
				this.emitSnapshot();
			},
			getState: (): JobState => record.state,
		};

		try {
			const runRes = await record.spec.run(execCtx);
			const endAt = Date.now();
			if (!isTerminalPhase(record.state.phase)) {
				if (runRes.ok) {
					this.applyJobEvent(record, { t: "phase", phase: "done", at: endAt });
				} else if (record.timedOut) {
					this.applyJobEvent(record, {
						t: "fail",
						error: timeoutError(timeoutMs),
						at: endAt,
					});
				} else if (record.ac.signal.aborted || record.spec.signal?.aborted === true) {
					this.applyJobEvent(record, { t: "cancel", at: endAt });
				} else {
					this.applyJobEvent(record, { t: "fail", error: runRes.error, at: endAt });
				}
			}
		} catch (e: unknown) {
			const endAt = Date.now();
			if (!isTerminalPhase(record.state.phase)) {
				if (record.timedOut) {
					this.applyJobEvent(record, {
						t: "fail",
						error: timeoutError(timeoutMs),
						at: endAt,
					});
				} else if (record.ac.signal.aborted || record.spec.signal?.aborted === true) {
					this.applyJobEvent(record, { t: "cancel", at: endAt });
				} else {
					this.applyJobEvent(record, {
						t: "fail",
						error: internalError(e instanceof Error ? e.message : String(e)),
						at: endAt,
					});
				}
			}
		} finally {
			clearTimeout(timeoutHandle);
			record.cleanupSignalListener?.();
			delete record.cleanupSignalListener;

			this.runningTotal = Math.max(0, this.runningTotal - 1);
			const prevProv = this.runningByProvider.get(provId) ?? 1;
			if (prevProv <= 1) {
				this.runningByProvider.delete(provId);
			} else {
				this.runningByProvider.set(provId, prevProv - 1);
			}
			this.lastFinishedAt = Date.now();
			this.emitSnapshot();

			if (record.state.phase === "done") {
				record.resolve(ok(record.state));
			} else if (record.state.phase === "cancelled") {
				record.resolve(err(abortedError()));
			} else {
				record.resolve(err(record.state.error ?? internalError("Job failed without error details")));
			}

			this.pump();
		}
	}

	private applyJobEvent(record: InternalJobRecord, ev: JobEvent): void {
		const nextState = reduceJob(record.state, ev);
		record.state = nextState;
		try {
			record.spec.onStateChange?.(nextState, ev);
		} catch {
			// Guard callback
		}
		this.jobEventEmitter.emit({ job: nextState, event: ev });
	}

	private trimHistory(): void {
		if (this.jobs.size <= MAX_HISTORY_JOBS) {
			return;
		}
		for (const [id, rec] of this.jobs.entries()) {
			if (this.jobs.size <= MAX_HISTORY_JOBS) {
				break;
			}
			if (isTerminalPhase(rec.state.phase)) {
				this.jobs.delete(id);
			}
		}
	}

	private emitSnapshot(): void {
		this.updateEmitter.emit(this.snapshot());
	}
}

import * as os from "node:os";
import { Worker } from "node:worker_threads";
import type { ImgError, WorkerOp } from "../core/errors.js";
import { abortedError, timeoutError, workerFailed } from "../core/errors.js";
import { newJobId } from "../core/ids.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type {
	ResponseForOp,
	WorkerPayload,
	WorkerRequestMessage,
	WorkerResponseMessage,
	WorkerSuccessPayload,
} from "./protocol.js";
import { collectRequestTransferables } from "./protocol.js";

export interface WorkerRunOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface WorkerPoolOptions {
	readonly size?: number;
	readonly defaultTimeoutMs?: number;
	/** Worker entry; defaults to {@link workerModuleUrl} of this module. */
	readonly workerUrl?: URL;
}

/**
 * Where the worker entry lives relative to the module running the pool:
 * - sources: `src/workers/pool.ts` → `./image.worker.ts` (same directory);
 * - bundle: the pool is inlined into `dist/index.js`, and `package.json#scripts.build`
 *   emits the worker at `dist/workers/image.worker.js`.
 */
export function workerModuleUrl(moduleUrl: string): URL {
	return moduleUrl.endsWith(".ts")
		? new URL("./image.worker.ts", moduleUrl)
		: new URL("./workers/image.worker.js", moduleUrl);
}

interface PendingTask {
	readonly id: string;
	readonly op: WorkerOp;
	readonly payload: WorkerPayload;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	readonly resolve: (res: Result<WorkerSuccessPayload, ImgError>) => void;
}

interface ActiveSlot {
	readonly worker: Worker;
	busy: boolean;
	currentTaskId: string | undefined;
	/** Set once the worker has answered a task; an error before that means it cannot start. */
	responded: boolean;
}

function isWorkerResponseMessage(v: unknown): v is WorkerResponseMessage {
	if (typeof v !== "object" || v === null) return false;
	if (!("id" in v) || typeof v.id !== "string") return false;
	if (!("ok" in v) || typeof v.ok !== "boolean") return false;
	return true;
}

function hasMatchingOp<O extends WorkerOp>(payload: unknown, op: O): payload is ResponseForOp<O> {
	return typeof payload === "object" && payload !== null && "op" in payload && payload.op === op;
}

export class WorkerPool {
	private readonly poolSize: number;
	private readonly defaultTimeoutMs: number;
	private readonly slots: ActiveSlot[] = [];
	private readonly queue: PendingTask[] = [];
	private readonly inFlight = new Map<
		string,
		{
			readonly task: PendingTask;
			readonly timer: ReturnType<typeof setTimeout>;
			readonly onAbort: (() => void) | undefined;
		}
	>();
	private terminated = false;
	private readonly workerUrl: URL;
	/** Set when the worker cannot start (missing entry, native module load failure). Never respawned. */
	private startupFailure: string | undefined;

	public constructor(options: WorkerPoolOptions = {}) {
		const cpuCount = typeof os.availableParallelism === "function" ? os.availableParallelism() : 2;
		const defaultSize = Math.max(1, Math.min(4, cpuCount - 1));
		this.poolSize = options.size ?? defaultSize;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
		this.workerUrl = options.workerUrl ?? workerModuleUrl(import.meta.url);
	}

	public get size(): number {
		return this.poolSize;
	}

	public async run<P extends WorkerPayload>(
		payload: P,
		options: WorkerRunOptions = {},
	): Promise<Result<ResponseForOp<P["op"]>, ImgError>> {
		if (this.terminated) {
			return err(abortedError());
		}
		if (options.signal?.aborted === true) {
			return err(abortedError());
		}
		if (this.startupFailure !== undefined) {
			return err(workerFailed(payload.op, this.startupFailure));
		}

		this.ensureWorkers();

		const rawResult = await new Promise<Result<WorkerSuccessPayload, ImgError>>(resolve => {
			const id = newJobId();
			const task: PendingTask = {
				id,
				op: payload.op,
				payload,
				timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
				...(options.signal !== undefined ? { signal: options.signal } : {}),
				resolve,
			};
			this.queue.push(task);
			this.drainQueue();
		});

		if (!rawResult.ok) {
			return rawResult;
		}
		const actualOp = rawResult.value.op;
		const candidate: unknown = rawResult.value;
		if (!hasMatchingOp<P["op"]>(candidate, payload.op)) {
			return err(workerFailed(payload.op, `Mismatched worker response op: ${actualOp}`));
		}
		return ok(candidate);
	}

	public async terminate(): Promise<void> {
		this.terminated = true;
		while (this.queue.length > 0) {
			const pending = this.queue.shift();
			pending?.resolve(err(abortedError()));
		}
		for (const [id, entry] of this.inFlight.entries()) {
			clearTimeout(entry.timer);
			if (entry.onAbort !== undefined && entry.task.signal !== undefined) {
				entry.task.signal.removeEventListener("abort", entry.onAbort);
			}
			this.inFlight.delete(id);
			entry.task.resolve(err(abortedError()));
		}
		const terminations: Promise<number>[] = [];
		for (const slot of this.slots) {
			terminations.push(slot.worker.terminate());
		}
		this.slots.length = 0;
		await Promise.allSettled(terminations);
	}

	private ensureWorkers(): void {
		if (this.slots.length >= this.poolSize) {
			return;
		}
		while (this.slots.length < this.poolSize) {
			this.slots.push(this.createSlot());
		}
	}

	private createSlot(): ActiveSlot {
		const worker = new Worker(this.workerUrl);
		const slot: ActiveSlot = {
			worker,
			busy: false,
			currentTaskId: undefined,
			responded: false,
		};

		worker.on("message", (raw: unknown) => {
			if (!isWorkerResponseMessage(raw)) {
				return;
			}
			const inflight = this.inFlight.get(raw.id);
			if (inflight === undefined) {
				return;
			}
			this.cleanupInFlight(raw.id);
			slot.busy = false;
			slot.currentTaskId = undefined;
			slot.responded = true;

			if (raw.ok) {
				inflight.task.resolve(ok(raw.result));
			} else {
				inflight.task.resolve(err(workerFailed(raw.op, raw.message)));
			}
			this.drainQueue();
		});

		worker.on("error", (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!slot.responded) {
				this.failStartup(`image worker failed to start (${this.workerUrl.pathname}): ${message}`);
				return;
			}
			const currentId = slot.currentTaskId;
			slot.busy = false;
			slot.currentTaskId = undefined;
			if (currentId !== undefined) {
				const inflight = this.inFlight.get(currentId);
				if (inflight !== undefined) {
					this.cleanupInFlight(currentId);
					inflight.task.resolve(err(workerFailed(inflight.task.op, message)));
				}
			}
			this.replaceSlot(slot);
			this.drainQueue();
		});

		return slot;
	}

	/** Fail everything once, stop all workers, and never respawn: retrying a broken entry would loop forever. */
	private failStartup(message: string): void {
		if (this.startupFailure !== undefined) {
			return;
		}
		this.startupFailure = message;
		for (const id of Array.from(this.inFlight.keys())) {
			const entry = this.inFlight.get(id);
			this.cleanupInFlight(id);
			entry?.task.resolve(err(workerFailed(entry.task.op, message)));
		}
		for (const pending of this.queue.splice(0)) {
			pending.resolve(err(workerFailed(pending.op, message)));
		}
		for (const slot of this.slots.splice(0)) {
			void slot.worker.terminate();
		}
	}

	private replaceSlot(brokenSlot: ActiveSlot): void {
		if (this.terminated) {
			return;
		}
		const idx = this.slots.indexOf(brokenSlot);
		void brokenSlot.worker.terminate();
		if (idx !== -1) {
			this.slots[idx] = this.createSlot();
		}
	}

	private cleanupInFlight(id: string): void {
		const entry = this.inFlight.get(id);
		if (entry === undefined) {
			return;
		}
		clearTimeout(entry.timer);
		if (entry.onAbort !== undefined && entry.task.signal !== undefined) {
			entry.task.signal.removeEventListener("abort", entry.onAbort);
		}
		this.inFlight.delete(id);
	}

	private drainQueue(): void {
		if (this.terminated || this.startupFailure !== undefined) {
			return;
		}
		for (const slot of this.slots) {
			if (slot.busy) {
				continue;
			}
			const nextTask = this.queue.shift();
			if (nextTask === undefined) {
				break;
			}
			if (nextTask.signal?.aborted === true) {
				nextTask.resolve(err(abortedError()));
				continue;
			}
			this.dispatchToSlot(slot, nextTask);
		}
	}

	private dispatchToSlot(slot: ActiveSlot, task: PendingTask): void {
		slot.busy = true;
		slot.currentTaskId = task.id;

		const timer = setTimeout(() => {
			const inflight = this.inFlight.get(task.id);
			if (inflight === undefined) {
				return;
			}
			this.cleanupInFlight(task.id);
			slot.busy = false;
			slot.currentTaskId = undefined;
			this.replaceSlot(slot);
			task.resolve(err(timeoutError(task.timeoutMs)));
			this.drainQueue();
		}, task.timeoutMs);

		let onAbort: (() => void) | undefined;
		if (task.signal !== undefined) {
			onAbort = (): void => {
				const inflight = this.inFlight.get(task.id);
				if (inflight === undefined) {
					return;
				}
				this.cleanupInFlight(task.id);
				slot.busy = false;
				slot.currentTaskId = undefined;
				this.replaceSlot(slot);
				task.resolve(err(abortedError()));
				this.drainQueue();
			};
			task.signal.addEventListener("abort", onAbort, { once: true });
		}

		this.inFlight.set(task.id, {
			task,
			timer,
			onAbort,
		});

		const reqMsg: WorkerRequestMessage = {
			id: task.id,
			payload: task.payload,
		};
		const uniqueTransfers = Array.from(new Set(collectRequestTransferables(task.payload)));
		try {
			slot.worker.postMessage(reqMsg, uniqueTransfers);
		} catch (e: unknown) {
			this.cleanupInFlight(task.id);
			slot.busy = false;
			slot.currentTaskId = undefined;
			const message = e instanceof Error ? e.message : String(e);
			task.resolve(err(workerFailed(task.op, message)));
			this.drainQueue();
		}
	}
}

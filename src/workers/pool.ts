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

	public constructor(options: WorkerPoolOptions = {}) {
		const cpuCount = typeof os.availableParallelism === "function" ? os.availableParallelism() : 2;
		const defaultSize = Math.max(1, Math.min(4, cpuCount - 1));
		this.poolSize = options.size ?? defaultSize;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
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
		const isTs = import.meta.url.endsWith(".ts");
		const workerUrl = new URL(isTs ? "./image.worker.ts" : "./image.worker.js", import.meta.url);
		const worker = new Worker(workerUrl);
		const slot: ActiveSlot = {
			worker,
			busy: false,
			currentTaskId: undefined,
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

			if (raw.ok) {
				inflight.task.resolve(ok(raw.result));
			} else {
				inflight.task.resolve(err(workerFailed(raw.op, raw.message)));
			}
			this.drainQueue();
		});

		worker.on("error", (error: unknown) => {
			const currentId = slot.currentTaskId;
			slot.busy = false;
			slot.currentTaskId = undefined;
			if (currentId !== undefined) {
				const inflight = this.inFlight.get(currentId);
				if (inflight !== undefined) {
					this.cleanupInFlight(currentId);
					const message = error instanceof Error ? error.message : String(error);
					inflight.task.resolve(err(workerFailed(inflight.task.op, message)));
				}
			}
			this.replaceSlot(slot);
			this.drainQueue();
		});

		return slot;
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
		if (this.terminated) {
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

import type { Disposer, Listener } from "../core/events.js";
import { TypedEmitter } from "../core/events.js";
import { SPINNER_FRAMES } from "./glyphs.js";

export class SharedTicker {
	private intervalMs: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private tickCount = 0;
	private activeJobCount = 0;
	private readonly emitter = new TypedEmitter<number>();

	public constructor(intervalMs = 80) {
		this.intervalMs = Math.max(20, intervalMs);
	}

	public setIntervalMs(intervalMs: number): void {
		const next = Math.max(20, intervalMs);
		if (next === this.intervalMs) {
			return;
		}
		this.intervalMs = next;
		if (this.timer !== undefined) {
			this.stopTimer();
			this.startTimerIfNeeded();
		}
	}

	public setActiveJobCount(count: number): void {
		this.activeJobCount = Math.max(0, Math.floor(count));
		if (this.activeJobCount > 0) {
			this.startTimerIfNeeded();
		} else {
			this.stopTimer();
		}
	}

	public get currentTick(): number {
		return this.tickCount;
	}

	public get isRunning(): boolean {
		return this.timer !== undefined;
	}

	public onTick(listener: Listener<number>): Disposer {
		return this.emitter.on(listener);
	}

	public stepManual(): number {
		this.tickCount = (this.tickCount + 1) % (SPINNER_FRAMES.length * 1000);
		try {
			this.emitter.emit(this.tickCount);
		} catch {
			// Guard listeners
		}
		return this.tickCount;
	}

	public stop(): void {
		this.activeJobCount = 0;
		this.stopTimer();
	}

	public dispose(): void {
		this.stop();
		this.emitter.clear();
	}

	private startTimerIfNeeded(): void {
		if (this.timer !== undefined || this.activeJobCount <= 0) {
			return;
		}
		this.timer = setInterval(() => {
			if (this.activeJobCount <= 0) {
				this.stopTimer();
				return;
			}
			this.stepManual();
		}, this.intervalMs);
	}

	private stopTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

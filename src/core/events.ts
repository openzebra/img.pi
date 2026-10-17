export type Listener<T> = (event: T) => void;
export type Disposer = () => void;

export class TypedEmitter<T> {
	readonly #listeners = new Set<Listener<T>>();

	public on(listener: Listener<T>): Disposer {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	public emit(event: T): void {
		const snapshot = [...this.#listeners];
		for (const fn of snapshot) {
			fn(event);
		}
	}

	public get size(): number {
		return this.#listeners.size;
	}

	public clear(): void {
		this.#listeners.clear();
	}
}

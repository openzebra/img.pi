export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => Object.freeze({ ok: true as const, value });
export const err = <E>(error: E): Err<E> => Object.freeze({ ok: false as const, error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
	return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
	return !result.ok;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
	if (!result.ok) {
		return result;
	}
	return ok(fn(result.value));
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
	if (result.ok) {
		return result;
	}
	return err(fn(result.error));
}

export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
	if (!result.ok) {
		return result;
	}
	return fn(result.value);
}

export async function andThenAsync<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
	if (!result.ok) {
		return result;
	}
	return fn(result.value);
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
	return result.ok ? result.value : fallback;
}

export function trySync<T, E>(fn: () => T, mapError: (e: unknown) => E): Result<T, E> {
	try {
		return ok(fn());
	} catch (e: unknown) {
		return err(mapError(e));
	}
}

export async function tryAsync<T, E>(fn: () => Promise<T>, mapError: (e: unknown) => E): Promise<Result<T, E>> {
	try {
		const value = await fn();
		return ok(value);
	} catch (e: unknown) {
		return err(mapError(e));
	}
}

export function collectResults<T, E>(results: readonly Result<T, E>[]): Result<readonly T[], E> {
	const values = new Array<T>(results.length);
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (item === undefined) {
			continue;
		}
		if (!item.ok) {
			return item;
		}
		values[i] = item.value;
	}
	return ok(Object.freeze(values));
}

export function runSafe(fn: () => Promise<void>, onError: (e: unknown) => void): void {
	fn().catch((e: unknown) => {
		try {
			onError(e);
		} catch {
			// Swallow secondary error in error handler
		}
	});
}

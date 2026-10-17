export function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			deepFreeze(item);
		}
		return Object.freeze(value);
	}
	if (value instanceof Map || value instanceof Set) {
		return Object.freeze(value);
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	for (const key of keys) {
		deepFreeze(record[key]);
	}
	return Object.freeze(value);
}

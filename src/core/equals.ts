export interface ValueObject<T> {
	equals(other: T): boolean;
	hashCode(): string;
}

function serializeCanonical(value: unknown, parts: string[]): void {
	if (value === null || value === undefined) {
		parts.push("null");
		return;
	}
	if (typeof value === "boolean") {
		parts.push(value ? "true" : "false");
		return;
	}
	if (typeof value === "number") {
		parts.push(Number.isFinite(value) ? String(value) : "null");
		return;
	}
	if (typeof value === "string") {
		parts.push(JSON.stringify(value));
		return;
	}
	if (Array.isArray(value)) {
		parts.push("[");
		for (let i = 0; i < value.length; i++) {
			if (i > 0) {
				parts.push(",");
			}
			serializeCanonical(value[i], parts);
		}
		parts.push("]");
		return;
	}
	if (value instanceof Set) {
		const sorted = [...value].map(item => canonicalJson(item)).sort();
		parts.push("[");
		for (let i = 0; i < sorted.length; i++) {
			if (i > 0) {
				parts.push(",");
			}
			parts.push(sorted[i] ?? "null");
		}
		parts.push("]");
		return;
	}
	if (value instanceof Map) {
		const entries = [...value.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
		parts.push("{");
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry === undefined) continue;
			if (i > 0) {
				parts.push(",");
			}
			parts.push(JSON.stringify(String(entry[0])));
			parts.push(":");
			serializeCanonical(entry[1], parts);
		}
		parts.push("}");
		return;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter(k => record[k] !== undefined && typeof record[k] !== "function")
			.sort();
		parts.push("{");
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			if (key === undefined) continue;
			if (i > 0) {
				parts.push(",");
			}
			parts.push(JSON.stringify(key));
			parts.push(":");
			serializeCanonical(record[key], parts);
		}
		parts.push("}");
		return;
	}
	parts.push("null");
}

export function canonicalJson(value: unknown): string {
	const parts: string[] = [];
	serializeCanonical(value, parts);
	return parts.join("");
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function hashCanonical(canonical: string): string {
	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < canonical.length; i++) {
		hash ^= BigInt(canonical.charCodeAt(i));
		hash = (hash * FNV_PRIME) & MASK_64;
	}
	return hash.toString(16).padStart(16, "0");
}

export function computeHashCode(value: unknown): string {
	return hashCanonical(canonicalJson(value));
}

export function structuralEquals(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) {
		return true;
	}
	return canonicalJson(a) === canonicalJson(b);
}

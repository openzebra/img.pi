import { ulid } from "ulid";

const MAX_SLUG_LENGTH = 48;
const SHORT_ID_LENGTH = 8;

export function newJobId(nowMs?: number): string {
	return nowMs !== undefined ? ulid(nowMs) : ulid();
}

export function shortJobId(jobId: string): string {
	return jobId.slice(0, SHORT_ID_LENGTH);
}

export function toSlug(text: string, maxLen: number = MAX_SLUG_LENGTH): string {
	const cleaned = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (cleaned.length === 0) {
		return "image";
	}
	if (cleaned.length <= maxLen) {
		return cleaned;
	}
	const sliced = cleaned.slice(0, maxLen).replace(/-+$/g, "");
	return sliced.length > 0 ? sliced : "image";
}

export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;

	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	let curr = new Array<number>(n + 1).fill(0);

	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		const charA = a.charCodeAt(i - 1);
		for (let j = 1; j <= n; j++) {
			const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
			const del = (prev[j] ?? 0) + 1;
			const ins = (curr[j - 1] ?? 0) + 1;
			const sub = (prev[j - 1] ?? 0) + cost;
			curr[j] = Math.min(del, ins, sub);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[n] ?? m;
}

export function fuzzySuggest(query: string, candidates: readonly string[], maxDist = 3, limit = 3): readonly string[] {
	const qLower = query.toLowerCase();
	const scored: { readonly candidate: string; readonly dist: number }[] = [];
	for (const cand of candidates) {
		const cLower = cand.toLowerCase();
		const shortName = cLower.includes("/") ? (cLower.split("/")[1] ?? cLower) : cLower;
		const distFull = levenshtein(qLower, cLower);
		const distShort = levenshtein(qLower, shortName);
		const subMatch = cLower.includes(qLower) || qLower.includes(shortName) ? 1 : 99;
		const bestDist = Math.min(distFull, distShort, subMatch);
		if (bestDist <= maxDist) {
			scored.push({ candidate: cand, dist: bestDist });
		}
	}
	scored.sort((x, y) => x.dist - y.dist || x.candidate.localeCompare(y.candidate));
	const count = Math.min(limit, scored.length);
	return Object.freeze(Array.from({ length: count }, (_, idx) => scored[idx]?.candidate ?? ""));
}

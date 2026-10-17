import { PLAIN_THEME } from "../ui/theme.js";
import type {
	ComponentLike,
	HostKind,
	PortableRenderResultOpts,
	PortableTheme,
	PortableTool,
	PortableToolResult,
	ThemeColorToken,
} from "./port.js";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function wrapHostTheme(rawTheme: unknown): PortableTheme {
	if (!isRecord(rawTheme)) {
		return PLAIN_THEME;
	}
	const fgFn = typeof rawTheme["fg"] === "function" ? rawTheme["fg"] : undefined;
	const boldFn = typeof rawTheme["bold"] === "function" ? rawTheme["bold"] : undefined;

	return {
		fg(color: ThemeColorToken, text: string): string {
			if (fgFn !== undefined) {
				try {
					const out: unknown = fgFn.call(rawTheme, color, text);
					if (typeof out === "string") {
						return out;
					}
				} catch {
					// Fallback
				}
			}
			return PLAIN_THEME.fg(color, text);
		},
		bold(text: string): string {
			if (boldFn !== undefined) {
				try {
					const out: unknown = boldFn.call(rawTheme, text);
					if (typeof out === "string") {
						return out;
					}
				} catch {
					// Fallback
				}
			}
			return PLAIN_THEME.bold(text);
		},
	};
}

function extractRenderOpts(rawOpts: unknown): PortableRenderResultOpts {
	if (!isRecord(rawOpts)) {
		return { expanded: false, isPartial: false };
	}
	return {
		expanded: rawOpts["expanded"] === true,
		isPartial: rawOpts["isPartial"] === true,
	};
}

export interface HostNormalizedRenderers<P, D> {
	readonly renderCall?: (...rawArgs: readonly unknown[]) => ComponentLike;
	readonly renderResult?: (...rawArgs: readonly unknown[]) => ComponentLike;
	readonly _phantom?: { readonly p?: P; readonly d?: D };
}

/**
 * Normalizes the divergent tool renderer signatures between omp and pi:
 * - omp: renderCall(args, options, theme) / renderResult(result, options, theme, args?)
 * - pi:  renderCall(args, theme, context) / renderResult(result, options, theme, context)
 */
export function toHostRenderers<P, D>(kind: HostKind, def: PortableTool<P, D>): HostNormalizedRenderers<P, D> {
	const rc = def.renderCall;
	const rr = def.renderResult;

	return {
		...(rc !== undefined
			? {
					renderCall: (...rawArgs: readonly unknown[]): ComponentLike => {
						const toolArgs = rawArgs[0] as P;
						// omp passes theme as 3rd arg (or 2nd if 2 args); pi passes theme as 2nd arg
						const rawTheme = kind === "omp" ? (rawArgs[2] ?? rawArgs[1]) : rawArgs[1];
						return rc(toolArgs, wrapHostTheme(rawTheme));
					},
				}
			: {}),
		...(rr !== undefined
			? {
					renderResult: (...rawArgs: readonly unknown[]): ComponentLike => {
						const toolResult = rawArgs[0] as PortableToolResult<D>;
						const opts = extractRenderOpts(rawArgs[1]);
						const rawTheme = rawArgs[2];
						let callArgs: P | undefined;
						if (kind === "omp") {
							callArgs = rawArgs[3] as P | undefined;
						} else {
							const ctxObj = rawArgs[3];
							if (isRecord(ctxObj) && "args" in ctxObj) {
								callArgs = ctxObj["args"] as P | undefined;
							}
						}
						return rr(toolResult, opts, wrapHostTheme(rawTheme), callArgs);
					},
				}
			: {}),
	};
}

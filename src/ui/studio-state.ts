import { deepFreeze } from "../core/freeze.js";

export const STUDIO_TABS = Object.freeze(["models", "settings", "gallery"] as const);
export type StudioTab = (typeof STUDIO_TABS)[number];

export const STUDIO_TAB_LABELS: Readonly<Record<StudioTab, string>> = deepFreeze({
	models: "Models",
	settings: "Settings",
	gallery: "Gallery",
});

/** Which config file Studio edits write to. */
export type SaveScope = "project" | "user";

export interface StudioMessage {
	readonly tone: "info" | "error";
	readonly text: string;
}

export interface StudioState {
	readonly tab: StudioTab;
	readonly cursor: Readonly<Record<StudioTab, number>>;
	readonly scope: SaveScope;
	readonly message?: StudioMessage;
}

export type StudioAction =
	| { readonly t: "tab"; readonly delta: 1 | -1 }
	| { readonly t: "move"; readonly delta: 1 | -1 }
	| { readonly t: "activate" }
	| { readonly t: "close" };

export const INITIAL_STUDIO_STATE: StudioState = deepFreeze({
	tab: "models",
	cursor: { models: 0, settings: 0, gallery: 0 },
	scope: "project",
});

/** Host-normalized key names (`parseKey`, identical on omp and pi) → Studio actions. */
const KEY_ACTIONS: Readonly<Record<string, StudioAction>> = deepFreeze({
	tab: { t: "tab", delta: 1 },
	right: { t: "tab", delta: 1 },
	"shift+tab": { t: "tab", delta: -1 },
	left: { t: "tab", delta: -1 },
	down: { t: "move", delta: 1 },
	j: { t: "move", delta: 1 },
	up: { t: "move", delta: -1 },
	k: { t: "move", delta: -1 },
	enter: { t: "activate" },
	space: { t: "activate" },
	escape: { t: "close" },
	q: { t: "close" },
});

export function keyToAction(key: string | undefined): StudioAction | undefined {
	return key !== undefined ? KEY_ACTIONS[key] : undefined;
}

function wrap(i: number, n: number): number {
	return n <= 0 ? 0 : ((i % n) + n) % n;
}

/** Navigation only; `activate` and `close` are effects the controller performs. */
export function reduceStudio(
	state: StudioState,
	action: StudioAction,
	rowCounts: Readonly<Record<StudioTab, number>>,
): StudioState {
	switch (action.t) {
		case "tab": {
			const idx = STUDIO_TABS.indexOf(state.tab);
			const tab = STUDIO_TABS[wrap(idx + action.delta, STUDIO_TABS.length)] ?? state.tab;
			return { tab, cursor: state.cursor, scope: state.scope };
		}
		case "move": {
			const next = wrap(state.cursor[state.tab] + action.delta, rowCounts[state.tab]);
			return { tab: state.tab, cursor: { ...state.cursor, [state.tab]: next }, scope: state.scope };
		}
		case "activate":
		case "close":
			return state;
		default: {
			const _exhaustive: never = action;
			return _exhaustive;
		}
	}
}

export function withScope(state: StudioState, scope: SaveScope): StudioState {
	return { ...state, scope };
}

export function withMessage(state: StudioState, message: StudioMessage | undefined): StudioState {
	const { message: _old, ...rest } = state;
	return message !== undefined ? { ...rest, message } : rest;
}

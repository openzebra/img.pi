import { deepFreeze } from "../core/freeze.js";

export const SPINNER_FRAMES: readonly string[] = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

export const SPINNER_FRAMES_ASCII: readonly string[] = Object.freeze([
	"|",
	"/",
	"-",
	"\\",
	"|",
	"/",
	"-",
	"\\",
	"|",
	"/",
]);

export const CIRCLED_NUMBERS: readonly string[] = Object.freeze([
	"①",
	"②",
	"③",
	"④",
	"⑤",
	"⑥",
	"⑦",
	"⑧",
	"⑨",
	"⑩",
	"⑪",
	"⑫",
	"⑬",
	"⑭",
	"⑮",
	"⑯",
]);

export interface GlyphSet {
	readonly queued: string;
	readonly done: string;
	readonly failed: string;
	readonly cancelled: string;
	readonly barFill: string;
	readonly barEmpty: string;
	readonly phaseDone: string;
	readonly phaseActive: string;
	readonly phasePending: string;
	readonly refIcon: string;
	readonly statusIcon: string;
	readonly bullet: string;
	readonly arrowRight: string;
	readonly pointer: string;
	readonly pointerRight: string;
	readonly lock: string;
	readonly home: string;
	readonly check: string;
	readonly cross: string;
	readonly roundTopLeft: string;
	readonly roundTopRight: string;
	readonly roundBottomLeft: string;
	readonly roundBottomRight: string;
	readonly boxTopLeft: string;
	readonly boxTopRight: string;
	readonly boxBottomLeft: string;
	readonly boxBottomRight: string;
	readonly boxHorizontal: string;
	readonly boxVertical: string;
	readonly boxTeeRight: string;
	readonly boxTeeLeft: string;
	readonly boxTeeDown: string;
	readonly boxTeeUp: string;
	readonly boxCross: string;
}

export const GLYPHS_UNICODE: GlyphSet = deepFreeze({
	queued: "◇",
	done: "✔",
	failed: "✖",
	cancelled: "⊘",
	barFill: "▰",
	barEmpty: "▱",
	phaseDone: "●",
	phaseActive: "●",
	phasePending: "○",
	refIcon: "▣",
	statusIcon: "🖼",
	bullet: "·",
	arrowRight: "→",
	pointer: "▸",
	pointerRight: "◂",
	lock: "🔒",
	home: "⌂",
	check: "✓",
	cross: "✗",
	roundTopLeft: "╭",
	roundTopRight: "╮",
	roundBottomLeft: "╰",
	roundBottomRight: "╯",
	boxTopLeft: "┌",
	boxTopRight: "┐",
	boxBottomLeft: "└",
	boxBottomRight: "┘",
	boxHorizontal: "─",
	boxVertical: "│",
	boxTeeRight: "├",
	boxTeeLeft: "┤",
	boxTeeDown: "┬",
	boxTeeUp: "┴",
	boxCross: "┼",
});

export const GLYPHS_ASCII: GlyphSet = deepFreeze({
	queued: "[..]",
	done: "[ok]",
	failed: "[x]",
	cancelled: "[-]",
	barFill: "#",
	barEmpty: ".",
	phaseDone: "*",
	phaseActive: "@",
	phasePending: "o",
	refIcon: "[ref]",
	statusIcon: "[img]",
	bullet: "|",
	arrowRight: "->",
	pointer: ">",
	pointerRight: "<",
	lock: "[lock]",
	home: "[loc]",
	check: "[v]",
	cross: "[x]",
	roundTopLeft: "+",
	roundTopRight: "+",
	roundBottomLeft: "+",
	roundBottomRight: "+",
	boxTopLeft: "+",
	boxTopRight: "+",
	boxBottomLeft: "+",
	boxBottomRight: "+",
	boxHorizontal: "-",
	boxVertical: "|",
	boxTeeRight: "+",
	boxTeeLeft: "+",
	boxTeeDown: "+",
	boxTeeUp: "+",
	boxCross: "+",
});

export function getGlyphs(noColor = false): GlyphSet {
	return noColor ? GLYPHS_ASCII : GLYPHS_UNICODE;
}

export function getSpinnerFrame(tick: number, noColor = false): string {
	const frames = noColor ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;
	const idx = Math.abs(Math.floor(tick)) % frames.length;
	return frames[idx] ?? frames[0] ?? "*";
}

export function getCircledNumber(indexOneBased: number, noColor = false): string {
	if (noColor || indexOneBased < 1 || indexOneBased > CIRCLED_NUMBERS.length) {
		return `${indexOneBased}.`;
	}
	return CIRCLED_NUMBERS[indexOneBased - 1] ?? `${indexOneBased}.`;
}

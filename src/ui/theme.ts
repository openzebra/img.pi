import { deepFreeze } from "../core/freeze.js";
import type { PortableTheme, ThemeColorToken } from "../host/port.js";
import { getGlyphs } from "./glyphs.js";

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export const PLAIN_THEME: PortableTheme = deepFreeze({
	fg(_color: ThemeColorToken, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
});

export function createTheme(hostTheme?: PortableTheme, noColor = false): PortableTheme {
	if (noColor || hostTheme === undefined) {
		return PLAIN_THEME;
	}
	return hostTheme;
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_REGEX, "");
}

export function visibleWidth(text: string): number {
	const clean = stripAnsi(text);
	let len = 0;
	for (const ch of clean) {
		const cp = ch.codePointAt(0) ?? 0;
		if ((cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xff60)) {
			len = len + 2;
		} else {
			len++;
		}
	}
	return len;
}

export function repeatChar(ch: string, count: number): string {
	const n = Math.max(0, Math.floor(count));
	if (n === 0) return "";
	return ch.repeat(n);
}

export function truncatePlain(text: string, maxChars: number): string {
	const cap = Math.max(1, Math.floor(maxChars));
	if (text.length <= cap) {
		return text;
	}
	if (cap <= 1) {
		return "…";
	}
	return `${text.slice(0, cap - 1)}…`;
}

export function padEndVisible(text: string, targetWidth: number): string {
	const vis = visibleWidth(text);
	if (vis >= targetWidth) {
		return text;
	}
	return `${text}${repeatChar(" ", targetWidth - vis)}`;
}

export function padStartVisible(text: string, targetWidth: number): string {
	const vis = visibleWidth(text);
	if (vis >= targetWidth) {
		return text;
	}
	return `${repeatChar(" ", targetWidth - vis)}${text}`;
}

export function fitVisibleLine(text: string, innerWidth: number): string {
	const vis = visibleWidth(text);
	if (vis <= innerWidth) {
		return padEndVisible(text, innerWidth);
	}
	const plain = stripAnsi(text);
	const truncated = truncatePlain(plain, innerWidth);
	return padEndVisible(truncated, innerWidth);
}

export function formatStopwatch(ms: number): string {
	const safeMs = Math.max(0, ms);
	const totalSec = safeMs / 1000;
	const mins = Math.floor(totalSec / 60);
	const secs = totalSec - mins * 60;
	const mm = String(mins).padStart(2, "0");
	const ssWhole = Math.floor(secs);
	const tenths = Math.floor((secs - ssWhole) * 10);
	const ss = `${String(ssWhole).padStart(2, "0")}.${tenths}`;
	return `${mm}:${ss}`;
}

export function formatCompactSeconds(ms: number): string {
	const safeMs = Math.max(0, ms);
	const secs = safeMs / 1000;
	if (secs < 60) {
		return `${secs.toFixed(1)}s`;
	}
	const mins = Math.floor(secs / 60);
	const rem = Math.round(secs - mins * 60);
	return `${mins}m${rem}s`;
}

export function formatEtaSeconds(ms: number): string {
	const secs = Math.max(1, Math.round(ms / 1000));
	return `${secs}s`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1_048_576) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export interface RoundBoxSpec {
	readonly headerLeft: string;
	readonly headerRight?: string;
	readonly bodyLines: readonly string[];
	readonly footerRight?: string;
	readonly width: number;
	readonly theme: PortableTheme;
	readonly noColor?: boolean;
}

export function renderRoundBox(spec: RoundBoxSpec): string[] {
	const g = getGlyphs(spec.noColor);
	const totalW = Math.max(20, spec.width);
	const innerW = totalW - 4;

	const leftText = ` ${spec.headerLeft} `;
	const rightText = spec.headerRight !== undefined && spec.headerRight.length > 0 ? ` ${spec.headerRight} ` : "";
	const leftVis = visibleWidth(leftText);
	const rightVis = visibleWidth(rightText);
	const dashCount = Math.max(1, totalW - 2 - leftVis - rightVis - 2);
	const topBorder =
		spec.theme.fg("border", `${g.roundTopLeft}${g.boxHorizontal}`) +
		leftText +
		spec.theme.fg("border", repeatChar(g.boxHorizontal, dashCount)) +
		rightText +
		spec.theme.fg("border", `${g.boxHorizontal}${g.roundTopRight}`);

	const footerText = spec.footerRight !== undefined && spec.footerRight.length > 0 ? ` ${spec.footerRight} ` : "";
	const footerVis = visibleWidth(footerText);
	const bottomDashLeft = Math.max(1, totalW - 2 - footerVis - (footerVis > 0 ? 4 : 0));
	const bottomDashRight = footerVis > 0 ? 4 : 0;
	const bottomBorder =
		spec.theme.fg("border", g.roundBottomLeft + repeatChar(g.boxHorizontal, bottomDashLeft)) +
		(footerVis > 0 ? spec.theme.fg("muted", footerText) : "") +
		spec.theme.fg("border", repeatChar(g.boxHorizontal, bottomDashRight) + g.roundBottomRight);

	const rows = new Array<string>(spec.bodyLines.length + 2);
	rows[0] = topBorder;
	const vBar = spec.theme.fg("border", g.boxVertical);
	for (let i = 0; i < spec.bodyLines.length; i++) {
		const line = spec.bodyLines[i] ?? "";
		const fitted = fitVisibleLine(line, innerW);
		rows[i + 1] = `${vBar} ${fitted} ${vBar}`;
	}
	rows[rows.length - 1] = bottomBorder;
	return rows;
}

export interface SquareBoxSpec {
	readonly title: string;
	readonly headerRight?: string;
	readonly subHeader?: string;
	readonly bodyLines: readonly string[];
	readonly footerLines?: readonly string[];
	readonly width: number;
	readonly theme: PortableTheme;
	readonly noColor?: boolean;
}

export function renderSquareBox(spec: SquareBoxSpec): string[] {
	const g = getGlyphs(spec.noColor);
	const totalW = Math.max(24, spec.width);
	const innerW = totalW - 4;
	const vBar = spec.theme.fg("border", g.boxVertical);
	const sepLine = spec.theme.fg("border", `${g.boxTeeRight}${repeatChar(g.boxHorizontal, totalW - 2)}${g.boxTeeLeft}`);

	const titleText = ` ${spec.title} `;
	const rightText = spec.headerRight !== undefined && spec.headerRight.length > 0 ? ` ${spec.headerRight} ` : "";
	const topDash = Math.max(1, totalW - 2 - visibleWidth(titleText) - visibleWidth(rightText) - 1);
	const topLine =
		spec.theme.fg("border", g.boxTopLeft) +
		spec.theme.bold(titleText) +
		spec.theme.fg("border", repeatChar(g.boxHorizontal, topDash)) +
		rightText +
		spec.theme.fg("border", `${g.boxHorizontal}${g.boxTopRight}`);

	const out: string[] = [topLine];

	if (spec.subHeader !== undefined) {
		out.push(`${vBar} ${fitVisibleLine(spec.subHeader, innerW)} ${vBar}`);
		out.push(sepLine);
	}

	for (const line of spec.bodyLines) {
		out.push(`${vBar} ${fitVisibleLine(line, innerW)} ${vBar}`);
	}

	if (spec.footerLines !== undefined && spec.footerLines.length > 0) {
		out.push(sepLine);
		for (const fl of spec.footerLines) {
			out.push(`${vBar} ${fitVisibleLine(fl, innerW)} ${vBar}`);
		}
	}

	const bottomLine = spec.theme.fg(
		"border",
		`${g.boxBottomLeft}${repeatChar(g.boxHorizontal, totalW - 2)}${g.boxBottomRight}`,
	);
	out.push(bottomLine);
	return out;
}

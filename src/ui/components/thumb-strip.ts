import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { fitVisibleLine, repeatChar } from "../theme.js";

export interface ThumbBoxItem {
	readonly lines: readonly string[];
	readonly caption?: string;
	readonly selected?: boolean;
}

export function renderFramedThumbBox(
	item: ThumbBoxItem,
	boxInnerWidth: number,
	boxInnerHeight: number,
	theme: PortableTheme,
	noColor = false,
): string[] {
	const g = getGlyphs(noColor);
	const w = Math.max(8, boxInnerWidth);
	const h = Math.max(1, boxInnerHeight);
	const borderToken = item.selected === true ? "accent" : "border";

	const top = theme.fg(borderToken, `${g.boxTopLeft}${repeatChar(g.boxHorizontal, w)}${g.boxTopRight}`);
	const bot = theme.fg(borderToken, `${g.boxBottomLeft}${repeatChar(g.boxHorizontal, w)}${g.boxBottomRight}`);
	const side = theme.fg(borderToken, g.boxVertical);

	const hasCaption = item.caption !== undefined;
	const rows = new Array<string>(h + 2 + (hasCaption ? 1 : 0));
	rows[0] = top;

	for (let r = 0; r < h; r++) {
		const rawLine = item.lines[r] ?? "";
		let inner = fitVisibleLine(rawLine, w);
		if (item.selected === true && r === Math.floor(h / 2) && w >= 6) {
			const mid = fitVisibleLine(rawLine, w - 2);
			inner = `${theme.fg("accent", g.pointer)}${mid}${theme.fg("accent", g.pointerRight)}`;
		}
		rows[r + 1] = `${side}${inner}${side}`;
	}

	rows[h + 1] = bot;
	if (item.caption !== undefined) {
		rows[h + 2] = ` ${fitVisibleLine(item.caption, w + 1)}`;
	}
	return rows;
}

export function renderThumbStrip(
	items: readonly ThumbBoxItem[],
	totalWidth: number,
	theme: PortableTheme,
	opts: {
		readonly boxWidth?: number;
		readonly boxHeight?: number;
		readonly noColor?: boolean;
	} = {},
): string[] {
	if (items.length === 0) {
		return [];
	}
	const boxInnerW = opts.boxWidth ?? 20;
	const boxInnerH = opts.boxHeight ?? 3;
	const fullBoxW = boxInnerW + 2;
	const maxCols = Math.max(1, Math.floor((totalWidth + 1) / (fullBoxW + 1)));

	const outLines: string[] = [];
	for (let start = 0; start < items.length; start = start + maxCols) {
		const rowSlice = items.slice(start, start + maxCols);
		const renderedBoxes = new Array<string[]>(rowSlice.length);
		let maxHeight = 0;
		for (let c = 0; c < rowSlice.length; c++) {
			const it = rowSlice[c];
			if (it === undefined) continue;
			const box = renderFramedThumbBox(it, boxInnerW, boxInnerH, theme, opts.noColor);
			renderedBoxes[c] = box;
			if (box.length > maxHeight) {
				maxHeight = box.length;
			}
		}

		for (let lineIdx = 0; lineIdx < maxHeight; lineIdx++) {
			const rowParts = new Array<string>(renderedBoxes.length);
			for (let c = 0; c < renderedBoxes.length; c++) {
				const box = renderedBoxes[c];
				rowParts[c] = box?.[lineIdx] ?? repeatChar(" ", fullBoxW);
			}
			outLines.push(rowParts.join(" "));
		}
	}

	return outLines;
}

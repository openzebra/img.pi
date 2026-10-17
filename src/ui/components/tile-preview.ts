import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { fitVisibleLine, padEndVisible, renderSquareBox, repeatChar } from "../theme.js";
import type { TilePreviewVM } from "../view-models.js";

export function renderTilePreview(vm: TilePreviewVM, width: number, theme: PortableTheme): string[] {
	const g = getGlyphs(vm.noColor);
	const scoreQual = vm.seamScore < 6 ? "good < 6" : "visible seam";
	const title = `tile preview ${g.bullet} ${vm.filename} ${g.bullet} seam score ${vm.seamScore.toFixed(1)} (${scoreQual})`;

	const cellW = 12;
	const topGrid = `${g.boxTopLeft}${repeatChar(g.boxHorizontal, cellW)}${g.boxTeeDown}${repeatChar(g.boxHorizontal, cellW)}${g.boxTopRight}`;
	const midGrid = `${g.boxTeeRight}${repeatChar(g.boxHorizontal, cellW)}${g.boxCross}${repeatChar(g.boxHorizontal, cellW)}${g.boxTeeLeft}`;
	const botGrid = `${g.boxBottomLeft}${repeatChar(g.boxHorizontal, cellW)}${g.boxTeeUp}${repeatChar(g.boxHorizontal, cellW)}${g.boxBottomRight}`;

	const sampleLine = fitVisibleLine(vm.tileLines[0] ?? "   [img]    ", cellW);
	const blankCell = repeatChar(" ", cellW);
	const sepV = vm.showGrid ? theme.fg("accent", g.boxVertical) : g.boxVertical;

	const gridRows = [
		topGrid,
		`${g.boxVertical}${blankCell}${sepV}${blankCell}${g.boxVertical}`,
		`${g.boxVertical}${sampleLine}${sepV}${sampleLine}${g.boxVertical}`,
		`${g.boxVertical}${blankCell}${sepV}${blankCell}${g.boxVertical}`,
		midGrid,
		`${g.boxVertical}${blankCell}${sepV}${blankCell}${g.boxVertical}`,
		`${g.boxVertical}${sampleLine}${sepV}${sampleLine}${g.boxVertical}`,
		`${g.boxVertical}${blankCell}${sepV}${blankCell}${g.boxVertical}`,
		botGrid,
	];

	const mapTabs = vm.availableMaps.map(m => (m === vm.activeMap ? theme.bold(`[${m}]`) : m)).join(" ");

	const rightInfo = [
		`maps  ${mapTabs}`,
		"",
		"←/→ switch map",
		`+/- tiles ${vm.tiles}×${vm.tiles} (2×2 … 4×4)`,
		`g toggle seam grid (${vm.showGrid ? "on" : "off"})`,
		"f fix seams (re-run offset_blend)",
		"esc back",
	];

	const bodyLines = new Array<string>(gridRows.length);
	for (let i = 0; i < gridRows.length; i++) {
		const leftCol = padEndVisible(gridRows[i] ?? "", 30);
		const rightCol = rightInfo[i] ?? "";
		bodyLines[i] = `${leftCol}${rightCol}`;
	}

	return renderSquareBox({
		title,
		bodyLines,
		width,
		theme,
		noColor: vm.noColor,
	});
}

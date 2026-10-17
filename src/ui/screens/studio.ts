import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { fitVisibleLine, padEndVisible, renderRoundBox, truncatePlain, visibleWidth } from "../theme.js";
import type { StudioRow, StudioVM } from "../view-models.js";

/** Max column widths for item rows (label, value); they shrink on narrow terminals, the note takes the rest. */
const LABEL_COL = 24;
const VALUE_COL = 34;

const STUDIO_KEYS = "←/→ tab · ↑/↓ move · enter select · esc close";
const STUDIO_KEYS_SHORT = "←→ ↑↓ enter esc";
/** Border, corners and padding around the footer text. */
const FOOTER_CHROME = 10;

function renderRow(row: StudioRow, innerW: number, theme: PortableTheme, noColor: boolean): string {
	const g = getGlyphs(noColor);
	switch (row.kind) {
		case "heading":
			return theme.bold(truncatePlain(row.text, innerW));
		case "text":
			return theme.fg(row.tone === "error" ? "error" : "muted", truncatePlain(row.text, innerW));
		case "item": {
			const pointer = row.selected ? theme.fg("accent", g.pointer) : " ";
			const mark = row.marked ? theme.fg("success", g.check) : " ";
			const labelW = Math.min(LABEL_COL, Math.floor(innerW * 0.35));
			const valueW = Math.min(VALUE_COL, Math.floor(innerW * 0.4));
			const label = padEndVisible(truncatePlain(row.label, labelW - 1), labelW);
			const value = padEndVisible(truncatePlain(row.value, valueW - 1), valueW);
			const noteW = Math.max(0, innerW - labelW - valueW - 3);
			const note = theme.fg("muted", truncatePlain(row.note, noteW));
			const body = `${label}${row.selected ? theme.bold(value) : value}${note}`;
			return fitVisibleLine(`${pointer}${mark} ${body}`, innerW);
		}
		default: {
			const _exhaustive: never = row;
			return String(_exhaustive);
		}
	}
}

export function renderStudio(vm: StudioVM, width: number, theme: PortableTheme): string[] {
	const innerW = Math.max(20, width - 4);
	const tabs = vm.tabs.map(t =>
		t.active ? theme.fg("accent", theme.bold(`[${t.label}]`)) : theme.fg("muted", t.label),
	);
	const bodyLines = vm.rows.map(row => renderRow(row, innerW, theme, vm.noColor));
	if (vm.message !== undefined) {
		bodyLines.push(
			"",
			theme.fg(vm.message.tone === "error" ? "error" : "success", truncatePlain(vm.message.text, innerW)),
		);
	}
	return renderRoundBox({
		headerLeft: theme.bold("img.pi"),
		headerRight: tabs.join("  "),
		bodyLines,
		footerRight: visibleWidth(STUDIO_KEYS) + FOOTER_CHROME <= width ? STUDIO_KEYS : STUDIO_KEYS_SHORT,
		width,
		theme,
		noColor: vm.noColor,
	});
}

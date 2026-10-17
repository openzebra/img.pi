import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { padEndVisible } from "../theme.js";
import type { SettingsVM } from "../view-models.js";

export interface SettingsRenderResult {
	readonly bodyLines: readonly string[];
	readonly footerLines: readonly string[];
}

export function renderSettingsScreen(vm: SettingsVM, _innerWidth: number, theme: PortableTheme): SettingsRenderResult {
	const g = getGlyphs(vm.noColor);
	const leftColWidth = 21;
	const vSep = theme.fg("border", g.boxVertical);

	const rightLines: string[] = [];
	if (vm.providerRows.length > 0) {
		rightLines.push(
			theme.fg(
				"muted",
				`${padEndVisible("PROVIDER", 10)} ${padEndVisible("ENABLED", 8)} ${padEndVisible("KEY SOURCE", 22)} STATUS`,
			),
		);
		for (let i = 0; i < vm.providerRows.length; i++) {
			const pr = vm.providerRows[i];
			if (pr === undefined) continue;
			const isSel = i === vm.activeFieldIndex;
			const en = pr.enabled ? "[x]" : "[ ]";
			const rowStr = `${padEndVisible(pr.id, 10)} ${padEndVisible(en, 8)} ${padEndVisible(pr.keySource, 22)} ${pr.status}`;
			rightLines.push(isSel ? theme.bold(rowStr) : rowStr);
		}
		rightLines.push("⏎ configure   t test connection   k set key env name");
	} else {
		for (let i = 0; i < vm.fields.length; i++) {
			const f = vm.fields[i];
			if (f === undefined) continue;
			const isSel = i === vm.activeFieldIndex;
			const line = `${padEndVisible(f.label, 18)} ‹ ${f.value} ›`;
			rightLines.push(isSel ? theme.bold(line) : line);
		}
		rightLines.push("");
		rightLines.push(theme.fg("muted", vm.originDescription));
		rightLines.push(theme.fg("muted", vm.overridesDescription));
	}

	const totalRows = Math.max(vm.sections.length, rightLines.length);
	const bodyLines = new Array<string>(totalRows);

	for (let r = 0; r < totalRows; r++) {
		const secName = vm.sections[r];
		let leftCell = "";
		if (secName !== undefined) {
			const isSec = r === vm.activeSectionIndex;
			const ptr = isSec ? theme.fg("accent", g.pointer) : " ";
			leftCell = `${ptr} ${secName}`;
		}
		const leftPadded = padEndVisible(leftCell, leftColWidth);
		const rightCell = rightLines[r] ?? "";
		bodyLines[r] = `${leftPadded} ${vSep} ${rightCell}`;
	}

	const footerLines = ["↑↓ section/field  ←→ value  ⏎ edit  u reset to inherited  ctrl+s save  esc"];

	return {
		bodyLines,
		footerLines,
	};
}

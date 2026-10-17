import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { padEndVisible, renderSquareBox } from "../theme.js";
import type { ModelPickerVM } from "../view-models.js";

export function renderModelPickerModal(vm: ModelPickerVM, width: number, theme: PortableTheme): string[] {
	const g = getGlyphs(vm.noColor);
	const headerRight = `/ filter: ${vm.filter || "all"}`;
	const colHeader = theme.fg(
		"muted",
		`  ${padEndVisible("PROVIDER", 10)} ${padEndVisible("MODEL", 22)} ${padEndVisible("CAPS", 23)} ${padEndVisible("KEY", 4)} COST`,
	);

	const bodyLines: string[] = [colHeader];
	if (vm.rows.length === 0) {
		bodyLines.push("  No matching models");
	} else {
		for (let i = 0; i < vm.rows.length; i++) {
			const row = vm.rows[i];
			if (row === undefined) continue;
			const isSel = i === vm.selectedIndex;
			const ptr = isSel ? theme.fg("accent", g.pointer) : " ";
			const prov = padEndVisible(row.provider, 10);
			const mod = padEndVisible(row.shortName, 22);
			const caps = padEndVisible(row.capsSummary, 23);
			const keyCol = padEndVisible(row.keyIcon, 4);
			const line = `${ptr} ${prov} ${mod} ${caps} ${keyCol} ${row.costLabel}`;
			bodyLines.push(isSel ? theme.bold(line) : line);
		}
	}

	const footerLines = ["⏎ select   d set default   / filter   ✗ = missing key (shows env name)"];

	return renderSquareBox({
		title: "choose model",
		headerRight,
		bodyLines,
		footerLines,
		width,
		theme,
		noColor: vm.noColor,
	});
}

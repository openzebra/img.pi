import type { PortableTheme } from "../../host/port.js";
import { renderFramedThumbBox } from "../components/thumb-strip.js";
import { padEndVisible } from "../theme.js";
import type { CompareVM } from "../view-models.js";

export function renderCompareScreen(vm: CompareVM, innerWidth: number, theme: PortableTheme): string[] {
	const halfW = Math.max(16, Math.floor((innerWidth - 6) / 2));
	const boxInnerW = Math.max(12, halfW - 2);

	const headerRow = `${padEndVisible(vm.leftLabel, halfW + 4)}${vm.rightLabel}`;

	const leftBox = renderFramedThumbBox(
		{
			lines: vm.leftLines,
			selected: vm.activeSide === "left",
		},
		boxInnerW,
		Math.max(1, vm.leftLines.length),
		theme,
		vm.noColor,
	);

	const rightBox = renderFramedThumbBox(
		{
			lines: vm.rightLines,
			selected: vm.activeSide === "right",
		},
		boxInnerW,
		Math.max(1, vm.rightLines.length),
		theme,
		vm.noColor,
	);

	const maxRows = Math.max(leftBox.length, rightBox.length);
	const out: string[] = [headerRow];
	for (let r = 0; r < maxRows; r++) {
		const l = padEndVisible(leftBox[r] ?? "", halfW + 4);
		const rt = rightBox[r] ?? "";
		out.push(`${l}${rt}`);
	}

	out.push(vm.deltaLine);
	out.push("←/→ choose winner   k keep winner (tag #pick)   d diff params   esc back");
	return out;
}

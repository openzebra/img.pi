import type { PortableTheme } from "../../host/port.js";
import { getGlyphs, getSpinnerFrame } from "../glyphs.js";
import { fitVisibleLine, padEndVisible, repeatChar } from "../theme.js";
import type { QueueWidgetVM } from "../view-models.js";

export function renderQueueWidget(vm: QueueWidgetVM, width: number, theme: PortableTheme): string[] {
	if (!vm.visible) {
		return [];
	}

	const g = getGlyphs(vm.noColor);
	const headerLine = theme.bold(` img ${g.pointer} ${vm.runningCount} running ${g.bullet} ${vm.queuedCount} queued`);

	const lines = new Array<string>(vm.items.length + 1);
	lines[0] = fitVisibleLine(headerLine, width);

	for (let i = 0; i < vm.items.length; i++) {
		const item = vm.items[i];
		if (item === undefined) {
			lines[i + 1] = "";
			continue;
		}

		if (item.phase === "queued") {
			const icon = theme.fg("muted", g.queued);
			const slugCol = padEndVisible(item.slugLabel, 22);
			const qText = theme.fg("muted", `queued #${item.queuePosition ?? 1}`);
			lines[i + 1] = fitVisibleLine(` ${icon} ${slugCol}  ${qText}`, width);
			continue;
		}

		const spin =
			item.phase === "done"
				? theme.fg("success", g.done)
				: item.phase === "failed"
					? theme.fg("error", g.failed)
					: theme.fg("accent", getSpinnerFrame(item.spinnerIndex, vm.noColor));

		const slugCol = padEndVisible(item.slugLabel, 22);
		const modelCol = theme.fg("muted", padEndVisible(item.shortModel, 14));

		const barCells = 10;
		const filled = Math.round(Math.max(0, Math.min(1, item.fraction)) * barCells);
		const empty = Math.max(0, barCells - filled);
		const bar = theme.fg("accent", repeatChar(g.barFill, filled)) + theme.fg("muted", repeatChar(g.barEmpty, empty));
		const pctStr = `${item.estimated ? "~" : " "}${item.percent}%`.padStart(4, " ");
		const detailPart = item.detail !== undefined ? `  ${theme.fg("muted", item.detail)}` : "";

		lines[i + 1] = fitVisibleLine(
			` ${spin} ${slugCol}  ${modelCol} ${bar} ${pctStr}  ${item.elapsedLabel}${detailPart}`,
			width,
		);
	}

	return lines;
}

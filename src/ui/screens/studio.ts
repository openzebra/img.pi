import type { PortableTheme } from "../../host/port.js";
import { renderPbrGrid } from "../components/pbr-grid.js";
import { renderTilePreview } from "../components/tile-preview.js";
import { getGlyphs, getSpinnerFrame } from "../glyphs.js";
import { padEndVisible, renderSquareBox, repeatChar, visibleWidth } from "../theme.js";
import type { QueueTabVM, StudioTabId, StudioVM } from "../view-models.js";
import { renderCompareScreen } from "./compare.js";
import { renderComposeScreen } from "./compose.js";
import { renderGalleryScreen } from "./gallery.js";
import { renderModelPickerModal } from "./model-picker.js";
import { renderSettingsScreen } from "./settings.js";

function renderTabHeader(
	activeTab: StudioTabId,
	rightStatus: string,
	innerWidth: number,
	theme: PortableTheme,
): string {
	const tabs: readonly { readonly id: StudioTabId; readonly label: string }[] = [
		{ id: 1, label: "1 Compose" },
		{ id: 2, label: "2 Gallery" },
		{ id: 3, label: "3 Queue" },
		{ id: 4, label: "4 Compare" },
		{ id: 5, label: "5 Settings" },
	];

	const tabParts = new Array<string>(tabs.length);
	for (let i = 0; i < tabs.length; i++) {
		const t = tabs[i];
		if (t === undefined) continue;
		tabParts[i] = t.id === activeTab ? theme.bold(`[${t.label}]`) : theme.fg("muted", ` ${t.label} `);
	}

	const left = tabParts.join(" ");
	const gap = Math.max(2, innerWidth - visibleWidth(left) - visibleWidth(rightStatus));
	return `${left}${repeatChar(" ", gap)}${theme.fg("muted", rightStatus)}`;
}

export function renderQueueTabScreen(
	vm: QueueTabVM,
	_innerWidth: number,
	theme: PortableTheme,
): { readonly bodyLines: readonly string[]; readonly footerLines: readonly string[] } {
	const g = getGlyphs(vm.noColor);
	const colHeader = theme.fg(
		"muted",
		` ${padEndVisible("ST", 4)} ${padEndVisible("JOB", 10)} ${padEndVisible("NAME", 20)} ${padEndVisible("MODEL", 16)} ${padEndVisible("PROGRESS", 17)} TIME`,
	);

	const bodyLines: string[] = [colHeader];
	if (vm.rows.length === 0) {
		bodyLines.push("  No jobs in queue");
	} else {
		for (let i = 0; i < vm.rows.length; i++) {
			const row = vm.rows[i];
			if (row === undefined) continue;
			const isSel = i === vm.selectedIndex;

			let stIcon: string;
			if (row.phase === "done") {
				stIcon = theme.fg("success", g.done);
			} else if (row.phase === "failed") {
				stIcon = theme.fg("error", g.failed);
			} else if (row.phase === "cancelled") {
				stIcon = theme.fg("warning", g.cancelled);
			} else if (row.phase === "queued") {
				stIcon = theme.fg("muted", g.queued);
			} else {
				stIcon = theme.fg("accent", getSpinnerFrame(row.spinnerTick, vm.noColor));
			}

			let progCell: string;
			if (
				row.phase === "preparing" ||
				row.phase === "submitting" ||
				row.phase === "generating" ||
				row.phase === "postprocess" ||
				row.phase === "saving"
			) {
				const barCells = 10;
				const filled = Math.round(Math.max(0, Math.min(1, row.fraction)) * barCells);
				const empty = Math.max(0, barCells - filled);
				const bar =
					theme.fg("accent", repeatChar(g.barFill, filled)) + theme.fg("muted", repeatChar(g.barEmpty, empty));
				const pctStr = `${row.estimated ? "~" : " "}${row.percent}%`.padStart(4, " ");
				progCell = `${bar} ${pctStr}`;
			} else {
				progCell = row.progressText;
			}

			const line = ` ${padEndVisible(stIcon, 4)} ${padEndVisible(row.shortId, 10)} ${padEndVisible(row.name, 20)} ${padEndVisible(row.model, 16)} ${padEndVisible(progCell, 17)} ${row.timeText}`;
			bodyLines.push(isSel ? theme.bold(line) : line);
		}
	}

	const footerLines = ["c cancel   r retry   ⏎ details   p pause queue   +/- concurrency"];

	return {
		bodyLines,
		footerLines,
	};
}

export function renderStudioScreen(vm: StudioVM, width: number, theme: PortableTheme): string[] {
	// Modal overrides
	if (vm.modal === "model_picker" && vm.modelPicker !== undefined) {
		return renderModelPickerModal(vm.modelPicker, width, theme);
	}
	if (vm.modal === "tile_preview" && vm.tilePreview !== undefined) {
		return renderTilePreview(vm.tilePreview, width, theme);
	}
	if (vm.modal === "pbr_grid" && vm.pbrGrid !== undefined) {
		return renderPbrGrid(vm.pbrGrid, width, theme);
	}
	if (vm.modal === "help") {
		return renderSquareBox({
			title: "img.pi studio · help",
			headerRight: "esc close",
			bodyLines: [
				"1..5 / Tab   Switch between Compose, Gallery, Queue, Compare, Settings",
				"Compose      ↑/↓ focus · ←/→ cycle · ⏎ edit/generate · m model picker · ctrl+d dry",
				"Gallery      ←↑↓→ navigate · ⏎ open · r re-run · t tile preview · c compare · y copy",
				"Queue        ↑/↓ select · c cancel · r retry · p pause/resume · +/- concurrency",
				"Compare      ←/→ choose winner · k keep (#pick) · d diff params",
				"Settings     ↑/↓ navigate · ←/→ change · u reset · ctrl+s save",
			],
			width,
			theme,
			noColor: vm.noColor,
		});
	}

	const innerW = Math.max(20, width - 4);
	let rightStatus = "? help  esc";
	if (vm.activeTab === 2 && vm.gallery.filter.length > 0) {
		rightStatus = `filter: ${vm.gallery.filter}`;
	} else if (vm.activeTab === 3) {
		const pauseTag = vm.queueTab.paused ? " (paused)" : "";
		rightStatus = `concurrency ${vm.queueTab.runningCount}/${vm.queueTab.maxConcurrent}${pauseTag}`;
	} else if (vm.activeTab === 5) {
		rightStatus = `scope: ‹${vm.settings.scope}›`;
	}

	const subHeader = renderTabHeader(vm.activeTab, rightStatus, innerW, theme);

	switch (vm.activeTab) {
		case 1: {
			const bodyLines = renderComposeScreen(vm.compose, innerW, theme);
			return renderSquareBox({
				title: "img.pi studio",
				subHeader,
				bodyLines,
				width,
				theme,
				noColor: vm.noColor,
			});
		}
		case 2: {
			const gal = renderGalleryScreen(vm.gallery, innerW, theme);
			return renderSquareBox({
				title: "img.pi studio",
				subHeader,
				bodyLines: gal.bodyLines,
				footerLines: gal.footerLines,
				width,
				theme,
				noColor: vm.noColor,
			});
		}
		case 3: {
			const q = renderQueueTabScreen(vm.queueTab, innerW, theme);
			return renderSquareBox({
				title: "img.pi studio",
				subHeader,
				bodyLines: q.bodyLines,
				footerLines: q.footerLines,
				width,
				theme,
				noColor: vm.noColor,
			});
		}
		case 4: {
			const bodyLines = renderCompareScreen(vm.compare, innerW, theme);
			return renderSquareBox({
				title: "compare",
				subHeader,
				bodyLines,
				width,
				theme,
				noColor: vm.noColor,
			});
		}
		case 5: {
			const s = renderSettingsScreen(vm.settings, innerW, theme);
			return renderSquareBox({
				title: "img.pi studio",
				subHeader,
				bodyLines: s.bodyLines,
				footerLines: s.footerLines,
				width,
				theme,
				noColor: vm.noColor,
			});
		}
		default: {
			const _exhaustive: never = vm.activeTab;
			return _exhaustive;
		}
	}
}

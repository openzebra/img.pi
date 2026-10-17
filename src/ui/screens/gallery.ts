import type { PortableTheme } from "../../host/port.js";
import type { ThumbBoxItem } from "../components/thumb-strip.js";
import { renderThumbStrip } from "../components/thumb-strip.js";
import type { GalleryVM } from "../view-models.js";

export interface GalleryBodyRenderResult {
	readonly bodyLines: readonly string[];
	readonly footerLines: readonly string[];
}

export function renderGalleryScreen(vm: GalleryVM, innerWidth: number, theme: PortableTheme): GalleryBodyRenderResult {
	if (vm.cards.length === 0) {
		return {
			bodyLines: ["  No generated artifacts in gallery yet."],
			footerLines: [
				vm.selectedDetailLine,
				"⏎ open  r re-run  v vary seed  e edit→Compose  c compare  t tile  y copy path",
				"del trash  / filter  ←↑↓→ move  pgup/pgdn page",
			],
		};
	}

	const items: ThumbBoxItem[] = vm.cards.map((card, idx) => ({
		lines: card.thumbLines,
		caption: card.label,
		selected: idx === vm.selectedIndex,
	}));

	const bodyLines = renderThumbStrip(items, innerWidth, theme, {
		boxWidth: 10,
		boxHeight: 1,
		noColor: vm.noColor,
	});

	const footerLines = [
		vm.selectedDetailLine,
		"⏎ open  r re-run  v vary seed  e edit→Compose  c compare  t tile  y copy path",
		"del trash  / filter  ←↑↓→ move  pgup/pgdn page",
	];

	return {
		bodyLines,
		footerLines,
	};
}

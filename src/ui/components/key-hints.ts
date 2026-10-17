import type { PortableTheme } from "../../host/port.js";

export interface KeyHintItem {
	readonly key: string;
	readonly label: string;
}

export function renderKeyHints(items: readonly KeyHintItem[], theme: PortableTheme, separator = "   "): string {
	const parts = new Array<string>(items.length);
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item === undefined) {
			parts[i] = "";
			continue;
		}
		parts[i] = `${theme.fg("accent", item.key)} ${theme.fg("muted", item.label)}`;
	}
	return parts.join(separator);
}

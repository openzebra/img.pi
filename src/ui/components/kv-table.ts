import type { PortableTheme } from "../../host/port.js";
import { padEndVisible, truncatePlain } from "../theme.js";

export interface KvRow {
	readonly key: string;
	readonly value: string;
}

export function renderKvTable(rows: readonly KvRow[], width: number, theme: PortableTheme, keyColWidth = 10): string[] {
	const valWidth = Math.max(10, width - keyColWidth);
	const out = new Array<string>(rows.length);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row === undefined) {
			out[i] = "";
			continue;
		}
		const keyCell = theme.fg("muted", padEndVisible(row.key, keyColWidth));
		const valCell = truncatePlain(row.value, valWidth);
		out[i] = `${keyCell}${valCell}`;
	}
	return out;
}

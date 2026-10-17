import type { JobPhase } from "../../domain/job.js";
import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { repeatChar } from "../theme.js";

export interface ProgressBarSpec {
	readonly fraction: number;
	readonly percent: number;
	readonly estimated: boolean;
	readonly barCells?: number;
	readonly detail?: string;
	readonly etaLabel?: string;
	readonly step?: number;
	readonly steps?: number;
	readonly theme: PortableTheme;
	readonly noColor?: boolean;
}

export function renderProgressBar(spec: ProgressBarSpec): string {
	const g = getGlyphs(spec.noColor);
	const cells = Math.max(4, Math.min(40, spec.barCells ?? 24));
	const clampedFrac = Math.max(0, Math.min(1, spec.fraction));
	const filled = Math.round(clampedFrac * cells);
	const empty = Math.max(0, cells - filled);

	const bar =
		spec.theme.fg("accent", repeatChar(g.barFill, filled)) + spec.theme.fg("muted", repeatChar(g.barEmpty, empty));

	const pctPrefix = spec.estimated ? "~" : " ";
	const pctStr = `${pctPrefix}${spec.percent}%`.padStart(4, " ");

	let statusPart = spec.detail ?? "";
	if (spec.step !== undefined && spec.steps !== undefined && spec.steps > 0) {
		statusPart = `step ${spec.step}/${spec.steps}`;
	} else if (spec.etaLabel !== undefined && statusPart.length > 0) {
		statusPart = `${statusPart} ${g.bullet} eta ${spec.estimated ? "~" : ""}${spec.etaLabel}`;
	} else if (spec.etaLabel !== undefined) {
		statusPart = `eta ${spec.estimated ? "~" : ""}${spec.etaLabel}`;
	}

	return statusPart.length > 0 ? `${bar} ${pctStr}  ${statusPart}` : `${bar} ${pctStr}`;
}

export function renderPhaseStepper(currentPhase: JobPhase, theme: PortableTheme, noColor = false): string {
	const g = getGlyphs(noColor);
	const steps: readonly { readonly id: JobPhase; readonly label: string }[] = [
		{ id: "preparing", label: "prep" },
		{ id: "submitting", label: "submit" },
		{ id: "generating", label: "generate" },
		{ id: "postprocess", label: "post" },
		{ id: "saving", label: "save" },
	];

	const activeIdx = steps.findIndex(s => s.id === currentPhase);
	const parts = new Array<string>(steps.length);
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (step === undefined) continue;
		if (i === activeIdx) {
			parts[i] = theme.fg("accent", `${g.phaseActive} ${step.label}`);
		} else if (activeIdx > i || currentPhase === "done") {
			parts[i] = theme.fg("success", `${g.phasePending} ${step.label}`);
		} else {
			parts[i] = theme.fg("muted", `${g.phasePending} ${step.label}`);
		}
	}
	return parts.join("  ");
}

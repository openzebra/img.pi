import type { ImgConfig, PartialConfig } from "../config/schema.js";

export type SettingValue = string | number | boolean;

/** Which config layer a setting's current value comes from. */
export type SettingSource = "project" | "user" | "default";

/** A cycleable setting, type-erased for the Studio after construction. */
export interface SettingField {
	readonly key: string;
	readonly label: string;
	readonly hint: string;
	readonly optionLabels: readonly string[];
	/** The effective value as shown, even when it is not one of the options. */
	valueLabel(cfg: ImgConfig): string;
	indexIn(cfg: ImgConfig): number;
	/** Patch selecting option `i`; `undefined` when out of range. */
	patchAt(i: number): PartialConfig | undefined;
	isSetIn(layer: PartialConfig): boolean;
}

function formatValue(v: SettingValue): string {
	return typeof v === "boolean" ? (v ? "on" : "off") : String(v);
}

function choiceField<T extends SettingValue>(spec: {
	readonly key: string;
	readonly label: string;
	readonly hint: string;
	readonly options: readonly T[];
	readonly read: (cfg: ImgConfig) => T;
	readonly patch: (v: T) => PartialConfig;
	readonly isSetIn: (layer: PartialConfig) => boolean;
}): SettingField {
	return Object.freeze({
		key: spec.key,
		label: spec.label,
		hint: spec.hint,
		optionLabels: Object.freeze(spec.options.map(formatValue)),
		valueLabel: (cfg: ImgConfig): string => formatValue(spec.read(cfg)),
		indexIn: (cfg: ImgConfig): number => spec.options.indexOf(spec.read(cfg)),
		patchAt: (i: number): PartialConfig | undefined => {
			const v = spec.options[i];
			return v === undefined ? undefined : spec.patch(v);
		},
		isSetIn: spec.isSetIn,
	});
}

const ON_OFF: readonly boolean[] = Object.freeze([true, false]);

/** Settings shown in the Studio. Every key maps 1:1 to `img-pi.json`; no hidden behavior. */
export const SETTINGS_FIELDS: readonly SettingField[] = Object.freeze([
	choiceField({
		key: "defaults.format",
		label: "Image format",
		hint: "File format for new images.",
		options: ["png", "jpeg", "webp", "avif"] as const,
		read: c => c.defaults.format,
		patch: v => ({ defaults: { format: v } }),
		isSetIn: l => l.defaults?.format !== undefined,
	}),
	choiceField({
		key: "defaults.returnImage",
		label: "Image back to agent",
		hint: "What the agent receives: a thumbnail (cheap), the full image, or only the path.",
		options: ["thumbnail", "full", "none"] as const,
		read: c => c.defaults.returnImage,
		patch: v => ({ defaults: { returnImage: v } }),
		isSetIn: l => l.defaults?.returnImage !== undefined,
	}),
	choiceField({
		key: "output.onConflict",
		label: "If file exists",
		hint: "suffix adds _2, _3…; overwrite replaces; error stops the job.",
		options: ["suffix", "overwrite", "error"] as const,
		read: c => c.output.onConflict,
		patch: v => ({ output: { onConflict: v } }),
		isSetIn: l => l.output?.onConflict !== undefined,
	}),
	choiceField({
		key: "output.allowOutsideCwd",
		label: "Save outside project",
		hint: "Allow output_dir outside the project (e.g. /tmp). Off keeps everything in .pi/img.",
		options: [false, true],
		read: c => c.output.allowOutsideCwd,
		patch: v => ({ output: { allowOutsideCwd: v } }),
		isSetIn: l => l.output?.allowOutsideCwd !== undefined,
	}),
	choiceField({
		key: "output.sidecar",
		label: "Sidecar .json",
		hint: "Write a reproducible .json next to each image.",
		options: ON_OFF,
		read: c => c.output.sidecar,
		patch: v => ({ output: { sidecar: v } }),
		isSetIn: l => l.output?.sidecar !== undefined,
	}),
	choiceField({
		key: "ui.inlinePreview",
		label: "Inline preview",
		hint: "Show the generated image inside the tool card.",
		options: ON_OFF,
		read: c => c.ui.inlinePreview,
		patch: v => ({ ui: { inlinePreview: v } }),
		isSetIn: l => l.ui?.inlinePreview !== undefined,
	}),
	choiceField({
		key: "ui.statusSegment",
		label: "Status bar",
		hint: "Show the active image model and job state in the status line.",
		options: ON_OFF,
		read: c => c.ui.statusSegment,
		patch: v => ({ ui: { statusSegment: v } }),
		isSetIn: l => l.ui?.statusSegment !== undefined,
	}),
	choiceField({
		key: "ui.queueWidget",
		label: "Queue widget",
		hint: "Show running and queued jobs above the editor.",
		options: ON_OFF,
		read: c => c.ui.queueWidget,
		patch: v => ({ ui: { queueWidget: v } }),
		isSetIn: l => l.ui?.queueWidget !== undefined,
	}),
	choiceField({
		key: "compat.hideBuiltin",
		label: "Hide omp generate_image",
		hint: "Hide omp's built-in image tool so the agent uses img_generate. Applies to new sessions.",
		options: ON_OFF,
		read: c => c.compat.hideBuiltin,
		patch: v => ({ compat: { hideBuiltin: v } }),
		isSetIn: l => l.compat?.hideBuiltin !== undefined,
	}),
	choiceField({
		key: "queue.maxConcurrent",
		label: "Parallel jobs",
		hint: "How many generations run at the same time.",
		options: [1, 2, 3, 4, 6, 8],
		read: c => c.queue.maxConcurrent,
		patch: v => ({ queue: { maxConcurrent: v } }),
		isSetIn: l => l.queue?.maxConcurrent !== undefined,
	}),
]);

export function settingSource(
	field: SettingField,
	layers: { readonly user?: PartialConfig; readonly project?: PartialConfig },
): SettingSource {
	if (layers.project !== undefined && field.isSetIn(layers.project)) {
		return "project";
	}
	if (layers.user !== undefined && field.isSetIn(layers.user)) {
		return "user";
	}
	return "default";
}

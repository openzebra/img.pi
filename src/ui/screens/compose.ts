import type { TextureMapKind } from "../../domain/texture.js";
import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { fitVisibleLine, repeatChar, visibleWidth } from "../theme.js";
import type { ComposeVM } from "../view-models.js";

const ALL_MAPS_ORDER: readonly TextureMapKind[] = ["albedo", "normal", "roughness", "ao", "height", "metallic"];

export function renderComposeScreen(vm: ComposeVM, innerWidth: number, theme: PortableTheme): string[] {
	const g = getGlyphs(vm.noColor);
	const boxW = Math.max(16, innerWidth - 2);

	const focusMark = (idx: number, label: string): string =>
		vm.focusedFieldIndex === idx ? theme.fg("accent", `${g.pointer} ${label}`) : `  ${label}`;

	const promptBoxTop = `${g.boxTopLeft}${repeatChar(g.boxHorizontal, boxW)}${g.boxTopRight}`;
	const promptBoxMid = `${g.boxVertical} ${fitVisibleLine(`${vm.prompt}▌`, Math.max(8, boxW - 2))} ${g.boxVertical}`;
	const promptBoxBot = `${g.boxBottomLeft}${repeatChar(g.boxHorizontal, boxW)}${g.boxBottomRight}`;

	const keyStatus = vm.hasKey
		? `${theme.fg("success", g.check)} ${vm.keyEnvHint}`
		: `${theme.fg("error", g.cross)} ${vm.keyEnvHint}`;

	const modeRadio = (m: "image" | "texture" | "edit"): string => (vm.mode === m ? `(•) ${m}` : `( ) ${m}`);

	const mapCheckboxes = ALL_MAPS_ORDER.map(m => (vm.maps.includes(m) ? `[x] ${m}` : `[ ] ${m}`)).join(" ");

	const normConv = vm.normalConvention === "opengl" ? "(•) OpenGL ( ) DirectX" : "( ) OpenGL (•) DirectX";

	const refLine =
		vm.refs.length > 0 ? vm.refs.map(r => `${g.refIcon} ${r.source}  ${r.role} ${r.weight}`).join("   ") : "none";

	const seedLock = vm.seedLocked ? `  ${g.lock}` : "";

	const estLeft = `  est. cost ≈ $${vm.estCostUsd.toFixed(2)} ${g.bullet} est. time ~${vm.estTimeSec}s`;
	const actionRight = "⏎ generate   ctrl+d dry";
	const gap = Math.max(2, innerWidth - visibleWidth(estLeft) - visibleWidth(actionRight));
	const footerLine = `${theme.fg("muted", estLeft)}${repeatChar(" ", gap)}${theme.fg("accent", actionRight)}`;

	return [
		focusMark(0, "Prompt"),
		promptBoxTop,
		promptBoxMid,
		promptBoxBot,
		`${focusMark(1, "Negative")}   ${vm.negativePrompt || "none"}`,
		"",
		`${focusMark(2, "Model")}     ‹ ${vm.model} ›     m pick     key ${keyStatus}`,
		`${focusMark(3, "Mode")}      ${modeRadio("image")}   ${modeRadio("texture")}   ${modeRadio("edit")}`,
		`${focusMark(4, "Size")}      ‹ ${vm.width} × ${vm.height} ›  aspect ${vm.aspectRatio}   res ${vm.resolution}   size_mode ${vm.sizeMode}`,
		`${focusMark(5, "Count")}     ‹ ${vm.count} ›        Seed  ‹ ${vm.seed} ›${seedLock}        Steps ‹ ${vm.steps} ›  CFG ‹ ${vm.guidance} ›`,
		`${focusMark(6, "Style")}     ‹ ${vm.style || "none"} ›`,
		`${focusMark(7, "Maps")}      ${mapCheckboxes}`,
		`${focusMark(8, "Normal")}    ${normConv}     strength ‹ ${vm.normalStrength.toFixed(1)} ›    tileable [${vm.tileable ? "x" : " "}]`,
		`${focusMark(9, "Refs")}      ${refLine}  a add`,
		`${focusMark(10, "Output")}    ${vm.outputTemplate}             o change`,
		"",
		footerLine,
	];
}

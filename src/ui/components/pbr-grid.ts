import type { PortableTheme } from "../../host/port.js";
import { getGlyphs } from "../glyphs.js";
import { padEndVisible, renderSquareBox, repeatChar } from "../theme.js";
import type { PbrGridVM } from "../view-models.js";

export function renderPbrGrid(vm: PbrGridVM, width: number, theme: PortableTheme): string[] {
	const g = getGlyphs(vm.noColor);
	const convLabel = vm.normalConvention === "opengl" ? "OpenGL" : "DirectX";
	const title = `material ${g.bullet} ${vm.materialName} ${g.bullet} ${vm.resolution}² ${g.bullet} ${convLabel}`;

	const cellW = 8;
	const topParts = new Array<string>(vm.maps.length);
	const midParts = new Array<string>(vm.maps.length);
	const botParts = new Array<string>(vm.maps.length);

	for (let i = 0; i < vm.maps.length; i++) {
		const m = vm.maps[i] ?? "albedo";
		const shortM = m === "roughness" ? "rough" : m;
		const padded = padEndVisible(` ${shortM}`, cellW);
		topParts[i] = `${g.boxTopLeft}${repeatChar(g.boxHorizontal, cellW)}${g.boxTopRight}`;
		midParts[i] = `${g.boxVertical}${padded}${g.boxVertical}`;
		botParts[i] = `${g.boxBottomLeft}${repeatChar(g.boxHorizontal, cellW)}${g.boxBottomRight}`;
	}

	const blenderHint = vm.hasBlender ? ` ${g.bullet} b open in Blender` : "";
	const bodyLines = [
		topParts.join(" "),
		midParts.join(" "),
		botParts.join(" "),
		`material.json (glTF pbrMetallicRoughness) ${g.bullet} y copy dir${blenderHint}`,
	];

	return renderSquareBox({
		title,
		bodyLines,
		width,
		theme,
		noColor: vm.noColor,
	});
}

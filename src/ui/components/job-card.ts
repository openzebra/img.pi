import type { PortableTheme } from "../../host/port.js";
import { getCircledNumber, getGlyphs, getSpinnerFrame } from "../glyphs.js";
import { fitVisibleLine, padEndVisible, renderRoundBox, truncatePlain, visibleWidth } from "../theme.js";
import type { CallVM, JobCardVM, NoteVM } from "../view-models.js";
import { renderKvTable } from "./kv-table.js";
import { renderPhaseStepper, renderProgressBar } from "./progress-bar.js";
import { renderFramedThumbBox, renderThumbStrip } from "./thumb-strip.js";

export function renderCallCard(vm: CallVM, width: number, theme: PortableTheme): string[] {
	const g = getGlyphs(vm.noColor);
	const paramsLine = vm.params.join(` ${g.bullet} `);
	if (width < 60) {
		const lines = [
			fitVisibleLine(`${g.queued} ${vm.toolName}`, width),
			fitVisibleLine(truncatePlain(`"${vm.prompt}"`, Math.max(10, width)), width),
		];
		return paramsLine.length > 0 ? [...lines, fitVisibleLine(paramsLine, width)] : lines;
	}
	const innerW = Math.max(20, width - 4);
	const bodyLines = [`"${truncatePlain(vm.prompt, Math.max(10, innerW - 2))}"`];
	if (paramsLine.length > 0) {
		bodyLines.push(theme.fg("muted", paramsLine));
	}
	return renderRoundBox({
		headerLeft: `${theme.fg("muted", g.queued)} ${theme.bold(vm.toolName)}`,
		bodyLines,
		width,
		theme,
		noColor: vm.noColor,
	});
}

const NOTE_TONE_COLOR = Object.freeze({ done: "success", failed: "error", cancelled: "muted" } as const);

export function renderNoteCard(vm: NoteVM, width: number, theme: PortableTheme): string[] {
	const g = getGlyphs(vm.noColor);
	const color = NOTE_TONE_COLOR[vm.tone];
	const innerW = Math.max(20, width - 4);
	const bodyLines = vm.lines.map(line => {
		const clipped = truncatePlain(line, innerW);
		return vm.tone === "failed" ? theme.fg("error", clipped) : clipped;
	});
	return renderRoundBox({
		headerLeft: `${theme.fg(color, g[vm.tone])} ${theme.bold(vm.toolName)}`,
		bodyLines,
		width,
		theme,
		noColor: vm.noColor,
	});
}

export function renderJobCard(vm: JobCardVM, width: number, theme: PortableTheme): string[] {
	const g = getGlyphs(vm.noColor);

	// Narrow width (< 60) collapses to 2 lines (§7.6)
	if (width < 60) {
		const spinOrIcon =
			vm.phase === "done"
				? g.done
				: vm.phase === "failed"
					? g.failed
					: vm.phase === "cancelled"
						? g.cancelled
						: vm.phase === "queued"
							? g.queued
							: getSpinnerFrame(vm.spinnerTick, vm.noColor);

		const topStatus =
			vm.phase === "done"
				? `${spinOrIcon} ${vm.shortModel} 100% ${vm.durationSec}`
				: vm.phase === "failed"
					? `${spinOrIcon} ${vm.shortModel} failed ${vm.durationSec}`
					: vm.phase === "cancelled"
						? `${spinOrIcon} ${vm.shortModel} cancelled`
						: `${spinOrIcon} ${vm.shortModel} ${vm.estimated ? "~" : ""}${vm.percent}% ${vm.durationSec}`;

		const secondLine =
			vm.artifacts[0]?.relativePath ?? vm.errorSummary ?? truncatePlain(`"${vm.prompt}"`, Math.max(10, width));

		return [fitVisibleLine(topStatus, width), fitVisibleLine(secondLine, width)];
	}

	const innerW = Math.max(20, width - 4);
	const quotedPrompt = `"${truncatePlain(vm.prompt, Math.max(12, innerW - 2))}"`;

	// 1. Queued state
	if (vm.phase === "queued") {
		const headerLeft = `${theme.fg("muted", g.queued)} ${theme.bold(vm.toolName)}`;
		const headerRight = theme.fg("muted", `queued #${vm.queuePosition ?? 1}`);
		const metaLine = `${vm.modelId} ${g.bullet} ${vm.requestedSizeLabel} ${g.bullet} ×${vm.count} ${g.bullet} ${vm.format} ${g.arrowRight} ${vm.outputDir}`;
		return renderRoundBox({
			headerLeft,
			headerRight,
			bodyLines: [quotedPrompt, theme.fg("muted", metaLine)],
			footerRight: "esc cancel",
			width,
			theme,
			noColor: vm.noColor,
		});
	}

	// 2. Done state (collapsed or expanded)
	if (vm.phase === "done") {
		const headerLeft = `${theme.fg("success", g.done)} ${theme.bold(vm.toolName)}`;
		const headerRight = `${vm.durationSec} ${g.bullet} ${vm.artifacts.length || vm.count}`;

		if (vm.expanded) {
			const refsSummary =
				vm.refs.length > 0 ? vm.refs.map(r => `${r.source}  ${r.role}  ${r.weight}`).join(", ") : "none";
			const kvRows = [
				{ key: "prompt", value: vm.prompt },
				{ key: "style", value: vm.styleLabel ?? "none" },
				{ key: "model", value: `${vm.modelId} (${vm.providerId})` },
				{
					key: "size",
					value: `${vm.requestedSizeLabel} requested ${g.bullet} ${vm.producedSizeLabel} produced ${g.bullet} ${vm.sizeNote ?? "exact"}`,
				},
				{
					key: "seed",
					value: `${vm.seed}          quality ${vm.quality}      background ${vm.background}`,
				},
				{ key: "refs", value: refsSummary },
				{ key: "timings", value: vm.timingsLine },
				{ key: "usage", value: vm.usageLine },
				{ key: "sidecar", value: vm.sidecarLine },
				{
					key: "warnings",
					value: vm.warnings.length > 0 ? vm.warnings.join("; ") : "none",
				},
			];
			const bodyLines = renderKvTable(kvRows, innerW, theme, 10);
			return renderRoundBox({
				headerLeft,
				headerRight,
				bodyLines,
				width,
				theme,
				noColor: vm.noColor,
			});
		}

		// Collapsed done state
		const bodyLines: string[] = [];
		if (vm.artifacts.length > 0) {
			const stripItems = vm.artifacts.map(a => ({
				lines: a.previewLines,
			}));
			const stripLines = renderThumbStrip(stripItems, innerW, theme, {
				boxWidth: 20,
				boxHeight: Math.min(3, Math.max(1, vm.artifacts[0]?.previewLines.length ?? 1)),
				noColor: vm.noColor,
			});
			for (const sl of stripLines) {
				bodyLines.push(sl);
			}
			for (const art of vm.artifacts) {
				const numGlyph = getCircledNumber(art.index, vm.noColor);
				const seamExtra = art.seamScore !== undefined ? `  seam ${art.seamScore.toFixed(1)}` : "";
				bodyLines.push(
					`${theme.fg("accent", numGlyph)} ${art.relativePath}  ${theme.fg("muted", art.sizeLabel + seamExtra)}`,
				);
			}
		}

		const leftMeta = `${vm.shortModel} ${g.bullet} ${vm.producedSizeLabel} ${g.bullet} seed ${vm.seed}`;
		const rightHint = theme.fg("muted", "ctrl+o expand");
		const gap = Math.max(2, innerW - visibleWidth(leftMeta) - visibleWidth(rightHint));
		bodyLines.push(`${theme.fg("muted", leftMeta)}${" ".repeat(gap)}${rightHint}`);

		return renderRoundBox({
			headerLeft,
			headerRight,
			bodyLines,
			width,
			theme,
			noColor: vm.noColor,
		});
	}

	// 3. Failed state
	if (vm.phase === "failed") {
		const headerLeft = `${theme.fg("error", g.failed)} ${theme.bold(vm.toolName)}`;
		const headerRight = vm.stopwatch;
		const bodyLines = [theme.fg("error", vm.errorSummary ?? "Generation failed")];
		if (vm.errorSuggestion !== undefined) {
			bodyLines.push(vm.errorSuggestion);
		}
		if (vm.failedSavePath !== undefined) {
			bodyLines.push(theme.fg("muted", `request saved: ${vm.failedSavePath}`));
		}

		return renderRoundBox({
			headerLeft,
			headerRight,
			bodyLines,
			width,
			theme,
			noColor: vm.noColor,
		});
	}

	// 4. Cancelled state
	if (vm.phase === "cancelled") {
		const headerLeft = `${theme.fg("warning", g.cancelled)} ${theme.bold(vm.toolName)}`;
		const headerRight = vm.stopwatch;
		return renderRoundBox({
			headerLeft,
			headerRight,
			bodyLines: [quotedPrompt, theme.fg("muted", `cancelled · ${vm.modelId}`)],
			width,
			theme,
			noColor: vm.noColor,
		});
	}

	// 5. Active states: preparing, submitting, generating, postprocess, saving
	const spin = getSpinnerFrame(vm.spinnerTick, vm.noColor);
	const headerLeft = `${theme.fg("accent", spin)} ${theme.bold(vm.toolName)}`;
	const headerRight = vm.stopwatch;
	const bodyLines: string[] = [];

	if (vm.phase === "preparing" || vm.phase === "submitting") {
		bodyLines.push(quotedPrompt);
		if (vm.refs.length > 0) {
			const refBadges = vm.refs
				.map(r => `${g.refIcon} ${r.source} (${r.role}${r.weight !== 1 ? `·${r.weight}` : ""})`)
				.join("  ");
			bodyLines.push(`refs  ${refBadges}`);
		}
		const barLine = renderProgressBar({
			fraction: vm.fraction,
			percent: vm.percent,
			estimated: false,
			barCells: 24,
			detail: vm.detail ?? (vm.phase === "preparing" ? "preparing references…" : "submitting…"),
			theme,
			noColor: vm.noColor,
		});
		bodyLines.push(barLine);
	} else if (vm.phase === "generating" && vm.livePreviewLines.length > 0) {
		const stepInfo =
			vm.step !== undefined && vm.steps !== undefined ? ` ${g.bullet} steps ${vm.step}/${vm.steps}` : "";
		bodyLines.push(`${vm.modelId} ${g.bullet} ${vm.requestedSizeLabel}${stepInfo}`);

		const previewBox = renderFramedThumbBox(
			{ lines: vm.livePreviewLines },
			14,
			Math.min(4, vm.livePreviewLines.length),
			theme,
			vm.noColor,
		);
		const barLine = renderProgressBar({
			fraction: vm.fraction,
			percent: vm.percent,
			estimated: vm.estimated,
			barCells: 24,
			...(vm.step !== undefined ? { step: vm.step } : {}),
			...(vm.steps !== undefined ? { steps: vm.steps } : {}),
			...(vm.detail !== undefined ? { detail: vm.detail } : {}),
			theme,
			noColor: vm.noColor,
		});
		const subStat =
			vm.iterPerSec !== undefined && vm.etaLabel !== undefined
				? `${vm.iterPerSec} ${g.bullet} eta ${vm.etaLabel}`
				: vm.etaLabel !== undefined
					? `eta ${vm.etaLabel}`
					: "live preview";

		for (let i = 0; i < previewBox.length; i++) {
			const leftPart = padEndVisible(previewBox[i] ?? "", 18);
			const rightPart = i === 1 ? barLine : i === 2 ? theme.fg("muted", subStat) : "";
			bodyLines.push(`${leftPart}${rightPart}`);
		}
	} else {
		bodyLines.push(quotedPrompt);
		bodyLines.push(theme.fg("muted", `${vm.modelId} ${g.bullet} quality ${vm.quality} ${g.bullet} seed ${vm.seed}`));
		const barLine = renderProgressBar({
			fraction: vm.fraction,
			percent: vm.percent,
			estimated: vm.estimated,
			barCells: 24,
			detail: vm.detail ?? vm.phase,
			...(vm.etaLabel !== undefined ? { etaLabel: vm.etaLabel } : {}),
			...(vm.step !== undefined ? { step: vm.step } : {}),
			...(vm.steps !== undefined ? { steps: vm.steps } : {}),
			theme,
			noColor: vm.noColor,
		});
		bodyLines.push(barLine);
		bodyLines.push(renderPhaseStepper(vm.phase, theme, vm.noColor));
	}

	return renderRoundBox({
		headerLeft,
		headerRight,
		bodyLines,
		footerRight: "esc cancel",
		width,
		theme,
		noColor: vm.noColor,
	});
}

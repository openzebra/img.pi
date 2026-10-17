import type { ImgConfig, StylePreset } from "../config/schema.js";
import { DEFAULT_PRESETS } from "../config/schema.js";
import { deepFreeze } from "../core/freeze.js";

export const TEXTURE_PROMPT_AUGMENTATION =
	"seamless tileable texture, top-down orthographic, flat even lighting, no shadows, no perspective, no vignette, fills entire frame";

export const TEXTURE_NEGATIVE_AUGMENTATION =
	"perspective, shadows, specular highlights, vignette, depth of field, border, text";

export interface ExpandedPrompt {
	readonly finalPrompt: string;
	readonly negativePrompt?: string;
	readonly resolvedStyle?: string;
	readonly presetUsed?: StylePreset;
}

export function resolveStylePreset(styleName: string | undefined, config: ImgConfig): StylePreset | undefined {
	if (styleName === undefined) {
		return undefined;
	}
	const key = styleName.trim();
	if (key.length === 0 || key === "none") {
		return undefined;
	}
	return config.presets[key] ?? DEFAULT_PRESETS[key];
}

export function expandPrompt(input: {
	readonly prompt: string;
	readonly negativePrompt?: string;
	readonly style?: string;
	readonly isTexture?: boolean;
	readonly config: ImgConfig;
}): ExpandedPrompt {
	const rawPrompt = input.prompt.trim();
	const effectiveStyleName = input.style ?? input.config.defaults.style;
	const preset = resolveStylePreset(effectiveStyleName, input.config);

	const promptParts: string[] = [rawPrompt];
	const negativeParts: string[] = [];

	if (input.negativePrompt !== undefined && input.negativePrompt.trim().length > 0) {
		negativeParts.push(input.negativePrompt.trim());
	}

	if (preset !== undefined) {
		if (preset.style.trim().length > 0) {
			promptParts.push(preset.style.trim());
		}
		if (preset.negative !== undefined && preset.negative.trim().length > 0) {
			negativeParts.push(preset.negative.trim());
		}
	} else if (
		effectiveStyleName !== undefined &&
		effectiveStyleName.trim().length > 0 &&
		effectiveStyleName.trim() !== "none"
	) {
		promptParts.push(effectiveStyleName.trim());
	}

	if (input.isTexture === true && preset === undefined && effectiveStyleName === undefined) {
		promptParts.push(TEXTURE_PROMPT_AUGMENTATION);
		negativeParts.push(TEXTURE_NEGATIVE_AUGMENTATION);
	}

	const finalPrompt = promptParts.join(", ");
	const mergedNegative = negativeParts.length > 0 ? negativeParts.join(", ") : undefined;

	return deepFreeze({
		finalPrompt,
		...(mergedNegative !== undefined ? { negativePrompt: mergedNegative } : {}),
		...(effectiveStyleName !== undefined && effectiveStyleName !== "none"
			? { resolvedStyle: effectiveStyleName }
			: {}),
		...(preset !== undefined ? { presetUsed: preset } : {}),
	});
}

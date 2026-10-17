import type { ConflictPolicy, ImageFormat, ReturnImageMode } from "../domain/output.js";
import type { ProviderModel } from "../providers/port.js";
import type { NormalConvention, TextureResolution, TilingMethod } from "../domain/texture.js";
import type { ImgConfig, PartialConfig, ProviderConfigEntry } from "../config/schema.js";

export const SETTINGS_SIZES: readonly { readonly width: number; readonly height: number }[] = Object.freeze([
	{ width: 512, height: 512 },
	{ width: 768, height: 768 },
	{ width: 1024, height: 1024 },
	{ width: 1536, height: 1024 },
	{ width: 1024, height: 1536 },
	{ width: 1280, height: 720 },
	{ width: 1920, height: 1080 },
]);

export const SETTINGS_FORMATS: readonly ImageFormat[] = Object.freeze(["png", "jpeg", "webp", "avif"]);

export const SETTINGS_RETURN_MODES: readonly ReturnImageMode[] = Object.freeze(["thumbnail", "full", "none"]);

export const SETTINGS_STYLES: readonly string[] = Object.freeze([
	"none",
	"photorealistic",
	"anime",
	"oil-painting",
	"watercolor",
	"pixel-art",
	"cinematic",
	"3d-render",
	"isometric",
]);

export const SETTINGS_TIMEOUTS_MS: readonly number[] = Object.freeze([
	30000, 60000, 120000, 180000, 300000, 600000,
]);

export const SETTINGS_PROVIDERS: readonly (keyof ImgConfig["providers"])[] = Object.freeze([
	"host",
	"fal",
	"replicate",
	"stability",
	"comfyui",
	"a1111",
]);

export const SETTINGS_OUTPUT_DIRS: readonly string[] = Object.freeze([
	"generated/images",
	"assets/textures",
	"output",
	"images",
	"generated",
]);

export const SETTINGS_FILENAME_TEMPLATES: readonly string[] = Object.freeze([
	"{date}/{slug}",
	"{date}_{seed}",
	"{slug}_{seed}",
	"{provider}_{model}_{index}",
]);

export const SETTINGS_ON_CONFLICT: readonly ConflictPolicy[] = Object.freeze(["suffix", "overwrite", "error"]);

export const SETTINGS_TEXTURE_RESOLUTIONS: readonly TextureResolution[] = Object.freeze([
	256, 512, 1024, 2048, 4096,
]);

export const SETTINGS_NORMAL_CONVENTIONS: readonly NormalConvention[] = Object.freeze(["opengl", "directx"]);

export const SETTINGS_NORMAL_STRENGTHS: readonly number[] = Object.freeze([0.5, 1.0, 1.5, 2.0, 2.5, 3.0]);

export const SETTINGS_TILING_METHODS: readonly TilingMethod[] = Object.freeze([
	"native",
	"offset_blend",
	"mirror",
	"auto",
]);

export const SETTINGS_BATCHES: readonly number[] = Object.freeze([1, 2, 4, 8, 16]);

export const SETTINGS_COSTS_USD: readonly number[] = Object.freeze([0.1, 0.25, 0.5, 1.0, 2.0, 5.0]);

export const SETTINGS_CONCURRENCIES: readonly number[] = Object.freeze([1, 2, 3, 4, 8]);

const DEFAULT_FALLBACK_MODELS: readonly string[] = Object.freeze([
	"host:auto",
	"openai/gpt-image-1",
	"google/imagen-3.0-generate-002",
	"fal/flux-pro-v1.1",
	"fal/flux-dev",
	"fal/flux-schnell",
]);

export function getSectionFieldCount(secName: string, effective: ImgConfig): number {
	switch (secName) {
		case "Defaults":
			return 6;
		case "Providers":
			return SETTINGS_PROVIDERS.length;
		case "Output":
			return 4;
		case "Textures":
			return 4;
		case "UI":
			return 3;
		case "Limits & cost":
			return 3;
		case "Aliases":
			return Math.max(1, Object.keys(effective.aliases).length);
		case "Presets":
			return Math.max(1, Object.keys(effective.presets).length);
		default:
			return 1;
	}
}

export function cycleSettingValue(
	secName: string,
	fieldIdx: number,
	delta: -1 | 1,
	effective: ImgConfig,
	currentPatch: PartialConfig,
	models: readonly ProviderModel[],
): PartialConfig {
	switch (secName) {
		case "Defaults": {
			if (fieldIdx === 0) {
				const modelList = models.length > 0 ? models.map(m => m.id) : DEFAULT_FALLBACK_MODELS;
				const curIdx = modelList.indexOf(effective.defaults.model);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + modelList.length) % modelList.length;
				const nextModel = modelList[nextIdx] ?? "host:auto";
				return {
					...currentPatch,
					defaults: { ...currentPatch.defaults, model: nextModel },
				};
			}
			if (fieldIdx === 1) {
				const curIdx = SETTINGS_SIZES.findIndex(
					s => s.width === effective.defaults.size.width && s.height === effective.defaults.size.height,
				);
				const idx = curIdx >= 0 ? curIdx : 2;
				const nextIdx = (idx + delta + SETTINGS_SIZES.length) % SETTINGS_SIZES.length;
				const nextSize = SETTINGS_SIZES[nextIdx] ?? SETTINGS_SIZES[2] ?? { width: 1024, height: 1024 };
				return {
					...currentPatch,
					defaults: { ...currentPatch.defaults, size: nextSize },
				};
			}
			if (fieldIdx === 2) {
				const curIdx = SETTINGS_FORMATS.indexOf(effective.defaults.format);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_FORMATS.length) % SETTINGS_FORMATS.length;
				const nextFmt = SETTINGS_FORMATS[nextIdx] ?? "png";
				return {
					...currentPatch,
					defaults: { ...currentPatch.defaults, format: nextFmt },
				};
			}
			if (fieldIdx === 3) {
				const curIdx = SETTINGS_RETURN_MODES.indexOf(effective.defaults.returnImage);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_RETURN_MODES.length) % SETTINGS_RETURN_MODES.length;
				const nextReturn = SETTINGS_RETURN_MODES[nextIdx] ?? "thumbnail";
				return {
					...currentPatch,
					defaults: { ...currentPatch.defaults, returnImage: nextReturn },
				};
			}
			if (fieldIdx === 4) {
				const curVal = effective.defaults.style ?? "none";
				const curIdx = SETTINGS_STYLES.indexOf(curVal);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_STYLES.length) % SETTINGS_STYLES.length;
				const nextStyle = SETTINGS_STYLES[nextIdx] ?? "none";
				return {
					...currentPatch,
					defaults: { ...currentPatch.defaults, style: nextStyle === "none" ? null : nextStyle },
				};
			}
			if (fieldIdx === 5) {
				let closestIdx = 0;
				let minDiff = Infinity;
				for (let i = 0; i < SETTINGS_TIMEOUTS_MS.length; i++) {
					const t = SETTINGS_TIMEOUTS_MS[i];
					if (t === undefined) continue;
					const diff = Math.abs(t - effective.defaults.timeoutMs);
					if (diff < minDiff) {
						minDiff = diff;
						closestIdx = i;
					}
				}
				const nextIdx = (closestIdx + delta + SETTINGS_TIMEOUTS_MS.length) % SETTINGS_TIMEOUTS_MS.length;
				const nextTimeout = SETTINGS_TIMEOUTS_MS[nextIdx] ?? 180000;
				return {
					...currentPatch,
					defaults: { ...currentPatch.defaults, timeoutMs: nextTimeout },
				};
			}
			return currentPatch;
		}
		case "Providers": {
			const pId = SETTINGS_PROVIDERS[fieldIdx] ?? "host";
			const curEnabled = effective.providers[pId].enabled;
			const nextEnabled = !curEnabled;
			const prevEntry: Partial<ProviderConfigEntry> = currentPatch.providers?.[pId] ?? {};
			return {
				...currentPatch,
				providers: {
					...currentPatch.providers,
					[pId]: {
						...prevEntry,
						enabled: nextEnabled,
					},
				},
			};
		}
		case "Output": {
			if (fieldIdx === 0) {
				const curIdx = SETTINGS_OUTPUT_DIRS.indexOf(effective.output.dir);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_OUTPUT_DIRS.length) % SETTINGS_OUTPUT_DIRS.length;
				const nextDir = SETTINGS_OUTPUT_DIRS[nextIdx] ?? "generated/images";
				return {
					...currentPatch,
					output: { ...currentPatch.output, dir: nextDir },
				};
			}
			if (fieldIdx === 1) {
				const curIdx = SETTINGS_FILENAME_TEMPLATES.indexOf(effective.output.filename);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_FILENAME_TEMPLATES.length) % SETTINGS_FILENAME_TEMPLATES.length;
				const nextTpl = SETTINGS_FILENAME_TEMPLATES[nextIdx] ?? "{date}/{slug}";
				return {
					...currentPatch,
					output: { ...currentPatch.output, filename: nextTpl },
				};
			}
			if (fieldIdx === 2) {
				const curIdx = SETTINGS_ON_CONFLICT.indexOf(effective.output.onConflict);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_ON_CONFLICT.length) % SETTINGS_ON_CONFLICT.length;
				const nextPol = SETTINGS_ON_CONFLICT[nextIdx] ?? "suffix";
				return {
					...currentPatch,
					output: { ...currentPatch.output, onConflict: nextPol },
				};
			}
			if (fieldIdx === 3) {
				return {
					...currentPatch,
					output: { ...currentPatch.output, sidecar: !effective.output.sidecar },
				};
			}
			return currentPatch;
		}
		case "Textures": {
			if (fieldIdx === 0) {
				const curIdx = SETTINGS_TEXTURE_RESOLUTIONS.indexOf(effective.textures.resolution);
				const idx = curIdx >= 0 ? curIdx : 2;
				const nextIdx = (idx + delta + SETTINGS_TEXTURE_RESOLUTIONS.length) % SETTINGS_TEXTURE_RESOLUTIONS.length;
				const nextRes = SETTINGS_TEXTURE_RESOLUTIONS[nextIdx] ?? 1024;
				return {
					...currentPatch,
					textures: { ...currentPatch.textures, resolution: nextRes },
				};
			}
			if (fieldIdx === 1) {
				const curIdx = SETTINGS_NORMAL_CONVENTIONS.indexOf(effective.textures.normalConvention);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_NORMAL_CONVENTIONS.length) % SETTINGS_NORMAL_CONVENTIONS.length;
				const nextConv = SETTINGS_NORMAL_CONVENTIONS[nextIdx] ?? "opengl";
				return {
					...currentPatch,
					textures: { ...currentPatch.textures, normalConvention: nextConv },
				};
			}
			if (fieldIdx === 2) {
				let closestIdx = 1;
				let minDiff = Infinity;
				for (let i = 0; i < SETTINGS_NORMAL_STRENGTHS.length; i++) {
					const s = SETTINGS_NORMAL_STRENGTHS[i];
					if (s === undefined) continue;
					const diff = Math.abs(s - effective.textures.normalStrength);
					if (diff < minDiff) {
						minDiff = diff;
						closestIdx = i;
					}
				}
				const nextIdx = (closestIdx + delta + SETTINGS_NORMAL_STRENGTHS.length) % SETTINGS_NORMAL_STRENGTHS.length;
				const nextStr = SETTINGS_NORMAL_STRENGTHS[nextIdx] ?? 1.0;
				return {
					...currentPatch,
					textures: { ...currentPatch.textures, normalStrength: nextStr },
				};
			}
			if (fieldIdx === 3) {
				const curIdx = SETTINGS_TILING_METHODS.indexOf(effective.textures.tilingMethod);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + SETTINGS_TILING_METHODS.length) % SETTINGS_TILING_METHODS.length;
				const nextMeth = SETTINGS_TILING_METHODS[nextIdx] ?? "native";
				return {
					...currentPatch,
					textures: { ...currentPatch.textures, tilingMethod: nextMeth },
				};
			}
			return currentPatch;
		}
		case "UI": {
			if (fieldIdx === 0) {
				return {
					...currentPatch,
					ui: { ...currentPatch.ui, inlinePreview: !effective.ui.inlinePreview },
				};
			}
			if (fieldIdx === 1) {
				return {
					...currentPatch,
					ui: { ...currentPatch.ui, statusSegment: !effective.ui.statusSegment },
				};
			}
			if (fieldIdx === 2) {
				return {
					...currentPatch,
					ui: { ...currentPatch.ui, queueWidget: !effective.ui.queueWidget },
				};
			}
			return currentPatch;
		}
		case "Limits & cost": {
			if (fieldIdx === 0) {
				const curIdx = SETTINGS_BATCHES.indexOf(effective.limits.maxBatch);
				const idx = curIdx >= 0 ? curIdx : 1;
				const nextIdx = (idx + delta + SETTINGS_BATCHES.length) % SETTINGS_BATCHES.length;
				const nextBatch = SETTINGS_BATCHES[nextIdx] ?? 4;
				return {
					...currentPatch,
					limits: { ...currentPatch.limits, maxBatch: nextBatch },
				};
			}
			if (fieldIdx === 1) {
				let closestIdx = 2;
				let minDiff = Infinity;
				for (let i = 0; i < SETTINGS_COSTS_USD.length; i++) {
					const c = SETTINGS_COSTS_USD[i];
					if (c === undefined) continue;
					const diff = Math.abs(c - effective.limits.maxCostPerCallUsd);
					if (diff < minDiff) {
						minDiff = diff;
						closestIdx = i;
					}
				}
				const nextIdx = (closestIdx + delta + SETTINGS_COSTS_USD.length) % SETTINGS_COSTS_USD.length;
				const nextCost = SETTINGS_COSTS_USD[nextIdx] ?? 0.5;
				return {
					...currentPatch,
					limits: { ...currentPatch.limits, maxCostPerCallUsd: nextCost },
				};
			}
			if (fieldIdx === 2) {
				const curIdx = SETTINGS_CONCURRENCIES.indexOf(effective.queue.maxConcurrent);
				const idx = curIdx >= 0 ? curIdx : 1;
				const nextIdx = (idx + delta + SETTINGS_CONCURRENCIES.length) % SETTINGS_CONCURRENCIES.length;
				const nextConc = SETTINGS_CONCURRENCIES[nextIdx] ?? 2;
				return {
					...currentPatch,
					queue: { ...currentPatch.queue, maxConcurrent: nextConc },
				};
			}
			return currentPatch;
		}
		case "Aliases": {
			const entries = Object.entries(effective.aliases);
			const entry = entries[fieldIdx];
			if (entry !== undefined) {
				const [aliasKey, curModel] = entry;
				const modelList = models.length > 0 ? models.map(m => m.id) : DEFAULT_FALLBACK_MODELS;
				const curIdx = modelList.indexOf(curModel);
				const idx = curIdx >= 0 ? curIdx : 0;
				const nextIdx = (idx + delta + modelList.length) % modelList.length;
				const nextModel = modelList[nextIdx] ?? "host:auto";
				return {
					...currentPatch,
					aliases: {
						...currentPatch.aliases,
						[aliasKey]: nextModel,
					},
				};
			}
			return currentPatch;
		}
		default:
			return currentPatch;
	}
}

export function resetSettingValue(
	secName: string,
	fieldIdx: number,
	currentPatch: PartialConfig,
): { readonly patch: PartialConfig; readonly label: string } {
	switch (secName) {
		case "Defaults": {
			const d = { ...currentPatch.defaults };
			let label = "defaults";
			if (fieldIdx === 0) {
				delete d.model;
				label = "default model";
			} else if (fieldIdx === 1) {
				delete d.size;
				label = "default size";
			} else if (fieldIdx === 2) {
				delete d.format;
				label = "default format";
			} else if (fieldIdx === 3) {
				delete d.returnImage;
				label = "return to model";
			} else if (fieldIdx === 4) {
				delete d.style;
				label = "style preset";
			} else if (fieldIdx === 5) {
				delete d.timeoutMs;
				label = "timeout";
			}
			return {
				patch: { ...currentPatch, defaults: d },
				label,
			};
		}
		case "Providers": {
			const pId = SETTINGS_PROVIDERS[fieldIdx] ?? "host";
			const p: Record<string, Partial<ProviderConfigEntry>> = {};
			for (const [k, v] of Object.entries(currentPatch.providers ?? {})) {
				if (k !== pId) {
					p[k] = v;
				}
			}
			return {
				patch: { ...currentPatch, providers: p },
				label: `provider ${pId}`,
			};
		}
		case "Output": {
			const o = { ...currentPatch.output };
			let label = "output";
			if (fieldIdx === 0) {
				delete o.dir;
				label = "output dir";
			} else if (fieldIdx === 1) {
				delete o.filename;
				label = "filename template";
			} else if (fieldIdx === 2) {
				delete o.onConflict;
				label = "on conflict";
			} else if (fieldIdx === 3) {
				delete o.sidecar;
				label = "write sidecar";
			}
			return {
				patch: { ...currentPatch, output: o },
				label,
			};
		}
		case "Textures": {
			const t = { ...currentPatch.textures };
			let label = "textures";
			if (fieldIdx === 0) {
				delete t.resolution;
				label = "resolution";
			} else if (fieldIdx === 1) {
				delete t.normalConvention;
				label = "normal convention";
			} else if (fieldIdx === 2) {
				delete t.normalStrength;
				label = "normal strength";
			} else if (fieldIdx === 3) {
				delete t.tilingMethod;
				label = "tiling method";
			}
			return {
				patch: { ...currentPatch, textures: t },
				label,
			};
		}
		case "UI": {
			const u = { ...currentPatch.ui };
			let label = "ui";
			if (fieldIdx === 0) {
				delete u.inlinePreview;
				label = "inline preview";
			} else if (fieldIdx === 1) {
				delete u.statusSegment;
				label = "status segment";
			} else if (fieldIdx === 2) {
				delete u.queueWidget;
				label = "queue widget";
			}
			return {
				patch: { ...currentPatch, ui: u },
				label,
			};
		}
		case "Limits & cost": {
			if (fieldIdx === 0) {
				const l = { ...currentPatch.limits };
				delete l.maxBatch;
				return {
					patch: { ...currentPatch, limits: l },
					label: "max batch",
				};
			}
			if (fieldIdx === 1) {
				const l = { ...currentPatch.limits };
				delete l.maxCostPerCallUsd;
				return {
					patch: { ...currentPatch, limits: l },
					label: "max cost / call",
				};
			}
			if (fieldIdx === 2) {
				const q = { ...currentPatch.queue };
				delete q.maxConcurrent;
				return {
					patch: { ...currentPatch, queue: q },
					label: "max concurrent",
				};
			}
			return { patch: currentPatch, label: "limits" };
		}
		default:
			return { patch: currentPatch, label: secName };
	}
}

export function testProviderConnection(
	pId: keyof ImgConfig["providers"],
	effective: ImgConfig,
	modelsCount: number,
): { readonly message: string; readonly type: "info" | "warning" } {
	if (pId === "host") {
		return {
			message: `Host provider: active (${modelsCount} models available)`,
			type: "info",
		};
	}
	if (pId === "fal") {
		const envKey = effective.providers.fal.apiKeyEnv ?? "FAL_KEY";
		const hasKey = process.env[envKey] !== undefined;
		return {
			message: hasKey ? `fal.ai: Key found in $${envKey}` : `fal.ai: $${envKey} not set in environment`,
			type: hasKey ? "info" : "warning",
		};
	}
	if (pId === "replicate") {
		const envKey = effective.providers.replicate.apiKeyEnv ?? "REPLICATE_API_TOKEN";
		const hasKey = process.env[envKey] !== undefined;
		return {
			message: hasKey ? `Replicate: Token found in $${envKey}` : `Replicate: $${envKey} not set in environment`,
			type: hasKey ? "info" : "warning",
		};
	}
	if (pId === "stability") {
		const envKey = effective.providers.stability.apiKeyEnv ?? "STABILITY_API_KEY";
		const hasKey = process.env[envKey] !== undefined;
		return {
			message: hasKey ? `Stability: Key found in $${envKey}` : `Stability: $${envKey} not set in environment`,
			type: hasKey ? "info" : "warning",
		};
	}
	if (pId === "comfyui") {
		const url = effective.providers.comfyui.baseUrl ?? "http://127.0.0.1:8188";
		return {
			message: `ComfyUI configured at ${url}`,
			type: "info",
		};
	}
	const url = effective.providers.a1111.baseUrl ?? "http://127.0.0.1:7860";
	return {
		message: `Automatic1111 configured at ${url}`,
		type: "info",
	};
}

export function cycleProviderKeyEnv(
	pId: keyof ImgConfig["providers"],
	effective: ImgConfig,
	currentPatch: PartialConfig,
): { readonly patch: PartialConfig; readonly message: string } {
	if (pId === "fal") {
		const cur = effective.providers.fal.apiKeyEnv ?? "FAL_KEY";
		const next = cur === "FAL_KEY" ? "FAL_API_KEY" : "FAL_KEY";
		const prev = currentPatch.providers?.["fal"] ?? {};
		return {
			patch: {
				...currentPatch,
				providers: { ...currentPatch.providers, fal: { ...prev, apiKeyEnv: next } },
			},
			message: `fal apiKeyEnv: ${next}`,
		};
	}
	if (pId === "replicate") {
		const cur = effective.providers.replicate.apiKeyEnv ?? "REPLICATE_API_TOKEN";
		const next = cur === "REPLICATE_API_TOKEN" ? "REPLICATE_API_KEY" : "REPLICATE_API_TOKEN";
		const prev = currentPatch.providers?.["replicate"] ?? {};
		return {
			patch: {
				...currentPatch,
				providers: { ...currentPatch.providers, replicate: { ...prev, apiKeyEnv: next } },
			},
			message: `replicate apiKeyEnv: ${next}`,
		};
	}
	if (pId === "stability") {
		const cur = effective.providers.stability.apiKeyEnv ?? "STABILITY_API_KEY";
		const next = cur === "STABILITY_API_KEY" ? "STABILITY_KEY" : "STABILITY_API_KEY";
		const prev = currentPatch.providers?.["stability"] ?? {};
		return {
			patch: {
				...currentPatch,
				providers: { ...currentPatch.providers, stability: { ...prev, apiKeyEnv: next } },
			},
			message: `stability apiKeyEnv: ${next}`,
		};
	}
	return {
		patch: currentPatch,
		message: `No alternate key env for ${pId}`,
	};
}

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type ImgConfig, type PartialConfig } from "../../src/config/schema";
import {
	cycleProviderKeyEnv,
	cycleSettingValue,
	getSectionFieldCount,
	resetSettingValue,
	testProviderConnection,
} from "../../src/commands/settings-actions";

describe("commands/settings-actions — section field counts", () => {
	test("returns correct field counts for each section", () => {
		expect(getSectionFieldCount("Defaults", DEFAULT_CONFIG)).toBe(6);
		expect(getSectionFieldCount("Providers", DEFAULT_CONFIG)).toBe(6);
		expect(getSectionFieldCount("Output", DEFAULT_CONFIG)).toBe(4);
		expect(getSectionFieldCount("Textures", DEFAULT_CONFIG)).toBe(4);
		expect(getSectionFieldCount("UI", DEFAULT_CONFIG)).toBe(3);
		expect(getSectionFieldCount("Limits & cost", DEFAULT_CONFIG)).toBe(3);
	});
});

describe("commands/settings-actions — cycling values", () => {
	const eff: ImgConfig = DEFAULT_CONFIG;
	const patch: PartialConfig = {};

	test("cycles format in Defaults", () => {
		// Default is png (idx 0), delta +1 -> jpeg
		const next = cycleSettingValue("Defaults", 2, 1, eff, patch, []);
		expect(next.defaults?.format).toBe("jpeg");

		// delta -1 from png -> wraps to avif
		const prev = cycleSettingValue("Defaults", 2, -1, eff, patch, []);
		expect(prev.defaults?.format).toBe("avif");
	});

	test("cycles size in Defaults", () => {
		// Default is 1024x1024 (idx 2), delta +1 -> 1536x1024
		const next = cycleSettingValue("Defaults", 1, 1, eff, patch, []);
		expect(next.defaults?.size).toEqual({ width: 1536, height: 1024 });
	});

	test("toggles provider enabled in Providers", () => {
		// host is enabled by default -> toggles to false
		const next = cycleSettingValue("Providers", 0, 1, eff, patch, []);
		expect(next.providers?.["host"]?.enabled).toBe(false);

		// replicate is disabled by default -> toggles to true
		const rep = cycleSettingValue("Providers", 2, 1, eff, patch, []);
		expect(rep.providers?.["replicate"]?.enabled).toBe(true);
	});

	test("toggles boolean flags in UI", () => {
		// inlinePreview is true by default -> toggles to false
		const next = cycleSettingValue("UI", 0, 1, eff, patch, []);
		expect(next.ui?.inlinePreview).toBe(false);
	});

	test("cycles texture resolution", () => {
		// Default resolution 1024 (idx 2), delta +1 -> 2048
		const next = cycleSettingValue("Textures", 0, 1, eff, patch, []);
		expect(next.textures?.resolution).toBe(2048);
	});
});

describe("commands/settings-actions — reset values", () => {
	test("resets defaults.format from patch", () => {
		const patch: PartialConfig = {
			defaults: { format: "webp", model: "custom/model" },
		};
		const res = resetSettingValue("Defaults", 2, patch);
		expect(res.label).toBe("default format");
		expect(res.patch.defaults?.format).toBeUndefined();
		expect(res.patch.defaults?.model).toBe("custom/model");
	});

	test("resets provider from patch", () => {
		const patch: PartialConfig = {
			providers: { fal: { enabled: true } },
		};
		const res = resetSettingValue("Providers", 1, patch);
		expect(res.label).toBe("provider fal");
		expect(res.patch.providers?.["fal"]).toBeUndefined();
	});
});

describe("commands/settings-actions — provider test & key cycling", () => {
	test("tests host provider", () => {
		const res = testProviderConnection("host", DEFAULT_CONFIG, 3);
		expect(res.type).toBe("info");
		expect(res.message).toContain("Host provider: active");
	});

	test("cycles fal key env name", () => {
		const res = cycleProviderKeyEnv("fal", DEFAULT_CONFIG, {});
		expect(res.patch.providers?.["fal"]?.apiKeyEnv).toBe("FAL_API_KEY");
	});
});

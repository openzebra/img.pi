import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { getFieldProvenance, resolveConfigLayers } from "../../src/config/layers";
import { migrateConfig } from "../../src/config/migrate";
import { DEFAULT_CONFIG, validatePartialConfig } from "../../src/config/schema";
import { ConfigStore } from "../../src/config/store";

describe("config/layers — precedence and provenance", () => {
	test("merges defaults < user < project < session < call", () => {
		const layers = {
			user: {
				defaults: { model: "fal/flux-dev", compression: 80 },
				queue: { maxConcurrent: 3 },
			},
			project: {
				defaults: { model: "fal/flux-pro-v1.1" },
				output: { dir: "assets/textures" },
			},
			session: {
				defaults: { quality: "high" as const },
			},
			call: {
				defaults: { compression: 95 },
			},
		};

		const effective = resolveConfigLayers(layers);
		expect(effective.defaults.model).toBe("fal/flux-pro-v1.1");
		expect(effective.defaults.compression).toBe(95);
		expect(effective.defaults.quality).toBe("high");
		expect(effective.defaults.format).toBe(DEFAULT_CONFIG.defaults.format);
		expect(effective.queue.maxConcurrent).toBe(3);
		expect(effective.output.dir).toBe("assets/textures");

		const modelProv = getFieldProvenance(layers, "defaults.model");
		expect(modelProv.source).toBe("project");
		expect(modelProv.overrides).toEqual(["user", "default"]);

		const fmtProv = getFieldProvenance(layers, "defaults.format");
		expect(fmtProv.source).toBe("default");
	});
});

describe("config/migrate & validation", () => {
	test("migrates v0 flat keys to v1", () => {
		const res = migrateConfig({
			version: 0,
			defaultModel: "openai/gpt-image-1",
			outputDir: "out/imgs",
			maxConcurrent: 4,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.defaults?.model).toBe("openai/gpt-image-1");
		expect(res.value.output?.dir).toBe("out/imgs");
		expect(res.value.queue?.maxConcurrent).toBe(4);
	});

	test("rejects unknown top-level keys and invalid field values with config_invalid", () => {
		const badSection = validatePartialConfig({ unknownKey: true });
		expect(badSection.ok).toBe(false);
		if (!badSection.ok) {
			expect(badSection.error.kind).toBe("config_invalid");
			if (badSection.error.kind === "config_invalid") {
				expect(badSection.error.path).toBe("unknownKey");
			}
		}

		const badRes = validatePartialConfig({ textures: { resolution: 999 } });
		expect(badRes.ok).toBe(false);
		if (!badRes.ok) {
			expect(badRes.error.kind).toBe("config_invalid");
			if (badRes.error.kind === "config_invalid") {
				expect(badRes.error.path).toBe("textures.resolution");
			}
		}

		const badTemplate = validatePartialConfig({ output: { filename: "{badtoken}" } });
		expect(badTemplate.ok).toBe(false);
	});
});

describe("config/store — atomic load & save round-trip", () => {
	test("round-trips user and project scopes", async () => {
		const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-cfg-"));
		try {
			const agentDir = path.join(tmpRoot, "agent");
			const projectDir = path.join(tmpRoot, "project");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(projectDir, { recursive: true });

			const store = new ConfigStore({
				agentDir,
				cwd: projectDir,
				projectDirName: ".omp",
			});

			const initial = await store.load();
			expect(initial.ok).toBe(true);

			const savedUser = await store.saveScope("user", {
				defaults: { model: "fal/flux-schnell" },
			});
			expect(savedUser.ok).toBe(true);
			if (savedUser.ok) {
				expect(savedUser.value.defaults.model).toBe("fal/flux-schnell");
			}

			const savedProj = await store.saveScope("project", {
				defaults: { model: "openai/gpt-image-1" },
				output: { dir: "custom/out" },
			});
			expect(savedProj.ok).toBe(true);
			if (savedProj.ok) {
				expect(savedProj.value.defaults.model).toBe("openai/gpt-image-1");
				expect(savedProj.value.output.dir).toBe("custom/out");
			}

			// Re-load from disk in a fresh ConfigStore
			const store2 = new ConfigStore({
				agentDir,
				cwd: projectDir,
				projectDirName: ".omp",
			});
			const reloaded = await store2.load();
			expect(reloaded.ok).toBe(true);
			if (reloaded.ok) {
				expect(reloaded.value.defaults.model).toBe("openai/gpt-image-1");
				expect(reloaded.value.output.dir).toBe("custom/out");
			}

			// In-memory setScopeLayer updates effective config immediately
			const updated = store2.setScopeLayer("project", {
				defaults: { format: "webp" },
			});
			expect(updated.ok).toBe(true);
			if (updated.ok) {
				expect(updated.value.defaults.format).toBe("webp");
			}
			expect(store2.getEffective().defaults.format).toBe("webp");
		} finally {
			await fs.rm(tmpRoot, { recursive: true, force: true });
		}
	});
});

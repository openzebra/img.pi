import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SIDECAR_SCHEMA_VERSION } from "../../src/domain/artifact.js";
import { GalleryStore } from "../../src/storage/gallery.js";
import { ManifestStore } from "../../src/storage/manifest.js";
import { expandFilenameTemplate, resolveSafeOutputPath } from "../../src/storage/paths.js";
import { writeArtifact, writeGltfMaterialJson } from "../../src/storage/writer.js";

describe("storage/paths, writer, manifest, gallery", () => {
	let tmpCwd: string;

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "img-pi-storage-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpCwd, { recursive: true, force: true });
	});

	test("expandFilenameTemplate expands all tokens deterministically and rejects unknown tokens", () => {
		const fixedNow = new Date("2025-06-11T14:02:11.000Z");
		const res = expandFilenameTemplate(
			"{date}_{time}_{slug}_{index}_{seed}_{model}_{provider}_{w}x{h}_{map}_{job}_{tag}",
			{
				prompt: "Rusty Corroded Metal Panel!",
				index: 2,
				seed: 41822,
				model: "openai/gpt-image-1",
				provider: "openai",
				width: 1536,
				height: 1024,
				map: "albedo",
				jobId: "01JXA9K3ABCDEF",
				tags: ["metal"],
				now: fixedNow,
			},
		);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.value).toBe(
				"2025-06-11_140211_rusty-corroded-metal-panel_2_41822_gpt-image-1_openai_1536x1024_albedo_01JXA9K3_metal",
			);
		}

		const bad = expandFilenameTemplate("{date}_{unknown_token}", {
			prompt: "test",
			index: 1,
			model: "gpt-image-1",
			provider: "openai",
			width: 512,
			height: 512,
			jobId: "01JX",
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.error.kind).toBe("config_invalid");
		}
	});

	test("resolveSafeOutputPath enforces cwd sandbox, blocks .git/node_modules/.omp, and handles conflicts", async () => {
		const outside = await resolveSafeOutputPath({
			cwd: tmpCwd,
			outputDir: "../outside-dir",
			relativeStem: "test",
			format: "png",
			allowOutsideCwd: false,
			onConflict: "suffix",
		});
		expect(outside.ok).toBe(false);
		if (!outside.ok) {
			expect(outside.error.kind).toBe("path_forbidden");
		}

		for (const forbiddenDir of [".git/hooks", "node_modules/pkg", ".omp/extensions", ".pi/agent"]) {
			const res = await resolveSafeOutputPath({
				cwd: tmpCwd,
				outputDir: forbiddenDir,
				relativeStem: "evil",
				format: "png",
				allowOutsideCwd: true,
				onConflict: "overwrite",
			});
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.error.kind).toBe("path_forbidden");
			}
		}

		// Conflict policies: suffix, error, overwrite
		const first = await resolveSafeOutputPath({
			cwd: tmpCwd,
			outputDir: "generated/images",
			relativeStem: "panel",
			format: "png",
			allowOutsideCwd: false,
			onConflict: "suffix",
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.relativePath).toBe("generated/images/panel.png");

		await fs.mkdir(path.dirname(first.value.absolutePath), { recursive: true });
		await fs.writeFile(first.value.absolutePath, "dummy");

		const secondSuffix = await resolveSafeOutputPath({
			cwd: tmpCwd,
			outputDir: "generated/images",
			relativeStem: "panel",
			format: "png",
			allowOutsideCwd: false,
			onConflict: "suffix",
		});
		expect(secondSuffix.ok).toBe(true);
		if (secondSuffix.ok) {
			expect(secondSuffix.value.relativePath).toBe("generated/images/panel_2.png");
		}

		const conflictErr = await resolveSafeOutputPath({
			cwd: tmpCwd,
			outputDir: "generated/images",
			relativeStem: "panel",
			format: "png",
			allowOutsideCwd: false,
			onConflict: "error",
		});
		expect(conflictErr.ok).toBe(false);
		if (!conflictErr.ok) {
			expect(conflictErr.error).toEqual({
				kind: "path_forbidden",
				path: "generated/images/panel.png",
				reason: "exists",
			});
		}
	});

	test("writeArtifact, ManifestStore, @last/@job resolution, and GalleryStore query", async () => {
		const manifest = new ManifestStore();
		const gallery = new GalleryStore(manifest);
		const manifestRel = ".img-pi/manifest.jsonl";

		const resolvedPath = await resolveSafeOutputPath({
			cwd: tmpCwd,
			outputDir: "generated/images",
			relativeStem: "stone_1",
			format: "png",
			allowOutsideCwd: false,
			onConflict: "suffix",
		});
		expect(resolvedPath.ok).toBe(true);
		if (!resolvedPath.ok) return;

		const rawBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const writeRes = await writeArtifact({
			absolutePath: resolvedPath.value.absolutePath,
			relativePath: resolvedPath.value.relativePath,
			imageBuffer: rawBytes.buffer,
			writeSidecar: true,
			summary: {
				index: 1,
				width: 1024,
				height: 1024,
				format: "png",
				sha256: "abc123sha",
			},
			sidecar: {
				schema: SIDECAR_SCHEMA_VERSION,
				job: "01JXA9K3001",
				index: 1,
				createdAt: "2025-06-11T14:02:11.233Z",
				host: "omp",
				provider: "fal",
				model: "flux-pro-v1.1",
				reportedModel: "flux-pro-v1.1",
				prompt: "mossy stone wall",
				negativePrompt: null,
				style: "pbr-texture",
				finalPrompt: "mossy stone wall, seamless",
				seed: 9921,
				steps: 28,
				guidance: 3.5,
				quality: "auto",
				requestedSize: [1024, 1024],
				producedSize: [1024, 1024],
				post: [],
				references: [],
				sha256: "abc123sha",
				format: "png",
				usage: null,
				costUsd: 0.04,
				texture: null,
				tags: ["stone", "moss"],
				metadata: {},
			},
		});
		expect(writeRes.ok).toBe(true);
		if (!writeRes.ok) return;

		const appendRes = await manifest.append(tmpCwd, manifestRel, [writeRes.value.sidecar]);
		expect(appendRes.ok).toBe(true);

		const lastRef = await manifest.resolveJobReference(tmpCwd, manifestRel, "@last");
		expect(lastRef.ok).toBe(true);
		if (lastRef.ok) {
			expect(lastRef.value.job).toBe("01JXA9K3001");
			expect(lastRef.value.seed).toBe(9921);
		}

		const idRef = await manifest.resolveJobReference(tmpCwd, manifestRel, "@job:01JXA9K3#1");
		expect(idRef.ok).toBe(true);

		const galleryPage = await gallery.query(tmpCwd, manifestRel, { tag: "#stone" });
		expect(galleryPage.ok).toBe(true);
		if (galleryPage.ok) {
			expect(galleryPage.value.total).toBe(1);
			expect(galleryPage.value.items[0]?.prompt).toBe("mossy stone wall");
		}

		const gltfRes = await writeGltfMaterialJson({
			directory: path.join(tmpCwd, "generated/textures"),
			materialName: "mossy-stone",
			mapFiles: {
				albedo: "mossy_albedo.png",
				normal: "mossy_normal.png",
				roughness: "mossy_roughness.png",
				ao: "mossy_ao.png",
			},
			normalStrength: 2.0,
			normalConvention: "opengl",
			resolution: 1024,
		});
		expect(gltfRes.ok).toBe(true);
		if (gltfRes.ok) {
			const text = await fs.readFile(gltfRes.value, "utf8");
			const parsed: unknown = JSON.parse(text);
			expect(
				typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === "mossy-stone",
			).toBe(true);
		}
	});
});

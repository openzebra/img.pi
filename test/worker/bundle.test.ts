import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkerPool, workerModuleUrl } from "../../src/workers/pool.js";
import { buildTinySeedPng } from "../fixtures/png.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
// Inside the repo so the bundled worker resolves the external `sharp` from node_modules.
const OUT_DIR = path.join(REPO_ROOT, ".test-dist");

/** The real `build` script from package.json, redirected to OUT_DIR. */
async function buildScriptArgs(): Promise<string[]> {
	const pkg: unknown = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
	const scripts = typeof pkg === "object" && pkg !== null && "scripts" in pkg ? pkg.scripts : undefined;
	const build = typeof scripts === "object" && scripts !== null && "build" in scripts ? scripts.build : undefined;
	if (typeof build !== "string") {
		throw new Error("package.json has no build script");
	}
	const args = (build.match(/'[^']*'|\S+/g) ?? []).map(a => a.replace(/^'|'$/g, ""));
	const outIdx = args.indexOf("--outdir");
	if (args[0] !== "bun" || outIdx === -1) {
		throw new Error(`unexpected build script: ${build}`);
	}
	args[outIdx + 1] = OUT_DIR;
	return args;
}

describe("bundled worker", () => {
	afterAll(async () => {
		await fs.rm(OUT_DIR, { recursive: true, force: true });
	});

	test("the worker path computed for the bundle exists and the built worker runs", async () => {
		const proc = Bun.spawn(await buildScriptArgs(), { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);

		const bundleUrl = pathToFileURL(path.join(OUT_DIR, "index.js")).href;
		const workerUrl = workerModuleUrl(bundleUrl);
		expect((await fs.stat(fileURLToPath(workerUrl))).isFile()).toBe(true);

		const pool = new WorkerPool({ size: 1, workerUrl });
		try {
			const b64 = Buffer.from(buildTinySeedPng(1, false)).toString("base64");
			const res = await pool.run({ op: "decode_b64", b64 });
			expect(res.ok).toBe(true);
		} finally {
			await pool.terminate();
		}
	}, 30_000);

	test("sources resolve the worker next to pool.ts", () => {
		const url = workerModuleUrl(pathToFileURL(path.join(REPO_ROOT, "src/workers/pool.ts")).href);
		expect(fileURLToPath(url)).toBe(path.join(REPO_ROOT, "src/workers/image.worker.ts"));
	});

	test("a worker that cannot start fails fast once and is never respawned", async () => {
		const pool = new WorkerPool({ size: 2, workerUrl: pathToFileURL(path.join(OUT_DIR, "missing.worker.js")) });
		try {
			const started = performance.now();
			const first = await pool.run({ op: "decode_b64", b64: "aGk=" });
			expect(first.ok ? "ok" : first.error.kind).toBe("worker_failed");
			if (!first.ok && first.error.kind === "worker_failed") {
				expect(first.error.message).toContain("failed to start");
			}
			const second = await pool.run({ op: "decode_b64", b64: "aGk=" });
			expect(second.ok ? "ok" : second.error.kind).toBe("worker_failed");
			expect(performance.now() - started).toBeLessThan(5_000);
		} finally {
			await pool.terminate();
		}
	});
});

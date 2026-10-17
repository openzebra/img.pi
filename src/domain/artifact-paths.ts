import { deepFreeze } from "../core/freeze";

/** Project-relative root for everything img.pi writes, identical on omp and pi. */
export const ARTIFACT_ROOT = ".pi/img";

export const ARTIFACT_PATHS = deepFreeze({
	images: `${ARTIFACT_ROOT}/images`,
	textures: `${ARTIFACT_ROOT}/textures`,
	manifest: `${ARTIFACT_ROOT}/manifest.jsonl`,
	failed: `${ARTIFACT_ROOT}/failed`,
});

/** Where a failed job's request is saved so it can be retried. */
export function failedRequestRelPath(jobId: string): string {
	return `${ARTIFACT_PATHS.failed}/${jobId}.json`;
}

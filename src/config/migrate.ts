import { configInvalid, type ImgError } from "../core/errors";
import { err, type Result } from "../core/result";
import { type PartialConfig, validatePartialConfig } from "./schema";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Sections removed when models and credentials moved to the host: direct-provider
 * entries and the estimate-based cost limit. Dropped silently so old files keep loading.
 */
function stripRemovedKeys(input: Record<string, unknown>): Record<string, unknown> {
	const { providers: _providers, ...rest } = input;
	const limits = rest["limits"];
	if (isRecord(limits)) {
		const { maxCostPerCallUsd: _maxCost, ...keptLimits } = limits;
		return { ...rest, limits: keptLimits };
	}
	return rest;
}

/**
 * Migrate legacy / v0 configuration payloads to v1 PartialConfig (§8.1, §12).
 */
export function migrateConfig(raw: unknown): Result<PartialConfig, ImgError> {
	if (!isRecord(raw)) {
		return err(configInvalid("root", "Config must be a JSON object"));
	}
	const input = stripRemovedKeys(raw);
	const version = input["version"];

	if (version !== undefined && version !== 0 && version !== 1) {
		return err(configInvalid("version", `Unsupported config version '${JSON.stringify(version)}', expected 1`));
	}

	// If v0 or legacy flat keys are present, normalize into v1 structure before validation
	const isLegacyV0 = version === 0 || "defaultModel" in input || "outputDir" in input || "maxConcurrent" in input;

	if (!isLegacyV0) {
		return validatePartialConfig(input);
	}

	const migrated: Record<string, unknown> = { version: 1 };
	const defaults: Record<string, unknown> =
		typeof input["defaults"] === "object" && input["defaults"] !== null
			? { ...(input["defaults"] as Record<string, unknown>) }
			: {};
	const output: Record<string, unknown> =
		typeof input["output"] === "object" && input["output"] !== null
			? { ...(input["output"] as Record<string, unknown>) }
			: {};
	const queue: Record<string, unknown> =
		typeof input["queue"] === "object" && input["queue"] !== null
			? { ...(input["queue"] as Record<string, unknown>) }
			: {};

	if (typeof input["defaultModel"] === "string" && !("model" in defaults)) {
		defaults["model"] = input["defaultModel"];
	}
	if (typeof input["outputDir"] === "string" && !("dir" in output)) {
		output["dir"] = input["outputDir"];
	}
	if (typeof input["maxConcurrent"] === "number" && !("maxConcurrent" in queue)) {
		queue["maxConcurrent"] = input["maxConcurrent"];
	}

	if (Object.keys(defaults).length > 0) migrated["defaults"] = defaults;
	if (Object.keys(output).length > 0) migrated["output"] = output;
	if (Object.keys(queue).length > 0) migrated["queue"] = queue;

	const copySections = ["aliases", "textures", "limits", "ui", "presets", "integrations", "compat"] as const;
	for (const key of copySections) {
		if (key in input) {
			migrated[key] = input[key];
		}
	}

	return validatePartialConfig(migrated);
}

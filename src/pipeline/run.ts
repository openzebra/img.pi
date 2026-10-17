import * as fs from "node:fs/promises";
import type { ImgConfig } from "../config/schema.js";
import type { ImgError } from "../core/errors.js";
import { configInvalid, internalError, unsupportedFeature } from "../core/errors.js";
import { newJobId, toSlug } from "../core/ids.js";
import type { Result } from "../core/result.js";
import { err, ok, tryAsync } from "../core/result.js";
import type { Artifact, ReferenceMetadata, SidecarDocument, UsageSummary } from "../domain/artifact.js";
import { SIDECAR_SCHEMA_VERSION } from "../domain/artifact.js";
import type { JobEvent, JobState } from "../domain/job.js";
import { createInitialJobState, reduceJob } from "../domain/job.js";
import type { GenerationRequest } from "../domain/request.js";
import type { SizeRequest } from "../domain/size.js";
import { Size, snapSize } from "../domain/size.js";
import type { HostPort, PortableCtx } from "../host/port.js";
import type { DurationStatsStore } from "../jobs/progress.js";
import type { JobQueue } from "../jobs/queue.js";
import type { HttpClient } from "../providers/http.js";
import type { PreparedReference, ProviderCtx, ProviderIO, RawImage, ResolvedJob } from "../providers/port.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ManifestStore } from "../storage/manifest.js";
import { expandFilenameTemplate, resolveSafeOutputPath } from "../storage/paths.js";
import { atomicWriteBytes, saveFailedJobRequest, writeArtifact } from "../storage/writer.js";
import type { WorkerPool } from "../workers/pool.js";
import { runPostProcess } from "./post.js";
import { expandPrompt } from "./prompt.js";
import { prepareReferences, prepareSingleReference } from "./refs.js";
import { runTexturePipeline } from "./texture.js";

export interface PipelineDeps {
	readonly host: HostPort;
	readonly hostCtx: PortableCtx;
	readonly config: ImgConfig;
	readonly registry: ProviderRegistry;
	readonly queue: JobQueue;
	readonly pool: WorkerPool;
	readonly http: HttpClient;
	readonly manifest: ManifestStore;
	readonly stats: DurationStatsStore;
}

export interface RunJobOptions {
	readonly jobId?: string;
	readonly signal?: AbortSignal;
	readonly onStateChange?: (state: JobState, ev: JobEvent) => void;
}

export interface ExecutedJobResult {
	readonly job: JobState;
	readonly dryRun: boolean;
	readonly failedRequestPath?: string;
	readonly textureExtra?: {
		readonly seamScore?: number;
		readonly previewRelativePath?: string;
		readonly previewThumbB64?: string;
		readonly previewThumbMimeType?: string;
		readonly materialJsonPath?: string;
	};
}

export async function runGenerationJob(
	request: GenerationRequest,
	deps: PipelineDeps,
	opts: RunJobOptions = {},
): Promise<Result<ExecutedJobResult, ImgError>> {
	const providerCtx: ProviderCtx = {
		host: deps.host,
		hostCtx: deps.hostCtx,
		config: deps.config,
	};

	const modelRes = await deps.registry.resolveModel(request.model, providerCtx);
	if (!modelRes.ok) {
		return modelRes;
	}
	const { model, provider } = modelRes.value;

	// Capability validation & warnings
	const warnings: string[] = [];
	if (request.negativePrompt !== undefined && !model.caps.has("negative_prompt")) {
		warnings.push("negative_prompt ignored (unsupported by model)");
	}
	if (request.steps !== undefined && !model.caps.has("steps")) {
		warnings.push("steps ignored (unsupported by model)");
	}
	if (request.guidance !== undefined && !model.caps.has("guidance")) {
		warnings.push("guidance ignored (unsupported by model)");
	}

	if (request.references.length > 0 && !model.caps.has("multi_ref")) {
		return err(unsupportedFeature(model.id, "multi_ref"));
	}

	if (request.kind === "edit" && request.edit !== undefined) {
		const needsMaskCap =
			request.edit.mode === "inpaint" || request.edit.mode === "outpaint" || request.edit.mask !== undefined;
		if (needsMaskCap && !model.caps.has("inpaint") && !model.caps.has("img2img")) {
			return err(unsupportedFeature(model.id, "inpaint"));
		}
		if (!needsMaskCap && !model.caps.has("img2img")) {
			return err(unsupportedFeature(model.id, "img2img"));
		}
	}

	// Size resolution
	const texSpec = request.kind === "texture" ? request.texture : undefined;
	const isTexture = texSpec !== undefined;
	const rawSizeReq: SizeRequest =
		texSpec !== undefined ? { width: texSpec.resolution, height: texSpec.resolution } : request.sizeRequest;

	const defaultFallbackSize = new Size(deps.config.defaults.size.width, deps.config.defaults.size.height);
	const snapRes = snapSize(rawSizeReq, model.sizes, defaultFallbackSize);
	if (!snapRes.ok) {
		return snapRes;
	}
	const producedProviderSize = snapRes.value.size;
	const requestedSize = snapRes.value.requested;

	if (!snapRes.value.exact && snapRes.value.note !== undefined) {
		warnings.push(snapRes.value.note);
	}

	if (requestedSize.pixels > deps.config.limits.maxPixels) {
		return err(
			configInvalid(
				"size",
				`Requested size ${requestedSize.format()} (${requestedSize.pixels} px) exceeds limits.maxPixels (${deps.config.limits.maxPixels})`,
			),
		);
	}

	const jobId = opts.jobId ?? newJobId();

	// Dry run handling
	if (request.dryRun) {
		const now = Date.now();
		let state = createInitialJobState({
			id: jobId,
			request,
			modelId: model.id,
			providerId: model.provider,
			requestedSize,
			producedSize: request.sizeMode === "exact" ? requestedSize : producedProviderSize,
			createdAt: now,
			warnings,
		});
		state = reduceJob(state, { t: "phase", phase: "done", at: now, detail: "dry run" });
		return ok({
			job: state,
			dryRun: true,
		});
	}

	const expanded = expandPrompt({
		prompt: texSpec !== undefined ? texSpec.material : request.prompt,
		...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
		...(request.style !== undefined ? { style: request.style } : {}),
		isTexture,
		config: deps.config,
	});

	let textureExtra: ExecutedJobResult["textureExtra"];

	const jobResult = await deps.queue.enqueue({
		id: jobId,
		request,
		modelId: model.id,
		providerId: model.provider,
		requestedSize,
		producedSize: request.sizeMode === "exact" ? requestedSize : producedProviderSize,
		warnings,
		...(opts.signal !== undefined ? { signal: opts.signal } : {}),
		...(opts.onStateChange !== undefined ? { onStateChange: opts.onStateChange } : {}),
		run: async (execCtx): Promise<Result<void, ImgError>> => {
			const loadCtx = {
				cwd: deps.hostCtx.cwd,
				allowOutsideCwd: deps.config.output.allowOutsideCwd,
				manifestRelPath: deps.config.output.manifest,
				http: deps.http,
				manifest: deps.manifest,
				pool: deps.pool,
				signal: execCtx.signal,
			};

			// 1. Prepare references
			execCtx.emit({
				t: "phase",
				phase: "preparing",
				at: Date.now(),
				detail: request.references.length > 0 ? "preparing references…" : "preparing…",
			});

			const refsRes = await prepareReferences(request.references, loadCtx);
			if (!refsRes.ok) {
				return refsRes;
			}
			const preparedRefs = refsRes.value;

			let initImage: PreparedReference | undefined;
			let maskImage: PreparedReference | undefined;

			if (request.edit !== undefined) {
				const initRes = await prepareSingleReference(request.edit.image, loadCtx);
				if (!initRes.ok) {
					return initRes;
				}
				initImage = initRes.value;

				if (request.edit.mode === "outpaint" && request.edit.outpaint !== undefined) {
					const op = request.edit.outpaint;
					const outpaintRes = await deps.pool.run({
						op: "outpaint_canvas",
						buffer: initImage.buffer.slice(0),
						left: op.left,
						right: op.right,
						top: op.top,
						bottom: op.bottom,
					});
					if (!outpaintRes.ok) {
						return outpaintRes;
					}
					const canvasEnc = await deps.pool.run({
						op: "encode_b64",
						buffer: outpaintRes.value.canvasBuffer.slice(0),
					});
					if (!canvasEnc.ok) {
						return canvasEnc;
					}
					const maskEnc = await deps.pool.run({
						op: "encode_b64",
						buffer: outpaintRes.value.maskBuffer.slice(0),
					});
					if (!maskEnc.ok) {
						return maskEnc;
					}
					initImage = {
						source: initImage.source,
						role: "init",
						weight: 1,
						buffer: outpaintRes.value.canvasBuffer,
						b64: canvasEnc.value.b64,
						mimeType: "image/png",
						sha256: canvasEnc.value.sha256,
					};
					maskImage = {
						source: "outpaint_mask",
						role: "mask",
						weight: 1,
						buffer: outpaintRes.value.maskBuffer,
						b64: maskEnc.value.b64,
						mimeType: "image/png",
						sha256: maskEnc.value.sha256,
					};
				} else if (request.edit.mask !== undefined) {
					const maskRes = await prepareSingleReference(request.edit.mask, loadCtx);
					if (!maskRes.ok) {
						return maskRes;
					}
					maskImage = maskRes.value;
				}
			}

			// 2. Submit & Generate (one host call per image)
			execCtx.emit({
				t: "phase",
				phase: "submitting",
				at: Date.now(),
				detail: `submitting to ${model.provider}…`,
			});

			const genStartedAt = Date.now();
			execCtx.emit({
				t: "phase",
				phase: "generating",
				at: genStartedAt,
				detail: "generating…",
			});

			const totalWanted = isTexture ? 1 : request.count;
			const rawImages: RawImage[] = [];
			let remaining = totalWanted;
			let callIndex = 0;

			const providerIO: ProviderIO = {
				signal: execCtx.signal,
				emit: execCtx.emit,
				host: deps.host,
				hostCtx: deps.hostCtx,
				config: deps.config,
				pool: deps.pool,
			};

			while (remaining > 0) {
				const batchSeed = request.seed + callIndex;
				const resolvedJob: ResolvedJob = {
					jobId,
					model,
					prompt: request.prompt,
					finalPrompt: expanded.finalPrompt,
					...(expanded.negativePrompt !== undefined ? { negativePrompt: expanded.negativePrompt } : {}),
					size: producedProviderSize,
					requestedSize,
					aspectRatio: snapRes.value.aspectRatio,
					...(request.sizeRequest.imageSize !== undefined ? { imageSize: request.sizeRequest.imageSize } : {}),
					count: 1,
					seed: batchSeed,
					...(request.steps !== undefined ? { steps: request.steps } : {}),
					...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
					quality: request.quality,
					background: request.background,
					...(request.edit !== undefined ? { strength: request.edit.strength } : {}),
					mode: request.edit !== undefined ? request.edit.mode : isTexture ? "texture" : "generate",
					...(texSpec !== undefined ? { tileable: texSpec.tileable } : {}),
					references: preparedRefs,
					...(initImage !== undefined ? { initImage } : {}),
					...(maskImage !== undefined ? { maskImage } : {}),
				};

				const genRes = await provider.generate(resolvedJob, providerIO);
				if (!genRes.ok) {
					return genRes;
				}
				for (const img of genRes.value) {
					rawImages.push(img);
				}
				remaining = remaining - 1;
				callIndex++;
			}

			const genElapsedMs = Math.max(1, Date.now() - genStartedAt);
			deps.stats.recordDuration(model.provider, model.id, producedProviderSize, genElapsedMs);
			void deps.stats.save();

			// Aggregate usage
			let totalInTokens = 0;
			let totalOutTokens = 0;
			let hasTokenUsage = false;
			let reportedCostUsd: number | undefined;
			for (const img of rawImages) {
				if (img.usage?.costUsd !== undefined) {
					reportedCostUsd = (reportedCostUsd ?? 0) + img.usage.costUsd;
				}
				if (img.usage?.inputTokens !== undefined) {
					totalInTokens = totalInTokens + img.usage.inputTokens;
					hasTokenUsage = true;
				}
				if (img.usage?.outputTokens !== undefined) {
					totalOutTokens = totalOutTokens + img.usage.outputTokens;
					hasTokenUsage = true;
				}
			}
			const aggUsage: UsageSummary = {
				...(hasTokenUsage && totalInTokens > 0 ? { inputTokens: totalInTokens } : {}),
				...(hasTokenUsage && totalOutTokens > 0 ? { outputTokens: totalOutTokens } : {}),
				images: rawImages.length,
				...(reportedCostUsd !== undefined ? { costUsd: reportedCostUsd } : {}),
			};
			execCtx.emit({ t: "usage", usage: aggUsage, at: Date.now() });

			const refsMeta: ReferenceMetadata[] = preparedRefs.map(r => ({
				source: r.source,
				sha256: r.sha256,
				role: r.role,
				weight: r.weight,
			}));

			// 3. Texture pipeline branch
			if (texSpec !== undefined) {
				const firstRaw = rawImages[0];
				if (firstRaw === undefined) {
					return err(internalError("Provider returned no images for texture generation"));
				}
				execCtx.emit({
					t: "phase",
					phase: "postprocess",
					at: Date.now(),
					detail: "synthesizing PBR maps…",
				});
				const texRes = await runTexturePipeline({
					jobId,
					albedoRawBuffer: firstRaw.buffer,
					request,
					texSpec,
					modelId: model.id,
					reportedModel: firstRaw.reportedModel ?? model.id,
					providerId: model.provider,
					finalPrompt: expanded.finalPrompt,
					...(expanded.negativePrompt !== undefined ? { negativePrompt: expanded.negativePrompt } : {}),
					...(expanded.resolvedStyle !== undefined ? { resolvedStyle: expanded.resolvedStyle } : {}),
					requestedSize,
					seed: firstRaw.seed ?? request.seed,
					referencesMeta: refsMeta,
					usage: aggUsage,
					cwd: deps.hostCtx.cwd,
					hostKind: deps.host.kind,
					config: deps.config,
					pool: deps.pool,
					manifest: deps.manifest,
					onProgressDetail: (detail: string) => {
						execCtx.emit({
							t: "phase",
							phase: "postprocess",
							at: Date.now(),
							detail,
						});
					},
				});
				if (!texRes.ok) {
					return texRes;
				}
				execCtx.emit({
					t: "phase",
					phase: "saving",
					at: Date.now(),
					detail: "saving texture maps…",
				});
				for (const art of texRes.value.artifacts) {
					execCtx.emit({ t: "artifact", artifact: art, at: Date.now() });
				}
				textureExtra = {
					...(texRes.value.seamScore !== undefined ? { seamScore: texRes.value.seamScore } : {}),
					...(texRes.value.previewRelativePath !== undefined
						? { previewRelativePath: texRes.value.previewRelativePath }
						: {}),
					...(texRes.value.previewThumbB64 !== undefined ? { previewThumbB64: texRes.value.previewThumbB64 } : {}),
					...(texRes.value.previewThumbMimeType !== undefined
						? { previewThumbMimeType: texRes.value.previewThumbMimeType }
						: {}),
					...(texRes.value.materialJsonPath !== undefined
						? { materialJsonPath: texRes.value.materialJsonPath }
						: {}),
				};
				return ok(undefined);
			}

			// 4. Standard image / edit postprocess + save
			execCtx.emit({
				t: "phase",
				phase: "postprocess",
				at: Date.now(),
				detail: "post-processing…",
			});

			const postResults = new Array<{
				readonly raw: RawImage;
				readonly post: Awaited<ReturnType<typeof runPostProcess>> extends Result<infer T, ImgError> ? T : never;
			}>(rawImages.length);

			for (let i = 0; i < rawImages.length; i++) {
				const raw = rawImages[i];
				if (raw === undefined) continue;
				const postRes = await runPostProcess({
					buffer: raw.buffer,
					requestedSize,
					sizeMode: request.sizeMode,
					fit: request.fit,
					post: request.post,
					background: request.background,
					modelSupportsTransparentBg: model.caps.has("transparent_bg"),
					format: request.output.format,
					compression: request.output.compression,
					embedMetadata: deps.config.output.embedMetadata,
					metadataToEmbed: {
						prompt: request.prompt,
						seed: String(raw.seed ?? request.seed + i),
						model: model.id,
					},
					returnImage: request.output.returnImage,
					pool: deps.pool,
				});
				if (!postRes.ok) {
					return postRes;
				}
				postResults[i] = { raw, post: postRes.value };
			}

			execCtx.emit({
				t: "phase",
				phase: "saving",
				at: Date.now(),
				detail: "writing files…",
			});

			const now = new Date();
			const createdAtIso = now.toISOString();
			const sidecarsToAppend: SidecarDocument[] = [];

			for (let i = 0; i < postResults.length; i++) {
				const item = postResults[i];
				if (item === undefined) continue;
				const index = i + 1;
				const itemSeed = item.raw.seed ?? request.seed + i;

				const stemRes = expandFilenameTemplate(request.output.filenameTemplate, {
					prompt: request.prompt,
					index,
					seed: itemSeed,
					model: model.id,
					provider: model.provider,
					width: item.post.width,
					height: item.post.height,
					jobId,
					tags: request.tags,
					now,
				});
				if (!stemRes.ok) {
					return stemRes;
				}

				const pathRes = await resolveSafeOutputPath({
					cwd: deps.hostCtx.cwd,
					outputDir: request.output.dir,
					relativeStem: stemRes.value,
					format: item.post.format,
					allowOutsideCwd: deps.config.output.allowOutsideCwd,
					onConflict: request.output.onConflict,
				});
				if (!pathRes.ok) {
					return pathRes;
				}

				const unitCost =
					aggUsage.costUsd !== undefined ? Number((aggUsage.costUsd / postResults.length).toFixed(4)) : null;

				const artifactRes = await writeArtifact({
					absolutePath: pathRes.value.absolutePath,
					relativePath: pathRes.value.relativePath,
					imageBuffer: item.post.buffer,
					writeSidecar: deps.config.output.sidecar,
					summary: {
						index,
						width: item.post.width,
						height: item.post.height,
						format: item.post.format,
						sha256: item.post.sha256,
						...(item.post.thumbB64 !== undefined ? { thumbB64: item.post.thumbB64 } : {}),
						...(item.post.thumbMimeType !== undefined ? { thumbMimeType: item.post.thumbMimeType } : {}),
					},
					sidecar: {
						schema: SIDECAR_SCHEMA_VERSION,
						job: jobId,
						index,
						createdAt: createdAtIso,
						host: deps.host.kind,
						provider: model.provider,
						model: model.id,
						reportedModel: item.raw.reportedModel ?? model.id,
						prompt: request.prompt,
						negativePrompt: expanded.negativePrompt ?? null,
						style: expanded.resolvedStyle ?? null,
						finalPrompt: expanded.finalPrompt,
						seed: itemSeed,
						steps: request.steps ?? null,
						guidance: request.guidance ?? null,
						quality: request.quality,
						requestedSize: [requestedSize.width, requestedSize.height],
						producedSize: [item.post.width, item.post.height],
						post: item.post.appliedOps,
						references: refsMeta,
						sha256: item.post.sha256,
						format: item.post.format,
						usage:
							item.raw.usage !== undefined
								? {
										...(item.raw.usage.inputTokens !== undefined
											? { input: item.raw.usage.inputTokens }
											: {}),
										...(item.raw.usage.outputTokens !== undefined
											? { output: item.raw.usage.outputTokens }
											: {}),
										...(item.raw.usage.images !== undefined ? { images: item.raw.usage.images } : {}),
									}
								: null,
						costUsd: unitCost,
						texture: null,
						tags: request.tags,
						metadata: request.metadata,
					},
				});
				if (!artifactRes.ok) {
					return artifactRes;
				}

				sidecarsToAppend.push(artifactRes.value.sidecar);
				execCtx.emit({ t: "artifact", artifact: artifactRes.value, at: Date.now() });
			}

			const manifestRes = await deps.manifest.append(
				deps.hostCtx.cwd,
				deps.config.output.manifest,
				sidecarsToAppend,
			);
			if (!manifestRes.ok) {
				return manifestRes;
			}

			return ok(undefined);
		},
	});

	if (!jobResult.ok) {
		if (jobResult.error.kind !== "aborted") {
			await saveFailedJobRequest(deps.hostCtx.cwd, jobId, request.toPlain(), jobResult.error);
		}
		return jobResult;
	}

	return ok({
		job: jobResult.value,
		dryRun: false,
		...(textureExtra !== undefined ? { textureExtra } : {}),
	});
}

export interface VariationsBatchSpec {
	readonly requests: readonly GenerationRequest[];
	readonly labels: readonly string[];
	readonly outputDir: string;
	readonly basePrompt: string;
}

export interface VariationsBatchResult {
	readonly jobs: readonly JobState[];
	readonly artifacts: readonly Artifact[];
	readonly contactSheetRelativePath?: string;
	readonly contactSheetThumbB64?: string;
	readonly contactSheetThumbMimeType?: string;
}

export async function runVariationsBatch(
	spec: VariationsBatchSpec,
	deps: PipelineDeps,
	opts: {
		readonly signal?: AbortSignal;
		readonly onProgress?: (completed: number, total: number, latestJob: JobState) => void;
	} = {},
): Promise<Result<VariationsBatchResult, ImgError>> {
	if (spec.requests.length === 0) {
		return err(configInvalid("vary", "Variations expansion produced 0 requests"));
	}
	if (spec.requests.length > deps.config.limits.maxBatch) {
		return err(
			configInvalid(
				"vary",
				`Variation count (${spec.requests.length}) exceeds limits.maxBatch (${deps.config.limits.maxBatch})`,
			),
		);
	}

	let completed = 0;
	const total = spec.requests.length;

	const promises = spec.requests.map(async req => {
		const res = await runGenerationJob(req, deps, {
			...(opts.signal !== undefined ? { signal: opts.signal } : {}),
		});
		if (res.ok) {
			completed++;
			opts.onProgress?.(completed, total, res.value.job);
		}
		return res;
	});

	const results = await Promise.all(promises);
	const jobs: JobState[] = [];
	const artifacts: Artifact[] = [];

	for (const r of results) {
		if (!r.ok) {
			return r;
		}
		jobs.push(r.value.job);
		for (const art of r.value.job.artifacts) {
			artifacts.push(art);
		}
	}

	// Build contact sheet if we have ≥1 artifact on disk
	let contactSheetRelativePath: string | undefined;
	let contactSheetThumbB64: string | undefined;
	let contactSheetThumbMimeType: string | undefined;

	if (artifacts.length > 0) {
		const buffers: ArrayBuffer[] = [];
		for (const art of artifacts) {
			const readRes = await tryAsync(
				() => fs.readFile(art.summary.path),
				() => undefined,
			);
			if (readRes.ok) {
				const u8 = readRes.value;
				buffers.push(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
			}
		}

		if (buffers.length > 0) {
			const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(buffers.length))));
			const sheetRes = await deps.pool.run({
				op: "contact_sheet",
				buffers,
				labels: spec.labels,
				cols,
				thumbSize: 256,
			});
			if (sheetRes.ok) {
				const slug = toSlug(spec.basePrompt, 36);
				const pathRes = await resolveSafeOutputPath({
					cwd: deps.hostCtx.cwd,
					outputDir: spec.outputDir,
					relativeStem: `${slug}_sheet`,
					format: "png",
					allowOutsideCwd: deps.config.output.allowOutsideCwd,
					onConflict: "suffix",
				});
				if (pathRes.ok) {
					const writeSheet = await atomicWriteBytes(
						pathRes.value.absolutePath,
						new Uint8Array(sheetRes.value.buffer.slice(0)),
					);
					if (writeSheet.ok) {
						contactSheetRelativePath = pathRes.value.relativePath;
					}
				}
				const thumbRes = await deps.pool.run({
					op: "thumbnail",
					buffer: sheetRes.value.buffer,
					maxSide: 512,
					quality: 80,
				});
				if (thumbRes.ok) {
					contactSheetThumbB64 = thumbRes.value.b64;
					contactSheetThumbMimeType = thumbRes.value.mimeType;
				}
			}
		}
	}

	return ok(
		Object.freeze({
			jobs: Object.freeze(jobs),
			artifacts: Object.freeze(artifacts),
			...(contactSheetRelativePath !== undefined ? { contactSheetRelativePath } : {}),
			...(contactSheetThumbB64 !== undefined ? { contactSheetThumbB64 } : {}),
			...(contactSheetThumbMimeType !== undefined ? { contactSheetThumbMimeType } : {}),
		}),
	);
}

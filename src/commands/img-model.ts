import { formatImgError } from "../core/errors.js";
import type { PortableCommand, PortableCtx } from "../host/port.js";
import type { CommandDeps } from "./img.js";

export function createImgModelCommand(deps: CommandDeps): PortableCommand {
	return {
		description: "Switch the session image generation model (or select interactively when no ID is given)",
		async handler(args: string, ctx: PortableCtx): Promise<void> {
			try {
				const pDeps = deps.getPipelineDeps(ctx);
				let targetModel = args.trim();

				if (targetModel.length === 0) {
					const listRes = await pDeps.registry.listModels(pDeps);
					if (!listRes.ok || listRes.value.length === 0) {
						ctx.ui.notify("No image models available to select.", "warning");
						return;
					}
					const options = listRes.value.map(e => e.model.id);
					const selected = await ctx.ui.select("Select default image model (session)", options);
					if (selected === undefined || selected.trim().length === 0) {
						return;
					}
					targetModel = selected.trim();
				}

				const resolved = await pDeps.registry.resolveModel(targetModel, pDeps);
				if (!resolved.ok) {
					ctx.ui.notify(formatImgError(resolved.error), "error");
					return;
				}

				const existingSession = deps.configStore.getLayers().session;
				const setRes = deps.configStore.setSessionLayer({
					...existingSession,
					defaults: {
						...existingSession?.defaults,
						model: resolved.value.model.id,
					},
				});
				if (!setRes.ok) {
					ctx.ui.notify(formatImgError(setRes.error), "error");
					return;
				}

				ctx.ui.notify(`Session image model set to ${resolved.value.model.id}`, "info");
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Failed to switch image model: ${msg}`, "error");
			}
		},
	};
}

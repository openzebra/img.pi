import type { PortableCommand, PortableCtx } from "../host/port.js";
import type { CommandDeps } from "./img.js";
import { openStudioOverlay } from "./img.js";

export function createImgQueueCommand(deps: CommandDeps): PortableCommand {
	return {
		description: "Open img.pi Studio directly on Tab 3 (Queue)",
		async handler(_args: string, ctx: PortableCtx): Promise<void> {
			try {
				await openStudioOverlay(ctx, deps, { initialTab: 3 });
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Failed to open img:queue: ${msg}`, "error");
			}
		},
	};
}

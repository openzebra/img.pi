import type { PortableCommand, PortableCtx } from "../host/port.js";
import type { CommandDeps } from "./img.js";
import { openStudioOverlay } from "./img.js";

export function createImgGalleryCommand(deps: CommandDeps): PortableCommand {
	return {
		description: "Open img.pi Studio directly on Tab 2 (Gallery), optionally filtered by #tag or query",
		async handler(args: string, ctx: PortableCtx): Promise<void> {
			try {
				const trimmed = args.trim();
				await openStudioOverlay(ctx, deps, {
					initialTab: 2,
					...(trimmed.length > 0 ? { initialGalleryFilter: trimmed } : {}),
				});
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Failed to open img:gallery: ${msg}`, "error");
			}
		},
	};
}

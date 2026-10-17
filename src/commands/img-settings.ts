import type { PortableCommand, PortableCtx } from "../host/port.js";
import type { CommandDeps } from "./img.js";
import { openStudioOverlay } from "./img.js";

export function createImgSettingsCommand(deps: CommandDeps): PortableCommand {
	return {
		description: "Open img.pi Studio directly on Tab 5 (Settings)",
		async handler(_args: string, ctx: PortableCtx): Promise<void> {
			try {
				await openStudioOverlay(ctx, deps, { initialTab: 5 });
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`Failed to open img:settings: ${msg}`, "error");
			}
		},
	};
}

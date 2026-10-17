# @hicaru/img-pi

Image and PBR texture generation extension for **omp** (`@oh-my-pi/pi-coding-agent`, primary) and **pi** (`@earendil-works/pi-coding-agent`, secondary).

## Features

- **Dual-host architecture**: One package supporting both `omp` and `pi` via runtime `HostPort` detection and normalized tool renderers.
- **6 Agent Tools**:
   - `img_generate` — Text-to-image with up to 16 reference images, exact pixel sizing (`cover` / `contain` / `fill`), post-processing (`trim`, `remove_background`, `upscale`, `sharpen`, `grayscale`, `palette`), and deterministic `.json` sidecars.
   - `img_edit` — Image-to-image, masked inpaint, 4-direction outpaint, and variations using file paths, URLs, `data:` URIs, or `@last` / `@job:<id>[#n]` references.
   - `img_texture` — Seamless tileable PBR material pipeline generating `albedo`, `normal` (OpenGL/DirectX Sobel 3×3), `height`, `roughness`, `ao` (multi-scale horizon occlusion), `metallic`, packed `orm`, a 2×2 tiled preview PNG, and a glTF 2.0 `material.json`.
   - `img_variations` — Batch sweeps across `seeds`, `prompts`, `models`, and `styles` (`cartesian` or `zip` up to `limits.maxBatch = 32`) with an automatic labeled contact sheet.
   - `img_list_models` — Live catalog of host-native and direct provider models with capabilities, size rules, key status (`✓`/`✗`/`⌂`), and cost hints.
   - `img_describe_job` — Full sidecar JSON lookup for `@last` or any job ID prefix so generations can be reproduced or tweaked.
- **Interactive TUI Studio (`/img` or `Ctrl+Alt+I`)**:
   - 5-tab full-screen overlay: **1 Compose**, **2 Gallery**, **3 Queue**, **4 Compare A/B**, and **5 Settings** (`user` / `project` scopes with provenance badges).
   - Live tool-call cards with 5-phase progress bar, EWMA ETA, and inline terminal thumbnails (`Image` component with `ImageBudget` eviction and half-block/text fallbacks).
   - Persistent queue widget above the editor and status-line segment.
- **Off-main-thread Worker Pool**: All heavy image decoding, resizing, Sobel normal synthesis, multi-band seamless blending, AO, ORM packing, and >1 MB manifest parsing run in worker threads (`src/workers/image.worker.ts`) with zero-copy `ArrayBuffer` transfers.

---

## Installation

```bash
bun install
bun run build
```

### Link into `omp` (`@oh-my-pi/pi-coding-agent`)

```bash
bun run link:omp
# Links into ~/.omp/agent/extensions/img-pi
```

Or add to `.omp/settings.json` / `~/.omp/agent/settings.json`:

```json
{
	"extensions": ["/path/to/img.pi/dist/index.js"]
}
```

### Link into `pi` (`@earendil-works/pi-coding-agent`)

```bash
bun run link:pi
# Links into ~/.pi/agent/extensions/img-pi
```

---

## Provider Configuration & Environment Variables

| Provider              | Default Status                               | API Key Env Var / Endpoint                                                                        | Example Models                                                                                  |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `host` (`omp` / `pi`) | Enabled                                      | Reuses `ctx.modelRegistry.getApiKey()` (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) | `openai/gpt-image-1`, `google/gemini-2.5-flash-image-preview`, `google/imagen-3.0-generate-002` |
| `fal`                 | Enabled                                      | `FAL_KEY`                                                                                         | `fal/flux-schnell`, `fal/flux-dev`, `fal/flux-pro-v1.1`, `fal/recraft-v3`                       |
| `replicate`           | Opt-in (`providers.replicate.enabled: true`) | `REPLICATE_API_TOKEN`                                                                             | `replicate/black-forest-labs/flux-schnell`, any `replicate/<owner>/<name>`                      |
| `stability`           | Opt-in (`providers.stability.enabled: true`) | `STABILITY_API_KEY`                                                                               | `stability/sd3.5-large`, `stability/ultra`, `stability/core`                                    |
| `comfyui`             | Opt-in (`providers.comfyui.enabled: true`)   | `http://127.0.0.1:8188`                                                                           | `comfyui/sdxl-pbr`, custom workflow JSONs                                                       |
| `a1111`               | Opt-in (`providers.a1111.enabled: true`)     | `http://127.0.0.1:7860`                                                                           | `a1111/default` (`tiling: true` native seamless)                                                |
| `mock`                | Always available                             | Local / deterministic                                                                             | `mock/gradient`, `mock/solid`                                                                   |

---

## Slash Commands & Shortcuts

| Command / Key         | Description                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| `/img [prompt]`       | Open the Studio overlay on Tab 1 (**Compose**), prefilling the prompt if provided |
| `/img:gallery [#tag]` | Open Studio on Tab 2 (**Gallery**), optionally filtered by `#tag` or query        |
| `/img:queue`          | Open Studio on Tab 3 (**Queue**) to inspect, pause, or cancel jobs                |
| `/img:settings`       | Open Studio on Tab 5 (**Settings**) to edit user or project config                |
| `/img:model [id]`     | Switch the session default image model directly or via interactive selector       |
| `Ctrl+Alt+I`          | Toggle the Studio overlay from anywhere in the TUI                                |

---

## Development & Verification

```bash
bun run check      # tsc --noEmit && eslint . --max-warnings 0 && bun test
bun run build      # Bundles dist/index.js and dist/workers/image.worker.js
bun run fmt        # Prettier format
```

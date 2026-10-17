# @hicaru/img-pi

Image and PBR texture generation extension for **omp** (`@oh-my-pi/pi-coding-agent`, primary) and **pi** (`@earendil-works/pi-coding-agent`, secondary).

## How it works

Open omp or pi and ask for a picture: _"draw me a ginger cat on a windowsill"_. The agent calls `img_generate` itself, using an image model from a provider you have already connected in the host (`/login`). The image is saved under `.pi/img/images/` and shown inline in the TUI. There is nothing to configure and no command to run.

- **Models come from the host.** If you have only Google connected, only Google image models are used and listed; there is no built-in model list, and no API keys are read by this extension. Ask the agent _"which image models do I have?"_ to see them (`img_list_models`).
- **Cost** is shown only when the host reports it.

## Tools (called by the agent)

- `img_generate`: text to image, with optional references, sizing, post-processing (`trim`, `remove_background`, `upscale`, `sharpen`, `grayscale`, `palette`) and a reproducible `.json` sidecar.
- `img_edit`: change an existing image (`@last`, `@job:<id>[#n]`, a path or a URL), including masked inpaint and outpaint. Needs a model that accepts input images.
- `img_texture`: seamless PBR material set (`albedo`, `normal`, `height`, `roughness`, `ao`, `metallic`, `orm`), a 2×2 tile preview and a glTF `material.json`.
- `img_variations`: batch sweeps over seeds, prompts, models and styles, with a labeled contact sheet.
- `img_list_models`: the image models available in this session, grouped by provider, with the default marked.
- `img_describe_job`: the full sidecar for `@last` or a job id, to reproduce or tweak a result.

`img_generate` and `img_edit` are always visible to the agent. With `compat.hideBuiltin` (default `true`), omp's built-in `generate_image` is hidden so there is one obvious image tool.

## Where files go

Everything is written under `<project>/.pi/img/` on both hosts:

| Path                        | Contents                               |
| --------------------------- | -------------------------------------- |
| `.pi/img/images/`           | Generated and edited images + sidecars |
| `.pi/img/textures/`         | Texture sets                           |
| `.pi/img/manifest.jsonl`    | One line per artifact                  |
| `.pi/img/failed/<job>.json` | Request of a failed job, for retrying  |

Heavy image work (decode, resize, normal/AO synthesis, seam blending, large manifest parsing) runs in worker threads.

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

## Configuration (optional)

`img-pi.json` in `~/.omp/agent/` or `~/.pi/agent/` (user), or in `<project>/.omp/` / `<project>/.pi/` (project). Common keys:

- `defaults.model`: preferred model id from `img_list_models` (default `"auto"`: the host session's image model, otherwise the first available).
- `aliases`: your own short names for model ids.
- `output.*`, `textures.*`, `queue.maxConcurrent`, `ui.*` (status segment, queue widget, inline preview size).

`--img-model <id>` sets the model for one session.

---

## Development & Verification

```bash
bun run check      # tsc --noEmit && eslint . --max-warnings 0 && bun test
bun run build      # Bundles dist/index.js and dist/workers/image.worker.js
bun run fmt        # Prettier format
```

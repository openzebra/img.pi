# AGENTS.md — img.pi

Image/texture generation extension for omp (`@oh-my-pi/pi-coding-agent`, primary) and pi (`@earendil-works/pi-coding-agent`).
Master plan: `/tmp/img-pi-PLAN.md`. Read it before any change.

Rules are **MUST** unless marked otherwise. A violation blocks merge. `bun run check` (typecheck + lint + test) must pass with zero warnings.

---

## 0. Harness first: the host is the source of truth

The product is: the user says "draw me a cat" in omp/pi, the agent calls `img_generate` itself, and the image lands in `.pi/img`. Every rule below serves that.

- **Generation is agent-driven.** No slash command, shortcut, or overlay ever generates an image. The user surface is a passive HUD (status segment, queue widget) and `/img` Studio (`src/commands/img.ts`) for looking and configuring only: Models (pick the default from host models), Settings (writes `img-pi.json` via `ConfigStore.patchScope`), Gallery (manifest + host `Image` preview). Do not add generate/compose UI or more commands without an explicit product decision.
- **Studio keys come from the host.** Use `host.parseKey` (host TUI `parseKey`) and `keyToAction` in `src/ui/studio-state.ts`; never parse escape sequences by hand. Settings rows are declared once in `src/ui/settings-fields.ts` (typed read/patch per key); add a setting there, nowhere else.
- **Agent-facing tools must be visible.** `img_generate` and `img_edit` set `essential: true` and `approval` (→ omp `loadMode: "essential"`, `oh-my-pi/packages/coding-agent/src/tools/essential-tools.ts:45`; extension tools are otherwise _discoverable_ and hidden from the top-level list) and `promptSnippet` / `promptGuidelines` (→ pi, which omits custom tools from "Available tools" without a snippet, `pi/packages/coding-agent/src/core/extensions/types.ts:587`). Descriptions tell the agent _when_ to call the tool. `test/e2e/*` asserts this.
- **Ask the host, never hardcode.** Model lists, display names, credentials, capabilities, request knobs, and prices come from the host API:
   - omp: `ctx.modelRegistry.getAvailable("all")` filtered by `kind === "image"` and `isImageGenerationApi(api)`; generate with `generateImage()` + `getApiKey`/`resolver`/`resolveModelHeaders` (mirror `oh-my-pi/packages/coding-agent/src/tools/image-gen.ts`).
   - pi: `ctx.modelRegistry.getAvailableOfType("image")` and `ctx.modelRegistry.generateImages()` (request-time auth).
   - Capabilities derive from the host model's `input` modalities; request knobs from the host transport (`HostImageOptions`).
- **Forbidden in `src/`:** model-ID tables, default/fallback model lists, env-var key lookups for host providers (`OPENAI_API_KEY`, …), cost/price literals (`"$0.04"`, `?? 0.04`), per-provider limit tables, and branching on provider or model name strings (`provider.startsWith("openai")`, `id.includes("imagen")`). If a fact is not available from the host, it stays absent; do not invent a default.
- **No catch-all flags.** No `hasKey`-style booleans or `provider === "mock"` checks: if a model is not usable, the host does not list it, so neither do we. Test doubles (`FakeHost`, the `@oh-my-pi/pi-ai` stub, PNG fixtures) live in `test/fixtures/` and are never registered at runtime.
- **No magic.** Every non-obvious literal is a named frozen constant with a one-line "why" (and a host `file:line` when it mirrors a host fact).
- **Cost is reported, never estimated.** Show `usage.cost` only when the host returns it.
- **Artifacts live in `<cwd>/.pi/img`** on both hosts (`images/`, `textures/`, `manifest.jsonl`, `failed/`). Use `ARTIFACT_PATHS` / `failedRequestRelPath` from `src/domain/artifact-paths.ts`; no path string literals elsewhere.

## 1. DRY: absolute

- Never copy/paste logic. When a second use appears, extract it first, then use it twice.
- Single sources of truth:
   - Tool parameter fields → `src/tools/schemas.ts` fragments only.
   - Errors → `src/core/errors.ts` (`ImgError` union).
   - Result/Either → `src/core/result.ts`.
   - HTTP (timeout, retry, abort, decode) → `src/providers/http.ts`.
   - Path/template/sandbox → `src/storage/paths.ts`.
   - Host differences → `src/host/*` only. No `if (host.kind === …)` outside `src/host/`.
   - Renderer signature differences → `src/host/render-shim.ts` only.
   - Colors/glyphs → `src/ui/theme.ts`, `src/ui/glyphs.ts`.
   - Shared host-adapter logic → `src/host/base.ts` (`BaseHost`); `omp.ts` / `pi.ts` contain only real host differences.
   - Artifact paths → `src/domain/artifact-paths.ts`.
- Reuse host APIs; do not re-implement them (§0): models, auth, and generation go through the host model registry and `generateImage()` / `generateImages()`. There are no direct provider adapters. Terminal images go through the host `Image` component (`host.imageComponent`).
- Duplicate string literals used ≥2 times become a frozen constant.

## 2. Types: strict, no dynamic types

- `tsconfig.json` MUST keep: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`.
- `any` is forbidden (explicit, implicit, `as any`, `any[]`, `Record<string, any>`). Use `unknown` and narrow with type guards.
- No `as` casts to widen or lie. Allowed: `as const`, `satisfies`. Narrowing happens through guards (`isX(v): v is X`) or schema validation (arktype).
- `@ts-ignore` and `@ts-expect-error` are forbidden. `// eslint-disable` needs a linked justification comment and reviewer approval.
- Exhaustive `switch` over unions: `default` branch assigns to `never` (`const _x: never = v`).
- Prefer discriminated unions over boolean flags and optional bags.

## 3. Null / undefined safety

- Non-null assertion `!` is forbidden. Use `?.`, `??`, explicit guards, or `Result`.
- Optional properties use `?:` only. **Never** write `x?: T | undefined` or `x: T | undefined` for an optional field:
   - ✅ `apiKeyEnv?: string`
   - ❌ `apiKeyEnv?: string | undefined`
   - ❌ `apiKeyEnv: string | undefined` (when the field is optional)
   - `T | undefined` is allowed only for return types and required parameters whose absence is meaningful (e.g. `find(): T | undefined`). Host-mandated signatures (e.g. `signal: AbortSignal | undefined` in `execute`) are copied verbatim in `src/host/*` only.
- Do not mix `null` and `undefined` for the same concept. Internally use `undefined`; `null` appears only in serialized JSON (sidecar/config).
- Index access results (`arr[i]`, `rec[k]`) are `T | undefined`. Handle it; never assert.

## 4. Errors: no crashes

- Code never throws across module boundaries. Fallible functions return `Result<T, ImgError>` (`src/core/result.ts`).
- Every external edge (fs, fetch, worker, host API, JSON.parse, sharp) is wrapped once via `tryAsync`/`trySync` and mapped to an `ImgError` variant.
- Tool `execute` top level: never rejects. `Err` → `AgentToolResult` with `isError: true` and structured text.
- Event handlers, timers, and UI callbacks wrap their bodies in try/catch → log + `ui.notify(…,"error")`. No unhandled promise: `no-floating-promises` and `no-misused-promises` are errors; fire-and-forget uses `void runSafe(…)`.
- `catch (e: unknown)` only; narrow before use.
- Abort is not an error to the user. `aborted` renders as cancelled, not failed.

## 5. Event loop: heavy work off the main thread

- Image decode/encode, base64 of >256 KB, resize, pixel math (Sobel, blur, AO, seam blend), contact sheets, JSON parse of >1 MB, and hashing of >1 MB all run in `src/workers/image.worker.ts` via `src/workers/pool.ts`.
- Transfer `ArrayBuffer`s (transfer list); do not structured-clone large buffers.
- The main thread does orchestration, IO awaits, and rendering only. Perf test: event-loop delay p99 < 20 ms during a 32-job batch.
- No sync fs (`readFileSync`, `writeFileSync`, `existsSync`) outside config bootstrap at load time.

## 6. UI: pure, fast, zero waste

- Components (`src/ui/components/*`, `src/ui/screens/*`) are pure: `render(width): string[]` from a ViewModel. No IO, no business logic, no `Date.now()`, no config reads, no allocation-heavy work inside `render`.
- ViewModels are built in `src/ui/view-models.ts` (pure selectors) and memoized by `(vm hash, width)`. A changed hash or width is the only trigger for recomputation. `invalidate()` clears the cache.
- One shared ticker (`src/ui/ticker.ts`) for all spinners. It runs only while a job is active and is stopped on `session_shutdown`.
- `requestRender` is throttled to ≤ 10 Hz from progress events.
- Gallery uses a shared `ImageBudget` and renders only visible thumbnails.
- Frozen constants: spinner frames, glyphs, theme token maps, defaults, phase weights, and capability tables are all wrapped in `Object.freeze` (deep for nested, via `src/core/freeze.ts`).
- Gate terminal graphics on `ctx.mode === "tui"` and host capability; always provide the text fallback.

## 7. Memory and collections

- Known size → preallocate: `Array.from({ length: n }, f)` or `new Array<T>(n)` filled by index. Do not `push` in loops when `n` is known.
- Typed arrays (`Float32Array`, `Uint8ClampedArray`) for pixel data; reuse buffers within an op.
- Clear listeners, intervals, and AbortControllers on job end and session shutdown. Every `on(...)` returns a disposer that is called.

## 8. Strings

- Never `+`/`+=` strings inside loops. Collect parts into an array (preallocated when the size is known) and `.join("")`.
- Template literals are fine outside loops.
- Line rendering builds `string[]` rows; no repeated full-string concatenation.

## 9. Data objects

- All DTO / VO / config / event properties are `readonly`. Arrays are `readonly T[]`; maps/sets are `ReadonlyMap`/`ReadonlySet`.
- Value objects that are compared (`GenerationRequest`, `Size`, `OutputSpec`, `TextureSpec`, `ReferenceImage`) implement `equals(other): boolean` and `hashCode(): string` (stable, from canonical JSON) in `src/core/equals.ts` helpers. No ad-hoc deep comparisons.
- Never mutate inputs; reducers return new objects.

## 10. Native memory (sharp / FFI / Wasm / N-API)

- sharp pipelines live only inside the worker op that created them. Call `.destroy()` on abort or error paths.
- Workers are terminated on `session_shutdown`; pool shutdown awaits `terminate()`.
- Any FFI/Wasm allocation is paired with an explicit free in `finally`. No native handle escapes its op.

## 11. Architecture boundaries

Allowed import direction: `host → app (wire, tools, commands, ui) → services (jobs, pipeline, providers, storage) → domain/core`. `workers/*` is imported only by `workers/pool.ts`.

- Only `src/host/*` and `src/index.ts` import `@oh-my-pi/*` or `@earendil-works/*` (type imports are allowed in `src/host/render-shim.ts`).
- `domain/*` and `core/*` do no IO and import nothing from services or host.
- Service construction happens only in `src/wire.ts` (composition root). Dependencies are passed explicitly; no module-level singletons with state.
- Enforced with `eslint-plugin-boundaries`.

## 12. Security / IO

- Output paths: resolve against `ctx.cwd`. Outside-cwd writes require `output.allowOutsideCwd`. Never write into `.git/`, `node_modules/`, or host config dirs (`.omp/`, `.pi/`), except img.pi's own `.pi/img/`.
- Atomic writes (tmp + fsync + rename).
- Secrets: never logged, never written to config/sidecar/manifest. Errors name the env var only.
- Reference URLs: http(s) only, 30 s timeout, 50 MB cap, content-type must be `image/*`.

## 13. Tooling and style

- ESLint 9 flat config with `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`. Mandatory errors: `no-explicit-any`, `no-non-null-assertion`, `no-unsafe-*`, `switch-exhaustiveness-check`, `no-floating-promises`, `no-misused-promises`, `consistent-type-imports`, `prefer-readonly`, `boundaries/element-types`.
- Prettier 3 (`.prettierrc.json`): tabs, width 120, double quotes, trailing commas `all`. Matches omp repo style (`oh-my-pi/.oxfmtrc.json`).
- File names kebab-case. Types PascalCase. Functions camelCase. Constants `SCREAMING_SNAKE` only for frozen module constants.
- One exported concept per file where practical. No barrel re-exports in `domain/` (prevents cycles).
- Tests sit beside the layer under `test/<layer>/`. Each bug fix lands with a regression test.

## 14. Change protocol for agents

1. Read `/tmp/img-pi-PLAN.md` and the referenced host sources (`~/projects/zebra/oh-my-pi`, `~/projects/zebra/pi`) before touching host-facing code. Do not guess host APIs; cite file:line in code comments for mirrored facts and in the PR description.
2. Search for existing helpers before writing new ones (`rg` in `src/`). DRY check is part of review.
3. Keep diffs focused. No drive-by refactors mixed with features.
4. Run `bun run check`. Zero warnings.
5. Update the plan's milestone table and open questions when a decision changes.
6. Before finishing, run the §0 audit: `rg -n 'costHint|costPerImageUsd|hasKey|"mock"|startsWith\("openai|DEFAULT_\w*IMAGE_MODELS|_API_KEY|\.img-pi' src` must return nothing.

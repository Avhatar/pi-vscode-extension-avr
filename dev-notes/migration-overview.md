# Standalone desktop migration — overview

## Problem statement

The previous `standalone/desktop/` app was Electron 43. Two things were wrong
with it for where we want to take the project:

- **Size and startup.** Electron bundles Chromium (~150 MB) and Node.js (~40 MB). Cold
  start is 500–2000 ms. The app is a fanart side-project meant to feel like a Fallout
  terminal — a heavy web-browser runtime is the wrong substrate for that.
- **Shader ceiling.** The atmosphere target is a full CRT effect: barrel warp of the
  UI itself, curved scanlines, phosphor bloom, edge glow, chromatic aberration,
  animated noise. Chromium's DOM rendering cannot participate in a real post-process
  shader pass without either sacrificing click hit-testing (CSS `filter` warps pixels
  but not layout) or manually round-tripping the DOM through
  `webContents.capturePage()` (async, ~30 fps, custom cursor required, native popups
  don't participate). Neither is what a native shader pipeline gives you for free.

## Goals

The migration must simultaneously deliver:

1. **Tiny binary** — target ≤ 30 MB installed footprint.
2. **Shader-native rendering** — real fragment shaders on the whole UI, no DOM-warp
   compromise.
3. **Instant startup** — ≤ 200 ms cold start on typical hardware.
4. **Multi-platform** — Windows, macOS, Linux from a single codebase.

Atmosphere is the product. Functionality is negotiable where it conflicts with these
goals.

## Rejected options

| Option | Why rejected |
|---|---|
| Stay on Electron, harder CSS effects | Cannot exceed the DOM ceiling described above. |
| Electron + `capturePage()` shader pipeline | Async capture caps at ~30 fps, text lag ~50 ms, native popups stay flat, custom cursor required. Complex plumbing for a compromised result. |
| Tauri (Rust host + system webview) | Solves size and startup, keeps existing web UI. But shader problem is unchanged — still DOM inside a webview. Also webview differs across platforms (WebView2 vs. WebKitGTK vs. WKWebView), so the shader would render differently per OS. |
| Flutter Desktop | Small enough, cross-platform, shaders via Impeller. But Dart ecosystem is mobile-first, terminal-style widgets are thin, and Pi-SDK integration would be more awkward than Rust FFI/sidecar. Second-best. |
| Slint (initial choice) | Declarative DSL, production TextInput/IME/ScrollView. But Slint 1.17.1's wgpu integration has a real bug (see decisions log): the `Image::try_from<wgpu::Texture>` code path silently drops textures when only the `unstable-wgpu-28` feature is enabled, because `i-slint-renderer-skia/cached_image.rs` gates the render arm on `unstable-wgpu-29` only. wgpu 29 is not on crates.io yet. The workaround is a local patch of one cfg line, but living on a forked slint sub-crate is uglier than pivoting to a stack that has a working shader pipeline out of the box. |
| Pure `wgpu` + hand-rolled UI | Smallest possible, but rebuilding scroll, textarea, IME, focus, clipboard from scratch is weeks we shouldn't spend. |

## Chosen stack

- **Rust** for the host process — window, event loop, GPU pipeline, persistence,
  auth, IPC.
- **Bevy 0.19+** for the UI and rendering — game-engine-style ECS with a
  documented custom-shader / post-process pipeline built directly on wgpu.
  Bevy UI (`bevy_ui`) provides Node-based layout, text rendering, and input.
  Text-input widget is not stock and will be hand-rolled or borrowed from a crate
  (`bevy_ui_text_input`, `bevy_egui`).
- **wgpu** — used transitively via Bevy. Identical shader source on every platform,
  no cargo-feature friction.
- **Node sidecar** for the Pi SDK. `@earendil-works/pi-coding-agent` is npm-published
  and JS-native; keeping it as a spawned child process means we don't reimplement or
  FFI-wrap the agent runtime. Communication is line-delimited JSON over stdin/stdout,
  same protocol shape as the current `shared/agent-protocol.ts`.

Originally the plan was to use **Slint** for the UI. See the decisions log below for
why we pivoted to Bevy.

## Target architecture

```
┌─────────────────────────────────────────────┐
│  Pi Code Desktop  (Rust binary, ~20 MB)     │
│  ┌────────────────────────────────────────┐ │
│  │  Slint UI  →  wgpu post-process pass   │ │
│  │  (window, all widgets, CRT shader)     │ │
│  └────────────────┬───────────────────────┘ │
│                   │ tokio channel            │
│  ┌────────────────┴───────────────────────┐ │
│  │  Sidecar bridge (JSON-lines over pipe) │ │
│  └────────────────┬───────────────────────┘ │
└───────────────────┼─────────────────────────┘
                    │ spawn + stdin/stdout
                    ▼
      ┌─────────────────────────────────┐
      │  Node sidecar (~40 MB bundled)  │
      │  - Pi SDK (@earendil-works/*)   │
      │  - Auth + secrets bridge        │
      │  - MCP adapters + web access    │
      └─────────────────────────────────┘
```

Node is bundled prebuilt inside the app resources so the user experience remains
single-file install. Bundled Node adds ~40 MB, but total is still 60 MB — three times
smaller than Electron and with far better startup and shader ceiling.

## Non-goals for v1

- **Auto-update.** Ship manual installers first; auto-update is a separate project.
- **Mobile targets.** Slint supports them; Pi SDK is desktop-focused so we don't
  chase mobile.
- **Multi-window.** Single window at first, add later only if driven by real use.
- **Accessibility polish.** Basic a11y only. Screen-reader support is a follow-up.

## Repo strategy

- New code lives in `standalone/desktop-rs/` (Phase 1+).
- The visual POC lives in `standalone/desktop-rs-poc/` — throwaway.
- The Electron `standalone/desktop/` directory was **retired on 2026-07-22**
  and is gone from the working tree. Git history preserves everything for
  reference. The private assets submodule (fonts, sounds) moved with the
  retirement to `standalone/desktop-rs-poc/assets/`.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-22 | Chose Rust + Slint + wgpu + Node sidecar | See rejected-options table above. |
| 2026-07-22 | POC lives in `standalone/desktop-rs-poc/`, throwaway | Isolate the visual-verification prototype from the eventual production tree. |
| 2026-07-22 | Windows is the primary POC platform | Matches current dev environment; macOS/Linux validated at end of POC. |
| 2026-07-22 | Slint used under royalty-free license (TBD lock before Phase 5) | Avoid GPL taint; commercial license only if royalty-free eligibility does not apply at ship time. |
| 2026-07-22 | Monofonto NOT copied into public POC folder | The private submodule policy in `AGENTS.md` forbids committing fonts/sprites/sounds into public paths. POC references the existing submodule path and falls back gracefully when the submodule is not initialized. |
| 2026-07-22 | Retired Electron `standalone/desktop/`; moved private assets submodule under POC | User called the Electron attempt a "провальный эксперимент" once the Bevy POC hit Day 4a with a working end-to-end CRT stack. Deleting Electron code from the working tree removes the biggest source of drift and lets the private assets submodule live under `standalone/desktop-rs-poc/assets/` — closer to where it is actually used. Git history preserves the Electron sources for reference. Wiki `Part X — Standalone desktop host` articles kept but marked *(retired 2026-07-22)* with banners pointing to this document. |
| 2026-07-22 | **PIVOTED from Slint to Bevy** | Discovered during POC Day 5 that `i-slint-renderer-skia-1.17.1/cached_image.rs:103` gates `ImageInner::WGPUTexture` render arm on `unstable-wgpu-29` only, not `unstable-wgpu-28`. Since wgpu 29 is not published to crates.io yet, wgpu textures passed to Slint via `Image::try_from` are silently dropped at draw time — verified with both render-pass output AND documented `queue.write_texture` upload paths. Only CPU-side `SharedPixelBuffer` works, which kills the whole point of GPU shader integration. Bevy has a first-class documented post-process pipeline on wgpu with no feature-flag friction. User has prior Bevy experience which lowers ramp-up cost. Slint Day 1–4 code is preserved in git history for reference. |
| 2026-07-22 | Bevy 0.19 UI runs after post-process; solved with render-to-texture routing | `bevy_ui_render/lib.rs:267` orders `ui_pass.after(Core2dSystems::PostProcess).before(upscaling)`. Attaching `LensDistortion` / `ChromaticAberration` / `Vignette` directly to the UI camera has zero visible effect because they run against the "world" (empty) before UI draws. Solution: first camera renders UI into an offscreen `Rgba16Float` texture (via `RenderTarget::Image` + `UiTargetCamera`), second camera displays that texture as a fullscreen `Sprite` and carries the post-process components. Post-process now warps the whole UI. Sprite is 1:1 with viewport; main camera clear is pure black so any pixel not covered by the sprite blends cleanly with the vignette fade. |
| 2026-07-22 | Tube-shape vignette via UI-layer `RadialGradient` (inside capture) | Built-in Bevy `Vignette` runs after barrel warp and stays circular in screen space, so it cannot follow the CRT tube. Placing a `BackgroundGradient` Node inside the UI tree makes the vignette belong to the UI capture — the main camera's barrel warp then bends the ellipse into a tube profile automatically. Stops are tunable in `poc.toml`. A true squircle / rounded-rectangle profile would need a custom UI material with L∞ or Lp distance in WGSL; not planned unless the elliptical fade fails the visual bar. |

## Licensing note

Slint has multiple licenses. The **royalty-free** option is free for individuals and
organizations under a revenue threshold and does not require open-sourcing our code.
GPL is avoided because it would infect the entire binary. The commercial license is a
paid fallback if the royalty-free eligibility does not apply at ship time. Lock the
license choice with Slint's current terms before Phase 5 (packaging).

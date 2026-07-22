# Visual proof-of-concept

## Status update — 2026-07-22 (Bevy Day 4a landed)

Where we are now, live in the running POC:

- Full UI layout ported from the Slint attempt into Bevy Node/Text — icon rail,
  control panel with toggles and section headers, main terminal column with a
  dummy feed (mixed row kinds and a Cyrillic line for the font/IME check),
  composer with block cursor, status bar.
- Composer is a live `EditableText` widget with `AutoFocus`, PIP-Boy block
  cursor via `TextCursorStyle`, tuned `cursor_width` and `cursor_blink_period`
  from settings. Enter submits, appends a `USER:` row + fake `PI:` echo, clears
  the composer. Cyrillic input works out of the box via `KeyboardInput.text`.
- CRT stack works end-to-end via a render-to-texture pipeline. UI is drawn by
  a first camera into an offscreen `Rgba16Float` texture; a second camera
  displays that texture as a fullscreen `Sprite` and carries the post-process
  effects. This routing is what makes the built-in `LensDistortion`,
  `ChromaticAberration`, and `Vignette` actually affect the UI (they run after
  `Core2dSystems::PostProcess`, before UI would normally draw — see
  `bevy_ui_render:267`).
- Tube-shape vignette lives INSIDE the UI capture as a `RadialGradient` overlay
  Node. Because it belongs to the UI texture, the main camera's barrel warp
  bends it into the CRT-tube profile automatically. Ellipse extent is tunable
  per axis so the shape can match arbitrary CRT aspect.
- Render target uses 16-bit float per channel — kills the 8-bit alpha banding
  the gradient produced on `Bgra8UnormSrgb` and gives headroom for the bloom /
  phosphor bleed passes on Day 4b.
- Runtime settings hot-reload works: `config/poc.toml` is watched by mtime
  polling. Every CRT knob (barrel intensity / scale / edge_curvature,
  chromatic intensity, built-in vignette intensity/radius/smoothness,
  tube_center_extent, tube_edge_darkness, tube_extent_x/y, cursor_blink_ms)
  updates live on save without restart.

Notes on trade-offs discovered along the way:

- The built-in Bevy `Vignette` runs *after* barrel warp so its shape stays
  circular in screen space — it cannot follow the tube. It is still exposed
  as a knob for users who want to add flat circular darkening on top of the
  tube-shape vignette, but our defaults have it off.
- Bevy's UI radial gradient produces ellipses (Euclidean distance). A true
  squircle / rounded-rectangle vignette would need a custom UI material with
  L∞ or Lp distance in a shader. Not planned unless the elliptical fade fails
  the visual bar.
- Slint attempt is preserved in git history. It got us through Days 1–3
  (layout + Cyrillic + block cursor). Day 4 hit `i-slint-renderer-skia`'s
  cfg bug where wgpu-28 textures are silently dropped at draw time, since
  the render arm is gated on `unstable-wgpu-29` which isn't published to
  crates.io yet. See `migration-overview.md` decisions log for full context.

What is still open (Day 4b onward):

- Custom post-process shader for scanlines + sweep line + noise + phosphor
  bloom + edge glow. Bevy has a documented custom post-process pattern; will
  need `AsBindGroup` material and a render-graph node.
- Custom cursor overlay if desired (the current block cursor is Bevy's
  built-in, which is fine for Fallout aesthetic).
- Perf validation on integrated GPUs (currently running on RTX 4080 via
  Vulkan — always 60fps, need to test where the floor is).
- Cross-platform validation (macOS Metal, Linux Vulkan).

## Purpose

Verify that Rust + Slint + wgpu can deliver the Fallout-terminal atmosphere we want
**before** committing 3–4 months to the full migration described in `phases.md`.

The POC is not the app. It is a throwaway prototype whose only job is to answer the
question: "does the visual and interaction result feel right?" If yes, we start
Phase 1 clean, borrowing only the shader code as reference. If no, we know that
before we've written any port of the actual chat/agent surface.

## Location

`standalone/desktop-rs-poc/` — the sibling directory the retired Electron app
used to occupy is gone; the POC now shares the parent folder alone. Deleted
after Phase 6.

## Scope IN

**Visual (mimicking the current Electron design)**:

- Icon rail on the left (dummy buttons, Unicode or SVG glyphs).
- Control panel column — static section headers (ToDo, Subagents, History, Tools)
  with fake list items.
- Main terminal column — feed of ~40 hard-coded lines mixing all row types (user,
  thinking, tool, diff) so distortion is testable on long strings, short buttons,
  panel borders.
- Composer at the bottom — a **real Slint `TextInput`** so we can validate that
  typing (including Cyrillic and IME) survives the shader pass.
- Monofonto font, phosphor palette (`#d8ff5c` on `#04100b`).

**Shader (fragment shader on wgpu, post-process pass over the Slint scene texture)**:

1. Barrel warp — non-linear, actual curvature of straight lines. Not a linear-gradient
   approximation.
2. Scanlines — sampled along the warped UV, so they bow inward at the edges.
3. Sweep line — bright phosphor band traveling top to bottom every ~7 s.
4. Static noise / grain — pseudo-random per-pixel modulation, animated by time.
5. Phosphor bloom — bright pixels are blurred and additively re-composited.
6. Edge glow — soft phosphor halo that follows the warped tube border.
7. Chromatic aberration — R/B channels separate more toward the edges.
8. Vignette — barrel-shaped, darkens the outside of the tube.
9. Custom cursor rendered inside the shader (system cursor hidden so the pointer
   follows the warped geometry).
10. Boot animation — ~1.5 s CRT warm-up on launch (static → blurred image → focus).

**Interactivity**:

- Clicks on rail / panel buttons print `clicked <name>` to stdout, proving that
  inverse coordinate mapping through the barrel function lands on the right widget.
- Composer accepts text; pressing Enter appends the line to the feed.
- A key binding cycles CRT intensity low → med → high, and shader uniforms scale
  accordingly.

## Scope OUT

- Pi SDK, sidecar Node process, any actual agent behavior.
- Auth, secrets, persistence.
- Multiple tabs, settings page, history loading, tool list, subagent lifecycle.
- Packaging, installers, code signing. Runs only via `cargo run --release`.
- Auto-update. Accessibility polish.

## Success criteria

The POC is considered successful when **all** of the following hold at the same time:

- [ ] Subjectively, watching the running app reads as "CRT / Fallout terminal", not
      as "flat UI with a filter on top".
- [ ] Straight lines visibly curve at the edges (not merely shift position).
- [ ] Sustained 60 fps on integrated graphics (Intel UHD 620 or Apple Silicon M1).
- [ ] Cyrillic text can be typed into the composer via IME and appears in the feed
      after Enter.
- [ ] Clicks on rail / panel buttons hit the correct widget despite visible warping.
- [ ] Text rendered under distortion is still readable — Monofonto stays sharp, no
      catastrophic mip / smear.
- [ ] Cold start ≤ 200 ms on the primary Windows dev machine.

If any criterion fails, we stop, write the failure into the decision log, and
choose one of: iterate on POC parameters, pivot to Bevy, or reduce the ambition
before Phase 1.

## Day-by-day plan

| Day | Deliverable |
|---|---|
| 1 | Cargo project scaffolded. Slint window opens at 1280×820 with dark background and phosphor-colored title. Monofonto registered from submodule with graceful fallback. |
| 2 | Static layout: icon rail + control panel + main column + composer. Fake feed content in place. |
| 3 | Live `TextInput` in composer. Enter appends to feed. Cyrillic input tested. |
| 4 | wgpu integration: Slint scene rendered into an offscreen texture, fullscreen quad, passthrough shader compiles and runs. First `cargo run` where the window is drawn via our own render pipeline. |
| 5 | Barrel warp + curved scanlines. First moment where the picture visibly bends. |
| 6 | Sweep line + noise + vignette. |
| 7 | Bloom + edge glow + chromatic aberration. |
| 8 | Custom cursor rendered in shader, OS cursor hidden. Inverse-coord mapping for clicks. |
| 9 | Boot animation, CRT-intensity uniforms, parameter tuning session. |
| 10 | Cross-platform validation (macOS + Linux boot check), FPS measurement, screenshots for the decision report. |

If Day 4 shows that Slint's wgpu-integration path is not workable within 2 days of
prodding, pause and rebuild the POC on Bevy. Estimated cost of the pivot: 2 extra
days, all previously written shader code and Slint UI are lost but the shape of
the effect stack transfers.

## Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| Slint refuses to expose a wgpu texture at Day 4 | Pivot the POC to Bevy. Rewrite UI shell; keep shader-design notes. |
| IME broken under the shader pass | Investigate whether `TextInput` uses OS-native compose window (which would draw outside our texture). If unfixable, accept flat IME popup on top of the warped UI as a known-issue. |
| FPS drops below 60 on target hardware | Simplify the effect stack: drop bloom (most expensive), reduce noise resolution, cap barrel-warp resolution. Document in the report. |
| Clicks off by a few pixels | Refine the inverse-mapping function. Check whether Slint reports mouse coordinates in logical or physical pixels and adjust. |
| Font mip artifacts at extreme distortion | Use signed-distance-field text or ship larger `.otf` variants; both are late-stage fixes, not blockers. |

## After the POC

Two outcomes:

- **All criteria green.** Archive the POC report in `dev-notes/`, delete
  `standalone/desktop-rs-poc/`, start Phase 1 in `standalone/desktop-rs/` with clean
  architecture. The shader `.wgsl` sources migrate as-is; the Slint UI does not.
- **Any criterion red.** Add a written decision to `migration-overview.md` explaining
  what failed and why, then either iterate on the POC, pivot the stack, or reduce the
  visual ambition before starting Phase 1.

Do not start Phase 1 with any criterion in an unresolved state.

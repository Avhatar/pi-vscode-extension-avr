# Migration phases (post-POC)

Do not start any of these until the POC in `poc-visual-proof.md` closes green.

Time estimates assume one developer at reasonable focus. Real-world calendar time will
be 1.5–2× because of Slint learning curve, Pi SDK edge cases, and packaging
surprises.

## Phase 1 — Rust workspace scaffold (3–5 days)

- Create `standalone/desktop-rs/` (Electron sibling was retired 2026-07-22).
- Cargo workspace with three crates:
  - `pi-shell` — the binary entry point.
  - `pi-protocol` — request/event types mirroring
    `src/shared/agent-protocol.ts` (hand-mirrored for now; consider `ts-rs` later).
  - `pi-sidecar` — spawns the Node child process and framed I/O over stdin/stdout.
- Empty Slint window with application name and version.
- CI matrix on GitHub Actions: `windows-latest`, `macos-latest`, `ubuntu-latest`.
- Logging via `tracing`.

## Phase 2 — Sidecar bridge (5–7 days)

- Recreate the headless Pi-agent glue in `standalone/desktop-rs/sidecar/index.mjs`
  based on the retired Electron main-process code preserved in git history.
  Same imports, same session management, but the transport is stdin/stdout
  JSON-lines instead of Electron IPC.
- Rust side: `tokio::process::Command` spawns the sidecar, `tokio_util::codec::LinesCodec`
  parses one message per line. Request/response correlation by UUID; event stream
  demuxed by subscriber map.
- Auth: API keys held Rust-side via the `keyring` crate. On sidecar start, Rust
  passes them through the init message.
- Integration smoke: end-to-end Rust test that sends a real `prompt`, receives
  `thinking` and `output` events, asserts a final `settled`.

## Phase 3 — UI port (3–5 weeks)

The bulk of the calendar time. Port each surface in order, ship each as it works.

1. **Layout skeleton** — icon rail, control panel, main column, composer, with
   mock data.
2. **Chat feed** — list of terminal-row entries with user/thinking/tool/diff types,
   auto-scroll, hover states, copy-to-clipboard.
3. **Composer** — TextInput, submit, keybindings, IME validated on Cyrillic.
4. **Session lifecycle** — start/stop, streaming visualization, queue strip.
5. **Control panel sections** — ToDo, Subagents, History, Tools with real
   sidecar data.
6. **Model/Thinking selectors** — Slint `ComboBox`.
7. **Settings** — separate window or modal.
8. **Toast, file-undo bar, scroll-to-latest button** — polish pass.

Each item ends when its surface works end-to-end with the real sidecar.

## Phase 4 — Shader pipeline (7–10 days)

Depends only on Phase 1 (window exists). Can run in parallel with Phase 3.

- Post-process pass through wgpu, taking the Slint scene texture as input.
- Fragment shader stack in `.wgsl`: barrel warp, scanlines, sweep, noise, bloom
  (two-pass gaussian), edge glow, chromatic aberration, vignette.
- Custom cursor drawn inside the shader; OS cursor hidden.
- CRT-intensity uniform scales all effects.
- Boot animation on first frame.
- Performance validated on Intel UHD, AMD Radeon Vega, and Apple Silicon.

If the POC delivered a working shader, this phase mostly copies its `.wgsl` sources
and adapts to Phase 1's crate layout.

## Phase 5 — Packaging and distribution (5–7 days)

- Bundle Node runtime + sidecar `index.mjs` into app resources folder.
- Windows: `.msi` via `cargo-wix`.
- macOS: `.dmg` via `cargo-bundle`; code sign if we have an Apple Developer
  certificate on hand.
- Linux: `AppImage` via `appimagetool` or `.deb` via `cargo-deb`.
- GitHub Actions matrix builds and drops release artifacts.
- Auto-update deferred to a follow-up.

## Phase 6 — Parity check and cleanup (5–7 days)

- Systematic walk through every user-visible feature of the Electron app and
  confirm the Rust app matches or documents the delta.
- Migrate user data format if it changed (workspace state, chat history).
- Update `AGENTS.md`, `CHANGELOG.md`, `README.md` for the new layout.
- Nothing to remove — `standalone/desktop/` was retired ahead of Phase 6 on
  2026-07-22. Parity is measured against the Electron implementation preserved
  in git history.

## Risk register

| Risk | Mitigation |
|---|---|
| Slint learning curve slows Phase 3 | Reserve first week of Phase 3 as "learning + skeleton"; do not commit to fixed sub-phase dates. |
| IME edge cases with Cyrillic/CJK | Validated in POC; if broken, budget extra week during Phase 3.3. |
| Sidecar latency under streaming load | Measured in POC. If problematic, move from JSON-lines to MessagePack or Unix-domain sockets. |
| Shader differences across GPU vendors | Phase 4 explicitly tests on Intel / AMD / Apple Silicon. `wgpu` abstracts the backend but corner cases exist. |
| Node runtime bundling issues | Standard packaging problem; documented in Phase 5. |
| Auto-update user expectation | Set clear release-notes expectation: "manual install for v1, auto-update planned for v2". |

## Rollback

If at the end of Phase 3 the port feels architecturally wrong (Slint patterns
fighting the terminal-UI domain, sidecar protocol too chatty, etc.), we roll back
to Electron and treat the Rust attempt as a research spike. All Rust work stays in
the repo history for reference. This is a real option, not a threat — do not force
the migration through if the architecture is not matching the domain.

# Pi Code Desktop — Visual POC (Bevy)

Throwaway prototype. See [`../../dev-notes/poc-visual-proof.md`](../../dev-notes/poc-visual-proof.md)
for scope, success criteria, and day-by-day plan.

Do not depend on anything here from production code. This directory will be deleted
once the POC delivers its verdict. The initial Slint attempt lives in git history.

## Prerequisites

- Rust stable (checked with 1.94; anything modern should work). See `rust-toolchain.toml`.
- Windows / macOS / Linux — all supported by Bevy's wgpu renderer. Primary dev target
  is Windows.
- Monofonto font from the private assets submodule at
  `standalone/desktop-rs-poc/assets/fonts/monofonto/monofonto.otf`. If the
  submodule is not initialized the app falls back to Bevy's default font with a
  warning printed to stderr — the shader work does not require the font to be
  present.

  ```bash
  git submodule update --init standalone/desktop-rs-poc/assets
  ```

## Run

```bash
cd standalone/desktop-rs-poc
cargo run
```

First build downloads Bevy (~1 GB compiled). Subsequent builds are seconds thanks to
the dev profile opt-level=1 for our code and opt-level=3 for dependency crates.

## Day-by-day status

Tracked in [`../../dev-notes/poc-visual-proof.md`](../../dev-notes/poc-visual-proof.md).
Current: Bevy Day 1 — window bootstrap after pivoting off Slint.

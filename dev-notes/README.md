# Development notes

Working scratch space for the standalone-desktop native-migration project. These are
living documents that capture decisions and reasoning as we go, not final documentation.
Kept in-repo so decisions survive context switches and future contributors can follow
the trail.

## Read in order

1. [migration-overview.md](migration-overview.md) — why we're moving the standalone
   desktop app off Electron, target architecture, and the tech-stack decision.
2. [poc-visual-proof.md](poc-visual-proof.md) — the visual proof-of-concept we're
   building first to de-risk the CRT-shader ambition before committing to the full
   migration.
3. [phases.md](phases.md) — post-POC phased plan for the actual migration.

## Scope of these notes

- The **VS Code extension** (root of the repo) is not in scope. It stays as-is.
- Only the **standalone desktop app** is being reconsidered. The Electron
  attempt lived in `standalone/desktop/` and was retired on 2026-07-22; the
  native Rust + Bevy successor is being prototyped in
  `standalone/desktop-rs-poc/`. The Fallout-terminal aesthetic is the driver
  — see the goals in `migration-overview.md`.

## Living documents

If a decision changes, update the relevant document in place and note the change at the
top with a date. Do not silently rewrite reasoning that was already acted on — future
readers need to understand why we picked what we picked.

---
name: pi-code-writing-plans
description: Use when turning an approved Pi Code design into concrete implementation steps, file changes, verification commands, and acceptance criteria.
---

# Writing Pi Code Implementation Plans

Produce a plan another developer or agent can execute without reconstructing the design or guessing project conventions.

## Preconditions

- The design or direction is approved.
- Applicable instructions, source, tests, and build scripts have been inspected.
- Open design decisions are resolved or explicitly listed as blockers.

Do not redesign while writing the plan. If repository reality invalidates the design, stop and surface the conflict. Do not start implementation in the same turn unless the user requested both planning and execution.

## Plan Qualities

A useful plan is:

- **ordered** — dependencies and shared contracts precede consumers;
- **concrete** — exact files and intended changes;
- **verifiable** — each task has observable acceptance criteria;
- **scope-controlled** — no unrelated cleanup;
- **boundary-aware** — host, protocol, webview, SDK, persistence, and packaging effects are explicit;
- **project-adapted** — commands and patterns actually exist.

## Task Granularity

Each task should produce one coherent, reviewable result. Split tasks that span unrelated subsystems, have independent failure modes, cannot share one clear verification outcome, or mix protocol, migration, UI, and packaging work unnecessarily. Do not force every edit into ceremonial micro-steps.

## Pi Code Planning Checklist

Include only relevant items:

- `src/shared/protocol.ts` message unions before host/webview handlers;
- extension-host providers, controllers, Pi SDK lifecycle, and disposal;
- browser-only chat, launcher, or settings webview code and CSS;
- per-tab session, diff, checkpoint, queue, steering, and restoration behavior;
- settings changes in both `package.json` and `SettingsData`, plus settings host/UI wiring;
- SecretStorage and provider/model authentication behavior;
- subagent registry, runtime, persistence, isolation, review/apply, and launcher state;
- runtime dependencies, bundled Pi packages, `.vscodeignore`, and VSIX contents;
- unit, integration, manual F5, and installed-VSIX evidence;
- `CHANGELOG.md` entry for code/product behavior changes.

## Recommended Format

```markdown
# [Feature] Implementation Plan

## Goal
[Approved outcome]

## Constraints
[Relevant decisions, compatibility requirements, non-goals]

## Task 1: [Coherent result]

**Files**
- Modify: `src/.../existing.ts`
- Create: `src/test/unit/.../new.test.ts`

**Steps**
1. Add a failing test or deterministic reproduction for [behavior].
2. Confirm it fails for [expected reason].
3. Update the shared protocol or owning layer before its consumers.
4. Implement the smallest change following [existing pattern].
5. Verify with [exact command or manual evidence].

**Acceptance criteria**
- [Observable behavior]
- [Isolation/compatibility/security condition]
- [Expected test/build result]

**Risks/rollback**
- [Only if material]
```

## Verification Selection

Use the narrowest relevant checks and state what each proves:

- focused Vitest target, then `npm run test:unit` for pure TypeScript logic, reducers, parsers, registries, and protocol serialization;
- `npm run compile` for extension-host and all webview bundles;
- `npm run test:integration` for activation, contribution, or command-registration behavior;
- `npm run test:all` for changes crossing unit and VS Code integration boundaries;
- manual Extension Development Host checks for webview interaction and visual behavior;
- installed-VSIX smoke through the `build-deploy` workflow for runtime dependencies, package contents, activation, or release claims.

Never invent a command. If the repository has no automated check for a behavior, specify the required evidence and mark the limitation.

## Completion

Present the plan with unresolved blockers and verification gaps. Planning completes when the plan is executable and acceptance-driven, not when implementation begins.

---
name: pi-code-requesting-code-review
description: Use when meaningful Pi Code (VS Code extension) changes are ready for independent review, especially before merging, releasing, or handing work to another team.
---

# Requesting Pi Code Review

Request review when it can still influence the change, with enough context and evidence for an independent reviewer to verify the work.

**Recommended companion:** `pi-code-code-reviewer` defines the two-stage review and Pi Code checklist. If the harness cannot load companion skills, include the relevant checklist directly in the reviewer prompt.

## When to Request

Review is strongly recommended:

- after a substantial or risky feature;
- after changes to the typed message protocol, extension activation, subagent lifecycle, session management, checkpoints/diffs, SecretStorage/auth, LSP integration, or packaging;
- after adding, rewriting, or reworking a webview provider (`src/webview/` or `src/providers/`);
- after a complex bug fix whose cause crossed subsystem boundaries;
- before merge, release, or handing work to another team;
- when stuck or when assumptions need an independent challenge.

A trivial, isolated, already verified edit may use self-review instead. Scale review effort to risk rather than file count alone.

## Prepare the Review Scope

Provide:

- requirements, approved design, and acceptance criteria;
- concise implementation summary;
- exact change scope: Git base/head, patch, or file list;
- relevant project conventions (from `AGENTS.md`): English-only, typed protocol first, per-tab isolation, no DOM frameworks, CSS variables for theming, SecretStorage for secrets;
- relevant checks run with actual results: focused tests, `npm run test:unit`, `npm run compile`, `npm run test:integration` or `npm run test:all`, F5 smoke, and installed-VSIX verification as the affected boundaries require;
- known limitations, migrations, and intentionally deferred work;
- any new protocol message types, settings contributions, or Pi extension dependencies.

Do not provide only the implementer's summary. The reviewer must be able to inspect the actual change and surrounding code.

## Review Stages

### 1. Requirement Compliance

Ask whether the implementation delivers exactly the approved behavior, including error paths, message protocol additions, and extension activation/deactivation lifecycle. Resolve missing requirements and unapproved scope before general quality review.

### 2. Implementation Quality

Review correctness, maintainability, tests, architecture boundaries, protocol safety, isolation, packaging risks, theme compatibility, and production readiness per the `pi-code-code-reviewer` checklist.

The stages may be performed by separate reviewers or as clearly separated passes by one reviewer.

## Harness-Neutral Reviewer Brief

```text
Review goal:
Requirements/design:
Change scope:
Implementation summary:
Verification already performed:
Pi Code constraints (architecture boundaries, isolation rules, packaging):
Known risks:
Requested output:
- requirement verdict (PASS/FAIL)
- findings by severity (Critical/Important/Minor) with file:line evidence
- verification gaps
- merge/readiness assessment
```

Use the current harness's review/subagent mechanism. Do not hardcode a model, agent type, worktree, or Git workflow unless the project requires one.

## Act on Findings

1. Reproduce or verify each material finding.
2. Fix Critical issues before merge/release.
3. Fix Important issues or explicitly obtain a risk decision.
4. Track Minor issues only when worth the maintenance cost.
5. Push back on incorrect findings with code, tests, or project requirements.
6. Re-review changed areas after fixes.
7. Run proportional integrated verification after all accepted changes:
   - run `npm run compile` when extension or webview bundles changed;
   - run the relevant focused/unit/integration suites for the affected behavior;
   - run `npm run test:all` for broad or cross-boundary changes;
   - if packaging, runtime dependencies, or `.vscodeignore` changed, smoke the installed VSIX.

Reviewer output is evidence to evaluate, not proof by itself.

## Red Flags

- Reviewing only an implementation summary
- Requesting review after the change can no longer be altered
- Treating every comment as mandatory without verification
- Skipping re-review after material fixes
- Declaring merge readiness while VSIX smoke or integration tests are pending
- Requiring heavyweight review for every one-line, low-risk change
- Using multiple review agents whose scopes overlap without coordination
- Omitting integration or installed-VSIX evidence when the reviewed claim depends on those boundaries

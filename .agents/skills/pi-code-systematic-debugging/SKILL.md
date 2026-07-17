---
name: pi-code-systematic-debugging
description: Use when investigating Pi Code bugs, crashes, unexpected behavior, flaky tests, performance regressions, build/package failures, or Extension Development Host versus installed-VSIX differences.
---

# Systematic Debugging for Pi Code

## Core Principle

```text
NO FIXES WITHOUT ROOT-CAUSE INVESTIGATION FIRST
```

Do not confuse suppressing a symptom with fixing its cause. A reversible containment may be necessary, but label it as mitigation rather than root-cause resolution.

## When to Use

Use for extension-host errors, webview failures, session or event bugs, lost/restored state, queue or steering errors, subagent failures, flaky tests, activation/build/package failures, provider/model/auth issues, performance problems, and F5-versus-installed-VSIX differences.

## The Four Phases

Complete each phase before the next.

### Phase 1: Root-Cause Investigation

1. **Read all evidence**
   - Preserve the first error, full stack, Output channel, Extension Host log, webview DevTools console, test output, and package/install output as relevant.
   - Distinguish tool failure, test failure, provider failure, and product behavior.

2. **Reproduce consistently**
   - Record exact steps, tab/session state, streaming state, queued prompts, open panels, workspace, and restart/reload state.
   - Record VS Code and Pi Code versions, OS, workspace trust, provider/model, authentication source, settings, and F5 versus installed VSIX.
   - If reproduction is unreliable, collect more evidence instead of guessing.

3. **Check recent changes**
   - Inspect code, tests, protocol, `package.json`, lockfile, `.vscodeignore`, bundled packages, settings, persistence formats, and generated/package output as relevant.

4. **Locate the failing boundary**
   - Trace activation/registration, provider/controller ownership, `PiSessionManager`, SDK events, typed `postMessage`, webview state, persistence, and packaging boundaries.
   - Record what enters and exits each boundary until correct state first becomes incorrect.

5. **Inspect runtime state**
   - Use targeted logs, breakpoints, deterministic fixtures, stored session data, diff inspection, or a minimal reproduction.
   - Ask the user for runtime evidence only when repository and available tools cannot provide it.

6. **Trace backward to the source**
   - Follow the call/event chain and state ownership to the original trigger.
   - Account for activation/disposal, stale webviews, tab switches, cancellation, async event order, queued prompts versus steering, reload restoration, and resource loading.
   - Read [root-cause-tracing.md](root-cause-tracing.md) when the symptom is far from its source.

### Phase 2: Pattern Analysis

1. Find a similar working implementation in the repository.
2. Read it completely, including protocol declarations, handlers, lifecycle, persistence, tests, and packaging configuration.
3. List meaningful differences between working and failing cases.
4. Identify required dependencies, ordering, ownership, and cleanup.

### Phase 3: Hypothesis and Testing

1. State one falsifiable hypothesis: “X is the cause because evidence Y predicts Z.”
2. Test it with the smallest diagnostic change or controlled experiment.
3. Change one variable at a time.
4. If disproved, discard it and form a new hypothesis; do not stack speculative fixes.
5. After repeated failed attempts, reset assumptions and collect new evidence.

### Phase 4: Implementation

1. Create a regression guard before the fix when practical: focused Vitest test, VS Code integration test, deterministic subagent/session smoke, or exact manual reproduction.
2. Implement one focused fix at the source.
3. Verify the original reproduction in the original environment.
4. Run nearest tests, `npm run compile` when bundles are affected, and broader checks proportional to scope.
5. For package/runtime dependency defects, verify an installed VSIX; F5 is insufficient.
6. Remove temporary instrumentation unless intentionally retained and low-cost.
7. If the fix fails, return to Phase 1 with the new evidence.

Read [regression-and-verification.md](regression-and-verification.md) for project-specific evidence options.

## Pi Code Quick Checks

Check only what matches the symptom:

- extension host versus chat/settings/launcher webview;
- `ClientMessage` / `ServerMessage` union and both handlers;
- tab identity, active tab, restored panel, session/diff/checkpoint ownership;
- `agent_end`, message queue dispatch, and steering paths;
- cancellation, disposal, event subscription, and window reload;
- provider/model selection, API-key bridge, SecretStorage, workspace trust;
- user versus project skills/tools/MCP/LSP/subagent resources;
- browser-only imports, DOM state, CSP, and theme CSS variables;
- production dependencies, pruning, `.vscodeignore`, and VSIX contents;
- OS paths, shell behavior, worktrees, and process cleanup.

For a fuller prompt list, read [pi-code-debugging-checklist.md](pi-code-debugging-checklist.md).

## Supporting Techniques

- [root-cause-tracing.md](root-cause-tracing.md) — trace a failure backward across host, protocol, SDK, and webview boundaries
- [condition-based-waiting.md](condition-based-waiting.md) — replace sleeps with observable completion
- [defense-in-depth.md](defense-in-depth.md) — add proportionate safeguards after finding the cause
- [regression-and-verification.md](regression-and-verification.md) — prove a Pi Code fix
- [pi-code-debugging-checklist.md](pi-code-debugging-checklist.md) — project-specific investigation prompts

## Red Flags

- “Just catch the error where it surfaces.”
- “Increase the timeout until the test passes.”
- “It works under F5, so the VSIX is fine.”
- “Change several things and see what happens.”
- “The third failed fix proves we need a rewrite.”
- “The exception disappeared, so the bug is fixed.”

## Completion Gate

Do not claim a fix without fresh evidence that the original reproduction passes in the relevant environment, the regression guard covers the old behavior when applicable, related checks pass, and no new relevant errors appeared.

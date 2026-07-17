---
name: pi-code-code-reviewer
description: Use when reviewing Pi Code (VS Code extension) changes for requirement compliance, correctness, maintainability, architecture boundaries, and production readiness.
---

# Pi Code Code Review

Review in two distinct passes: first determine whether the change solves the requested problem, then determine whether it is well built. Mixing both too early can hide missing requirements behind style discussion.

## Stage 1: Requirement Compliance

Compare the actual diff and resulting behavior against the specification or user request. Do not rely on the implementer's summary.

Check:

- every acceptance criterion is implemented;
- claimed behavior exists in code and is reachable;
- no requested behavior is missing;
- no unapproved feature or refactor expanded scope;
- protocol additions follow the typed message union pattern in `src/shared/protocol.ts` and have corresponding handlers on both sides;
- settings contributions update both `package.json` (`contributes.configuration`) and `src/shared/protocol.ts` (`SettingsData`);
- migrations, backward compatibility, and extension activation/deactivation match the design;
- tests cover the requested behavior.

Verdict:

```text
PASS — requirement compliant
```

or

```text
FAIL — issues with file:line evidence
```

Resolve and re-review compliance before Stage 2 when possible.

## Stage 2: Implementation Quality

Review correctness and production readiness:

### Architecture Boundaries

- Extension host code (`src/extension.ts`, `src/providers/`, `src/pi/`) does not leak into webview bundles (`src/webview/`).
- Webview code (`src/webview/`) never imports `vscode` or Node.js modules; it is browser-only IIFE.
- Communication crosses the boundary only through typed messages in `src/shared/protocol.ts`, never through direct imports or global state.
- `tsconfig.json` correctly excludes `src/webview/**/*` from the main compilation.

### Protocol Safety

- New message types are added to the shared union types in `src/shared/protocol.ts` before handlers are implemented.
- Both extension-host and webview sides handle new messages; no handler is missing or silently ignored.
- Message payloads are fully typed; no `any` casts or unchecked property access on incoming messages.

### Tab and Session Isolation

- Each chat tab owns its `PiSessionManager`, `DiffManager`, and `CheckpointManager`; state is never shared between tabs.
- Per-tab ToDo (`src/pi/todo/`) does not leak across sessions.
- Checkpoint snapshots are scoped to the owning tab.

### SecretStorage and Auth

- API keys, tokens, and secrets are stored through `vscode.SecretStorage`, never in `settings.json`, plaintext files, or webview state.
- New providers are added to the `KNOWN_PROVIDERS` list in `src/pi/auth.ts`.
- Secret changes propagate via `secrets.onDidChange` without requiring a window reload.

### Session and Subagent Lifecycle

- Pi SDK packages (`@earendil-works/pi-*`) are dynamically imported; no static top-level imports that would fail at extension load.
- `AgentSession` lifecycle: start, stream, steer, and end handled correctly; cleanup on tab close.
- Subagent orchestration (`src/pi/subagents/`) respects the one-level delegation depth limit; child agents never receive the `subagent` tool.
- Worktree isolation is used for write-capable background subagents; shared-workspace writes use the writer lease.
- The parent agent always owns final review, diff application, and verification; children never self-certify.

### Queue vs Steering Semantics

- During streaming, user messages are queued in `TabState.queuedMessages` and auto-dispatched on `agent_end`.
- Mid-stream steering uses `AgentSession.steer()`, not the message queue.
- Queue and steering paths are distinct; queued messages do not interfere with active streaming.

### Packaging and Runtime Dependencies

- New production dependencies are declared explicitly in root `package.json`; transitive-only dependencies are not relied upon.
- `.vscodeignore` is reviewed when `src/` or `node_modules/` paths change; CSS under `src/webview/styles/` remains un-ignored because providers load it at runtime.
- `npm prune --omit=dev` is not broken by the change; all runtime dependencies survive pruning.
- Bundled Pi extensions in `BUNDLED_PI_PACKAGES` (`src/pi/bundled-packages.ts`) are production dependencies, never devDependencies.
- No code calls `pi install npm:<pkg>` or writes into `~/.pi/settings.json`; bundled extensions use `additionalExtensionPaths` only.

### Webview and Theming

- Webview UI uses vanilla TypeScript and DOM APIs; no React or framework dependency is introduced.
- Styles use VS Code CSS custom properties (`--vscode-*`); no hardcoded colors.
- The `el()` helper pattern for element creation is followed; no innerHTML with unsanitized content.

### General TypeScript Quality

- Error handling covers invalid states, null/undefined, and asynchronous failures.
- Ownership and separation of concerns are clear; no god objects or circular module dependencies.
- No unnecessary complexity, duplication, or speculative abstraction.
- Tests verify behavior rather than implementation details; unit tests run under `npm run test:unit`, and integration runs under `npm run test:integration` or as part of `npm run test:all`.
- LSP tool code (`src/pi/lsp/`) is gated by `pi-code.lsp.enabled` and does not activate unconditionally.

## Severity

| Level | Meaning |
|---|---|
| Critical | crash, security leak, data loss, broken core behavior, protocol mismatch, isolation violation, or SecretStorage exposure |
| Important | correctness, architecture boundary violation, compatibility, packaging defect, material test gap, or missing handler that should block merge |
| Minor | worthwhile non-blocking clarity, maintainability, naming, or documentation improvement |

Do not inflate severity. A style preference is not Critical.

## Output

```markdown
## Requirement Compliance
PASS / FAIL

## Strengths
- [Specific evidence]

## Issues

### Critical
- `file:line` — issue, impact, and smallest appropriate fix

### Important
- ...

### Minor
- ...

## Verification Gaps
- [What was not run or cannot be proven from the diff]

## Assessment
Ready to merge: Yes / No / With fixes
```

Use file:line references. Report only findings supported by inspected evidence.

Read [review-prompts.md](review-prompts.md) when delegating either review stage to another agent.

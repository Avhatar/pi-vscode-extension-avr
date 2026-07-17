---
name: pi-code-receiving-code-review
description: Use when evaluating or implementing code review feedback in the Pi Code VS Code extension, especially when comments are unclear, risky, or potentially incompatible with existing architecture boundaries.
---

# Receiving Pi Code Review

Treat review comments as technical claims to understand and verify, not instructions to accept reflexively or arguments to reject defensively.

## Response Process

1. **Read all feedback** before changing code.
2. **Classify each item:** correctness, requirement, maintainability, test gap, style, question, or preference.
3. **Clarify** comments whose required outcome is ambiguous.
4. **Verify** claims against the actual code, tests, project conventions (`AGENTS.md`), and runtime behavior.
5. **Evaluate impact** on behavior, compatibility, architecture boundaries, and scope.
6. **Respond technically:** accept, ask, or push back with evidence.
7. **Implement focused items** and verify each coherent group.
8. **Report resolution:** changed, declined with reason, or still blocked.

Independent clear items may proceed while unrelated questions are clarified. Do not partially implement a group of coupled comments whose combined intent is unclear.

## Pi Code-Specific Verification

Before accepting a suggestion, check relevant concerns:

### Architecture Boundaries
- Does the change put Node.js/vscode API imports into a webview bundle (`src/webview/`)?
- Does it bypass the typed protocol by smuggling state through globals, DOM, or URL parameters?
- Does it keep `tsconfig.json` exclusion of `src/webview/**/*` intact?

### Protocol
- Are new message types fully typed in `src/shared/protocol.ts`?
- Do both extension-host and webview handlers exist for every new direction?
- Is the `SettingsData` interface updated when `package.json` configuration changes?

### Isolation
- Is per-tab session, diff, checkpoint, and ToDo state still isolated?
- Does the change assume shared state between tabs?

### Security and Secrets
- Are API keys still stored through `SecretStorage`, not in settings, state, or logs?
- Are new providers added to `KNOWN_PROVIDERS` in `src/pi/auth.ts`?
- Does `secrets.onDidChange` still propagate without a window reload?

### Session and Subagent Lifecycle
- Is the Pi SDK still dynamically imported (no static top-level import)?
- Does `AgentSession` lifecycle (start, stream, steer, end, cleanup) remain correct?
- Is subagent depth still capped at one; do children still lack the `subagent` tool?
- Are queue (`TabState.queuedMessages` on `agent_end`) and steering (`AgentSession.steer()`) still distinct?

### Packaging
- Are new dependencies declared in root `package.json` as production deps?
- Does `npm prune --omit=dev` leave all runtime dependencies intact?
- Is `.vscodeignore` still correct — especially the `src/webview/styles/**` un-ignore?
- Are bundled Pi extensions still production deps and referenced through `additionalExtensionPaths` only?

### Webview and Theming
- Is the webview still vanilla TypeScript/DOM (no framework)?
- Are colors still VS Code CSS custom properties (`--vscode-*`)?

### Verification Selection
Choose checks that prove the affected behavior rather than running this as a mandatory list:
- `npm run compile` — extension-host and webview bundles build
- `npm run test:unit` — unit suite passes
- `npm run test:integration` — VS Code integration suite passes
- `npm run test:all` — unit and integration suites pass for broad changes
- F5 dev-host smoke — affected interactive behavior works
- Installed-VSIX smoke — package/runtime path works when packaging, `.vscodeignore`, or runtime dependencies changed

## When to Push Back

Push back when the suggestion:

- contradicts verified requirements or an approved design;
- breaks the extension host / webview architecture boundary;
- weakens per-tab isolation or the typed protocol contract;
- exposes secrets outside `SecretStorage`;
- introduces a framework dependency into the webview;
- hardcodes colors instead of using `--vscode-*` variables;
- relies on a transitive dependency without declaring it in `package.json`;
- calls `pi install npm:<pkg>` or writes into `~/.pi/settings.json`;
- addresses a symptom rather than the cause;
- adds unused scope or speculative abstraction;
- is based on an incomplete reading of the code;
- cannot be validated with available evidence.

Use code, tests, `AGENTS.md` conventions, or a minimal reproduction as evidence. If the disagreement changes architecture or product scope, return the decision to the appropriate owner.

## Good Responses

```text
Implemented: the new message type `ApplyDiffResponse` is in the protocol union, and both `chat-panel.ts` and `main.ts` handle it. `npm run test:all` passes.
```

```text
I did not apply this change. The suggested import would pull `vscode` into `src/webview/main.ts`, which is a browser-only IIFE bundle. The data must cross via `postMessage` through the typed protocol instead.
```

```text
I did not apply this change. The color `#333` is hardcoded. Pi Code uses `--vscode-editor-background` for theme compatibility. The existing variable covers this case.
```

```text
I understand the null guard, but not the intended recovery state after it triggers. Should the session abort, retry, or transition to an error state visible to the user?
```

Be concise and factual. Courtesy is fine; performative agreement is not a substitute for technical evaluation.

## Red Flags

- Editing before understanding the requested outcome
- Assuming reviewer authority proves correctness
- Rejecting feedback without checking the code
- Applying every item as one unverified batch
- Treating style preference as a critical defect
- Saying "fixed" without fresh evidence from the checks relevant to the claim
- Preserving compatibility nobody actually requires without checking
- Accepting a suggestion that crosses the extension-host/webview boundary

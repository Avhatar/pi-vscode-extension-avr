# Pi Code Review Prompt Templates

Use the current harness's agent mechanism. Do not hardcode model names, agent types, or worktree behavior here.

## Requirement Compliance Reviewer

```markdown
Review whether the implementation matches the requested behavior.

## Requirements
[Full requirements and acceptance criteria]

## Change Scope
[Diff range, changed files, or patch]

## Implementer Summary
[Informational only; verify independently]

Read the actual change and relevant surrounding code. Check missing requirements, unapproved scope, incorrect interpretation, migrations, protocol changes, and verification coverage.

Pi Code specifics to check:
- New message types are in `src/shared/protocol.ts` typed unions before handlers exist.
- Settings changes touch both `package.json` (`contributes.configuration`) and `protocol.ts` (`SettingsData`).
- Extension host and webview sides both handle any new message direction.

Return PASS or FAIL. For every issue include file:line evidence, impact, and the unmet requirement. Do not perform a general style or quality review yet.
```

## Quality Reviewer

```markdown
Requirement compliance has passed. Review implementation quality and production readiness.

## Approved Requirements
[Requirements/design]

## Change Scope
[Diff range, changed files, or patch]

Inspect the actual implementation and relevant tests. Review:

### Architecture Boundaries
- Extension host code never leaks into webview bundles. Webview code never imports `vscode` or Node.js modules.
- All cross-boundary communication uses typed messages from `src/shared/protocol.ts`.

### Protocol and Isolation
- Message types are fully typed; no `any` casts on incoming messages.
- Per-tab isolation: each tab owns its session, diff, and checkpoint managers independently.
- SecretStorage used for all secrets; no plaintext keys or tokens.

### Session and Subagent Lifecycle
- Pi SDK dynamically imported; AgentSession lifecycle correct.
- Subagent depth capped at one; worktree isolation for write-capable background children.
- Message queuing (streaming) vs steering (`AgentSession.steer()`) are distinct paths.

### Packaging and Dependencies
- No new transitive-only dependency reliance; production deps declared explicitly.
- `.vscodeignore` reviewed; `src/webview/styles/` un-ignored for runtime CSS loading.
- Bundled Pi extensions handled through `additionalExtensionPaths`, never `pi install`.

### Webview and Theming
- Vanilla TypeScript/DOM only; no framework introduced.
- VS Code CSS custom properties for colors; no hardcoded colors.

### General
- Error handling, null safety, async cleanup, and disposal.
- Tests verify behavior; unit tests (`npm run test:unit`) and integration tests (`npm run test:all`) cover the change.
- CHANGELOG entry under `[Unreleased]` if the change is user-facing.

Categorize findings as Critical, Important, or Minor. Include file:line evidence and explain impact. Finish with Ready to merge: Yes / No / With fixes.
```

## Reviewer Constraints

- Do not trust summaries instead of reading the change.
- Do not modify files unless the parent explicitly assigns a fixing task.
- Do not report findings outside the supplied scope without clearly labeling them pre-existing.
- State tools/tests not available rather than assuming results.
- Do not claim `npm run compile`, `npm run test:unit`, `npm run test:all`, or VSIX smoke passed without running them.

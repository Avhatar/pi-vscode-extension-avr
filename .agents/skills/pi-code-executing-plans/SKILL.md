---
name: pi-code-executing-plans
description: Use when executing an approved implementation, migration, documentation, or investigation plan for Pi Code.
---

# Executing Pi Code Plans

Execute an approved plan step by step, verify each meaningful result, and surface blockers before they become hidden deviations.

## Core Principle

```text
REVIEW FIRST. EXECUTE IN ORDER. VERIFY BEFORE ADVANCING.
```

## Process

### 1. Load and Review

Read the complete plan and applicable project instructions. Before editing:

- confirm goal, scope, dependencies, acceptance criteria, and commands;
- check that referenced files, symbols, tests, scripts, and APIs exist;
- identify changes affecting shared protocol, persisted state, settings, secrets, runtime dependencies, package contents, or public behavior;
- raise only concerns that materially affect execution.

Do not silently improve or redesign an approved direction. Escalate design-changing corrections.

### 2. Establish Progress State

Track pending, active, completed, and blocked steps with the current harness. Keep one dependent step active at a time. Parallelize independent work only after applying `pi-code-dispatching-parallel-agents` and the repository's subagent isolation rules.

### 3. Execute the Smallest Coherent Step

For each step:

1. Re-read its requirements and expected result.
2. Inspect the existing project pattern before editing.
3. Add or run the planned failing guard when applicable.
4. Make only the changes required by that step.
5. Preserve typed protocol compatibility, tab isolation, secrets, persistence, and host/webview boundaries.
6. Run the specified verification and read the full result.
7. Record actual results and approved deviations.
8. Mark complete only when acceptance criteria are satisfied.

### 4. Verify at the Right Level

| Change | Typical evidence |
|---|---|
| Pure TypeScript logic | focused Vitest test, then `npm run test:unit` |
| Shared protocol | serialization/handler tests plus `npm run compile` |
| Extension activation/provider/command | `npm run compile` and `npm run test:integration` |
| Chat/settings/launcher webview | `npm run compile`, relevant tests, manual F5 interaction |
| Session, queue, steering, persistence | focused unit tests and deterministic reproduction |
| Subagents or isolation | relevant subagent unit/smoke coverage; parent reviews actual child diff |
| Runtime dependencies or VSIX contents | `build-deploy` workflow and installed-extension smoke |
| Cross-boundary change | `npm run test:all` plus any required manual check |

Compilation proves bundling, not behavior. F5 does not prove packaged runtime dependencies. Use only the evidence relevant to the claim.

### 5. Handle Blockers

Stop the affected step when a dependency is missing, the plan conflicts with current code, verification fails unexpectedly, a new design decision is required, or a destructive action lacks approval. Capture evidence, explain impact, and request the smallest needed decision. Do not stack speculative workarounds.

Unrelated work may continue only when it cannot hide or worsen the blocker.

### 6. Report Completion

Report completed steps and changed paths, checks run with actual results, approved deviations, unresolved risks, and the next pending step. Do not claim the plan complete while an acceptance criterion remains unverified.

## Red Flags

- Starting before reading the full plan
- Marking complete because files changed
- Updating protocol consumers before the shared union
- Importing Node or `vscode` APIs into a webview bundle
- Treating F5 success as proof of VSIX correctness
- Refactoring unrelated code while executing
- Continuing after repeated unexplained failures

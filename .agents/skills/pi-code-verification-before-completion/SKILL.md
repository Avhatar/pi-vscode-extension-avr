---
name: pi-code-verification-before-completion
description: Use when about to claim Pi Code work is fixed, complete, passing, performant, merge-ready, package-ready, or release-ready.
---

# Verification Before Completion for Pi Code

Make status claims from fresh evidence, not confidence, code inspection, a previous run, or a child-agent summary.

## Verification Gate

Before any completion claim:

1. **Identify** the observation that would prove the claim.
2. **Run** the complete relevant check now.
3. **Read** full output, exit status, failures, logs, and environment.
4. **Compare** evidence with acceptance criteria.
5. **Inspect** the actual diff, including child-produced changes.
6. **Report** verified and unverified checks separately.

If the relevant environment is unavailable, verification remains pending. Do not turn “could not test” into “should work.”

## Pi Code Evidence Matrix

| Claim | Minimum relevant evidence |
|---|---|
| Pure TypeScript behavior works | focused test plus `npm run test:unit` when scope warrants |
| Extension and webviews compile | fresh `npm run compile` succeeds |
| Shared protocol change works | sender/receiver or serialization coverage plus compile |
| Activation/command/provider works | `npm run test:integration` or exact VS Code host reproduction |
| Chat/settings/launcher UI works | compile plus manual Extension Development Host path |
| Session/queue/steering bug fixed | original deterministic reproduction and focused lifecycle test |
| Subagent/isolation behavior works | relevant unit/smoke scenario and parent inspection of actual diff/lifecycle result |
| Cross-boundary change is green | `npm run test:all` plus any required manual evidence |
| Package/runtime dependency works | `build-deploy` flow, installed VSIX, reload, and affected path exercised |
| Performance improved | comparable measurement under the same workload |
| Flake fixed | repeated runs under representative load |
| Ready to merge | requirements checked, diff reviewed, relevant tests/build/manual checks pass |
| Ready to release | changelog/version policy satisfied and installed-VSIX smoke passes |

Use the narrowest evidence that proves the claim, then broader checks proportional to blast radius. Do not claim all tests pass when only a focused subset ran.

## Required Reading of Results

- Preserve the first error; later errors may be consequences.
- Distinguish command/tool failure from test/product failure.
- Wait for asynchronous processes, child lifecycle operations, package installation, and VS Code reload to finish.
- Inspect Output, Extension Host, webview, and install logs where relevant.
- Treat child claims as reports to verify, never as parent evidence.
- Remember that F5 uses the full development dependency tree and cannot prove VSIX contents.

## Regression Verification

For a new regression guard:

1. Observe it fail against broken behavior or a controlled reversion.
2. Restore/apply the fix.
3. Observe it pass.
4. Run related checks.

When safe reversion is impractical, document evidence that the guard exercises the original failure path.

## Reporting Format

```text
Verified:
- [check]: [result and environment]

Not verified:
- [check]: [reason]

Status:
- Complete / Blocked / Partially verified
```

## Red Flags

- “Should work now”
- “The code looks correct”
- “It passed earlier”
- “Compile passed, so behavior is correct”
- “F5 works, so the package is correct”
- “Tests passed” when only a subset ran
- “The child reported success” without parent verification
- Marking complete while a relevant check is running or unavailable

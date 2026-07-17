# Regression Testing and Verification in Pi Code

## Regression Guard

Before changing production code, create the smallest guard that reproduces the failure when practical.

Preferred forms:

1. **Focused Vitest test** — reducers, parsers, protocol serialization, models, controllers, persistence, resource resolution, or isolated session behavior.
2. **VS Code integration test** — activation, contribution, provider, or command-registration behavior that requires the VS Code host.
3. **Deterministic smoke scenario** — subagent lifecycle, isolation, persistence, launcher state, or multi-component behavior already covered by project smoke infrastructure.
4. **Manual Extension Development Host reproduction** — browser/webview interaction, focus, layout, accessibility, or visual behavior.
5. **Installed-VSIX reproduction** — production dependency, pruning, ignore-rule, bundled package, activation, or release-only failures.

The guard should fail for the observed reason before the fix and pass afterward. If automation is impractical, document exact steps and expected observations.

## Verification Matrix

| Claim | Required evidence |
|---|---|
| Pure logic fixed | focused test passes, then relevant unit suite |
| Protocol path fixed | protocol/handler test and `npm run compile` |
| Activation/command fixed | `npm run test:integration` or exact host reproduction |
| Webview interaction fixed | `npm run compile` plus exact manual path |
| Session/queue/steering fixed | focused lifecycle test and original reproduction |
| Subagent/isolation fixed | relevant deterministic smoke/unit coverage |
| Package/runtime bug fixed | installed VSIX reproduces successfully after package flow |
| Performance fixed | comparable measurement under the same workload |
| Flake fixed | repeated runs under representative load |

## Completion Sequence

1. Run the focused regression guard.
2. Reproduce the original user path in the original environment.
3. Run related tests.
4. Run `npm run compile` when extension or webview bundles are affected.
5. Run `npm run test:integration` or `npm run test:all` when the change crosses the VS Code boundary.
6. Use the `build-deploy` workflow and reload VS Code when package/runtime behavior is part of the claim.
7. Check Output, Extension Host, webview, test, and install logs for new relevant errors.
8. Report verified and unverified evidence separately.

## Avoid False Confidence

These do not prove a fix:

- code inspection alone;
- compilation alone;
- one passing flaky-test run;
- chat working while launcher/settings were affected;
- F5 success for a package-content bug;
- an agent summary claiming tests passed;
- a catch or guard that only suppresses the symptom.

Use fresh, claim-specific evidence.

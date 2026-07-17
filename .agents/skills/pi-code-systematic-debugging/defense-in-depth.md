# Proportionate Defense in Depth for Pi Code

## Principle

After finding the root cause, add safeguards where they prevent recurrence or improve diagnosis. Do not scatter guards everywhere by default.

## Useful Layers

1. **Input/configuration boundary** — validate webview messages, settings, paths, model references, and user-provided values.
2. **Shared contract boundary** — keep protocol unions and runtime narrowing consistent across host and webviews.
3. **Ownership/lifecycle boundary** — reject stale tab, session, panel, child, or disposed-resource operations.
4. **Trust/environment boundary** — enforce SecretStorage, workspace trust, tool permissions, provider availability, and worktree isolation.
5. **Packaging/runtime boundary** — resolve production dependencies and bundled resources explicitly; fail clearly when absent.
6. **Diagnostics** — preserve enough tab/session/provider/action context to investigate without leaking secrets.

## Pi Code Examples

- Reject an unknown protocol message instead of silently ignoring state corruption.
- Pair event subscriptions with disposal when a panel, session, or extension lifecycle ends.
- Verify the target tab still owns the session before applying streamed events.
- Keep API keys in SecretStorage and redact them from logs/errors.
- Resolve bundled Pi packages from declared production dependencies and report missing packages clearly.

## Keep It Proportionate

Add a layer only when it catches a distinct failure mode or protects a meaningful boundary. Avoid checks that hide the original defect, silently return with inconsistent state, duplicate sources of truth, expose secrets, or add noisy logging on streaming/UI hot paths.

Prefer clear development failures. Use production recovery only when the recovery state is defined and safe.

## Checklist

1. Trace bad state from source to use.
2. Fix the source.
3. Identify boundaries that can independently admit the same failure class.
4. Add the smallest useful guards there.
5. Test the source fix and each important guard.

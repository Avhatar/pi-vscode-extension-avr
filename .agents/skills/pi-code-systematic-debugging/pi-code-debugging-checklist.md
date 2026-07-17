# Pi Code Debugging Checklist

Use this as a prompt list, not as a requirement to check everything.

## Reproduction Context

- exact steps and frequency
- Pi Code and VS Code versions; OS
- workspace root and trust state
- active tab/panel and restored/new session state
- idle, streaming, queued, steering, cancelling, or reloading state
- provider, model, authentication source, and relevant settings
- Extension Development Host or installed VSIX
- clean checkout/dependency/package reproducibility

## Logs and Evidence

- first error and complete stack trace
- Output → Pi Code and Extension Host logs
- webview DevTools console/network output
- unit/integration command, exit status, and full failure
- child/task lifecycle and actual isolated diff where relevant
- package/prune/vsce/install output
- minimal state snapshot without secrets

## Architecture Boundaries

- extension host versus browser-only webview ownership
- typed protocol variant and both handler sides
- activation/registration and disposal order
- dynamic Pi SDK import and resource-loader inputs
- vanilla DOM rendering and CSS variable usage
- runtime CSS and bundle paths included by `.vscodeignore`

## State and Lifecycle

- stable tab/session/child identifier versus active UI selection
- per-tab `PiSessionManager`, `DiffManager`, and `CheckpointManager`
- queue dispatch on `agent_end` versus `steer()` injection
- cancellation, abort signals, event listener cleanup, and process disposal
- panel serialization and window-reload restoration
- persisted schema compatibility and stale records

## Security and Environment

- SecretStorage rather than plaintext settings
- API-key bridge refresh after secret changes
- workspace trust and permission/tool gating
- provider/model availability and fallback behavior
- user/project skill, MCP, LSP, and agent resource precedence
- path separators, shell quoting, filesystem case, and worktree state

## Packaging

- dependency is direct and in `dependencies` when needed at runtime
- bundled Pi package is registered in `BUNDLED_PI_PACKAGES`
- prune did not remove required transitive/runtime files
- `.vscodeignore` preserves runtime CSS and required resources
- installed VSIX, not only F5, exercises the failing path

## Timing and Performance

- arbitrary timeout or polling assumptions
- event order around streaming, `agent_end`, cancellation, and disposal
- duplicate listeners or DOM updates
- repeated serialization, rendering, logging, or file reads on hot paths
- provider/network latency mistaken for local logic delay
- comparable timing/memory evidence under the same workload

## Evidence Summary Template

```text
Symptom:
Environment:
Reliable reproduction:
First failing boundary:
Known-good comparison:
Hypothesis:
Minimal test:
Result:
Root cause:
Fix:
Verification performed:
Remaining uncertainty:
```

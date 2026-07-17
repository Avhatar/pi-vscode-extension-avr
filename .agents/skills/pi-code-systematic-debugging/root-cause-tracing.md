# Root-Cause Tracing in Pi Code

## Principle

Trace backward through calls, SDK events, protocol messages, state transitions, and lifecycle boundaries until you find where correct state first became incorrect. Fix that source, not only the final visible symptom.

## Process

1. **Observe the symptom** — capture the first error, full stack, relevant Output/webview/test logs, and environment.
2. **Find the immediate cause** — identify the exact operation and invalid state.
3. **Find the caller or trigger** — command, provider callback, SDK event, protocol message, queued prompt, steering action, restoration, child lifecycle, filesystem/process callback, or package load.
4. **Trace the value backward** — where was it created, deserialized, assigned, persisted, restored, cleared, or allowed to become stale?
5. **Find the original trigger** — the earliest incorrect assumption, ownership decision, or state transition.
6. **Confirm causality** — change only the suspected cause in a controlled test or diagnostic experiment.

## Pi Code Example

Symptom:

```text
A streamed update appears in the wrong chat tab.
```

Do not merely ignore updates when the visible tab differs.

Trace backward:

```text
webview render update
<- ChatController routed session event
<- event callback captured mutable active-tab state
<- session belonged to a different tab
```

The source is incorrect event ownership/routing, not the renderer lacking a visibility guard.

## Project-Specific Traps

### Host/webview split

The browser webview cannot call `vscode` or Node APIs. Trace `postMessage` through the typed protocol and both handler sides rather than assuming one runtime owns the whole flow.

### Tab and session identity

Active UI state is not ownership. Trace the stable tab/session identifier through controller, panel, queue, diff, checkpoint, and persistence paths.

### Queue versus steering

Queued prompts dispatch after `agent_end`; steering injects into the active stream. Confirm which path changed state and which lifecycle event authorizes it.

### Reload and restoration

A panel or session may be reconstructed after window reload. Check persisted schema, serializer/controller order, stale listeners, and disposed resources.

### Resource and package loading

F5 sees the development dependency tree. Installed VSIX activation sees pruned production contents. Trace package resolution and `.vscodeignore` before changing runtime code.

## Targeted Instrumentation

Log immediately before the suspect boundary with only context that distinguishes hypotheses: action, tab/session/child identifier, lifecycle state, provider/model, and error category. Never log API keys, prompts unnecessarily, or full sensitive configuration. Remove temporary noisy logs after diagnosis.

## Questions to Keep Asking

- What exact state is invalid?
- Which component owns it?
- When was it last correct?
- Which event, message, or lifecycle transition changed it?
- Why was that transition allowed?
- What evidence would disprove this explanation?

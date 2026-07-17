# Condition-Based Waiting in Pi Code

## Principle

Wait for the state or event the product actually requires, not for a guessed duration. Arbitrary `setTimeout`, sleeps, polling delays, and retry counts make tests and runtime behavior depend on machine speed, extension-host load, provider latency, and webview timing.

## Prefer

- the Pi SDK/session event that signals completion;
- a promise returned by the owning operation;
- a typed host/webview acknowledgement when a cross-boundary action must complete;
- polling an observable condition with a bounded timeout and useful failure message in tests;
- `AbortSignal` or the project's cancellation path for runtime operations.

## Vitest Example

```ts
async function waitFor(
    predicate: () => boolean,
    timeoutMs = 1_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error('Session did not reach the expected state');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
```

The timeout is a safety bound, not the expected completion time. The check proceeds immediately once state is ready. Prefer existing test helpers over adding a duplicate helper.

## Common Patterns

| Need | Wait for |
|---|---|
| Agent turn completion | routed `agent_end` or settled prompt promise |
| Queued message dispatch | queue/state transition and resulting session call |
| Webview initialization | ready/initial-state message, not a render delay |
| Child lifecycle | child state transition or lifecycle result |
| File/process operation | returned promise/process exit plus cancellation |
| VS Code integration | registered extension/command or explicit activation result |

## Common Mistakes

- Increasing the delay instead of removing the race
- Omitting a timeout so a failed condition hangs forever
- Polling a captured stale value rather than current state
- Treating an SDK/provider delay as deterministic
- Using an event without cleaning up its listener
- Continuing after timeout without reporting the observed state

## When a Fixed Delay Is Valid

Use a fixed delay only when elapsed time is the behavior under test, such as debounce, notification duration, or retry backoff. State why the duration is meaningful and use fake timers when they preserve the real contract.

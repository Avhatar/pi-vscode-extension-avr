---
name: pi-code-test-driven-development
description: Use when implementing testable Pi Code behavior, fixing regressions, or changing logic where an automated test or deterministic reproduction can be created before production code.
---

# Test-Driven Development for Pi Code

Define intended behavior first, observe the guard fail for the right reason, then implement the smallest change that makes it pass.

## Core Cycle

```text
RED -> verify the failure -> GREEN -> verify the fix -> REFACTOR -> stay green
```

### 1. RED — Create One Failing Guard

Choose the narrowest useful level:

- **Vitest unit test:** pure logic, reducers, protocol serialization, models, resource resolution, persistence, controller/session behavior with deterministic boundaries;
- **VS Code integration test:** activation, contribution, command, or provider behavior requiring the host;
- **deterministic smoke scenario:** subagent lifecycle, isolation, persistence, launcher state, or coordinated runtime behavior;
- **manual F5 reproduction:** webview focus, layout, accessibility, or visual interaction;
- **installed-VSIX reproduction:** package contents, runtime dependencies, pruning, bundled resources, or activation after installation.

Test one observable behavior and name it accordingly.

```ts
it('dispatches a queued message only after agent_end', async () => {
    // Arrange the session/controller state using existing test helpers.
    // Observe that the queued prompt is not sent while streaming.
    // Emit agent_end and assert one dispatch with the expected tab/session owner.
});
```

Use actual project helpers and APIs; this example describes intent, not a copy-paste fixture.

### 2. Verify RED

Run the focused guard before implementation. Confirm it fails rather than merely failing to compile or set up, the message matches the missing behavior, and it would pass if the requirement existed. A test that passes immediately may cover the wrong path or existing behavior.

### 3. GREEN — Implement Minimally

Write the smallest production change that satisfies the observed requirement. Follow existing ownership and boundary patterns. Update the shared protocol before consumers when needed. Do not add unrelated abstractions or cleanup.

### 4. Verify GREEN

Run the focused guard, then the nearest related suite. Run `npm run compile` when extension-host or webview bundles changed. Use integration/manual/VSIX checks only when that boundary is part of the behavior.

### 5. REFACTOR

Improve names, duplication, and structure only while checks remain green. New behavior requires another RED cycle.

## Bug Fixes

A regression guard should reproduce the original failure before the fix. For async bugs, wait for an event or observable state with a bounded timeout rather than increasing sleeps. For F5/VSIX differences, preserve the exact packaging reproduction and automate the nearest deterministic layer.

## When Conventional TDD Is Impractical

Visual composition, VS Code focus behavior, provider outages, OAuth UI, billed live-provider behavior, OS integration, and package-install failures may not fit a normal unit test. Do not create a meaningless mock-based test. Use the best available guard:

- exact manual procedure with expected evidence;
- deterministic protocol/controller test below the UI boundary;
- Extension Development Host smoke;
- installed-VSIX smoke;
- bounded diagnostic harness or existing subagent smoke scenario.

State what remains manual. The principle remains: failure observed before change, relevant evidence observed afterward.

## Test Quality

- Test observable behavior, not implementation details.
- Prefer real lightweight collaborators when deterministic.
- Mock slow, external, billed, or nondeterministic boundaries, not the behavior under test.
- Preserve real typed protocol and lifecycle contracts in fakes.
- Clean up files, processes, listeners, timers, static state, sessions, and worktrees.
- Avoid test-order dependence, wall-clock sleeps, real secrets, and unbounded provider calls.

Read [testing-anti-patterns.md](testing-anti-patterns.md) when introducing mocks, helpers, fake sessions/webviews, timers, filesystem fixtures, or lifecycle-sensitive tests.

## Completion Checklist

- [ ] Guard failed for the expected reason before the change
- [ ] Minimal implementation made it pass
- [ ] Related tests still pass
- [ ] `npm run compile` passes when bundles changed
- [ ] Fixtures, listeners, processes, files, and state are cleaned up
- [ ] Manual, integration, or installed-VSIX evidence is documented when required

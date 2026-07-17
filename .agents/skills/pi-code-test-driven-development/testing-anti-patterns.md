# Pi Code Testing Anti-Patterns

## Test Behavior, Not Test Doubles

Mocks and fakes isolate boundaries; they are not the behavior being verified. Do not assert only that a mock was called when the user-visible or state transition outcome can be observed.

Before mocking, identify the dependency's contract and side effects. Mock the lowest slow, external, billed, or nondeterministic boundary while preserving the protocol and lifecycle needed downstream.

## Avoid Production APIs Used Only by Tests

Do not add public extension APIs solely to reset or expose private state. Prefer fixtures, builders, dependency injection at existing ownership boundaries, test-only modules, or assertions through public behavior. Real cleanup such as `dispose`, unsubscribe, abort, process termination, or worktree cleanup belongs in production when it represents genuine ownership.

## Avoid Incomplete Test Doubles

A fake `vscode` API, Pi SDK session, webview, provider response, child runtime, filesystem, or process must preserve the contract used downstream. Partial doubles can hide message ordering, disposal, persistence, and error behavior. Prefer existing project helpers or real lightweight implementations.

## Avoid State Leaks

Tests must restore what they change:

- dispose subscriptions, panels, sessions, controllers, and child runtimes;
- restore timers, environment variables, settings, and static registries;
- remove temporary files, repositories, worktrees, sockets, and processes;
- isolate SecretStorage/auth substitutes and never use real secrets;
- reset DOM and webview/global state in browser-oriented tests.

A test that passes alone but fails in the suite often leaks state or depends on order.

## Avoid Arbitrary Time Assumptions

Do not increase sleeps or polling delays to hide races. Wait for an event, promise, process exit, or observable condition with a timeout and diagnostic state. Fixed timing is valid only when elapsed time is the requirement; use fake timers when they preserve behavior.

## Avoid Over-Mocking VS Code and Pi SDK

A unit test cannot prove command contribution, webview CSP, VS Code focus behavior, real provider authentication, or packaged dependency availability. Use integration, F5, deterministic smoke, or installed-VSIX evidence when those boundaries are central.

## Avoid Protocol False Confidence

Testing a handler in isolation does not prove the host/webview contract. When changing messages, verify the typed union, serialization, sender, receiver, invalid input behavior, and compatibility with restored/persisted state as applicable.

## Avoid Packaging False Confidence

`npm run compile` and F5 do not prove that pruning or `.vscodeignore` preserved runtime files. Use an installed VSIX when the defect surface includes dependencies, bundled packages, CSS, or activation after installation.

## Quick Check

- Is the assertion about observable behavior?
- Would it fail against the original defect?
- Does the fixture preserve real contracts and ownership?
- Does cleanup restore all global and external state?
- Is the chosen test level exercising the boundary that matters?

# Chapter: platform-ports

Every part of the portable core that has to touch the outside world — read a file, look up a setting, open a diff editor, acquire a session lock — does so through a port declared in [src/core/ports/](../../../../src/core/ports/). The port is a TypeScript interface; the adapter is a class in [src/adapters/vscode/](../../../../src/adapters/vscode/) or [src/adapters/node/](../../../../src/adapters/node/) that implements it. The core never imports adapters; adapters never import from each other.

This chapter is a catalog of the port surface.

## Article roster

- [platform-ports](platform-ports.md) — every port interface (`ChatPlatformPorts`, `FileStatePort`, `DiffPresenterPort`, `SessionRuntimePorts`, `RawStoragePort`, `Logger`, `ExternalUrlPort`), the sub-ports they aggregate, and the invariants callers can rely on.

## Reader task

The reader arrives here to answer one of:

- "The reducer needs to check whether a file exists. Which port does it call?"
- "Where do I add a new session-scoped capability?"
- "Why is `FileStatePort.readText` synchronous when almost everything else is async?"
- "How does the reducer choose between VS Code and Node implementations?"

## Neighborhood

- **Adapters** implementing these ports live in [Part IV](../../04-platform-adapters/vscode-workspace-and-diff/vscode-workspace-and-diff.md).
- **Callers** are throughout Parts III / V / VII — the reducer reads settings, the session manager acquires locks, the diff manager captures / presents diffs.
- **The event router** at [Part V § event-router](../../05-pi-sdk-integration/event-router/event-router.md) is thematically similar but is *not* a port — it lives above the SDK, not below the reducer.

## Non-goals

- Concrete adapter behavior (what `VsCodeSecretStore.get` does under the hood) is [Part IV](../../../index.md#part-iv--platform-adapters).
- Any port that has ever been considered but not added — this chapter documents what exists, not what could exist.
- The claude-compat surface, which is a Pi SDK integration and not a port; see [Part V § claude-sdk-compat](../../05-pi-sdk-integration/claude-sdk-compat/claude-sdk-compat.md).

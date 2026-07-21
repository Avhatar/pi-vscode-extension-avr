# Chapter: writable-session-lock

Two hosts — a VS Code window and the standalone desktop app — can both open the same repository. If they both try to write to the same Pi session file, message history corrupts and the underlying JSONL becomes inconsistent. The **writable-session lock** is the mechanism that prevents this: a sidecar `.pi-code.lock` file next to every session file, holding a JSON payload identifying the owner (`applicationId`, `processId`, `hostname`, `acquiredAt`). Acquisition is exclusive; a second host attempting to open the same session hits a `SessionLockConflictError` and either offers to recover (if the previous owner is dead) or refuses.

## Article roster

- [writable-session-lock](writable-session-lock.md) — `SessionLockPort` surface, `NodeSessionLock` semantics, lifecycle in the session manager, and cross-host safety guarantees.

## Reader task

The reader arrives here to answer one of:

- "What happens when the user has the same repo open in both VS Code and the standalone desktop app?"
- "How is a stale lock (from a crashed process) recovered?"
- "Why is the lock file next to the session file, not in a shared table?"
- "Does the lock survive across window reloads?"

## Neighborhood

- **The port declaration** is [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md).
- **The concrete Node implementation** shared by both hosts is [Part IV § node-platform-adapters](../../04-platform-adapters/node-platform-adapters/node-platform-adapters.md).
- **Acquisition in the session lifecycle** is [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).

## Non-goals

- Message-level concurrency inside a single session (append order, race between two threads in one host) is not this lock's concern — it operates at the "which host opens this file" level.
- File-system-level locking (`fcntl`, Windows `LockFile`) is not used; the sidecar file is the mutual exclusion primitive.
- The lock does not protect *read-only* history browsing — only writable sessions.

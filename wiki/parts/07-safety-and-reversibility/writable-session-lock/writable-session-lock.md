# writable-session-lock

## Stance

Locks are a **safety property**, not a hint. Every writable session acquires its lock **before** the SDK opens the session file. If acquisition fails and stale recovery is not possible, the session simply does not open — the UI surfaces the conflict, and the user is directed to close the other host. This is intentionally conservative: silently taking over a session risks data loss if the "dead" process is actually alive on a different network path. The recovery path exists only when the owner is verifiably gone (dead PID, same hostname, minimum age).

## Role

[`SessionLockPort`](../../../../src/core/ports/session-platform.ts#L104):

- `acquire(sessionPath): Promise<SessionLockHandle>` — creates the sidecar lock file with exclusive `wx` flags; on `EEXIST`, throws `SessionLockConflictError` with the current owner's payload.
- `recoverStale(sessionPath, expectedOwnerId): Promise<SessionLockHandle>` — writes a recovery-claim marker, checks the current lock's liveness; if the owner is dead and the age ≥ threshold, deletes the old lock and re-acquires.

Support types [session-platform.ts:67-96](../../../../src/core/ports/session-platform.ts#L67):

- `SessionLockOwner`: `{ ownerId, applicationId, processId, hostname, acquiredAt }`
- `SessionLockHandle`: `{ sessionPath, owner, release(): Promise<void> }`
- `SessionLockConflict`: `{ sessionPath, lockPath, owner, ownerLiveness: 'alive' | 'dead' | 'unknown', ageMs, staleRecoveryAllowed }`
- `SessionLockConflictError` — extends `Error`, exposes the conflict payload.

[`NodeSessionLock`](../../../../src/adapters/node/session-lock.ts#L35) is the shared implementation used by both VS Code (with `applicationId: 'pi-code-vscode'`) and the standalone desktop host (`applicationId: 'pi-code-node'`).

- `acquire(sessionPath)` [session-lock.ts:59](../../../../src/adapters/node/session-lock.ts#L59) — writes `{ version: 1, owner }` as JSON to `<canonicalizedSessionPath>.pi-code.lock` with `fs.openSync(path, 'wx', 0o600)`. On `EEXIST`, reads the existing lock, computes `ownerLiveness` via `_ownerLiveness(owner)`, throws `SessionLockConflictError`.
- `release()` [session-lock.ts:97](../../../../src/adapters/node/session-lock.ts#L97) — idempotent. Reads the lock, verifies the `ownerId` still matches (someone else may have taken over via recovery), and `fs.unlinkSync`.
- `recoverStale(sessionPath, expectedOwnerId)` [session-lock.ts:111](../../../../src/adapters/node/session-lock.ts#L111) — writes a recovery-claim file (`lockPath + '.recover-' + SHA256(expectedOwnerId)`); reads the current lock; if `ownerLiveness === 'dead'` AND `ageMs ≥ staleAfterMs`, deletes the lock, deletes the claim, re-acquires.
- `_ownerLiveness(owner)` [session-lock.ts:176](../../../../src/adapters/node/session-lock.ts#L176) — if `owner.hostname !== os.hostname()`, returns `'unknown'`; same host, calls the injectable `isProcessAlive(pid)` (default: `process.kill(pid, 0)` probe).
- `canonicalizeSessionPath` [session-lock.ts:198](../../../../src/adapters/node/session-lock.ts#L198) — resolves symlinks via `realpathSync.native`; without this, `~/proj/session.json` and `/home/user/proj/session.json` would get different locks.
- `getSessionLockPath` [session-lock.ts:189](../../../../src/adapters/node/session-lock.ts#L189) — returns `sessionPath + '.pi-code.lock'`.

Defaults: `DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000` [session-lock.ts:15](../../../../src/adapters/node/session-lock.ts#L15).

Integration in the session manager [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md):

- `_activateSessionRuntime` calls `sessionLocks.acquire(sessionPath)` **before** the SDK opens the session file.
- The handle is stored in `PiSessionRuntimeState.sessionLock`.
- `_invalidateCurrent()` calls `handle.release()` during teardown.

## Keywords

**Types:**
- `SessionLockPort` — [session-platform.ts:104](../../../../src/core/ports/session-platform.ts#L104)
- `SessionLockHandle` — [session-platform.ts:98](../../../../src/core/ports/session-platform.ts#L98)
- `SessionLockOwner` — [session-platform.ts:67](../../../../src/core/ports/session-platform.ts#L67)
- `SessionLockConflict` — [session-platform.ts:77](../../../../src/core/ports/session-platform.ts#L77)
- `SessionLockConflictError` — [session-platform.ts:86](../../../../src/core/ports/session-platform.ts#L86)
- `PersistedSessionLock` — [session-lock.ts:17](../../../../src/adapters/node/session-lock.ts#L17); on-disk payload shape
- `NodeSessionLock` — [session-lock.ts:35](../../../../src/adapters/node/session-lock.ts#L35)

**Methods:**
- `acquire(sessionPath)` — [session-lock.ts:59](../../../../src/adapters/node/session-lock.ts#L59)
- `release()` (on handle) — [session-lock.ts:97](../../../../src/adapters/node/session-lock.ts#L97)
- `recoverStale(sessionPath, expectedOwnerId)` — [session-lock.ts:111](../../../../src/adapters/node/session-lock.ts#L111)
- `_readConflict(sessionPath, lockPath)` — [session-lock.ts:148](../../../../src/adapters/node/session-lock.ts#L148)
- `_ownerLiveness(owner)` — [session-lock.ts:176](../../../../src/adapters/node/session-lock.ts#L176)
- `canonicalizeSessionPath(sessionPath)` — [session-lock.ts:198](../../../../src/adapters/node/session-lock.ts#L198)
- `getSessionLockPath(sessionPath)` — [session-lock.ts:189](../../../../src/adapters/node/session-lock.ts#L189)
- `getRecoveryClaimPath(lockPath, expectedOwnerId)` — [session-lock.ts:193](../../../../src/adapters/node/session-lock.ts#L193)

**Attributes / markers:**
- Sidecar naming: `<sessionPath>.pi-code.lock`
- File permissions: `0o600` — owner read/write only
- Lock file JSON version: `1`
- `DEFAULT_STALE_AFTER_MS`: 5 minutes
- Owner liveness values: `'alive' | 'dead' | 'unknown'`
- `applicationId` distinguishes hosts: `'pi-code-vscode'` vs. `'pi-code-node'`

**Namespaces:**
- [src/core/ports/session-platform.ts](../../../../src/core/ports/session-platform.ts) — port + support types
- [src/adapters/node/session-lock.ts](../../../../src/adapters/node/session-lock.ts) — the shared implementation

## Lifecycle edges

**Depends on:**
- [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — the port surface.
- [Part IV § node-platform-adapters](../../04-platform-adapters/node-platform-adapters/node-platform-adapters.md) — where `NodeSessionLock` lives.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — session acquisition / release call sites.

**Used by:**
- [desktop-host-lifecycle](../../10-standalone-desktop-host/desktop-host-lifecycle/desktop-host-lifecycle.md) — the shared lock semantics prevent this host from racing a VS Code window on the same session file.

## See also

- **Rule — acquire before the SDK opens the file.** Reversing the order opens a race. `_activateSessionRuntime` maintains this ordering; new session-opening paths must too.
- **Rule — `release` is idempotent, but not blind.** It checks the ownerId still matches. If someone recovered a stale lock (took over), `release` on the original handle is a no-op — this is the correct behavior; you were no longer the owner.
- **Pattern — canonicalize before anything else.** `foo/../bar/session.json` and `bar/session.json` must map to the same lock file. `realpathSync.native` handles symlinks and case variations.
- **Pattern — recovery has a claim file.** Concurrent recovery attempts write to different claim paths (SHA256 of ownerId); only one wins the actual delete-then-re-acquire race. This avoids two hosts both thinking they successfully recovered.
- **Pitfall — cross-host liveness is `unknown`.** If the owner is on a different hostname, we cannot check whether their process is alive. `staleRecoveryAllowed` is false; the UI must instruct the user to close the other host.
- **Pitfall — lock files are user-visible.** They live next to session files. Users may see them in file browsers and delete them — do not rely on them being invisible. Recovery handles the "deleted while process alive" case: next `acquire` succeeds cleanly.
- **Pattern — 5-minute stale threshold is a floor.** It exists so a briefly-hung process cannot be prematurely taken over. If tuning is ever needed, expose the value in options; do not lower it below ~1 minute.

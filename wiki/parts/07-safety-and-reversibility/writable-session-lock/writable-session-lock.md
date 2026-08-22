# writable-session-lock

## Stance

Locks are a **safety property**, not a hint. Every writable session acquires its lock **before** the SDK opens the session file. If acquisition fails and stale recovery is not possible, the session simply does not open — the UI surfaces the conflict, and the user is directed to close the other host. This is intentionally conservative: silently taking over a session risks data loss if the "dead" process is actually alive on a different network path.

The mirror-image failure is equally real: a crash, a `kill`, or a power loss leaves a sidecar behind with nobody to release it, and an unreclaimable sidecar makes its chat permanently unopenable. So *provably* gone owners are reclaimed, and reclaiming happens on the ordinary open path rather than through a separate user-initiated repair. Proof means one of: the recorded pid no longer exists on this host, or the lock predates the current OS boot. Everything weaker — a live pid, another hostname, an unreadable payload younger than the stale threshold — still refuses.

## Role

[`SessionLockPort`](../../../../src/core/ports/session-platform.ts#L132):

- `acquire(sessionPath): Promise<SessionLockHandle>` — creates the sidecar lock file with exclusive `wx` flags; on `EEXIST`, throws `SessionLockConflictError` with the current owner's payload.
- `recoverStale(sessionPath, expectedOwnerId): Promise<SessionLockHandle>` — writes a recovery-claim marker, re-reads the conflict; if it is still recoverable and still names `expectedOwnerId`, deletes the old lock and re-acquires. `expectedOwnerId` is `undefined` for an unreadable lock, which then recovers only while it stays unreadable.

Support types [session-platform.ts:69-141](../../../../src/core/ports/session-platform.ts#L69):

- `SessionLockOwner`: `{ ownerId, applicationId, processId, hostname, acquiredAt, bootTimeMs? }`
- `SessionLockHandle`: `{ sessionPath, owner, release(): Promise<void> }`
- `SessionLockConflict`: `{ sessionPath, lockPath, owner, ownerLiveness: 'alive' | 'dead' | 'unknown', ageMs, staleRecoveryAllowed, ownerBootMismatch? }`
- `SessionLockConflictError` — extends `Error`, exposes the conflict payload; its message comes from `describeSessionLockConflict(conflict)`, which names the owner, states whether that process still runs, and points at the sidecar when the user must remove it by hand.

[`acquireSessionLock(locks, sessionPath, log?)`](../../../../src/core/session/session-lock-recovery.ts#L17) is the portable acquire-then-reclaim path both hosts use, so recovery policy is not re-implemented per call site. It tries `acquire`, and on a conflict with `staleRecoveryAllowed` calls `recoverStale` **once** — a lock that keeps changing hands surfaces the conflict instead of spinning. Callers: [`PiSessionManager._acquireSessionLock`](../../../../src/pi/session.ts#L465) for chat sessions and [`PiChildSessionFactory._acquireTranscriptLock`](../../../../src/pi/subagents/pi-child-session.ts#L135) for persistent child transcripts, which outlive their parent and would otherwise strand a resumable run.

[`NodeSessionLock`](../../../../src/adapters/node/session-lock.ts#L44) is the shared implementation used by both VS Code (with `applicationId: 'pi-code-vscode'`) and the standalone desktop host (`applicationId: 'pi-code-node'`).

- `acquire(sessionPath)` [session-lock.ts:70](../../../../src/adapters/node/session-lock.ts#L70) — writes `{ version: 2, owner }` as JSON to `<canonicalizedSessionPath>.pi-code.lock` with `fs.open(path, 'wx', 0o600)`. On `EEXIST`, reads the existing lock, computes the conflict verdict, throws `SessionLockConflictError`.
- `release()` [session-lock.ts:110](../../../../src/adapters/node/session-lock.ts#L110) — idempotent. Reads the lock, verifies the `ownerId` still matches (someone else may have taken over via recovery), and unlinks.
- `recoverStale(sessionPath, expectedOwnerId)` [session-lock.ts:124](../../../../src/adapters/node/session-lock.ts#L124) — writes a recovery-claim file (`lockPath + '.recover-' + SHA256(expectedOwnerId ?? 'unidentified-owner')`); re-reads the conflict; if `staleRecoveryAllowed` AND the on-disk owner still equals `expectedOwnerId`, deletes the lock, deletes the claim, re-acquires.
- `_isStaleRecoveryAllowed(sameHost, ownerLiveness, ageMs)` [session-lock.ts:205](../../../../src/adapters/node/session-lock.ts#L205) — the verdict matrix. Another hostname is never recoverable; `'dead'` on this host is recoverable **immediately** (a vanished pid cannot come back — a restart of that host takes a fresh lock); `'alive'` never is; `'unknown'` waits out `staleAfterMs`.
- `_ownerLiveness(owner, ownerBootMismatch)` [session-lock.ts:234](../../../../src/adapters/node/session-lock.ts#L234) — if `owner.hostname !== os.hostname()`, returns `'unknown'`; a pre-boot lock is `'dead'` regardless of the probe; otherwise calls the injectable `isProcessAlive(pid)` (default: `process.kill(pid, 0)`).
- `_isBootMismatch(owner)` [session-lock.ts:228](../../../../src/adapters/node/session-lock.ts#L228) — compares `owner.bootTimeMs` with the current boot instant beyond `BOOT_TIME_TOLERANCE_MS`. This outranks the liveness probe because after a reboot the OS may have handed the recorded pid to an unrelated live process, which would otherwise read as `'alive'` forever.
- `_readSidecarAgeMs(lockPath)` [session-lock.ts:216](../../../../src/adapters/node/session-lock.ts#L216) — mtime-based age for locks with no readable payload; a vanished sidecar returns `undefined` and counts as recoverable.
- `defaultBootTimeMs()` [session-lock.ts:315](../../../../src/adapters/node/session-lock.ts#L315) — `Date.now() - os.uptime() * 1000`. `os.uptime()` counts suspended time on Windows, Linux, and macOS, so sleep/resume keeps the value stable while a reboot moves it far beyond the tolerance.
- `canonicalizeSessionPath` [session-lock.ts:264](../../../../src/adapters/node/session-lock.ts#L264) — resolves symlinks via `fs.realpath`; without this, `~/proj/session.json` and `/home/user/proj/session.json` would get different locks.
- `getSessionLockPath` [session-lock.ts:253](../../../../src/adapters/node/session-lock.ts#L253) — returns `sessionPath + '.pi-code.lock'`.

Defaults: `DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000`, `BOOT_TIME_TOLERANCE_MS = 10_000` [session-lock.ts:14-23](../../../../src/adapters/node/session-lock.ts#L14). On-disk schema is `LOCK_SCHEMA_VERSION = 2`; `SUPPORTED_LOCK_VERSIONS` also reads version 1 (pre-`bootTimeMs`) locks, which fall back to pid-and-age evidence.

Integration in the session manager [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md):

- `_createSessionRuntimeInner` calls `_acquireSessionLock(sessionPath)` — the recovery-aware wrapper — **before** the SDK creates or opens the session file.
- The handle is stored in `PiSessionRuntimeState.sessionLock`.
- `_invalidateCurrent()` calls `handle.release()` during teardown.
- A reclaimed lock is logged to the Pi Code output channel with the conflict description, so a takeover is never silent.

## Keywords

**Types:**
- `SessionLockPort` — [session-platform.ts:132](../../../../src/core/ports/session-platform.ts#L132)
- `SessionLockHandle` — [session-platform.ts:126](../../../../src/core/ports/session-platform.ts#L126)
- `SessionLockOwner` — [session-platform.ts:69](../../../../src/core/ports/session-platform.ts#L69)
- `SessionLockConflict` — [session-platform.ts:86](../../../../src/core/ports/session-platform.ts#L86)
- `SessionLockConflictError` — [session-platform.ts:117](../../../../src/core/ports/session-platform.ts#L117)
- `PersistedSessionLock` — [session-lock.ts:25](../../../../src/adapters/node/session-lock.ts#L25); on-disk payload shape
- `NodeSessionLock` — [session-lock.ts:44](../../../../src/adapters/node/session-lock.ts#L44)
- `NodeSessionLockOptions` — [session-lock.ts:30](../../../../src/adapters/node/session-lock.ts#L30); injectables include `now`, `isProcessAlive`, `bootTimeMs`, `ownerIdFactory`

**Methods:**
- `acquireSessionLock(locks, sessionPath, log?)` — [session-lock-recovery.ts:17](../../../../src/core/session/session-lock-recovery.ts#L17)
- `describeSessionLockConflict(conflict)` — [session-platform.ts:98](../../../../src/core/ports/session-platform.ts#L98)
- `acquire(sessionPath)` — [session-lock.ts:70](../../../../src/adapters/node/session-lock.ts#L70)
- `release()` (on handle) — [session-lock.ts:110](../../../../src/adapters/node/session-lock.ts#L110)
- `recoverStale(sessionPath, expectedOwnerId)` — [session-lock.ts:124](../../../../src/adapters/node/session-lock.ts#L124)
- `_readConflict(sessionPath, lockPath)` — [session-lock.ts:163](../../../../src/adapters/node/session-lock.ts#L163)
- `_isStaleRecoveryAllowed(sameHost, ownerLiveness, ageMs)` — [session-lock.ts:205](../../../../src/adapters/node/session-lock.ts#L205)
- `_readSidecarAgeMs(lockPath)` — [session-lock.ts:216](../../../../src/adapters/node/session-lock.ts#L216)
- `_isBootMismatch(owner)` — [session-lock.ts:228](../../../../src/adapters/node/session-lock.ts#L228)
- `_ownerLiveness(owner, ownerBootMismatch)` — [session-lock.ts:234](../../../../src/adapters/node/session-lock.ts#L234)
- `defaultBootTimeMs()` — [session-lock.ts:315](../../../../src/adapters/node/session-lock.ts#L315)
- `canonicalizeSessionPath(sessionPath)` — [session-lock.ts:264](../../../../src/adapters/node/session-lock.ts#L264)
- `getSessionLockPath(sessionPath)` — [session-lock.ts:253](../../../../src/adapters/node/session-lock.ts#L253)
- `getRecoveryClaimPath(lockPath, expectedOwnerId)` — [session-lock.ts:257](../../../../src/adapters/node/session-lock.ts#L257)
- `PiSessionManager._acquireSessionLock(sessionPath)` — [session.ts:465](../../../../src/pi/session.ts#L465)
- `PiChildSessionFactory._acquireTranscriptLock(transcriptPath)` — [pi-child-session.ts:135](../../../../src/pi/subagents/pi-child-session.ts#L135)

**Attributes / markers:**
- Sidecar naming: `<sessionPath>.pi-code.lock`
- Recovery-claim naming: `<lockPath>.recover-<sha256(ownerId)>`
- File permissions: `0o600` — owner read/write only
- Lock file JSON version: `2` written, `1` still readable
- `DEFAULT_STALE_AFTER_MS`: 5 minutes — applies to unverifiable owners only
- `BOOT_TIME_TOLERANCE_MS`: 10 seconds
- `UNIDENTIFIED_OWNER_CLAIM`: recovery-claim salt for an unreadable lock
- Owner liveness values: `'alive' | 'dead' | 'unknown'`
- `applicationId` distinguishes hosts: `'pi-code-vscode'` vs. `'pi-code-node'`

**Namespaces:**
- [src/core/ports/session-platform.ts](../../../../src/core/ports/session-platform.ts) — port + support types
- [src/core/session/session-lock-recovery.ts](../../../../src/core/session/session-lock-recovery.ts) — the portable acquire-then-reclaim path
- [src/adapters/node/session-lock.ts](../../../../src/adapters/node/session-lock.ts) — the shared implementation

## Lifecycle edges

**Depends on:**
- [Part III § platform-ports](../../03-portable-chat-core/platform-ports/platform-ports.md) — the port surface.
- [Part IV § node-platform-adapters](../../04-platform-adapters/node-platform-adapters/node-platform-adapters.md) — where `NodeSessionLock` lives.
- [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md) — session acquisition / release call sites.

**Used by:**
- [desktop-host-lifecycle](../../10-standalone-desktop-host/desktop-host-lifecycle/desktop-host-lifecycle.md) — the shared lock semantics prevent this host from racing a VS Code window on the same session file.

## See also

- **Rule — acquire before the SDK opens the file.** Reversing the order opens a race. `_createSessionRuntimeInner` maintains this ordering; new session-opening paths must too.
- **Rule — every session-opening path goes through `acquireSessionLock`.** Calling `SessionLockPort.acquire` directly reintroduces the original defect: a crashed owner's sidecar then blocks its chat forever, because nothing else in the process ever calls `recoverStale`. The one deliberate exception is [`JsonStateStore`](../../04-platform-adapters/node-platform-adapters/node-platform-adapters.md), whose own retry loop waits out a *live* writer before applying the same recovery decision.
- **Rule — `release` is idempotent, but not blind.** It checks the ownerId still matches. If someone recovered a stale lock (took over), `release` on the original handle is a no-op — this is the correct behavior; you were no longer the owner.
- **Pattern — canonicalize before anything else.** `foo/../bar/session.json` and `bar/session.json` must map to the same lock file. `fs.realpath` handles symlinks and case variations.
- **Pattern — recovery has a claim file.** Concurrent recovery attempts write to different claim paths (SHA256 of ownerId); only one wins the actual delete-then-re-acquire race. This avoids two hosts both thinking they successfully recovered.
- **Pattern — recovery is attempted once per open.** `acquireSessionLock` does not loop. A lock that keeps changing owners under us produces a conflict the user can act on rather than an unbounded retry.
- **Pitfall — cross-host liveness is `unknown`.** If the owner is on a different hostname, we cannot check whether their process is alive. `staleRecoveryAllowed` is false; the conflict message names the host and the sidecar so the user can decide.
- **Pitfall — lock files are user-visible.** They live next to session files. Users may see them in file browsers and delete them — do not rely on them being invisible. Recovery handles the "deleted while process alive" case: next `acquire` succeeds cleanly.
- **Pitfall — a pid probe alone cannot detect a reboot.** Process ids are recycled, so after a power loss the recorded pid may belong to an unrelated live process and probe as `'alive'`. `bootTimeMs` is the tie-breaker; do not drop it from the payload, and do not "simplify" the verdict matrix back to a pure liveness check.
- **Pitfall — the stale threshold no longer gates dead owners.** It applies only where the evidence is weak: an `'unknown'` liveness verdict on this host, or an unreadable payload aged by sidecar mtime. Reinstating it for `'dead'` owners just re-adds a five-minute outage after every crash, because a vanished pid cannot resume writing.
- **Pattern — an unreadable sidecar is a crash artifact, not a foreign owner.** A torn JSON write (power loss mid-`writeFile`) yields no owner id. It becomes recoverable once mtime shows it older than `staleAfterMs`, and `recoverStale(path, undefined)` refuses if a real owner has appeared in the meantime.

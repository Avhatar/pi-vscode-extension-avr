# Wiki Changelog

Newest entries at the top. Never reshuffle past entries. `wiki-maintain` prepends a dated entry for every edit that touches wiki content.

Format for each entry:

```
## YYYY-MM-DD — <short scope label>

- **Code:** <1-line description of what changed in the repo>
- **Wiki:** <files touched with section-level summary>
- **Escalations:** <open question reference or "none">
```

## 2026-08-23 — Split the user-facing release notes from the per-build changelog

- **Code:** `CHANGELOG.md` shipped inside the VSIX as `extension/changelog.md`, so the Marketplace Changelog tab rendered 173 stamped builds while only 11 versions were ever published — a user upgrading 0.57.1 → 0.66.3 had to read and merge 21 sections to learn what they got. New `RELEASES.md` carries one consolidated entry per published version (all 11, plus 0.70.0), `package.json`'s `package` script passes `--changelog-path RELEASES.md`, and `.vscodeignore` now excludes `CHANGELOG.md` so the per-build history stays a contributor artefact. `bump-version.js` is unchanged and still stamps `CHANGELOG.md` only, because a bump happens per build while a release entry is owed only at publication. `chat-controller.ts`'s `openChangelog` now probes `RELEASES.md` → `changelog.md` → `CHANGELOG.md` instead of hardcoding one name, since the source checkout and the installed VSIX have different layouts and only a case-insensitive filesystem forgave the old path.
- **Wiki:** `packaging-and-release.md` — the `package` script line and vsce-flags marker record `--changelog-path`, the `.vscodeignore` invariant adds `CHANGELOG.md`, the `CHANGELOG.md` format block states it is per-build and excluded, a new `RELEASES.md` block documents the consolidation contract and the hand-curation rule, Keywords/Namespaces split the two artefacts by audience, and See-also gains the two-file pattern, the entry-owed-at-publication rule, and a pitfall against collapsing the `/changelog` probe; `_intro.md` reframes the swap as covering both README and changelog and adds a reader task.
- **Escalations:** none — the split was chosen by the user, and all edits landed in existing articles.

## 2026-08-23 — DeepSeek vision model shim and the image-compat guard

- **Code:** DeepSeek announced `deepseek-v4-flash-vision-exp` on 2026-08-21, but the newest published Pi SDK (0.84.2, 2026-08-14) generates its catalog before that date and its `deepseek` provider is static, so the model was absent and `supportsImages` (derived from `model.input`) kept the chat panel from accepting attachments for every DeepSeek model. New `src/pi/providers/deepseek.ts` adds the entry through `registerDeepSeekVisionModel`, cloning the provider's own models and deriving the vision entry from `deepseek-v4-flash`; `prepareModelRuntime` applies it via `syncDeepSeekVisionModel`, and the `runtime.getModel()` gate makes it idempotent and self-retiring. New `src/pi/image-compat-guard.ts` (`createImageCompatGuard`, wired into `_buildResourceLoader`'s factory list) rewrites the `context` event for one request when the active model's `input` lacks `image`, because the SDK's `openai-completions` builder emits history image blocks without checking model capability and DeepSeek answers 400.
- **Wiki:** `models-and-auth.md` — Role documents `syncDeepSeekVisionModel` and a new paragraph covers `src/pi/providers/deepseek.ts` (clone-not-declare, inherited auth, self-retiring gate), Keywords add the shim method and both id/name markers, and See-also gains the clone-never-re-declare pattern, the self-retirement rule, and the `input`-is-the-only-signal pitfall; `session-lifecycle.md` — the factory roster lists the image-compat guard, a new paragraph explains the per-request rewrite and the mixed-line-up failure it prevents, Keywords add `createImageCompatGuard()`, and Namespaces add the new module.
- **Escalations:** none — the approach was approved by the user before implementation and all edits landed in existing articles.

## 2026-08-22 — Salvage a failed background subagent's partial result

- **Code:** A failed foreground child's last assistant text reached the parent because `withSalvagedPartial` in `tool.ts` appended `SubagentRunError.partialResult` to the thrown failure, but that wrapper only covers the synchronous tool call — a background spawn returns as soon as the run is queued, and the real failure arrives later through `onBackgroundSettled`. `_deliverBackgroundSubagentNotification` read only `error.message`, so the parent got the termination reason and none of the child's work. The salvage formatting moved into `describeSubagentFailure` (`src/pi/subagents/runtime.ts`, with `PARTIAL_RESULT_LIMIT`) and both paths now use it; `session.ts` applies it to the notification body and `details.result`.
- **Wiki:** `subagent-manager-and-lifecycle.md` — the budget-spent bullet now names the shared formatter and states that every termination reason carries the salvage, a new paragraph documents the two delivery paths and the unchanged-message contract, Keywords add `SubagentRunError` / `describeSubagentFailure` / `PARTIAL_RESULT_LIMIT` plus the salvage bound marker, the background-notification pattern records the salvaged body and its corrected line anchor, and a new pitfall warns that any future failure-delivery route must run the error through the formatter because `partialResult` is not part of `message`.
- **Escalations:** none

## 2026-08-22 — Reclaim writable-session locks abandoned by dead owners

- **Code:** A crash, a `kill`, or a power loss left `<sessionPath>.pi-code.lock` behind and nothing ever reclaimed it, so the chat became permanently unopenable — `session.ts` and `pi-child-session.ts` only ever called `SessionLockPort.acquire`, and the sole `recoverStale` caller was `JsonStateStore`. Four fixes: the new portable `acquireSessionLock` helper (`src/core/session/session-lock-recovery.ts`) reclaims once when the conflict reports `staleRecoveryAllowed`, and both session paths plus persistent child transcripts now use it; locks record `bootTimeMs` (payload version 2, version 1 still read) so a pre-boot lock outranks a liveness probe that a recycled pid would answer with `'alive'`; `_isStaleRecoveryAllowed` reclaims a dead pid on this host immediately and keeps the five-minute threshold only for unverifiable liveness and unreadable payloads (aged by sidecar mtime, which previously made a torn write permanent); and `describeSessionLockConflict` replaces the bare conflict text with the owner, its liveness, and the sidecar path to remove.
- **Wiki:** `writable-session-lock.md` — Stance gains the abandoned-lock half of the invariant, Role documents the helper, the verdict matrix, boot-instant evidence, mtime fallback, and schema versioning, Keywords add `acquireSessionLock`, `describeSessionLockConflict`, `bootTimeMs`, `ownerBootMismatch`, the new private methods and both call sites, and See-also replaces the "5-minute floor" rule with the evidence-based rules plus pid-reuse and torn-sidecar pitfalls; `_intro.md` reframes recovery as a first-class path and adds a reader task; `platform-ports.md` records the `undefined` owner id and routes callers to the helper; `node-platform-adapters.md` updates the `NodeSessionLock` description, lock version marker, and blind-retry pitfall; `session-lifecycle.md` extends the lock-before-open rule.
- **Escalations:** none — the recovery-policy change was approved by the user before implementation, and all edits landed in existing articles.

## 2026-08-22 — Place background subagent cards by real completion time

- **Code:** Background completion notifications are buffered while the parent streams and flushed at `agent_end`, so a child that settled mid-turn had its card appended after the parent's final report — reading as if the report preceded the children. The buffering cannot be removed (the entry participates in the LLM context and would split an assistant message from its tool results), so the fix is display-side: `_deliverBackgroundSubagentNotification` now records `details.finishedAt`, and the ordering pass was extracted from `main.ts` into `webview/display-order.ts` as `orderDisplayMessages`, which re-inserts notifications by completion time alongside the existing compaction-summary hoist. Notifications without `finishedAt` keep their append position. The card gained a footer naming the completion time.
- **Wiki:** `webview-architecture.md` adds the `display-order.ts` helper to the module list, a **Display order** paragraph describing the single ordering pass, and a pitfall against "fixing" the order by appending earlier; `subagent-manager-and-lifecycle.md` documents the buffer/flush path and why it must stay.
- **Escalations:** none — display-only reordering inside already-documented surfaces.

## 2026-08-22 — Stop stranding subagents on their turn budget

- **Code:** 96% of observed child failures were `max-turns`, every one at `turnCount === maxTurns + 1`, because the `maxTurns` tool parameter carried no description and orchestrators sized it like conversation turns while a turn is one provider round-trip. Five changes: the `subagent` schema and guidelines now state what a turn costs; `resolveTurnBudget` makes a definition's `maxTurns` a floor an invocation cannot lower (new `limit-raised` diagnostic); `buildChildSystemInstructions` tells the child its budget; the manager steers a wind-down one turn before the ceiling and reads `getCompletion()` before honouring an abort, and `tool.ts` appends `SubagentRunError.partialResult` to failures so stranded work is recoverable; and children gained the read-only LSP surface via `registerLspChildTools` plus opt-in `bash` behind `pi-code.subagents.allowChildBash`.
- **Wiki:** `subagent-manager-and-lifecycle.md` documents the two-stage wind-down, the completion-before-abort ordering, and a pitfall recording the failure statistics; `agent-registry-and-resolution.md` splits `resolveTurnBudget` out of `resolveBoundedInteger` and adds the floor rule; `subagent-extensibility.md` records `CHILD_BASH_TOOL`, the three-source child tool assembly, and rules for the shell grant and per-tool opt-in; `lsp-tools.md` documents the child surface, the capture-shim mechanic, the allowlist rule, and the workspace-vs-worktree pitfall.
- **Escalations:** none — all edits landed in existing articles.

## 2026-08-22 — Time context compaction and subagent queue wait

- **Code:** Compaction was reduced only as an `isCompacting` flag, so a full summarization request over the whole context was untimed. `reduceEvent` now stamps `compaction_start` and splits the measured duration two ways, because Pi checks for overflow both after an assistant message (inside the run) and before sending a prompt (outside it): `turnCompactionMs` is inside `turnDurationMs` and is subtracted from `modelWaitMs`, while `pendingCompactionMs` is charged to the next turn for display but deliberately **not** subtracted, since subtracting time that elapsed outside the turn would shrink the residual below what happened. `agent_start` clears the former and preserves the latter. Separately, `syncSubagentRuns` now reads the manager's `queueWaitMs` (falling back to the queued/started pair) into `SubagentStatEntry.queueWaitMs`, which `totalSubagentStats` aggregates for a `Queued before start` row — the metric existed but reached only the launcher.
- **Wiki:** `chat-host-and-service.md` documents compaction timing and the in-turn versus pre-prompt split with a rule against subtracting the latter; `tab-registry-and-runtime.md` records the compaction fields and `queueWaitMs`.
- **Escalations:** none — both figures reuse events and metrics the runtime already produced.

## 2026-08-22 — Split the turn breakdown into four named sections

- **Code:** Child tool time was only visible as one per-run total, so the tools a subagent actually ran were invisible. `TabRuntime` now keeps three per-turn accumulators — `turnToolStats` (own calls), `turnDirectToolStats` (own calls minus the `subagent` wrapper), `turnChildToolStats` (calls inside delegated runs) — and `recordSubagentToolEvent` resolves each child call's display name at tool start. `completeAgentEnd` snapshots `childToolStats` (children only) and `combinedToolStats` (built from the direct and child accumulators via the new `mergeToolStats`), omitting both when no child tool ran; `isDelegationToolName` keeps the wrapper out of the combined view so its seconds are not double-reported. The webview renders four sections in a fixed order — `ONLY ORCHESTRATOR TOOLS TIME`, `ONLY SUBAGENTS TOOLS TIME`, `TOTAL WITH SUBAGENTS TOOLS TIME`, `SUBAGENTS TOTAL TIME AND STATUS` — because the earlier `OWN TOOLS` / `INCL. SUBAGENT TOOLS` pair read as if the first section were already a total. A turn with no delegation still shows one unlabelled breakdown. Two derived rows close the gap between tool time and real elapsed time. `Model await & startup` (`subagentNonToolTime`) explains delegated runs: a child that thinks for eight seconds and runs `ls` for forty milliseconds otherwise reads as having done nothing, inviting the conclusion that actions went unrecorded. `Model await` does the same for the orchestrator, from a new `modelWaitMs` on `TabMessageMeta`. It is **not** the turn duration minus summed tool durations: Pi runs a message's tool calls in parallel by default, so those sums overlap and can exceed real time. `TabRuntime` therefore tracks `turnToolBusyMs` as a union of tool-execution intervals via an in-flight counter (`turnToolInFlight`, `turnToolBusySince`), and `completeAgentEnd` closes any interval abandoned by the SDK at the turn boundary so the residual cannot absorb time a tool was still using.
- **Wiki:** `chat-host-and-service.md` documents the two breakdowns, why the wrapper is excluded, the new shared helpers, and a rule against building the combined view from `turnToolStats`; `tab-registry-and-runtime.md` records the three accumulators, the widened `pendingSubagentTools` value, `combinedToolStats` on `TabMessageMeta`, and the clearing lifecycle.
- **Escalations:** none — an additive section inside already-documented turn accounting.

## 2026-08-21 — Key turn metadata by message identity

- **Code:** `TabRuntime.messageMeta` was keyed by an assistant message's position inside the compact model context, which compaction rewrites. A turn followed by auto-compaction therefore lost its footer duration, tok/s, and tool/subagent breakdown, and a surviving assistant could inherit an unrelated older turn's numbers. Introduced `assistantMetaKey(message)` (the SDK-required `timestamp`), re-keyed the map, replaced the ordinal lookup plus the "align newest assistants from the end" transcript pass in `buildState` with one identity-matched annotation over both projections, and added `recordMessageMeta` with a `MESSAGE_META_HISTORY_LIMIT` ceiling now that the map no longer shrinks with the context.
- **Wiki:** `chat-host-and-service.md` documents identity-keyed projection, `assistantMetaKey`, and a rule against reintroducing ordinal keying or positional alignment; `tab-registry-and-runtime.md` updates the `messageMeta` shape, adds `recordMessageMeta`, and records the identity-key rule with its bound.
- **Escalations:** none — a keying fix inside already-documented turn accounting.

## 2026-08-21 — Restore text in the Todo tool result card

- **Code:** `src/webview/main.ts` declared a two-parameter `el(tag, className?)` while `launcher.ts` and `raw.ts` declare `el(tag, className?, text?)`. `buildTodoToolResultElement` was written against the wider signature, so the task number, label, and blocked-by chips were created empty and the card rendered as bare bullets. Added the `text?` parameter to the `main.ts` and `settings.ts` helpers so all four bundles match, and added `src/test/unit/webview/element-helper.test.ts` as an arity guard — nothing else can catch this, since esbuild does not typecheck the webview and `tsconfig.json` excludes `src/webview/**`.
- **Wiki:** `webview-architecture.md` updates the `el()` signature in Role and Keywords and gains a See-also rule that every per-bundle copy must keep the same arity, with the Todo card as the recorded failure.
- **Escalations:** none — a signature drift fix inside an already-documented helper.

## 2026-08-21 — Transfer delegated-run timing to the parent turn summary

- **Code:** `ChatService` gained `recordSubagentToolEvent` and `syncSubagentRuns`, fed by the existing `onSubagentMutation` / `onSubagentStateChanged` channels in `ChatController`. `TabRuntime` tracks delegated runs in a bounded `subagentStats` map with mutable rows, charges each run to the turn that first observed it via `turnSubagentIds`, and holds in-flight child tool starts in `pendingSubagentTools`. `completeAgentEnd` attaches those rows to the closing assistant message by reference so a background child settling after its turn updates the closed summary; `buildState` copies them into `_subagentStats` for the webview, which renders a separate Subagents section — including failed, cancelled, and still-running delegations.
- **Wiki:** `chat-host-and-service.md` documents the separate delegated-run accounting channel, the new methods and shared types, and the rule against publishing state per child tool event; `tab-registry-and-runtime.md` records the delegated-run fields, `subagentStat`, and the mutable-row and once-per-run charging rules; `subagent-manager-and-lifecycle.md` notes timing as a second consumer of the mutation channel and why delegated time is reported separately from the parent's own `subagent` tool row.
- **Escalations:** none — this extends the existing tool-timing accounting and reuses the established subagent event channels.

## 2026-08-21 — Record completed tool timing

- **Code:** `ChatService` now measures each completed tool call by stable call id, retains a bounded per-tab duration history, snapshots grouped per-tool totals onto the closing assistant message, and projects both per-call and per-turn timing into chat and transcript state for the webview.
- **Wiki:** `chat-host-and-service.md` documents tool timing reduction and projection plus the shared helper types; `tab-registry-and-runtime.md` records the duration maps, message metadata snapshot, bounded-history rule, and reset lifecycle.
- **Escalations:** none — the feature extends existing chat-service and tab-runtime accounting rather than creating a separate subsystem.

## 2026-08-17 — Remove the host cap on subagent turns

- **Code:** `session.ts` no longer passes a `maxTurns` ceiling, so `resolveBoundedInteger` honours `pi-code.subagents.defaultMaxTurns` verbatim instead of silently clamping it to `100`; the setting's `maximum` was dropped from `package.json` and the settings-page number field, and the frontmatter parser accepts any `maxTurns` ≥ 1 (was 1–1000). Agent definitions were left untouched, so a definition's own `maxTurns` still outranks the setting.
- **Wiki:** `agent-registry-and-resolution.md` documents the limit-resolution step, the absent turn ceiling versus the surviving 120-minute timeout ceiling, and that a definition's `maxTurns` outranks the setting; `subagent-manager-and-lifecycle.md` records the no-ceiling default and that one turn is one child assistant step.
- **Escalations:** none — no new article, chapter, or appendix entry was needed.

## 2026-08-12 — Plan Mode waits for plan approval

- **Code:** Rewrote `PLAN_MODE_INSTRUCTIONS` so the agent stops after presenting a plan, states that it is waiting, revises and re-presents when the user objects instead of approving, executes the whole plan once approved, and restarts the cycle on each new user request; dropped the clause that allowed same-turn execution. Tool restriction was explicitly rejected — the active-tool set is still never touched. Launcher tooltips, the `pi-code.planMode.defaultEnabled` description, `README.md`, and `MARKETPLACE.md` no longer promise same-turn execution or read-only tools.
- **Wiki:** `plan-mode-and-todos.md` gains a See-also pitfall recording that approval is guidance rather than a gate, plus the 0.33.0 (`1defd6d`) enforcement post-mortem — marker-driven transitions, the idle reset, and the in-memory saved tool set — as preconditions for any future gate.
- **Escalations:** none — the mechanism (preamble prepended to direct prompts, per-session key) is unchanged, and instruction wording is already a declared non-goal of the chapter.

## 2026-08-10 — Require approval for dependency changes

- **Code:** Added an `AGENTS.md` boundary forbidding dependency graph, lockfile, pin, override, or repair-script changes without explicit approval for a separate dependency change; reverted unapproved `undici`, `hono`, and `ip-address` hardening from the 0.67.9 release candidate while preserving the established `brace-expansion` workaround.
- **Wiki:** `packaging-and-release.md` records the approval boundary and restores the approved brace-only repair facts; its current roughly 90 MB package-size and recursive source-map guidance remain synchronized.
- **Escalations:** none — this tightens the existing release workflow without changing wiki taxonomy.

## 2026-08-07 — Prune VSIX baggage: source maps and bundled-package assets

- **Code:** Replaced the inert `*.map` rule in `.vscodeignore` with `**/*.map` (vsce bare patterns match root-level files only, so 10 050 source maps were shipping) and added narrow per-file globs dropping bundled-package assets (`pi-web-access` demo mp4 + banner + `test/**` + `skills/**`, `pi-mcp-adapter` banner + `cli.js`, `@mixmark-io/domino` test data). Zero functional files touched; `vsce ls` and the boundary script verified.
- **Wiki:** `bundle-targets-and-esbuild.md` and `bundled-pi-packages.md` document the narrow-glob rule and the `**/*.map` vsce quirk.
- **Escalations:** none — extends the two existing packaging articles.

## 2026-08-07 — Hide bundled-package skills the project did not opt into

- **Code:** Added `HIDDEN_BUNDLED_PACKAGE_SKILLS` + `filterBundledPackageSkills` in `bundled-packages.ts`, wired as `DefaultResourceLoader.skillsOverride` in `_buildResourceLoader`; the bundled `pi-web-access` `librarian` skill is no longer surfaced to agents while the package's web tools keep loading.
- **Wiki:** `bundled-pi-packages.md` documents the exclusion mechanism, keywords, and the smoke-test note.
- **Escalations:** none — extends the existing bundled-pi-packages article.

## 2026-08-07 — Prompt echo before first agent response

- **Code:** Deferred the `message_end` name refresh and state publish in `ChatHost.handleEvent` by one microtask so the SDK's synchronous session-branch append lands before the transcript projection is read; the user's own prompt now appears immediately instead of lagging until the first assistant response.
- **Wiki:** `chat-host-and-service.md` documents the deferral and the SDK append-after-emit pitfall in `handleEvent`.
- **Escalations:** none — extends the existing chat-core article.

## 2026-08-05 — Persistent titles and full compacted-chat history

- **Code:** Separated compact model context from a lazily paged full current-branch transcript, preserved scroll position while loading older messages, and persisted automatic chat titles in SDK session metadata with legacy unnamed-session migration.
- **Wiki:** `message-protocol.md` documents transcript payloads and requests; `chat-host-and-service.md` and `chat-command-service.md` cover pagination and correlated results; `session-lifecycle.md` records the dual projections and durable title source; `webview-architecture.md` and `chat-panel-provider.md` describe upwards loading, stable-id reconciliation, and restore semantics.
- **Escalations:** none — the change extends existing protocol, session, chat-core, and webview articles without introducing a separate subsystem article.

## 2026-08-04 — Aggregate foreground-subagent waiting state

- **Code:** Parent chats now summarize pending foreground subagents in one waiting indicator, keep individual child cards visually quiet, and mark shared-workspace child file changes so they remain reviewable without rendering inline chat diffs.
- **Wiki:** `file-change-tracking.md` and its intro document child provenance and review-only presentation; `subagent-manager-and-lifecycle.md` records aggregate waiting behavior; `write-isolation-and-worktree.md` clarifies shared-workspace routing; `message-protocol.md` lists the optional `subagentAgentId` marker.
- **Escalations:** none — the change refines existing chat, mutation-routing, protocol, and file-tracking behavior without adding a new subsystem.

## 2026-08-03 — DeepSeek balance and monetary turn accounting

- **Code:** Added official DeepSeek balance refreshes, key/date-scoped local daily spend accounting, SDK session-cost turn deltas, typed host/webview messages, and chat footer presentation for remaining balance plus turn, session, and daily costs.
- **Wiki:** `message-protocol.md` and `protocol-runtime.md` now list the DeepSeek payloads and runtime schema; `tab-registry-and-runtime.md` and `chat-host-and-service.md` document provider-specific monetary turn metadata; `session-lifecycle.md` records the cumulative session-cost projection; `models-and-auth.md` owns the DeepSeek account store, credential use, and persisted daily ledger.
- **Escalations:** none — the feature extends existing protocol, chat-accounting, session, and auth articles without meeting the new-article threshold.

## 2026-08-02 — Marketplace patch readiness

- **Code:** Refreshed Marketplace and repository product documentation and the Marketplace screenshot for the changes accumulated since Marketplace 0.57.1, expanded manifest discovery metadata, moved CI to Node.js 22.19 with unit-test and tag/version gates, documented the current packaged size and explicit publication boundary, updated vulnerable transitive dependencies, and added a deterministic install/package guard plus SemVer boundary coverage for the Pi SDK's shrinkwrapped vulnerable `brace-expansion` copy.
- **Wiki:** `packaging-and-release.md` now records the roughly 120 MB compressed runtime package, explicit Marketplace publication and verification step, matching-tag rule, private standalone-submodule boundary, and physical runtime-dependency repair gate; its chapter intro no longer describes the retired Electron packager as the active standalone build, and the computed reverse edge in `desktop-host-lifecycle.md` was refreshed. `bundled-pi-packages.md` documents why the local repair is not `pi install` and why audit metadata can outlive the removed nested package, while `bundle-targets-and-esbuild.md` includes runtime verification in the package chain. The Raw Mode article and intro now describe opt-in capture, immediate stop-on-disable, retained recordings, and every supported deletion path accurately.
- **Escalations:** none — these are corrections and extensions to the existing packaging-and-release article, with no taxonomy change.

## 2026-08-01 — Chat rename, subagent defaults, and automatic wiki maintenance

- **Code:** Added typed inline chat renaming in editor panels, raised default child-agent execution limits from 30 turns / 10 minutes to 60 turns / 30 minutes, and aligned the bundled `deepseek-v4-implementer` definition; repository guidance now requires an automatic wiki-impact check and in-place synchronization during every relevant change.
- **Wiki:** `chat-command-service.md` and `message-protocol.md` now document the typed `renameTab` path; `subagent-manager-and-lifecycle.md` records the new execution defaults. The two retired desktop IPC pages now point to the private `standalone/` successor instead of a deleted migration note. Recomputed five stale `Used by` sections from the dependency graph. `wiki-maintain` policy and workflow now make existing-article synchronization a required completion gate rather than an opt-in follow-up.
- **Escalations:** none — these are existing-article fact, link, graph, and maintenance-rule corrections without a taxonomy change.

## 2026-07-23 — Standalone-repo split reflected in TOC framing

- **Code:** Split standalone into a separate private repo <https://github.com/Avhatar/pi-code-standalone> attached as a submodule at `standalone/` (commit `09434c3`); then inlined the fonts/assets into that submodule and dropped the nested `pi-code-standalone-assets` layer (commit `ec5df86`). CRT-shader work (commit `fc8edd1`) lives entirely inside the submodule and does not surface in the extension-runtime wiki.
- **Wiki:** `index.md` — updated the two `Part X — standalone desktop host *(retired)*` framing paragraphs (Reading-order §8 and Part X section header) to describe standalone as a private submodule rather than an in-tree `standalone/desktop-rs-poc/` directory. No Part X article body edits (they remain the intentional Electron historical snapshot). Validators pass with `[E] ERROR: none`; `compute-used-by.py` reported 0 updates (no `Depends on` graph changes).
- **Escalations:** none — Stance-sentence revision per Step 2 rubric row 4. Follow-up: Part X `desktop-*` articles still cite `standalone/desktop/src/...` file paths for the retired Electron implementation — those code links have been broken since the Electron retirement on 2026-07-22 and remain broken by design (historical snapshot). No action planned.

## 2026-07-22 — Parts VI–XI bootstrap authoring + Parts I–V backfill

- **Code:** No code changes — this pass continues wiki bootstrap from where the 2026-07-21 entry stopped.
- **Wiki:** Authored 20 articles + 20 chapter intros across Parts VI–XI (UI surfaces webview, safety and reversibility, message flow discipline, subagents, standalone desktop host, auxiliary systems). Backfilled every "not yet authored" plain-text reference in Parts I–V to now-existing markdown links across 9 files. Ran `compute-used-by.py`; 37 files got 112 computed reverse edges. All 78 wiki files now form a complete graph with forward-only `Depends on` authored + `Used by` computed. Validator passes with `[E] ERROR: none` and no `[I]` info hints. Structural enumeration remains limited to `index.md` (no `AGENTS.md` / SKILL.md changes needed).
- **Escalations:** none — no new articles / chapters / appendix entries beyond what was already reserved in the TOC. Appendix (`appendix-a-seam-types.md`) still uncreated; the current article set has clear enough cross-links that a seam-types cheatsheet is not needed yet. Follow-up considerations for future maintenance passes: (a) expand THIN intros (below 50-line threshold) — non-blocking warnings, ~50 files affected; (b) expand THIN articles (below 80-line threshold) — ~10 affected; (c) revisit `chat-event-policy` and `bundled-pi-packages` articles once new event types / new bundled Pi packages appear, since both have narrow authoritative surface areas.

## 2026-07-21 — Parts I–V bootstrap authoring

- **Code:** No code changes — the wiki `parts/**` tree was empty scaffold; this pass populates it for the first time.
- **Wiki:** Authored 19 articles + 19 chapter intros across Parts I–V (extension host substrate, shared protocol / contracts, portable chat core, platform adapters, Pi SDK integration). Every article follows the `Stance / Role / Keywords / Lifecycle edges / See also` schema; every intro carries a chapter description + article roster + reader task + neighborhood + non-goals. Forward-only `Depends on` edges authored; ran `compute-used-by.py` to populate reverse `Used by` bullets (43 computed edges across 19 files). Parts VI–XI remain empty scaffold — cross-references to them in Parts I–V articles are rendered as unlinked "not yet authored" plain-text mentions until those chapters are written. `[W]` THIN warnings remain on a subset of the shorter intros / articles but are non-blocking; validator passes with `[E] ERROR: none`.
- **Escalations:** none — this is the first authoring pass of an empty wiki, so no rule/pitfall contradictions were encountered. Next scheduled pass: Parts VI–XI (UI surfaces webview, safety and reversibility, message flow discipline, subagents, standalone desktop host, auxiliary systems). Appendix (`appendix-a-seam-types.md`) remains uncreated — no cross-cutting concept has yet spanned 3+ chapters in the authored set.

## 2026-07-21 — RawMode chapter reservation

- **Code:** Added RawMode — per-chat developer view of the full agent-to-model exchange. Portable recorder + ring buffer under `src/core/raw/`, Node JSONL storage adapter under `src/adapters/vscode/raw-storage.ts`, inline Pi extension in `src/pi/raw-recorder-extension.ts` subscribing to every `pi.on(...)` event plus `onPayload`/`onResponse` stream capture, RawPanel + serializer, Settings-panel stats block, and cleanup wired into `deleteHistorySession`.
- **Wiki:** `index.md` — reserved a new chapter line `raw-mode` under Part XI (Auxiliary systems) next to `lsp-tools`, matching the "opt-in developer surface that sits around the main product" framing. No article files created — the wiki is still in bootstrap state (empty `parts/**`); this update only tracks the placement decision so the first article-writing pass has a slot to fill.
- **Escalations:** none — TOC-only edit; the article body itself will be authored when `parts/**` starts being populated. Scope check when that happens: RawMode has 10+ distinct types (`RawRecorder`, `RawEntryBuffer`, `RawStoragePort`, `NodeRawStorage`, `RawRecorderRegistry`, `RawPanel`, `RawPanelSerializer`, `RawEntry`, `RawEntryKind`, `RawStorageStats`, `createRawRecorderExtension`) and a distinct reader-task (debugging what the agent sees), so it clears the ≥7-types-and-distinct-reader-task bar for a standalone article.

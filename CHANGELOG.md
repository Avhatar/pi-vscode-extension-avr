# Changelog

All notable changes to the Pi Code VS Code extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added exclusive writable-session ownership across VS Code and standalone hosts, with typed conflicts and explicit stale-lock recovery safeguards.
- Added a sandboxed Electron desktop shell that composes the shared chat host through validated, correlated IPC with renderer reload recovery.
- Added active project wiki skills `wiki-read` and `wiki-maintain` under `.agents/skills/` alongside a `wiki/` scaffold at repo root, so any agent runtime that discovers `.agents/` skills can orient on and maintain repo documentation without depending on a Claude-specific `.claude/skills/` layout.

### Changed
- Routed chat lifecycle, commands, queue settlement, preferences, and state projection through a shared headless host so VS Code and desktop clients can use the same backend behavior.
- Reused one browser-safe request correlation and event recovery implementation across VS Code and desktop transports.
- Documented the wiki-first repo orientation soft rule in `AGENTS.md` and updated the project skill catalog with the new wiki workflows.

## [0.59.0] - 2026-07-20

### Added
- Added production Node adapters for workspace discovery, filesystem state, session settings, persistent application state, dialogs, and logging as the foundation of the standalone host.
- Added a production Node workspace file-mention index and watcher with the same search, exclusions, and prompt augmentation as the VS Code client.

### Changed
- Continued the shared session-runtime extraction by moving host capabilities behind platform-neutral ports and centralizing Pi session ownership and replacement in a portable runtime.
- Improved chat-tab isolation by moving each tab's transient state, subscriptions, and resource lifecycle into a portable shared runtime.
- Moved chat preference persistence and workspace file mentions behind portable platform ports without changing their existing behavior.
- Moved file-change tracking and checkpoint rollback/redo into the portable shared core while preserving VS Code diff review and undo behavior.
- Moved chat event-derived streaming state and serialized snapshot assembly into a portable shared service without changing tab, queue, or panel behavior.
- Moved queued prompt preparation and FIFO dispatch into the portable chat service while preserving settlement, retry, compaction, and tab-isolation behavior.
- Moved queued-message add, edit, remove, and cancel validation into the portable chat service without changing chat controls.
- Moved direct prompt and compaction lifecycle into the portable chat service while preserving Plan Mode, attachments, and immediate acknowledgement.
- Moved steering, follow-up, and stop dispatch into the portable chat service without changing attachment, acknowledgement, or active-turn behavior.
- Moved chat-tab membership and active-tab selection into a portable registry without changing panel, session-restoration, or close behavior.
- Completed the portable chat-application extraction by moving lifecycle decisions, preferences and tool gates, launcher projection, terminal-event policy, and agent command routing behind shared host-neutral services.
- Authentication links now use a host-neutral external-URL boundary so desktop and VS Code hosts can apply the same URL safety policy.
- Removed VS Code coupling from session auth events, Codex response monitoring, and per-tab completion state so alternative hosts can compose those capabilities.

### Fixed
- Reopening an actively running chat from History now reconstructs in-flight tool cards, including their original start time and arguments, instead of showing only a generic preparing indicator while the tool continues in the background.
- Undo and Redo now restore changes in reopened sessions by aligning checkpoint numbering with persisted user turns; after Undo removes the final active file change, the File Undo View remains visible with Redo available; and both controls are visibly disabled and rejected while an agent is streaming or compacting to prevent active writes from racing restoration.
- Confirmation actions now return through correlated transport responses, so event-gap recovery cannot lose Undo or Redo decisions.
- Queued prompts rejected before starting now retry once without looping, empty queues avoid redundant state refreshes, edited local rename commands stay local, and fractional queue indices are rejected.
- The `/name` command now behaves consistently for direct, queued, steer, and follow-up input, normalizes explicit names, caps them at 60 characters, and rejects attachments before clearing the draft.
- Session replacement and shutdown now serialize activation and cleanup, never report a disposed failed replacement as ready, and finish local teardown even when one disposer fails.
- File rollback and redo no longer risk deleting an existing unreadable file by mistaking a baseline read failure for a missing file, and file tracking normalizes resolved path segments before using them as identities.
- Chat panels now accept restarted host event streams, isolate failing event consumers, and retry transient initial-state handshake failures before leaving models or skills uninitialized.
- Native confirmation dialogs now wait for the user, while session history and workspace searches use a longer bounded request timeout instead of failing after 30 seconds.
- Restored chats no longer show a false interrupted-turn warning after completed error or aborted turns, and live state updates remain valid while streaming or compacting.
- Plan Mode instructions no longer appear in user chat bubbles when a file is attached.
- Queued messages now start after the active agent fully settles instead of being dropped while the SDK still considers the previous run busy.

## [0.58.0] - 2026-07-18

### Added
- Chats can now be renamed without contacting the model by entering `/name <new name>`.
- Added an isolated portable Electron CRT desktop experience spike for testing a future standalone agent interface without shipping its files in the VS Code extension.

### Changed
- The CRT desktop spike now closely matches the original phosphor terminal reference with its bundled display font, curved screen, scanlines, rolling beam, glow, and terminal-style controls.
- Expanded regression coverage for file-change tracking, checkpoint rollback and redo, workspace file mentions, per-tab message queues, and session event rebinding ahead of the shared-backend extraction.
- Began shared-backend extraction by separating portable agent, platform capability, and VS Code-only chat protocol contracts without changing the existing VS Code interface.
- Added runtime validation for chat webview commands and versioned transport-neutral request, response, and event contracts with correlation IDs and per-connection sequencing.
- Editor chat panels now use the versioned connection protocol end to end, with correlated command failures, ordered events, reload rebinding, and automatic state recovery after event gaps.
- Began the platform-neutral session-runtime extraction by removing VS Code-specific event emitters from subagent session notifications.

### Fixed
- Restored chats now clearly mark turns interrupted by **Reload Window** instead of appearing stuck on unfinished thinking or tool output.

## [0.57.3] - 2026-07-17

### Fixed
- Turn completion notifications now appear only after an explicitly submitted parent-agent task settles, not for internal or subagent lifecycle activity.
- Scrolling upward while the agent is working now reliably pauses auto-follow instead of snapping the chat back to the bottom.

## [0.57.2] - 2026-07-17

### Fixed
- Chat now keeps your reading position when a turn finishes instead of jumping to the latest message after you scroll up.
- Expanded chat details, diff previews, queued messages, and sidebar subagent rows now stay open during agent-driven refreshes.

## [0.57.1] - 2026-07-17

### Changed
- Marketplace and repository guides now document subagents, turn notifications, project tool defaults, Claude Code MCP imports, current web tools, all available settings, and the correct source-build requirements.

## [0.57.0] - 2026-07-16

### Added
- Pi Code settings can now opt in to using user-level Claude Code MCP servers without copying their definitions or credentials.

## [0.56.2] - 2026-07-16

### Security
- Disabled direct MCP tools can no longer be invoked through the generic MCP gateway.

## [0.56.1] - 2026-07-16

### Fixed
- Show Popup now uses native Windows notifications outside VS Code instead of editor-local messages.

## [0.56.0] - 2026-07-16

### Added
- Tool selections can now be saved as the project default so every newly created agent starts with the same enabled tools.
- Turn completion can now show an optional popup and play the standard Windows notification sound, controlled from the new Notifications launcher panel.

## [0.55.1] - 2026-07-16

### Changed
- The prompt expansion control now shares the footer row with timestamp and token details instead of taking a separate line.

## [0.55.0] - 2026-07-16

### Added
- Enabled parent agents to autonomously route independent work to matching named agents or temporary ad-hoc roles, including concurrent sibling delegation, transient role names, and explicit parent-model inheritance.

## [0.54.5] - 2026-07-16

### Fixed
- Long current prompts now show an explicit control to expand the full text and collapse it again.

## [0.54.4] - 2026-07-16

### Fixed
- Adapted Claude skills now appear as compact skill invocations instead of exposing their full compatibility instructions as user-authored chat text.

## [0.54.3] - 2026-07-16

### Changed
- MCP calls in chat now use the dedicated MCP icon.
- The extension package no longer includes unused legacy interface icons.

## [0.54.2] - 2026-07-16

### Changed
- Chat now uses the unified `subagents2.png` icon for both delegated tasks and returned subagent results.

## [0.54.1] - 2026-07-16

### Fixed
- Subagents that finish with a usable final response on their last allowed turn no longer lose their completed work to a misleading maximum-turn failure.

## [0.54.0] - 2026-07-16

### Added
- User and project skills in the cross-client `.agents/skills/` locations now appear in Pi Code alongside existing skill sources.

### Changed
- Project and user named-agent discovery now prefers neutral `.agents/agents/` directories while retaining legacy Pi directory fallback.
- Chat delegation cards and launcher subagent statuses now use dedicated monochrome icons for new tasks, completed results, active work, success, and failure.

## [0.53.0] - 2026-07-16

### Changed
- Subagent worktree review, apply, and cleanup are now owned entirely by the parent orchestrator, without asking users to make child lifecycle decisions.
- The launcher now presents expandable delegated tasks and final results with only a Dismiss action, while chat subagent cards show a truncated task/result preview and the full content when expanded.

## [0.52.0] - 2026-07-16

### Added
- Added a project-scoped DeepSeek V4 Pro implementation agent for small, concrete coding tasks, with fresh context, explicit worktree isolation, bounded turns, and handoff guidance for GPT-led architecture and verification.
- Added orchestrator-driven `review`, `apply`, and `cleanup` subagent actions, with mandatory modal confirmation before applying or discarding isolated worktree changes.

### Fixed
- Worktree review and apply now include new files created by isolated subagents, not only modifications to already tracked files.

## [0.51.0] - 2026-07-15

### Added
- Trusted `.claude/agents/**/*.md` files can now contribute named Pi subagents through the Claude resource compatibility boundary, including conservative Claude tool-name mapping and model-alias inheritance.
- Bundled Pi packages can declare native agent files through `pi.agents`, with package provenance, path-boundary validation, deterministic precedence, and collision diagnostics.
- Added explicit host contracts for child-safe extension and MCP tool factories; parent tool registration or MCP discovery alone never grants a capability to child sessions.
- The cumulative **Pi Code: Run Subagent Smoke Test** now covers native, Claude-compatible, package, duplicate, untrusted, unsupported, child-tool factory, and remote-policy fixtures without provider or network requests.

### Changed
- Claude `Agent` and legacy `Task` references now map to the native `subagent` capability only when it is active; child agents still cannot delegate recursively.
- Forked parent context now fails explicitly instead of being silently treated as fresh context.

### Security
- Claude project agents require Workspace Trust, unsupported Claude tools are diagnosed rather than granted, aliases such as `sonnet` inherit the selected Pi model instead of forcing a provider, and exact unavailable models retain no-fallback behavior.
- Remote A2A execution, persistent child memory, fork context, and nested delegation remain disabled behind explicit policy decisions until their trust and isolation contracts are implemented.

## [0.50.0] - 2026-07-15

### Added
- Write-capable child agents can now use `edit` and `write` with a workspace-wide writer lease for foreground shared-workspace runs or extension-owned Git worktrees for isolated and background runs.
- Shared child edits now feed the parent File Undo View and checkpoint pipeline with namespaced tool-call IDs, while worktree rows provide explicit Review, Apply, and Clean controls.
- The cumulative **Pi Code: Run Subagent Smoke Test** now includes a confirmed temporary-Git scenario covering writer-lease rejection, mutation routing, worktree isolation, review, explicit staged apply, non-Git rejection, and cleanup.

### Security
- Background write agents are rejected unless worktree isolation is selected, worktree patches are never applied automatically, and both Apply and destructive cleanup require explicit modal confirmation.

## [0.49.0] - 2026-07-15

### Added
- Subagents can now run in the background, returning a persistent `agentId` immediately while live status remains visible and a bounded completion or failure notification is added to the parent context.
- Added configurable global and per-chat child concurrency limits, FIFO queueing, queue-wait metrics, permission-wait status, and deterministic cross-tab fairness.
- The cumulative **Pi Code: Run Subagent Smoke Test** now covers background IDs, global and per-chat limits, queue order, parent notifications, permission waits, stop, parent close, extension shutdown, and orphan detection.

### Changed
- Background notifications that settle while the parent is streaming are deferred until the parent turn ends, avoiding concurrent parent-session writes.

## [0.48.0] - 2026-07-15

### Added
- Subagent transcripts and definition snapshots now persist in extension-owned storage and are restored with their parent chat without appearing in ordinary History.
- Recent child rows now provide Inspect, Send, Stop, Resume, and Dismiss controls, and the parent `subagent` tool supports the corresponding persistent-ID lifecycle actions.
- The cumulative **Pi Code: Run Subagent Smoke Test** now covers persist, reload, transcript inspection, parent-compaction isolation, steering, stop, resume, stale IDs, dismissal, and retention cleanup through temporary storage.

### Changed
- Deleting a parent chat now removes its child metadata and transcripts, while startup retention cleanup removes child records older than 30 days.
- Active child runs interrupted by an extension restart are restored as explicit failures instead of remaining in a misleading running state.

## [0.47.0] - 2026-07-15

### Added
- Added a per-chat **Subagents** launcher panel showing active and retained child runs with their actual model, lifecycle status, current tool, activity, turns, elapsed time, errors, and a Stop action for live runs.
- The cumulative **Pi Code: Run Subagent Smoke Test** now injects inspectable queued, starting, running, retrying, completed, failed, and cancelled rows into the real launcher state path until Reset is clicked.

### Changed
- Completed, failed, and cancelled subagent rows are now retained for ten minutes with a 20-row cap so recent outcomes remain visible without unbounded session memory growth.

## [0.46.0] - 2026-07-15

### Added
- Chats can now opt in to a single `subagent` delegation tool for named or ad-hoc read-only child agents, including exact cross-provider model selection, per-call limits, progress updates, and bounded foreground results.
- Added Subagent settings for new-chat enablement, default and allowed child models, per-call model overrides, maximum turns, and foreground timeouts.
- The cumulative **Pi Code: Run Subagent Smoke Test** now includes deterministic parent-tool registration, prompt-surface gating, busy-state protection, Tools-panel synchronization, and session-reload checks.

### Security
- Subagent capability is off by default per chat; while disabled, its schema, named-agent catalog, and prompt guidelines are removed from the model context, and generic Tools-panel operations cannot bypass the dedicated gate.

## [0.45.0] - 2026-07-15

### Added
- Added the isolated foreground subagent runtime with separate in-memory child sessions, exact cross-provider model selection, structured completion, lifecycle snapshots, bounded concurrency, cancellation, timeouts, turn limits, and result-size limits.
- The cumulative **Pi Code: Run Subagent Smoke Test** now includes a deterministic foreground runtime scenario plus an optional confirmed live cross-provider check using the active chat's configured models.

### Security
- Foreground child sessions are restricted to read-only tools, use isolated resource and settings runtimes, and never silently replace an unavailable or unauthenticated explicitly selected model.

## [0.44.1] - 2026-07-15

### Added
- Subagent diagnostics now use stable run-state and structured activity-event contracts, preparing smoke logs and later launcher status updates to share the same data model.

## [0.44.0] - 2026-07-15

### Added
- Native subagent definitions can now be discovered from user and trusted-project agent directories with strict validation, deterministic precedence, provider-independent model selection, and policy-bounded tool resolution.
- Added **Pi Code: Run Subagent Smoke Test** with a deterministic registry-and-resolution scenario and inspectable Output Channel logs for validating the first subagent implementation phase.

### Security
- Project subagent definitions are ignored in untrusted workspaces, and explicit unavailable or disallowed child models fail instead of silently falling back.

## [0.43.9] - 2026-07-15

### Fixed
- Subscription sign-in now supports browser callbacks, login-method selection, device codes, provider prompts, empty optional answers, and reliable cancellation across ChatGPT, Claude, and GitHub Copilot.

### Removed
- Removed the internal LSP smoke-test command from the Command Palette.

## [0.43.8] - 2026-07-15

### Added
- Workspaces with detected Claude infrastructure now receive provider-independent compatibility for root, ancestor, local, imported, and directory-scoped `CLAUDE.md` instructions without affecting ordinary projects.
- Claude projects can use `.claude/rules/**/*.md`, including project-wide guidance and path-scoped rules that are applied before matching file operations.
- Project and activated user Claude skills and legacy commands are available as native slash commands, while nested skills activate only inside their directory scope under qualified names such as `/apps/web:deploy`.
- Active Claude projects expose `/claude-compat` for inspecting loaded instructions, rules, resources, exclusions, and tool-reference mappings.

### Changed
- Claude-authored resources are interpreted through a compatibility boundary that preserves the selected Pi agent, model, permissions, runtime, and active tool set.
- Claude tool references, including Claude-style MCP names, resolve only to capabilities already available through Pi; compatibility never grants tools or introduces a second MCP configuration.
- Explicit `@file` instruction imports are contained to the workspace, deduplicated, cycle-safe, and limited to four recursive hops.

### Fixed
- Generated, dependency, and build directories no longer activate compatibility through cached Claude instructions or skills.
- Hidden compatibility instructions no longer appear as visible chat messages.
- Collapsed ToDo, History, and Tools sections now align consistently with Plan Mode in the launcher sidebar.

### Security
- Removed local paths and editor metadata from marketplace images, and excluded common secret and machine-specific configuration files from the repository.

## [0.33.4] - 2026-07-14

### Fixed
- Codex context limits now follow the authenticated model catalog for the current ChatGPT account instead of pinning GPT-5.6 to 272k, so account rollouts between 272k and 372k are reflected when chats open or credentials change.

## [0.33.3] - 2026-07-14

### Fixed
- GPT-5.6 context usage now uses the correct provider-specific maximum: 272k tokens for Codex subscriptions and 1.05M tokens for the direct OpenAI API; approximate usage is now clearly marked until an authoritative provider snapshot is available.

## [0.33.2] - 2026-07-14

### Fixed
- Codex subscription usage now loads from the authenticated ChatGPT usage endpoint instead of a Cloudflare-blocked API path, and failed requests show an actionable unavailable state instead of spinning indefinitely.

## [0.33.1] - 2026-07-14

### Changed
- Codex subscription usage now refreshes only when a Codex chat opens and after each completed turn; concurrent refresh triggers share one request and no periodic polling is used.

### Fixed
- Codex usage now remains current with the default WebSocket transport and supports model-specific limit buckets, optional window metadata, current plan types, credits, workspace spend controls, and banked resets from the account usage API.
- Stale or reset-crossing account snapshots are no longer shown as zero usage or incorrectly attributed to a single assistant turn, and cached usage is cleared when the Codex account changes.

## [0.33.0] - 2026-07-14

### Added
- New `xhigh` and `max` thinking levels are now available in the Settings page's Default Thinking Level dropdown and in the in-chat thinking picker. `xhigh` extends `high` with deeper reasoning; `max` is the deepest tier and is natively supported only by GPT-5.6 and adaptive Claude models — on other models the SDK falls back to the closest supported level.
- GPT-5.6 support out of the box: the OpenAI model catalog now includes `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` (verified for `openai-codex` as well). They appear in the model picker once an OpenAI or Codex key is configured.

### Changed
- Bumped bundled Pi SDK from `0.80.3` to `0.80.6`. Notable behavioural improvements inherited from upstream: input-based pricing tiers for long-context GPT-5.4/5.5/5.6 accounting, `agent_settled` extension hook, `showCacheMissNotices` transcript notices, and more robust retry classification (Cloudflare 524, Copilot device-code polling, Codex WebSocket 60-minute rotation).
- Plan Mode now works as pure prompt injection. When the toggle is on, every user prompt is prefixed with a fixed `<plan-mode-instructions>` block asking the agent to plan first for change-heavy or multi-step tasks and to re-read files before editing. The agent decides per-prompt whether the task actually needs a plan — simple questions and lookups get answered directly. No tool restrictions, no phase state machine, no manual "go" hand-off, no `<plan-ready/>` / `<plan-complete/>` markers. The Plan Mode toggle keeps its per-chat persistence and greyed-out-while-streaming behaviour; everything else about it is gone.

### Fixed
- Newer Claude models no longer intermittently error out on thinking-block conversion. The Pi SDK now preserves thinking blocks with empty text but a valid signature instead of dropping them, which used to trigger provider-side thinking-block validation failures on the latest Claude releases.

### Removed
- Plan Mode's `plan` / `exec` / `idle` phase machine, the read-only tool restriction (`PLAN_MODE_READONLY_TOOLS`, `setPlanModeActive`, saved-tool-set restoration), the `<plan-ready/>` and `<plan-complete/>` markers, the auto-continue-into-exec flow, the `EXEC_IDLE_RESET_MS` idle safety net, and the phase-restart on session load / new session / abort. Everything the toggle now does is a single string prepended to the outgoing prompt.

## [0.32.1] - 2026-07-12

### Fixed
- Plan Mode auto-continue no longer fails with "Agent is already processing". The `<plan-ready/>` handler now dispatches via `session.followUp()` instead of `session.prompt()` — the SDK keeps `isStreaming = true` throughout the `agent_end` listener chain and only clears it in `finishRun()` after all listeners return, so a synchronous `prompt()` from inside the handler always raced with the reset. `followUp()` queues the message and the agent loop starts a fresh run on its own, which is exactly the pattern the SDK expects for `agent_end`-queued work.
- Streamed assistant answer no longer flickers/disappears mid-turn. The streamed text now lives in a persistent "answer draft" widget pinned to the bottom of the current turn, so mid-turn stateSyncs (fired on `message_end` / `turn_end`) no longer wipe it. The controller also resets the streaming buffers on `message_end`, so deltas from the next assistant message start from a clean slate instead of appending to the previous message's text and producing duplicated content when the widget repopulates.

## [0.32.0] - 2026-07-10

### Added
- Plan Mode now supports agent-driven exit from the plan phase. The agent is instructed to end its final plan-phase response with a `<plan-ready/>` marker when the plan is finalised; on detection the extension auto-transitions into the execution phase and dispatches a synthetic "proceed" prompt in the same conversation, so the user no longer has to type "go" manually. The plan itself stays visible in the chat.

### Changed
- Edit-tool preflight now dumps the raw and final argument shapes to the "Pi Code" output channel on every call (long strings are truncated to `<string len=N>…`), making it possible to diagnose why a specific model's Edit calls are being rewritten and which fields, if any, are being silently stripped.

### Fixed
- Plan Mode execution-phase instructions now tell the agent that `oldText` must match the file byte-for-byte and that files read only during the plan phase must be re-read before editing. Previously the exec-phase prompt only explained the `<plan-complete/>` marker, so agents (notably DeepSeek) reconstructed `oldText` from the plan they had drafted in prose and Edit failed to match — the same edit that succeeded outside Plan Mode.

## [0.31.0] - 2026-07-10

### Added
- Running tool cards now show elapsed time (e.g. `running 12s`) that ticks every second while a tool is executing, so it's obvious whether a call is progressing or hung. After 60s the chip switches to a pulsing red "stuck" style with a tooltip pointing at Esc / Abort.
- If a tool call never reports completion before the turn ends, a warning banner now names the orphaned tools ("N tool calls did not report completion this turn"). Details are also written to the "Pi Code" output channel with per-call elapsed time.

## [0.30.4] - 2026-07-09

### Changed
- Tools panel demotes single-member categories into **Other** instead of showing them as their own top-level sections. Previously a category with just one tool (e.g. **ToDo** or **MCP**, when they're the only member registered) got its own heading + collapse chevron + Enable/Disable buttons — overkill for a single checkbox. Now the same "≥2 members required" rule that already applied to prefix groups applies to named categories too, so tiny sections consolidate into the shared Other bucket at the bottom.

## [0.30.3] - 2026-07-09

### Changed
- Tools panel now categorizes previously-ungrouped tools into named sections instead of a flat list: **Pi built-ins** (`read`, `bash`, `edit`, `write`), **Web** (`web_search`, `fetch_content`, `get_search_content`), **ToDo** (`todo`), **MCP** (`mcp`), **Language Server** (`find_references`, `document_symbols`, `goto_definition`, `hover`, `find_implementations`, `type_definition`, `workspace_symbols`, `call_hierarchy_incoming`, `call_hierarchy_outgoing`). Each category is collapsible with per-category Enable / Disable buttons, mirroring the prefix-based groups (`github_*`, `database_*`, …). Anything not matching a category and not sharing a prefix with another tool lands in a new **Other** section at the bottom.
- Named categories carry a subtle blue left-accent stripe so the curated set reads distinctly from the auto-derived prefix groups. Category labels are rendered as human text (sentence case) while prefix groups keep their monospaced identifier styling (e.g. `unity`).

## [0.30.2] - 2026-07-09

### Fixed
- Tools panel no longer scrolls back to the top after every checkbox click. The launcher re-render (triggered by the host state push after a toggle) now preserves the tools body's scroll position and, if the filter box was focused, restores focus + cursor selection.

### Changed
- Tools panel now uses the same framed-box treatment as ToDo, Plan Mode, and History (border + rounded corners + subtle section-header background) so all four side-by-side sections read as siblings.

## [0.30.1] - 2026-07-09

### Added
- Hover tooltips in the Tools panel — each row's title carries the tool's `name`, source label (`builtin` / `sdk` / package name like `pi-web-access`), a `§` marker + explanation when the tool ships `promptGuidelines` (extra tokens per turn), the full description string the LLM sees in its system prompt (up to 600 chars), and a one-line hint about what checking / unchecking the row will do. Group headings show a sample of up to three descriptions from the group so you can see at a glance whether the whole prefix is worth keeping active.
- Filter box in the Tools panel now matches against tool descriptions in addition to names — typing "prefab" finds every Unity tool whose description mentions prefabs even when the name doesn't contain the word.

## [0.30.0] - 2026-07-09

### Added
- **Tools panel** in the launcher sidebar under History. Lists every tool registered for the active chat with a checkbox per tool; unchecking hides the tool from the model on the next turn. Tools sharing a prefix (`github_*`, `database_*`, `browser_*`, …) are grouped into collapsible sections with per-group "Enable" / "Disable" buttons — one click removes a large tool group from the prompt when it is not needed. Also has a filter box and top-level "Enable all" / "Disable all". Selection is per-chat, persisted, and survives ReloadWindow. When the active chat is streaming, the panel is greyed out (matches the ToDo / Plan Mode toggles).
- **Copy / Paste tool selection** buttons in the Tools panel heading — Copy writes the current chat's tool selection to the system clipboard as versioned JSON, Paste applies a previously copied selection to the active chat. Works between chats and between VS Code windows.
- Diagnostic log lines in the "Pi Code" output channel: `[tool apply]` on every persisted-state application (subscribe / newSession / loadSession / restore), `[tool selection]` on every effective `setActiveToolsByName` call, and `[prompt|steer|followUp|queued]` before every model turn with a warning if the UI toggle disagrees with the actual active-tools set. Makes tool-visibility mismatches (e.g. "ToDo toggle shows ON but the model isn't calling it") visible without a debugger.

### Changed
- Per-chat ToDo toggle is now folded into the same denylist storage as the Tools panel — toggling ToDo OFF via its dedicated switch is equivalent to unchecking `todo` in the Tools panel, and vice versa. Existing per-chat ToDo state is preserved (the ToDo toggle still uses its historical storage key for the `todo` entry).

## [0.29.2] - 2026-07-09

### Added
- Small colored language chip on shell/bash tool cards when the command is really a scripting-language one-liner (`python -c`, `python3 file.py`, `node -e`, `node file.js`, `deno eval`, `perl -pi`, `ruby -e`, `php -r`, `sed -i`, `awk -i inplace`, `powershell -c`). Makes it obvious at a glance that the tool call is running code against your files rather than a plain shell pipeline — useful when the model does an inline `python -c "…file.write(…)…"` and the fact that it's a script (not a `ls` / `cd` / `grep`) would otherwise be buried inside the truncated command preview.
- Python tool icon on shell/bash tool cards when the command runs a Python script — the default terminal glyph is swapped for a dedicated Python icon so the row is scannable at a distance.

## [0.29.1] - 2026-07-09

### Added
- Preflight normalizer for the `edit` tool that catches the most common malformed argument shapes before the Pi SDK's schema validator sees them. Rescues Anthropic-style `file_path` (renames to `path`), per-edit `path`/`file_path` fields (hoists to top level when consistent across all edits), and edit item variants that use `old_string`/`new_string` / `old`/`new` / `oldStr`/`newStr` (rewrites to `oldText`/`newText` and strips extras). Cuts the "Validation failed for tool edit" retry loop that DeepSeek and similar models were falling into. If a shape cannot be confidently rescued, args pass through unchanged and the original SDK validation error is still reported. Every rewrite is logged to the "Pi Code" output channel.

## [0.29.0] - 2026-07-09

### Added
- Every agent turn now leaves a one-line summary in the "Pi Code" output channel (`[turn end] provider=… model=… stopReason=… in=… out=… cacheR=… cacheW=…`), so how a turn ended is never hidden — even a clean `stop` leaves a trail you can inspect later.
- Chat now shows a yellow warning banner when a turn ends with `stopReason === 'length'` — the model was cut off by its per-turn output token cap. Previously such truncated responses stopped mid-sentence with no indication anything was wrong.
- Chat now shows a blue info banner when a turn ends with a stop reason we do not explicitly recognise (anything other than `stop`, `length`, `error`, `aborted`), so unmapped provider states surface instead of disappearing silently.

## [0.28.0] - 2026-07-09

### Changed
- Failed tool calls with schema validation errors ("Validation failed for tool ...") now render as a structured, auto-expanded error card: a plain-English explanation that the SDK rejected the call before it ran, a bulleted list of schema errors, and the received arguments pretty-printed. Previously the raw error dump was hidden behind a single collapsed pre-block.
- When the model retries a failed `edit`/`write` call with corrected arguments, the earlier validation-error card gets a clickable "retried below ↓" chip in its header that scrolls to the successful diff card. Applies both during streaming and after chat reload, so it is obvious a file was actually edited even when the first attempt is on screen.

## [0.27.1] - 2026-07-08

### Fixed
- Chat no longer forces you back to the bottom while the agent is streaming if you scrolled up with the keyboard, scrollbar drag, or wheel-down — any input method now pins your position until you scroll back near the bottom yourself.

## [0.27.0] - 2026-07-08

### Added
- Copy-to-clipboard button next to the ToDo heading in the launcher sidebar. Copies the current task list as a Markdown checklist (`- [ ]` pending, `- [~]` in-progress, `- [x]` completed) in creation order. Semi-transparent by default, brightens on hover.

## [0.26.0] - 2026-07-05

### Changed
- Pi SDK bumped from 0.74.2 to 0.80.3 (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`) — six minor releases including richer `agent_end` events, new project-trust and session-info-changed extension events, and `excludeTools` denylist support. New Claude / Gemini / GPT model IDs and provider registrations are picked up automatically via `ModelRegistry`.
- `pi-web-access` bumped from 0.10.7 to 0.13.0 — adds Tavily / Parallel / Brave / OpenAI web-search providers, an auto-summary workflow for `web_search`, and SSRF `allowRanges` controls.
- `pi-mcp-adapter` bumped from 2.6.1 to 2.11.0 — default-on output guarding, MCP elicitation, `structuredContent` rendering, and stdio-server cwd defaults that resolve against the Pi session directory.
- Bundled `@earendil-works/pi-tui` and refreshed `typebox` — new pi-web-access peer dependencies that must ship inside the VSIX.
- Minimum required VS Code raised from 1.100 to 1.110 (March 2026). Older VS Code releases still bundle Node 20, but Pi SDK 0.75.0+ requires Node.js ≥ 22.19.0 and 1.110 is the first release with Node 22.22.

### Fixed
- `pi-code.allowedTools` now actually restricts the agent's toolset. It was a silent no-op in 0.24.x–0.25.x because the SDK option had been renamed from `allowedToolNames` to `tools` and the extension still passed the old key.

### Removed
- `code_search` tool — removed upstream from `pi-web-access` 0.12+. It is no longer surfaced in the timeline rail or reserved as a Plan-Mode read-only tool.

## [0.25.3] - 2026-05-31

### Fixed
- Chat input footer's progressive hiding (cache → tokens → thinking → attach → send → model) now actually fires when the panel is resized: the resize observer is re-attached on every chat-tab switch (it was getting stuck on the previous tab's destroyed container), and a window-resize listener was added as a backup trigger.

## [0.25.2] - 2026-05-31

### Changed
- In editor-tab chat panels, the input box now keeps a stable preferred width (up to 720px) instead of always being 50% of the panel. On wide panels it stops growing past 720px (so the side gaps grow with the panel); on narrow panels it shrinks just enough to always leave a 5% gap on each side.
- When the chat input footer is too narrow to fit everything on one line, items are now hidden one at a time by priority (cache chip → context-usage chip → thinking chip → attach button → send button → model name) instead of wrapping onto a second row.

## [0.25.1] - 2026-05-31

### Fixed
- Chat input footer (model name, cache / thinking chips, context usage, send button) now wraps onto multiple lines when the chat panel is narrow, instead of overflowing past the input box.

## [0.25.0] - 2026-05-31

### Added
- **File Undo View** toggle in the launcher sidebar (under Plan Mode). The bar listing files the agent changed (with Undo / Redo / Review) above the chat input is now opt-in per chat — off by default. Flip the toggle to show or hide it without affecting file edits or per-message diffs. The default for new chats can be set via `pi-code.fileUndoView.defaultEnabled`.

## [0.24.1] - 2026-05-23

### Changed
- Excluded the `docs/` folder from the VSIX — development notes that aren't needed at runtime. VSIX is ~250 KB smaller.

## [0.24.0] - 2026-05-22

### Added
- Thinking-level chip in the chat footer next to the cache chip. Click to pick `off` / `minimal` / `low` / `medium` / `high` — same setting that previously lived only inside the model picker, now visible at all times and one click away.
- Model picker rows now show the technical model ID next to the friendly name (e.g. `Free Models Router` · `openrouter/free`), and the search box matches both — so searching for `openrouter/free` finds "Free Models Router" instead of returning empty.

### Changed
- Pi SDK bumped from 0.74.0 to 0.74.2 (still pinned to `^0.74.x` — 0.75.x is intentionally avoided because it raises the minimum Node.js to 22.19.0, which not all supported VS Code versions ship with). The 0.74.2 catalogue adds `deepseek/deepseek-v4-flash:free` (via OpenRouter) and a direct `deepseek-v4-flash-free` provider model, plus image-generation support and the Together AI provider from 0.74.1.
- Thinking-level chips are removed from the model picker now that the footer chip is the canonical place to change it.

## [0.23.0] - 2026-05-21

### Added
- `/new` slash command in the chat input. Starts a fresh chat in a new editor tab — same action as the `+` button in the chat toolbar and **New chat** in the launcher sidebar, just surfaced through `/` for keyboard-driven discovery.
- `/model` slash command. Opens the inline model picker (same one as clicking the model name in the chat footer) without having to leave the keyboard.
- `/hotkeys` slash command. Opens VS Code's Keyboard Shortcuts editor pre-filtered to Pi Code commands (`@ext:Avhatar.pi-code`), so the full list of bindings — including ones you've remapped — is one keystroke away.
- `/changelog` slash command. Opens the bundled `CHANGELOG.md` in a rendered Markdown preview so you can scan release notes without leaving the editor.

### Changed
- Settings button in the launcher sidebar now uses the `settings.png` cog icon instead of the unicode `⚙` glyph. The PNG renders more visibly, matches the rest of the icon set, and inverts on hover like the other toolbar icons.

## [0.22.0] - 2026-05-21

### Added
- `/settings` slash command in the chat input. Opens the Pi Code settings page directly from the slash menu — useful when the gear icon in the launcher sidebar isn't obvious. Works both ways: pick it from the `/` menu (opens immediately) or type `/settings` and press Enter.

### Changed
- Pi SDK dependencies migrated from the deprecated `@mariozechner/*` npm scope to its successor `@earendil-works/*` (pi-coding-agent, pi-agent-core, pi-ai). Mario marked the `@mariozechner` packages as deprecated at 0.73.1 and continues development under `@earendil-works`; we are now on 0.74.x. `pi-mcp-adapter` bumped to `^2.6.1` so its transitive `@mariozechner/pi-ai` is also dropped. No user-visible API or behaviour change — esbuild externals and ~25 import paths are updated in lockstep.
- CLAUDE.md injector rewritten to match the upstream reference implementation. It now also detects a root-level `CLAUDE.md` (not just `.claude/CLAUDE.md`), respects the compaction boundary when deciding which instruction files are still unread, tracks reads through dedicated session entries (so subsequent reads via `tool_batch` are recognised), and only nudges the agent to read the files it hasn't already pulled in via `read`/`tool_batch` or that Pi pre-loaded via `contextFiles`. A new `/claude-md-injector` slash command prints a status report: applicable `CLAUDE.md` files, their `@`-imports, which are read vs unread, and an optional path-scoped breakdown (`/claude-md-injector src/foo`).
- CLAUDE.md injector optimisations: both hooks now bail out immediately when neither `CLAUDE.md` nor `.claude/CLAUDE.md` exists in the workspace (single existence check per chat, no text scanning or path walking for projects that don't follow Claude conventions); `@`-import expansion is cached by file mtime so bootstrap files aren't re-parsed on every event; and files whose content is purely `@`-imports plus whitespace ("pure alias" stubs, e.g. a `CLAUDE.md` that just contains `@AGENTS.md`) are skipped in the nudge — the agent is told to read the targets directly instead of a useless redirector file. The `/claude-md-injector` status output marks pure-alias files with `(alias)` for visibility.

### Fixed
- Qwen/DashScope models now show the cache selector as fixed to short retention with an explanatory tooltip instead of implying that long cache duration can be selected.
- DeepSeek models now show the cache selector as provider-managed and no longer imply that Pi Code can choose a short or long cache duration.

### Removed
- Stale "Icons by Royyan Wijaya on Flaticon" attribution. The current icon set is no longer derived from those Flaticon authors, so the credit line is dropped from `MARKETPLACE.md`, `README.md`, and the Settings page (the now-empty Credits section is removed from Settings too).

## [0.21.0] - 2026-05-13

### Added
- Hover-tooltips on every icon next to the chat timeline rail. Each tool icon now explains what the tool does (Bash, Read, Edit, Grep, the LSP family, Todo, web tools, …), the thinking indicator describes itself, and the busy placeholder distinguishes "preparing next move" from "compacting". Useful while you're still learning what each icon means; uses native `title` so it follows the OS tooltip style and stays out of the way once you know them.

### Changed
- Marketplace README (`MARKETPLACE.md`) refreshed: dropped the tool-approval feature description, added Plan Mode, Language Server tools, per-turn timing, and timeline-rail tooltips, and refreshed the Settings table with `pi-code.planMode.defaultEnabled` and `pi-code.lsp.enabled`. The GitHub `README.md` got the same updates plus an updated architecture diagram and project-structure listing.

### Removed
- Removed the tool-approval feature: the `pi-code.autoApproveTools` setting, the "Auto-approve tool calls" toggle in Settings, and the inline approval cards in chat. The agent now runs each tool without prompting, matching the upstream Pi behaviour.

### Fixed
- `CHANGELOG.md` is now shipped inside the VSIX so the **Changelog** tab on the Marketplace listing is populated.

## [0.20.1] - 2026-05-13

### Changed
- Settings page: clarified the **Provider** dropdown description. It only selects which provider's API key the form below edits — the runtime provider is decided by the selected model. Previous wording ("Preferred AI provider … Leave empty for automatic detection") suggested the dropdown constrained model selection, which it never did. Renamed the section from "API Connection" to "API Keys" to match what it actually does.

### Removed
- Removed four settings that did nothing: `pi-code.apiBaseUrl`, `pi-code.autoSaveSessions`, `pi-code.sessionStoragePath`, `pi-code.contextUsageWarningThreshold`. They were rendered in the Settings UI and read back from `settings.json`, but no other code path consumed them — Pi SDK handles session persistence on its own and the context-usage warning threshold was never checked anywhere. The "Session Behavior" section is gone with them.

## [0.20.0] - 2026-05-13

### Added
- New `find_references` tool: the agent can now ask the active language extension (C#, rust-analyzer, Pylance, TypeScript, etc.) for all references to a symbol — addressed either by file/line/column or by symbol name. Results include matches in external dependency sources (cargo registry, NuGet, node_modules) annotated as `external`. Toggle with the new `pi-code.lsp.enabled` setting (default **off**, opt-in); when off, the tool is not registered and adds nothing to the system prompt.
- New `document_symbols` tool: lists every declaration in a file (classes, methods, fields, properties, etc.) with authoritative LSP positions, parent container, and kind. Use it before `find_references` to avoid hand-counting columns from a `read` output — particularly important on declarations like `public Player Player;` where the type and the field share a name. Supports an optional `nameContains` substring filter for large files.
- `find_references` now accepts `includeAccessKind: true` to tag each reference as `read`/`write`/`text`/`unknown` using the language server's document-highlight provider (Roslyn, rust-analyzer, tsserver, …). Header line surfaces a breakdown (e.g. `72 reference sites — read: 65, write: 5`). Off by default — classification costs one extra LSP call per file containing references.
- New `goto_definition` tool: jumps to the definition site(s) of a symbol via the active language server. Returns each location with a snippet showing the signature plus surrounding context (default 4 lines), and handles legitimate multi-result cases like partial classes and overloaded methods. External dependency definitions (cargo registry, NuGet, node_modules) are surfaced and annotated `[external]`. Address via (file, line, column) or symbol name. Gated by the same `pi-code.lsp.enabled` toggle as the other LSP tools.
- New `hover` tool: returns the language server's full hover payload (signature, inferred type, xml-doc / rustdoc / jsdoc) at a given position. The most info-dense LSP tool — one ~10 ms call often answers "what is X?" without any follow-up `read`. Same `(file, line, column)` or `symbol`-name addressing as the other LSP tools.
- New `find_implementations` tool: returns every concrete implementation or override of the symbol at a given position via the active language server. Use for "who implements IFoo", "all overrides of method X", "every class deriving from abstract Y". Complements `goto_definition`: on an interface method, `goto_definition` lands on the interface declaration, while `find_implementations` returns each implementing class's method. Default `contextLines: 3`, `maxResults: 100`. Same gating and addressing as the other LSP tools.
- New `type_definition` tool: jumps to the declaration of a variable / property / parameter's TYPE — not the variable itself. For `var x = GetThing()`, `goto_definition` on `x` lands on that line, while `type_definition` lands on `class Thing { ... }`. Collapses the common "hover the variable → look up the type by name" workflow into one call. External types annotated `[external]`. Same gating and addressing as the other LSP tools.
- New `workspace_symbols` tool: cross-file symbol discovery via the active language server. Search the whole workspace for symbols matching a free-form query and get back name, kind, container, and an authoritative `(file, line, column)` for each match — ready to feed into `find_references`, `goto_definition`, `hover`, etc. Optional `kindFilter` (e.g. `["class", "interface"]`) narrows short queries. Documented caveat: Roslyn's workspace search occasionally drops valid matches for some queries — fall back to grep on empty results.
- New `call_hierarchy_incoming` and `call_hierarchy_outgoing` tools: cleaner alternative to `find_references` when the question is specifically "who CALLS X" or "what does X CALL". Each entry is a caller / callee (not a use site), with the callable's own declaration position ready for follow-up tools, plus the call site line(s) inside the body where the invocation appears. Useful for walking the call graph one step at a time. Server support: rust-analyzer, tsserver, Pylance, C# Dev Kit (`ms-dotnettools.csdevkit`), gopls, clangd. The OmniSharp-only `ms-dotnettools.csharp` extension does NOT implement call hierarchy — install C# Dev Kit for C# projects if results are unexpectedly empty.

### Changed
- Chat: tool, diff and thinking rows now sit on a vertical timeline rail — action icons line up in a column on the left, a faint connecting line runs through them top-to-bottom, and labels and bodies are shifted right of the icon column for clearer separation. User prompt bubbles are unchanged.
- Chat: replaced the rotating blue "Preparing next moves..." spinner with a filled dot that pulses between the icon color and the blue accent. The dot is sized to match other tool-row icons and aligns with the timeline rail, so the "agent busy, no tool yet" state no longer clashes with the surrounding tool style.
- Prompt input: `@` file-mention chips now render with a subtle tinted background instead of bold text. Bold made the mention glyphs wider than what the textarea above measured, so the caret drifted right of the typed character on every subsequent column.

### Fixed
- Prompt input: caret and typed characters no longer drift apart after an `@` file mention in a narrow / non-maximized window. The textarea now uses the same `overflow-wrap: anywhere` rule as the highlight layer beneath it, so a long mention wraps at the same column in both layers and the caret stays under the next typed glyph.
- Sidebar launcher: aligned the Plan Mode heading with the ToDo and History rows so the title and toggle line up uniformly.

## [0.19.2] - 2026-05-11

### Added
- `find` tool now uses the magnifying-glass icon, matching `glob` and `grep`.

### Changed
- Plan Mode: replaced the hardcoded English/Russian follow-up keyword heuristic with an agent-driven completion signal. After executing a plan the agent now emits the marker `<plan-complete/>` when (and only when) the planned work is fully done. The next user prompt then restarts the planning cycle, while follow-up prompts (no marker) stay in execution. Works in any language. A 10-minute idle reset is kept as a safety net in case the agent forgets to emit the marker.

### Fixed
- Plan Mode: the planning-phase instructions injected into the agent prompt are now wrapped in a marker block and stripped from the chat bubble, so the user's message displays exactly what they typed instead of the internal scaffolding text.
- Plan Mode: the agent's `<plan-complete/>` control marker is stripped from the assistant message bubble (both streaming and final) so it is not shown to the user.

## [0.19.1] - 2026-05-11

### Changed
- ToDo section tooltip now explicitly mentions that the task list survives `/compact`.

## [0.19.0] - 2026-05-11

### Added
- Explanatory tooltips on the Plan Mode, ToDo, and History section headings in the sidebar launcher.

## [0.18.2] - 2026-05-11

### Fixed
- Plan Mode: the agent now receives a clear planning-phase instruction when entering PLAN mode, so it knows it is in read-only planning mode (not broken) and presents a plan waiting for user confirmation instead of complaining about missing write tools.

## [0.18.1] - 2026-05-11

### Fixed
- Plan Mode: fixed tool restriction so all read-only tools (`read`, `grep`, `find`, `ls`, `web_search`, `code_search`, `fetch_content`, `get_search_content`) are now activated from the full registry instead of only from currently-active tools, preventing missing-tool errors.

## [0.18.0] - 2026-05-10

### Added
- **Plan Mode**: A per-chat toggle in the sidebar that makes the agent study the task and propose a plan with read-only tools before making any changes. When enabled, the first message in a new task is sent with only diagnostic/read tools — the model analyses, asks clarifying questions, and suggests an approach. The user's response then unlocks the full tool set for execution. After execution, the next prompt restarts the cycle. Minor follow-ups (short messages, confirmations) keep execution tools so the flow stays natural. Disabled by default for new chats; toggle it on via the Plan Mode switch above ToDo in the sidebar.
- Assistant message footers now show each turn's elapsed time and the cumulative active turn time for the chat alongside token usage, excluding idle gaps between turns.

### Changed
- ToDo items in the left sidebar now show incomplete tasks as dots and completed tasks as checkmarks.
- Running action icons in chat now pulse while their tool call is still active, matching the thinking indicator.

## [0.17.6] - 2026-05-10

### Removed
- Trimmed development-only planning documents and a stray build artifact from the VSIX. No runtime impact.

## [0.17.5] - 2026-05-10

### Changed
- License badge in both READMEs is now green (was yellow) for visual consistency with success/permissive-license conventions.
- Marketplace README now uses an absolute GitHub raw URL for the in-action screenshot. The VS Code Marketplace page and the extension details view inside VS Code render the README without resolving extension-relative paths, so the previous `media/screenshots/screenshot1.png` link rendered as a broken image; the absolute URL fixes that.

## [0.17.4] - 2026-05-10

### Changed
- README updated with missing features (Per-Chat ToDo, User Message Glow), complete settings table, expanded provider list, and corrected architecture diagram and project structure.
- README polished for VS Code Marketplace publication: added MIT and VS Code badges, a one-line tagline describing Pi Code as a visual wrapper around the Pi coding agent for non-engineers and Claude Code converts, and an in-action screenshot at the top of the page.
- Split documentation into two READMEs. `README.md` stays as the GitHub-facing source-of-truth (fork rationale, architecture diagram, project structure, development setup, full prerequisites). A new `MARKETPLACE.md` is the product-focused page used on the VS Code Marketplace — features, getting started, supported providers, keyboard shortcuts, commands, settings, privacy. The `package` npm script now passes `--readme-path ./MARKETPLACE.md` to `vsce` so the marketplace listing and VSIX both pick up the trimmed product README instead of the GitHub one.

## [0.17.3] - 2026-05-10

### Fixed
- Qwen requests no longer fail with `400 'developer' is not one of ['system','assistant','user','tool','function']`. The Pi SDK's OpenAI-compatible adapter switches the system prompt to `role: 'developer'` for any reasoning-enabled model unless the model explicitly opts out, but DashScope's OpenAI-compatible endpoint only accepts the standard chat-completions roles. All bundled Qwen models now declare `supportsDeveloperRole: false` (along with `supportsStore` and `supportsLongCacheRetention` opt-outs for the same reason: those parameters are OpenAI-specific and confuse DashScope), so the system prompt is sent as `role: 'system'` instead.

## [0.17.2] - 2026-05-10

### Fixed
- Provider error banners now actually stay visible. Previously every error pushed to the chat was wiped one frame later by the `agent_end` state sync (which replaces the message list with the SDK's transcript, and the SDK does not store `role:'error'` entries), so silent Qwen/DashScope failures stayed silent even after the 0.17.1 detection fix. The webview now preserves locally-pushed error banners across state syncs and clears them on the next `agent_start`.

## [0.17.1] - 2026-05-10

### Fixed
- Empty or unreported provider responses are no longer swallowed silently. When a turn ends with an `error` stop reason but no error message attached (some providers omit it), the chat now still surfaces a banner. When a turn ends with HTTP success but no streamed content at all (e.g. DashScope/Qwen returning 200 with no choices on quota or region/auth issues), the chat now shows an actionable banner explaining the most likely causes (invalid key, exhausted quota, region/endpoint mismatch). Provider errors are also written to the "Pi Code" output channel with the provider, model, and stop reason for diagnostics.

## [0.17.0] - 2026-05-10

### Added
- Qwen model picker now includes the Qwen3.6 and Qwen3.5 flagship lineup: `qwen3.6-max-preview`, `qwen3.6-max` (latest alias), `qwen3.6-plus`, `qwen3.5-plus`. The Qwen3.6 series is vision-language so it accepts images, and reasoning is enabled with the DashScope `enable_thinking` format. Existing aliases (`qwen3-max`, `qwen-plus`, `qwen-turbo`, `qwen3-coder-plus`/`-flash`, `qwq-plus`, `qwen-vl-max`, `qwen3-vl-plus`) are kept and now have a "(latest)" suffix in their display name to make it explicit they track DashScope's current snapshot.

## [0.16.3] - 2026-05-10

### Fixed
- Qwen models now actually appear in the chat model picker after entering a DashScope API key. Previously the Qwen provider registration was silently rejected by the Pi SDK validator (which requires an `apiKey` field at registration time), so Qwen models were never added to the registry. The provider is now registered dynamically once a key is saved and unregistered when the key is removed.

## [0.16.2] - 2026-05-10

### Fixed
- Models list in the chat now refreshes immediately after saving a new API key in Settings. Previously the new provider's models (e.g. Qwen) only became selectable after a window reload, because the auth-changed signal that triggers the model rebroadcast was wired only to OAuth login/logout, not to manual API-key saves.

## [0.16.1] - 2026-05-10

### Added
- Settings page now shows which providers already have a saved API key: configured providers are listed as clickable chips under the dropdown ("Saved API keys"), and the dropdown itself prefixes those entries with a ✓ check mark. Click a chip to switch the active provider to it.

## [0.16.0] - 2026-05-10

### Added
- Provider dropdown in Settings now exposes the full set of providers supported by the Pi SDK (OpenRouter, Groq, Cerebras, xAI, Mistral, Fireworks, Hugging Face, Kimi, MiniMax, Z.ai, Vercel AI Gateway, Google Vertex AI, Azure OpenAI, Amazon Bedrock) so their API keys can be entered directly from the UI.
- Built-in Qwen (Alibaba DashScope) provider for both regions: choose "Qwen (Alibaba DashScope International)" (`dashscope-intl.aliyuncs.com`) or "Qwen (Alibaba DashScope China)" (`dashscope.aliyuncs.com`) in Settings and paste your DashScope API key to use Qwen3 Max, Qwen3 Coder Plus/Flash, Qwen Plus, Qwen Turbo, QwQ Plus, Qwen VL Max, and Qwen3 VL Plus.
- Auth-method detection in Settings now recognises the standard environment variables for every newly exposed provider (e.g. `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DASHSCOPE_API_KEY`).

## [0.15.6] - 2026-05-10

### Added
- New "ToDo" section in the Settings page with a multi-line editor for the prompt guidelines that describe the ToDo tool to the agent. A "Reset" button restores the built-in default. Changes apply to new chat sessions — open a new chat or reload the window for them to take effect.

### Changed
- The default ToDo prompt guidelines now require the agent to create a `todo` entry for every actionable user request, including single-step and trivial tasks. Previously the guideline told the agent to skip ToDo for "single trivial tasks", which could leave plans unrecorded for short requests. Conversational replies that produce no code, files, or commands remain the only exception.
- Tightened the default ToDo guidelines from 7 to 5 lines (~50% fewer tokens) by dropping points already documented in the tool's JSON schema (state-machine enumeration, `activeForm` being present-continuous, additive-merge semantics of `addBlockedBy`/`removeBlockedBy`, `list` filter behaviour). The five remaining lines carry the only signals the schema can't supply: when to use the tool, the lifecycle pattern, the no-premature-complete rule, the cycle-rejection fact, and the subject/description/activeForm style hint.
- User message glow is now visible and configurable: the color and opacity of the glow outline around user messages can be set via the Settings page (Chat Appearance section).

## [0.15.5] - 2026-05-10

### Changed
- User messages in chat now have a subtle white halo glow to improve visual distinction from assistant responses.

### Fixed
- ToDo toggle state now applies in both directions on every session entry. Previously a chat where the user had explicitly turned ToDo OFF could silently come back ON after `Reload Window`, switching sessions ("Load Session"), or starting a new session inside a tab — the agent would still see the `todo` tool even though the sidebar toggle showed OFF. The persisted per-chat preference is now re-applied on subscribe, on `loadSession`, and on `newSession`.

## [0.15.4] - 2026-05-10

### Changed
- History section in the launcher sidebar now has the same framed visual style (border, rounded corners) as the ToDo section.

## [0.15.3] - 2026-05-10

### Changed
- History panel in sidebar now has the same framed visual style (border, rounded corners) as the ToDo panel.

## [0.15.2] - 2026-05-10

### Added
- Favourite models: star icon next to each model in the model picker. Click to pin a model to the top "Favorites" section; click again to unpin. Favorites persist across VS Code restarts and are sorted alphabetically. The "Recent" section now shows only the last-used model and never duplicates a favorite.

## [0.15.1] - 2026-05-09

### Added
- Web tools (`web_search`, `fetch_content`, `get_search_content`, `code_search`) now display the `web.png` icon and descriptive labels in chat.

### Changed
- ToDo entries in the sidebar and ToDo tool cards in chat now use the dedicated `todo.png` icon.

## [0.15.0] - 2026-05-09

### Added
- Per-chat ToDo is now ON by default for new chats. A new `pi-code.todo.defaultEnabled` setting controls this default; existing chats keep whatever toggle state you set.
- The ToDo section in the sidebar is now collapsible (click the heading to fold it), mirroring how History works.

### Changed
- ToDo list now sorts newest-first — the most recently created task is at the top. The visible area caps at 10 rows; the rest of the list scrolls.

## [0.14.0] - 2026-05-09

### Added
- The context usage chip now opens a small menu with a Compact action, so you can compact the chat without typing `/compact`.

### Fixed
- Diff placeholder hatching now stays visually aligned across consecutive empty rows.

## [0.13.1] - 2026-05-09

### Fixed
- Sidebar's "active tab" tracking now updates when you switch focus between already-open chat panels. Previously the sidebar (including the per-tab ToDo toggle) only refreshed when a panel was first created, so toggling ToDo ON in one chat made the same toggle appear ON in every other chat until the panel was reopened.

## [0.13.0] - 2026-05-09

### Added
- Per-chat persistent ToDo: a per-tab toggle in the sidebar (above History) opts the chat into a task list the agent can keep across `/compact` and across VS Code restarts. State lives in the conversation branch — no external storage. When the toggle is OFF the agent has zero knowledge of the feature; flipping ON instantly exposes the tool plus its task list. The toggle greys out while the agent is streaming or compacting. Adopted prompt guidelines and persistence approach from [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) (MIT). See `PERSISTENT_TODO.md` for design details.

## [0.12.1] - 2026-05-09

### Fixed
- Binary file entries in chat messages now display correctly with the `filebinary.png` icon instead of showing raw `[File: …] (binary file) [/File]` markup.

## [0.12.0] - 2026-05-09

### Changed
- Attachment icons now use `media/` resources: `file.png` for text files, `filebinary.png` for binary files, `picture.png` for images. Binary files (PDF, ZIP, executables, etc.) are detected by extension and shown with a distinct icon.
- Images in chat messages are no longer shown inline by default. Each image is now a clickable chip with `picture.png` and the filename; click to expand/collapse the inline preview.

## [0.11.1] - 2026-05-09

### Fixed
- Attached text files no longer leak their raw content into the user message bubble. File blocks (`[File: name] … [/File]`) are now stripped from the displayed message and replaced with a compact file-name chip (📄 icon). The LLM still receives the full file content in context.

## [0.11.0] - 2026-05-09

### Added
- The attach button now supports arbitrary text files in addition to images. You can attach source code, config files, logs, CSVs, and other text-based files (up to 512 KB each, max 5 files per message) via the same button or by drag-and-drop / paste. File contents are automatically included in the prompt as fenced code blocks.

## [0.10.1] - 2026-05-09

### Fixed
- Error messages no longer get stuck and slide under new messages; they now stay in place as part of the conversation flow.
- Diff blocks no longer overflow horizontally off-screen; lines now wrap correctly within the available width.

## [0.10.0] - 2026-05-09

### Added
- Prompt cache retention can now be controlled per chat from the input footer. A new `cache: …` chip next to the model picker switches between `short`, `long`, and `auto`. In `auto` the chip shows which retention is currently active; the heuristic is provider-aware — backends with free cache writes (OpenAI, DeepSeek, Z.AI, Cerebras, OpenAI-codex, …) always use `long`, while Anthropic / Bedrock-Claude / Kimi-coding pick `long` only after a noticeable idle gap or large cached prefix. The chip is shown faded for providers where Pi cannot act on the setting (Mistral, Google/Gemini, Groq, non-Claude Bedrock).

### Changed
- Build/deploy instructions now support a `-` test-build shortcut that packages and installs the current version without changelog or version-bump steps.
- The README now reflects the current launcher, OAuth login, message queueing, and cache-retention behavior.
- Thinking indicators in chat now use the bundled thinking icon instead of a blinking dot.
- The chat input now uses a single action button that switches between Send and Stop, with queued prompts available only from the keyboard while a response is streaming.

### Fixed
- Thinking indicators now match the size of other command and action icons in chat.

## [0.9.4] - 2026-05-09

### Fixed
- Slash command menu keyboard navigation now keeps the selected skill visible while moving through long lists.

## [0.9.3] - 2026-05-08

### Changed
- Compaction summary cards now stay collapsed by default so users can expand details only when needed.

## [0.9.2] - 2026-05-08

### Fixed
- Manual compaction now shows a live `Compacting...` status and keeps the context footer updated with an approximate post-compaction size.

## [0.9.1] - 2026-05-08

### Fixed
- Manual compaction now shows an expanded summary card at the point where compaction happened, including before/after context token counts.

## [0.9.0] - 2026-05-08

### Added
- Chat slash commands now include `/compact`, allowing users to manually summarize older conversation context from the command menu.

## [0.8.13] - 2026-05-08

### Changed
- "Preparing next moves..." placeholder now shows a spinning ring next to the label so it's obvious the agent is still thinking.
- The sidebar now focuses on chat history only: open chats are no longer duplicated there, and history starts collapsed while remembering its expanded state.

### Fixed
- Command output cards no longer briefly flash as full raw output before settling into the compact IN/OUT preview layout.

## [0.8.12] - 2026-05-08

### Changed
- New marketplace icon featuring the pi symbol in curly braces.
- Activity Bar icon redrawn to match the new pi-in-braces motif and resized to fill the slot.
- Empty-state welcome icon now uses the same pi-in-braces glyph as the rest of the UI.
- Editor tab icon for chat panels now uses the new pi-in-braces artwork.

## [0.8.11] - 2026-05-08

### Changed
- Inline file change previews now match command output spacing and use clearer Write/Edit headers.

## [0.8.10] - 2026-05-08

### Fixed
- Edit results now consistently render as compact side-by-side diff previews instead of plain tool output cards.

## [0.8.9] - 2026-05-08

### Changed
- User prompt cards in chat now have a small inset instead of touching the view edges.
- Inline file change previews now show side-by-side before and after panes for easier review.

## [0.8.8] - 2026-05-08

### Fixed
- Only the latest user prompt now sticks to the top of the chat, and the sticky prompt is capped to three lines so skill runs and long prompts no longer overlap or cover the conversation.

## [0.8.7] - 2026-05-08

### Changed
- Build/deploy instructions now clarify that rebuild and install requests should always run, reusing the current version when there are no new changes.
- Command-like tool cards now show compact IN/OUT previews with full output available on expand.

## [0.8.6] - 2026-05-08

### Fixed
- Unit tests now adapt to the available model registry instead of failing when a local Ollama test model is not installed.
- The full test suite now builds its integration-test runner before launching VS Code integration tests.
- Packaged extensions no longer include generated integration-test artifacts after local test runs.

## [0.8.5] - 2026-05-08

### Added
- The agent now auto-loads `.claude/CLAUDE.md` (and any files it `@`-imports) at the start of each turn, and surfaces per-folder `CLAUDE.md` files whenever it touches paths in that subtree, so per-directory rules are honored without manual reads.

### Fixed
- MCP servers configured in `.mcp.json` / `.pi/mcp.json` are now picked up correctly; bundled Pi extensions (including the MCP adapter) register their tools at session start instead of staying invisible.

## [0.8.4] - 2026-05-08

### Fixed
- Provider error banner now sits at the end of the message flow next to the last reply, instead of floating in the middle of the screen below the trailing spacer.

## [0.8.3] - 2026-05-08

### Fixed
- Provider errors (Gemini quota / 429, expired keys, network failures) are now shown as a red banner in the chat instead of failing silently. JSON-shaped error envelopes are unwrapped so the message is human-readable.
- When the SDK auto-retries after a rate limit, a transient status-bar message reports the attempt and remaining delay so the chat no longer looks frozen.

## [0.8.2] - 2026-05-08

### Changed
- File mentions in the chat input are now highlighted in blue so referenced files stand out before sending.

## [0.8.1] - 2026-05-08

### Fixed
- File mention suggestions now stay focused and scroll correctly when navigating long result lists with the keyboard.

## [0.8.0] - 2026-05-08

### Added
- Chat input now supports `@` workspace file mentions with cached suggestions, configurable excludes, and minimal prompt references so the agent knows which files may be useful to inspect.

## [0.7.0] - 2026-05-08

### Added
- MCP adapter support is now bundled and loaded automatically, enabling MCP tools without a separate `pi install` step.

## [0.6.2] - 2026-05-07

### Changed
- The image attachment button now uses the folder icon for a cleaner toolbar appearance.

## [0.6.1] - 2026-05-07

### Added
- Image attachments can now be selected with a paperclip button next to the model picker.

### Changed
- Large image attachments are now resized automatically instead of being rejected by file size.

## [0.6.0] - 2026-05-07

### Added
- Images can now be pasted or dropped into the chat input and sent to image-capable models as attachments, with previews shown before sending and in chat history.

## [0.5.2] - 2026-05-07

### Fixed
- Thinking output now stays collapsed to a single-line preview by default and only expands when opened manually.

## [0.5.1] - 2026-05-07

### Changed
- The prompt input in chat editor windows is now half-width and centered, leaving free space on both sides.

## [0.5.0] - 2026-05-07

### Changed
- Rebranded the extension as Pi Code, including the package identity, publisher, command IDs, settings namespace, and visible UI labels.

## [0.4.1] - 2026-05-07

### Added
- Per-turn Codex usage delta is now appended to each assistant message footer (e.g. `5h +1.2% · week +0.3%`), so you can see how much of the 5-hour and weekly subscription windows the turn consumed. Hidden for non-Codex models.

### Changed
- Both the global Codex usage indicator and the per-turn delta now show one decimal place (e.g. `1.2%` instead of `1%`) so small turns don't round to zero.

## [0.4.0] - 2026-05-07

### Added
- Web access for the Pi coding agent: `web_search`, `code_search`, `fetch_content`, and `get_search_content` tools (powered by the bundled `pi-web-access` package), plus its accompanying skill. Works out of the box via Exa MCP without any API keys; optionally read `~/.pi/web-search.json` for Exa, Perplexity, or Gemini keys. Fetching GitHub repos, YouTube videos, PDFs, and local video files is supported.

### Changed
- Pi extensions (npm packages tagged `pi-package`) now ship inside the VSIX and are loaded automatically at session start — no `pi install` step required.

## [0.3.9] - 2026-05-07

### Added
- ChatGPT subscription usage indicator in the chat footer when using a Codex (GPT-5.x) model. Shows the percent used in the 5-hour and weekly windows, with colour cues at 50% and 90%, and a tooltip detailing the plan, exact reset times, and credit balance. Hidden for non-Codex models and when the account is on a token-billed API key.

### Changed
- The temporary `PI_CODEX_PROXY_URL` discovery hook (added in 0.3.8) was removed; subscription data is now read directly from the Codex response headers.

## [0.3.8] - 2026-05-07

### Added
- Codex provider response headers are now logged to the Pi Code output channel, and the provider's base URL can be temporarily redirected to a local capture proxy by setting the `PI_CODEX_PROXY_URL` environment variable. Diagnostic plumbing for upcoming subscription-usage indicator work.

### Fixed
- The welcome screen no longer shows a "No models available yet" warning before the saved/current model has finished loading.

## [0.3.7] - 2026-05-07

### Changed
- Token usage shown after assistant turns now includes total, output, input, cache write, and cache read counts.

## [0.3.6] - 2026-05-07

### Added
- History entries in the sidebar can now be deleted one at a time.

### Fixed
- Open chats in the sidebar now keeps showing the current chat panel instead of becoming empty.

## [0.3.5] - 2026-05-07

### Removed
- Duplicate New Chat and Settings buttons from the sidebar title bar.

## [0.3.4] - 2026-05-07

### Changed
- Chat editor tabs now keep longer titles, and chat panel toolbar actions are icon-only.

## [0.3.3] - 2026-05-07

### Changed
- Chat tabs are narrower and chat panel toolbar buttons now use matching Pi icons.

## [0.3.2] - 2026-05-07

### Changed
- Chat session editor tabs now use the full Pi icon.

## [0.3.1] - 2026-05-07

### Fixed
- "Open chats" section in the launcher no longer lists ghost entries that aren't actually open in any editor tab. The list now reflects only chats with a visible panel; everything else lives under "History". Stale tab data persisted by pre-0.3.0 versions is cleared automatically on first launch.

## [0.3.0] - 2026-05-07

### Changed
- The sidebar is now a **launcher**: it lists open chats and a history of previous sessions, and gives one-click buttons to start a new chat or open settings. The chat itself lives in editor-area panels — not in the sidebar — so it can be split, dragged into another editor group, or moved into a separate window, just like Claude Code.
- Starting a new chat (sidebar `+`, palette command, or `Ctrl+Shift+N`) now opens an editor panel directly. Clicking a previous session in the launcher reopens it as a panel.

### Added
- Toolbar at the top of every chat panel with **New chat** and **History** buttons, so you don't need to switch back to the launcher to spawn a sibling chat or jump to an older session.
- Launcher shows live indicators per chat (streaming spinner, unread dot) and lets you remove a chat from the list (the underlying session is preserved on disk and remains available under "History").

## [0.2.2] - 2026-05-07

### Added
- New "Open Chat in Editor" button (link-external icon) in the sidebar title bar. Opens the current chat as a stand-alone editor tab that can be split, dragged into another editor group, or moved into a separate window — same UX as Claude Code's chat panels.
- Chat editor panels are persisted across `Reload Window`: their position, splits, and bound session are restored automatically.

### Changed
- The sidebar still works as before; opening a chat in the editor is opt-in via the new title-bar button. (A future release will make editor panels the default and turn the sidebar into a launcher.)

## [0.2.1] - 2026-05-07

### Changed
- Internal: extracted chat tab logic from `SidebarProvider` into a new `ChatController`. The sidebar view becomes a thin wrapper that forwards messages between the webview and the controller. No user-visible behaviour change — preparation step for the upcoming editor-tab panels migration.

## [0.2.0] - 2026-05-07

### Added
- Sign-in via OAuth in the settings panel: ChatGPT (Plus/Pro/Codex), Anthropic Claude, GitHub Copilot, Google Gemini CLI, Antigravity. Unlocks subscription-only models (e.g. GPT-5.1 Codex) without leaving VS Code.
- Manual authorization-code paste field shown alongside the browser flow as a fallback when the local OAuth callback can't be reached.
- Welcome screen banner with a direct "Open Settings" button when no models are available yet.

### Changed
- Auth-related errors in the chat now include an "Open Settings" shortcut.
- Model list refreshes automatically after a successful OAuth login or logout — no window reload required.

## [0.1.6] - 2026-05-07

### Fixed
- Skill text no longer floods the chat window. Skill blocks are stripped from user messages and replaced with a compact `/skill:name` badge; only the user's own text is shown.

## [0.1.5] - 2026-05-07

### Fixed
- Long user messages (e.g. skill text) filling the entire chat window and blocking agent responses. User messages now collapse at 150px with a "Show more" / "Show less" toggle.

## [0.1.4] - 2026-05-07

### Fixed
- Agent appearing stuck after completing a request (spinning indicator wouldn't stop until switching tabs). The SDK's `isStreaming` flag lags behind the `agent_end` event; now tracked locally.

## [0.1.3] - 2026-05-07

### Added
- Versioning pipeline with `deploy:patch/minor/major` npm scripts
- `CHANGELOG.md` with Keep a Changelog format
- `scripts/bump-version.js` — auto-bump with changelog validation
- Build-deploy skill for the agent (`.pi/skills/build-deploy/`)

## [0.1.2] - 2026-05-07

### Added
- Preserve draft text in input field across tab switches
- `npm run deploy` one-command build pipeline
- Build-deploy skill for the agent (`.pi/skills/build-deploy/`)

### Fixed
- Draft input text lost when switching between agent tabs

## [0.1.1] - 2025-05-07

### Added
- Persist tabs across window reloads
- Move header action buttons to VS Code view title bar

### Fixed
- Auto-scroll when user scrolls up during streaming
- Name sessions from first user message
- Forward SecretStorage API keys into Pi AuthStorage
- VSIX packaging: include hoisted deps and webview styles
- CI: prune devDeps before vsce package

## [0.1.0] - 2025-05-06

### Added
- Initial release
- Sidebar chat UI with multi-tab sessions
- Inline diffs and file change tracking
- Tool approval with allow/deny round-trip
- Checkpoints and rollback per turn
- Settings page with API key management via SecretStorage
- Message queuing during streaming
- Mid-stream steering (Ctrl+Enter)
- Slash-command skills
- Context usage display in footer

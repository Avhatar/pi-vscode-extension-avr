<!--
  MAINTAINERS / AGENTS: this is the user-facing history. The newest entry is an
  accumulator named after the newest build, not proof that users received it.
  release-state.json is the only record of the last version handed to users.

  Which build reaches users is the maintainer's call and cannot be inferred
  from this repo — most versions never leave the machine. Each bump rolls the
  accumulator forward; add that build's user-visible changes as they happen.
  When the maintainer names a handout, record it with mark-released, make sure
  the entry tells the whole story since the previous handout, and rebuild so
  those notes are inside the VSIX. Full rules: AGENTS.md § Two changelogs, and
  .agents/skills/build-deploy/SKILL.md.
-->

# Pi Code — Release Notes

Each entry covers everything that arrived since the version directly below it.
Upgrading from that version means reading one entry; if you skipped several
releases, read the intervening entries too.
The newest entry follows the latest build and accumulates changes until that
build is handed to users; intermediate development builds are not kept as
separate entries. Contributors can find the full per-build history in
[CHANGELOG.md](https://github.com/Avhatar/pi-vscode-extension-avr/blob/main/CHANGELOG.md).

---

## 0.72.1 — 2026-09-12

*Everything new since 0.72.0.*

### Added

- **GPT-6 Astra** is available in the model picker with either an OpenAI API key or a ChatGPT subscription through Codex. The direct API reports its full 1,050,000-token context window; Codex uses the allowance returned by your own account.
- **DeepSeek V4.1 Flash** is available with image input and tools, even though the bundled catalog predates it. The older V4 Flash and V4 Flash Vision Exp names that now route to it also accept screenshots and use the corrected prices.
- **A warning before long context costs more.** The context chip turns yellow above the selected model's higher-price threshold. Its tooltip names that threshold and suggests compacting the conversation to reduce context. It follows the model's price table rather than a fixed token count.

### Changed

- **Faster startup without a blank launcher.** Full prewarm now runs in the background instead of holding extension activation open, so the launcher, commands, and restored panels register without waiting for the session. Stored API keys are read concurrently to shorten session startup. A chat opened before warm-up finishes can still need a wait.
- **Claude-compatible projects no longer get stuck reviewing resources.** After three consecutive interruptions to load scoped skills or rules, the bridge stops blocking tools for the rest of the session while still adding resources to context. The chat explains when this happens, with details in the Pi Code output channel.

### Fixed

- **Messages sent during compaction are no longer lost.** They queue until the session is free, including during the short wrap-up after a response ends. The input explains when the agent is compacting; `Ctrl+Enter` queues then instead of trying to steer a response that is not running.
- **Codex uses the context your account actually grants.** Astra and other large-context models now use the account catalog's maximum allowance instead of staying at a conservative default. GPT-5.4 and GPT-5.5 on the direct OpenAI API also report their full 1,050,000-token windows instead of 272,000.
- **Astra on Codex no longer shows an inapplicable long-context surcharge.** Its cost table and context warning respect the Codex exemption above 272,000 tokens; the direct OpenAI API still uses its long-context tier.
- **DeepSeek spend estimates account for peak hours and current V4 Pro prices.** Last-turn and daily figures include double rates at 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. The rate is chosen at turn start, so turns spanning a pricing boundary can differ from the provider's per-request bill. The cumulative session figure remains the SDK's base-rate total.
- **One failing provider no longer prevents the others from being configured.** A stored API key that cannot be applied, or a provider that times out during configuration, is reported and skipped rather than stalling startup or aborting the remaining providers. It is retried on the next credential synchronization.
- Skills grouped into subdirectories under `.agents/skills/` are discovered correctly, and an ordinary `README.md` in a skill folder is no longer reported as a broken skill.
- Context and settings files saved with a UTF-8 byte-order mark load correctly instead of being silently skipped.
- Reopening a conversation from history no longer corrupts the next message written to it.
- Long conversations compact more reliably: oversized tool results are handled before the next model request, and missing streamed token-usage data no longer causes compaction to be skipped.
- Stopping a response on Windows no longer crashes the agent when `taskkill.exe` is missing from `PATH`.
- Provider connections are more reliable: Codex handles final stream events correctly, Anthropic recovers from signed-thinking mismatches, Mistral keeps fragmented tool calls together, and GitHub Copilot sign-in handles model-policy rate limits more reliably.
- Long-cache requests for GPT-5.6 and newer Responses models use the supported 30-minute cache option. Proxy fixes cover Google Vertex, `NO_PROXY` domain matching, and plain-HTTP requests that could hang after a tool call.
- Built-in file and shell tools respect their execution context's working directory, and extension messages no longer break the order of tool calls and results in conversation history.

---

## 0.72.0 — 2026-08-24

*Everything new since 0.67.9.*

### Added

- **DeepSeek can now see images.** DeepSeek's vision model is offered in the model picker, so screenshots and images can be sent to DeepSeek at last. It costs and holds exactly what DeepSeek V4 Flash does and still calls tools, so it works as a normal agent model.
- **Every turn tells you where its time went.** Completed tool calls show their wall-clock duration, and each finished turn expands into a per-tool breakdown with call counts and totals. When a turn delegated work, the breakdown splits into four named sections — what your agent ran itself, what its children ran, the combined total, and each delegated run with its outcome — plus rows for model wait, child startup, context compaction, and time children spent queued waiting for a slot. Context compaction is routinely the largest single cost in a turn and used to be invisible entirely. All of it is stored with the conversation, so it survives a window reload and is still there when you scroll back into earlier turns.
- **Delegated work can be continued instead of restarted.** Your agent can go back to a subagent it already used and ask it to carry on, even when that child was working in its own isolated worktree — which used to be refused outright. The child picks up its own conversation, so it still knows the code it just read and the decisions it just made, resumes in the same worktree with its unfinished edits intact, and gets a full turn budget again. A chain like "implementer, then a thorough reviewer, then hand the review back to the same implementer" now runs to the end instead of expiring partway through and being redone from scratch, and a finished child says which worktree its edits are waiting in rather than leaving them to be found by hand.
- **Child agents can navigate code semantically.** Whenever Language Server tools are enabled, delegated children get the read-only ones — find references, go to definition, hover, document and workspace symbols, implementations, type definitions, call hierarchy. A child answers "where is this used" in one call instead of a long grep-and-read sequence.
- **New `Allow shell access for children` setting** (off by default) grants child agents the `bash` tool. Worktree isolation bounds a child's file edits, not what a shell can reach, so this hands children the same machine access the parent has without the parent's review step — but it lets read-only children answer with one `git diff` instead of many turns.

### Changed

- **Plan Mode waits for your approval.** The agent presents a plan and stops instead of executing it in the same turn. Ask for changes and it revises the plan and waits again; approve it and it carries out the whole plan. Your next request starts a fresh plan-and-approve cycle.
- **The subagent turn limit is used exactly as you set it** — there is no upper bound in settings or in agent definitions, and no hidden cap at 100 behind the scenes. Keep in mind that one turn is one model response including every tool call it makes, so tool-heavy work consumes turns quickly.

### Fixed

- **A chat whose window crashed can be opened again.** Its session file used to keep an exclusive write lock that was never reclaimed, so the chat stayed permanently unopenable from history and had to be unblocked by deleting a lock file by hand. Pi Code now reclaims a lock whose owner is provably gone, including after a power loss that left the lock file truncated, or when the operating system reused the dead process's id for something else after the reboot. A chat genuinely open elsewhere is still protected, and lock errors now name the owner and the file to remove.
- **Child agents no longer fail en masse with "exceeded its maximum turn count".** A turn is one model response including every tool call it makes, and nothing said so — so orchestrators handed children budgets sized like conversation turns and the children were stopped mid-task. Children are now told their budget up front, are asked to wrap up one turn before it runs out, and hand back the work they already produced when they are stopped anyway, in both foreground and background runs. A child that delivered its result at the very end of its budget is no longer reported as failed.
- **Switching an image-bearing chat to a model without image support no longer breaks it.** Images in the history are replaced with a short placeholder for those requests and come back as soon as an image-capable model is selected again. Providers that keep vision in a separate model — DeepSeek does — used to turn that switch into a dead end, with every following request rejected outright.
- **A turn that delegated nothing no longer shows other turns' subagents in its statistics.** After a window reload the whole retained history of finished delegations could be charged to whichever turn happened to be running, so a seven-minute turn claimed hours of delegated work. Runs are now attributed to the turn that actually started them, and a background child left over from an earlier turn no longer adds its tool time to the current turn's breakdown.
- Background subagent completion cards now sit where the child actually finished instead of all landing below the turn's final report, and each card names the completion time.
- A turn's footer details — duration, tokens per second, and the breakdown — no longer disappear when the context is compacted right after that turn, and a compacted chat can no longer show one turn the timings of an unrelated earlier one.
- Setting up an isolated worktree for a child no longer fails when a previous one was deleted from disk behind Git's back.
- ToDo tool result cards no longer render as empty rows; the task number, subject, and blocked-by chips are visible again.

---

## 0.67.9 — 2026-08-10

*Everything new since 0.66.3.*

### Added

- **DeepSeek spend is visible while you work.** DeepSeek chats show the remaining USD balance, the latest turn's cost, and today's total Pi Code spend below the input, and completed responses show both the turn cost and the cumulative session cost.

### Changed

- MCP tool calls now name the server and the tool being called (for example "MCP: wikijs.search") instead of a generic "mcp" label.
- Parent chats waiting on foreground subagents show one aggregate waiting indicator and keep individual subagent cards visually quiet, while still retaining child file changes for review instead of flooding the chat with inline diffs.
- **The installed extension is smaller.** Source maps and bundled-package demo videos, banners, and test files that are never used at runtime no longer ship, and the bundled web tools no longer offer the unrequested `librarian` research skill to agents. Web search and page-fetching tools are unaffected.

### Fixed

- Your own prompt now appears in the chat immediately after sending it, instead of waiting for the agent's first response or tool action.
- Compacted chats keep their original names and preserve the complete current-branch conversation, with earlier messages loading automatically when you scroll upward.
- Active turns keep showing the pulsing activity indicator between assistant text, reasoning, and tool actions instead of appearing stuck, and action timelines stop at the final icon instead of leaving a dangling vertical line.
- Inline diff hatching forms continuous diagonal lines across adjacent rows and no longer shifts while the chat scrolls.

---

## 0.66.3 — 2026-08-02

*Everything new since 0.57.1.*

### Added

- **Chat renaming.** Use the pencil button in a chat panel or type `/name <new name>` to rename a chat locally, without contacting the model. Renamed chats keep their full history, tracked file changes, and checkpoints.
- **Raw Mode** — opt-in developer diagnostics that record the complete unredacted stream of provider payloads and agent events for a chat into a local file under VS Code global storage. Disabled by default; turn it on with `pi-code.rawMode.enabled`, open it with **Pi Code: Open Raw View for Active Chat** or the inspect icon in the chat toolbar, and clear recordings per session or all at once from Pi Code Settings. Nothing is uploaded, and nothing is redacted — this is a diagnostic tool.
- **Faster startup and restoration.** The extension warms up in the background at VS Code startup so the first click no longer pays the SDK import cost, the Codex model catalog is cached across window reloads, and an optional full prewarm (`pi-code.prewarm.full`) brings the entire session up eagerly. Chat panels show a loading overlay and a status-bar progress indicator while a new or restored session prepares, instead of appearing frozen.
- **Claude compatibility controls** — a master switch (`pi-code.claudeCompat.enabled`) and a per-workspace mode (`auto` / `on` / `off`) decide when the Claude bridge activates.

### Changed

- A project whose only Claude marker is a `CLAUDE.md` that simply redirects to `AGENTS.md` no longer activates the compatibility bridge — Pi already loads `AGENTS.md` natively, so the redirect no longer duplicates project rules or spends tokens.
- Updated the bundled Pi SDK to 0.82.1 for the latest model runtime, provider authentication, retry behaviour, and model catalog support.

### Fixed

- **Streaming no longer steals your reading position.** Scrolling upward during a turn keeps you where you are, and a finishing turn no longer jumps you to the latest message. Expanded details, diff previews, queued messages, and sidebar subagent rows stay open during agent-driven refreshes.
- Queued messages now start after the agent has fully settled instead of being dropped while the previous run was still considered busy.
- Restored chats mark turns interrupted by **Reload Window** instead of appearing stuck on unfinished thinking or tool output, and no longer show a false interrupted warning after turns that ended in an error or were aborted.
- Reopening an actively running chat from History reconstructs in-flight tool cards with their original start time and arguments, instead of showing a generic preparing indicator while the tool continues in the background.
- Undo and Redo work in reopened sessions, stay available after undoing the final change, and are visibly disabled while an agent is streaming or compacting so an active write cannot race a restore.
- Internal scaffolding stays out of your chat: Plan Mode instructions, attachment inspection notes, and file-mention metadata no longer appear in message bubbles or new chat titles.
- Running `/compact` no longer shows a misleading request-timeout while compaction is still in progress.
- Deleting a chat from History is fast again, restored chat and Raw View tabs reconnect after **Reload Window** without waiting for the sidebar, and turn-completion notifications fire only for tasks you actually submitted.

### Security

- Updated vulnerable runtime and test dependencies, and added a packaging guard that replaces a vulnerable transitive dependency with its patched release before tests or packaging.

---

## 0.57.1 — 2026-07-17

*Everything new since 0.43.9. This is the subagents release.*

### Added

- **Subagents.** A per-chat toggle gives the agent a single `subagent` tool for delegating bounded work to child agents. Reusable agents are discovered from user and trusted-project `.agents/agents/*.md` files, Claude-compatible agent definitions, and bundled packages, and the parent can also invent temporary ad-hoc roles. Each child runs with fresh context and an exact cross-provider model, in the foreground or the background, under global and per-chat concurrency limits with FIFO queueing.
- **A Subagents panel in the launcher** showing every child spawned from the active chat with its real model, lifecycle status, current tool, activity, turns, elapsed time, errors, and a Stop action — plus expandable task and result details.
- **Child work survives a reload.** Subagent transcripts and definition snapshots persist in extension-owned storage and are restored with their parent chat without cluttering ordinary History. Deleting a parent chat removes its children with it.
- **Children can write files.** Foreground children editing the shared workspace take a writer lease and feed the parent's File Undo View and checkpoints; isolated and background writers work inside extension-owned Git worktrees, which the parent reviews, applies, and cleans up.
- **Tool selections can be saved as the project default,** so every new chat in that project starts with the same enabled tools.
- **Turn-completion notifications** — optional popup and standard Windows notification sound, controlled from a new Notifications panel in the launcher.
- Skills are now discovered from the cross-client `.agents/skills/` locations alongside the existing sources.
- Pi Code can opt in to using your user-level Claude Code MCP servers without copying their definitions or credentials.

### Changed

- The prompt expansion control shares the footer row with the timestamp and token details instead of taking a line of its own, and long prompts get an explicit expand/collapse control.
- Delegated tasks, returned results, and MCP calls now have their own icons in chat and in the launcher.

### Fixed

- A subagent that finishes with a usable final response on its last allowed turn no longer loses that work to a maximum-turn failure.
- Adapted Claude skills appear as compact skill invocations instead of dumping their full compatibility instructions into the chat as if you had typed them.

### Security

- Delegation is off by default per chat, and while it is off its schema, agent catalog, and prompt guidelines are removed from the model's context entirely.
- Children start read-only, project agent definitions require Workspace Trust, and an explicitly selected model that is unavailable or disallowed fails instead of silently falling back to another one.
- Background writers are rejected unless worktree isolation is selected, worktree patches are never applied automatically, and both apply and destructive cleanup require explicit confirmation.
- A disabled MCP tool can no longer be invoked through the generic MCP gateway.

---

## 0.43.9 — 2026-07-15

*Everything new since 0.33.4.*

### Added

- **Claude Code project compatibility.** A workspace with Claude infrastructure gets provider-independent support for root, ancestor, local, imported, and directory-scoped `CLAUDE.md` instructions, `.claude/rules/**/*.md` including path-scoped rules applied before matching file operations, and project and activated user Claude skills and legacy commands as native slash commands — with nested skills active only inside their own directory scope. `/claude-compat` shows exactly what was loaded. Ordinary projects receive no Claude-specific content, and native `AGENTS.md` handling is unchanged.

### Changed

- Claude-authored resources are interpreted through a compatibility boundary that preserves your selected Pi agent, model, permissions, runtime, and active tool set. Claude tool references resolve only to capabilities Pi already has — compatibility never grants a tool or introduces a second MCP configuration.

### Fixed

- **Subscription sign-in works reliably** across ChatGPT, Claude, and GitHub Copilot, including browser callbacks, login-method selection, device codes, provider prompts, optional answers left empty, and cancellation.
- Generated, dependency, and build directories no longer switch a project into Claude compatibility through cached instructions or skills, and hidden compatibility instructions no longer appear as visible chat messages.

---

## 0.33.4 — 2026-07-14

*Everything new since 0.32.0.*

### Added

- **`xhigh` and `max` thinking levels** in the Settings page and the in-chat thinking picker. `xhigh` extends `high` with deeper reasoning; `max` is the deepest tier, natively supported by GPT-5.6 and adaptive Claude models, with other models falling back to their closest supported level.
- **GPT-5.6 out of the box** — `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` appear in the model picker once an OpenAI or Codex credential is configured.

### Changed

- **Plan Mode is now pure prompt guidance.** When the toggle is on, every prompt asks the agent to plan first for change-heavy or multi-step work and to re-read files before editing; the agent answers simple questions directly. No tool restrictions, no phase state machine, no manual "go" hand-off, and no control markers.

### Fixed

- Codex subscription usage loads from the correct authenticated endpoint, supports per-model limit buckets, plan types, credits, and spend controls, shows an actionable unavailable state instead of spinning forever, and is cleared when the account changes. Stale snapshots are no longer shown as zero usage or blamed on a single turn.
- GPT-5.6 context usage follows the authenticated account's own catalog — 272k for Codex subscriptions, 1.05M for the direct OpenAI API — instead of a pinned value.
- Newer Claude models no longer intermittently error out on thinking-block conversion.

---

## 0.32.0 — 2026-07-10

*Everything new since 0.24.1.*

### Added

- **Tools panel in the launcher.** Every tool the active chat exposes to the model, with a checkbox each; unchecking hides it from the model on the next turn. Tools sharing a prefix (`github_*`, `database_*`, …) are grouped into collapsible sections with per-group Enable / Disable, named categories (Pi built-ins, Web, ToDo, MCP, Language Server) sit alongside them, a filter box searches names and descriptions, and hover tooltips explain each tool and what toggling it will do. Copy and Paste buttons move a curated selection between chats and between VS Code windows. Selection is per-chat and survives **Reload Window**.
- **File Undo View toggle** — the bar above the input listing every file the agent changed, with Undo / Redo / Review per row, is now opt-in per chat. File-edit tracking always runs regardless; this just surfaces it up front.
- **You can see when a tool is stuck.** Running tool cards show elapsed time that ticks every second, switch to a pulsing "stuck" style after 60 seconds, and a warning banner names any tool that never reported completion before the turn ended.
- **Turn-end warnings.** A yellow banner appears when the model was cut off by its output token cap, and a blue one when a turn ends in a state Pi Code does not recognise, instead of the response simply stopping mid-sentence.
- Copy the ToDo list to the clipboard as a Markdown checklist, and see a coloured language chip and icon on shell tool cards when the command is really a scripting one-liner (`python -c`, `node -e`, `sed -i`, …) rather than a plain shell pipeline.

### Changed

- **Failed tool calls explain themselves.** A schema validation failure now renders as a structured, auto-expanded card with a plain-English explanation, the list of schema errors, and the arguments the model actually sent. When the model retries with corrected arguments, the failed card links down to the successful one.
- **Malformed `edit` arguments are rescued before they fail.** Common wrong shapes (`file_path` instead of `path`, `old_string`/`new_string` instead of `oldText`/`newText`, per-edit paths) are normalized, cutting the retry loop that DeepSeek and similar models were falling into. Anything that cannot be confidently rescued passes through untouched.
- The chat input keeps a stable width on wide panels, and when the footer is too narrow to fit everything it hides items one at a time by priority instead of wrapping onto a second row.
- Updated the bundled Pi SDK to 0.80.3, the web tools to 0.13.0 (adding Tavily / Parallel / Brave / OpenAI search providers and an auto-summary workflow), and the MCP adapter to 2.11.0.
- **The minimum supported VS Code is now 1.110.** Older releases bundle Node 20, and the Pi SDK requires Node.js 22.19 or newer.

### Fixed

- **`pi-code.allowedTools` restricts the toolset again.** It was a silent no-op in 0.24.x and 0.25.x because the underlying SDK option had been renamed.
- Scrolling up during streaming pins your position no matter how you scrolled — keyboard, scrollbar drag, or wheel — until you come back near the bottom yourself.
- The Tools panel keeps its scroll position and filter focus after every checkbox click.

### Removed

- The `code_search` tool, removed upstream from the bundled web tools.

---

## 0.24.1 — 2026-05-23

*Everything new since 0.24.0.*

### Changed

- The installed extension is about 250 KB smaller — development notes that are never used at runtime no longer ship.

---

## 0.24.0 — 2026-05-22

*Everything new since 0.23.0.*

### Added

- **Thinking-level chip in the chat footer,** next to the cache chip. One click to pick `off` / `minimal` / `low` / `medium` / `high` — the same setting that previously lived only inside the model picker.
- Model picker rows show the technical model ID next to the friendly name, and the search box matches both, so searching for `openrouter/free` finds "Free Models Router" instead of returning nothing.

### Changed

- Updated the bundled Pi SDK to 0.74.2, which adds DeepSeek V4 Flash entries and the Together AI provider to the catalog.
- Thinking-level chips are gone from the model picker now that the footer chip is the canonical place to change it.

---

## 0.23.0 — 2026-05-21

*Everything new since 0.21.0.*

### Added

- **Four new slash commands.** `/new` starts a fresh chat in a new editor tab, `/model` opens the inline model picker, `/hotkeys` opens VS Code's Keyboard Shortcuts editor filtered to Pi Code, and `/changelog` opens the bundled release notes in a Markdown preview. `/settings` opens the Pi Code settings page.

### Changed

- **The `CLAUDE.md` handling was rewritten** to match the upstream reference: it now also detects a root-level `CLAUDE.md`, respects the compaction boundary when deciding which instruction files are still unread, recognises files the agent already read, and skips stub files that only redirect elsewhere. `/claude-md-injector` prints a status report of what applies and what has been read.
- Migrated the Pi SDK dependencies to their successor npm scope. No user-visible behaviour change.

### Fixed

- Qwen / DashScope and DeepSeek models show their cache selector as fixed or provider-managed with an explanatory tooltip, instead of implying Pi Code can choose a retention it cannot.

---

## 0.21.0 — 2026-05-13

*Everything new since 0.17.6.*

### Added

- **Plan Mode** — a per-chat toggle that makes the agent study the task and propose a plan before making changes, then unlocks execution once you respond.
- **Language Server tools (opt-in).** Nine semantic-navigation tools that ask your active language extension instead of guessing from grep: `find_references`, `document_symbols`, `goto_definition`, `hover`, `find_implementations`, `type_definition`, `workspace_symbols`, `call_hierarchy_incoming`, and `call_hierarchy_outgoing`. Each returns authoritative `(file, line, column)` positions with surrounding context, marks results found in external dependency sources, and accepts either a position or a symbol name. Off by default — enable with `pi-code.lsp.enabled`. Requires a language extension per file's language; for C# call hierarchy specifically, install **C# Dev Kit**.
- **Per-turn and cumulative timing** in every assistant message footer, alongside token usage, excluding idle gaps between turns.
- Hover tooltips on every icon next to the chat timeline rail and on the launcher's section headings, so it is clear what each tool and control does while you are still learning the interface.

### Changed

- **Chat rows now sit on a vertical timeline rail** — action icons line up in a column on the left with a faint connecting line running through them, and labels and bodies shift right of the icon column. The "agent busy, no tool yet" state became a pulsing dot sized to match the other icons.
- Plan Mode's internal instructions are stripped from your message bubble, so it displays exactly what you typed.

### Removed

- **Tool approval.** The `pi-code.autoApproveTools` setting, the Settings toggle, and the inline approval cards are gone; the agent runs each tool without prompting, matching upstream Pi behaviour.
- Four settings that never did anything: `pi-code.apiBaseUrl`, `pi-code.autoSaveSessions`, `pi-code.sessionStoragePath`, and `pi-code.contextUsageWarningThreshold`.

### Fixed

- The caret no longer drifts away from typed characters after an `@` file mention in a narrow window.
- The **Changelog** tab on the Marketplace listing is populated.

---

## 0.17.6 — 2026-05-10

*The first version published to users.*

Pi Code is a visual VS Code wrapper around the [Pi coding agent](https://pi.dev/),
built as a friendly UI for non-engineers and as a landing pad for anyone moving
over from Claude Code. At this first published release it already offered:

- **Chat panels as editor tabs,** with the activity-bar sidebar acting as a launcher for new chats, settings, and session history. Split them, drag them into another editor group, move them into a separate window, and restore them across **Reload Window**.
- **Multi-tab sessions** — several agent sessions in parallel, each with its own conversation history, tracked file changes, and checkpoints.
- **Inline diffs, file-change tracking, checkpoints, and rollback** — review every modification inline or in VS Code's diff editor, and roll the workspace back to any earlier turn, then redo.
- **Tool visibility** — every file read, write, edit, shell command, search, and web call renders as an expandable card with arguments and results, streamed live.
- **Bring your own model** — API keys for the major providers, or OAuth sign-in with an existing Anthropic, ChatGPT/Codex, GitHub Copilot, or Google subscription, plus a built-in Qwen (Alibaba DashScope) provider for both regions. Favourite and recent models are pinned in the picker.
- **Streaming with collapsible thinking blocks,** message queuing while the agent works, and mid-stream steering with `Ctrl+Enter`.
- **Per-chat persistent ToDo** the agent maintains across `/compact` and across restarts.
- **Prompt cache retention control** in the chat footer, with provider-aware `auto` behaviour.
- **Attachments** — images and text files by paste, drag-and-drop, or the paperclip button.
- **Slash commands and skills,** context-usage display, and a settings page with API key management through VS Code's SecretStorage.

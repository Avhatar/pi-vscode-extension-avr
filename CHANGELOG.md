# Changelog

All notable changes to the Pi Code VS Code extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

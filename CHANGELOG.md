# Changelog

All notable changes to the Pi Code VS Code extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Hover-tooltips on every icon next to the chat timeline rail. Each tool icon now explains what the tool does (Bash, Read, Edit, Grep, the LSP family, Todo, web tools, …), the thinking indicator describes itself, and the busy placeholder distinguishes "preparing next move" from "compacting". Useful while you're still learning what each icon means; uses native `title` so it follows the OS tooltip style and stays out of the way once you know them.

### Removed
- Removed the tool-approval feature entirely (the `pi-code.autoApproveTools` setting, the "Auto-approve tool calls" toggle in Settings, and the inline approval cards in chat). The toggle was non-functional anyway — Pi SDK has a fast path that bypassed our approval hook unless a Pi extension explicitly listens for `tool_call` events, which none of ours did, so disabling auto-approve silently ran tools as if it were on. We're embracing the upstream Pi YOLO model for now: the agent runs every tool without confirmation.

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
- VSIX no longer ships internal design docs (`MIGRATION_PANELS.md`, `PERSISTENT_TODO.md`, `WORKSPACE_FILE_MENTIONS.md`) or a stray `nul` artefact left over from a misdirected shell redirect. The docs remain in the GitHub repository for contributors but are excluded from the published package via `.vscodeignore`. Reduces VSIX clutter without changing any runtime behaviour.

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

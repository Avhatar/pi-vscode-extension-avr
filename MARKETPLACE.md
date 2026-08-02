# Pi Code for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.110%2B-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)

A visual VS Code wrapper around the [Pi coding agent](https://pi.dev/) — built as a friendly UI for non-engineers and as a smooth landing pad for anyone moving over from Claude Code who wants the same familiar ergonomics, extra quality-of-life features, and the freedom to use any AI model behind the scenes.

![Pi Code in action — chat panel as an editor tab, with launcher sidebar, ToDo list, inline tool calls and diffs](https://raw.githubusercontent.com/Avhatar/pi-vscode-extension-avr/main/media/screenshots/screenshot1.png)

## What's new since Marketplace 0.57.1

- **Chat renaming** — use the pencil button in a chat panel or type `/name` to rename a chat locally without contacting the model. Renamed chats keep their full history, diffs, and checkpoints.
- **Raw Mode** — opt-in developer diagnostics that record complete unredacted provider payloads and agent events to local VS Code global storage. The recording stays local, is disabled by default, and opens with **Pi Code: Open Raw View for Active Chat**.
- **Faster startup and restoration** — Pi SDK warm-up removes the first dynamic-import delay, an optional full prewarm (`pi-code.prewarm.full`) completes session bring-up at startup, and the Codex model catalog is cached across reloads. Chat panels show a loading overlay and VS Code status progress while new or restored sessions prepare.
- **Claude compatibility controls** — a master switch (`pi-code.claudeCompat.enabled`) and per-workspace mode (`auto` / `on` / `off`) control when the Claude bridge activates. Restored chat and Raw View tabs reconnect after `Reload Window` without waiting for the sidebar.
- **Reliability fixes** — streaming preserves your reading position, attachment and file-mention scaffolding stays out of visible prompts, queued messages wait for full agent settlement, and long-running compaction no longer shows a misleading request timeout.
- **Pi SDK 0.82.1** — updated model runtime, provider authentication, retry behaviour, and model catalog support.

## Why Pi Code?

- **Claude Code-style ergonomics.** Chats are normal editor tabs — split, drag into another editor group, move into a separate window, restore across `Reload Window`. Multiple chats run in parallel, each with its own history, file changes, and checkpoints.
- **Bring your own model.** Works with the major AI providers via API key, or sign in with your existing subscription — no separate setup, no second invoice.
- **Web access and MCP servers out of the box.** Web search, page/PDF/YouTube fetch, and any MCP server you declare in `.mcp.json` work immediately after install. No CLI step — bundled extensions load from the VSIX without a global install step. Optionally import your Claude Code MCP servers with one checkbox.
- **Plan-before-execute.** Optional Plan Mode gives the agent persistent guidance to study change-heavy tasks, outline an approach, and then execute once the plan is clear — while answering simple questions directly.
- **Semantic code navigation.** Opt-in Language Server tools let the agent ask your existing language extension (C#, rust-analyzer, Pylance, TypeScript, gopls, clangd) for references, definitions, implementations, call hierarchy, and workspace symbols instead of guessing from grep.
- **Made for non-engineers too.** Inline diffs, per-turn checkpoints, image attachments, per-turn timing, and a per-chat ToDo make the agent legible — you can see exactly what it's doing and undo any step.

## Features

### Chat panels as editor tabs
Each chat opens as a normal editor-area webview panel. Split the editor, drag the tab between groups, move it into a separate window, or close and reopen it from the launcher's history.

### Multi-tab sessions
Run several agent sessions in parallel. Conversation history, tracked file changes, and checkpoint state are isolated per tab.

### Tool visibility
Every tool call (file reads/writes/edits, shell, glob/grep/find, web search, fetch, LSP semantic queries) renders as an expandable card with arguments and results, streamed in real time. A vertical timeline rail connects the icons on the left so it's easy to follow what the agent did across a long turn; hover any icon for a tooltip describing what the tool does.

### Tool selection panel
The launcher sidebar has a **Tools** panel that lists every tool the active chat exposes to the model, with a checkbox per tool. Unchecking a tool hides it from the model on the next turn. Tools sharing a prefix (`github_*`, `database_*`, `browser_*`, …) are grouped into collapsible sections with per-group Enable / Disable buttons — one click removes a large tool group from the prompt when it is not needed. Named categories (**Pi built-ins**, **Web**, **ToDo**, **MCP**, **Language Server**) sit alongside prefix groups, and a filter box searches both tool names and descriptions. **Copy** / **Paste** buttons serialise the current selection to the clipboard so you can transplant a curated tool set between chats or between VS Code windows. **DefaultForProject** saves the active selection as the workspace project default — reuse the same curated tool set across every new chat in that project. Selection is per-chat and persists across `Reload Window`.

### Inline diffs and rollback
File modifications are tracked automatically. Review unified diffs inline or open them in VS Code's native diff editor. Undo a single file or every change at once.

### File Undo View
Optional always-visible bar above the prompt input that lists every file the agent has changed in the current chat, each row with **Undo** / **Redo** / **Review** buttons for one-click revert or diff-editor inspection. File-edit tracking always runs regardless — this bar just surfaces it up-front so pending changes stay in your eye-line. Per-chat toggle in the launcher sidebar; enable by default for new chats with `pi-code.fileUndoView.defaultEnabled`.

### Checkpoints
Every user message creates a checkpoint. Roll the workspace back to any earlier turn, then redo to bring changes back. The conversation history is preserved so you can branch from any point.

### Plan Mode
Per-chat toggle in the launcher sidebar (above ToDo) that prepends planning guidance to every prompt. Questions and information requests are answered directly; for code changes and multi-step work, the agent studies the relevant files, outlines an approach, and can execute it in the same turn once the plan is clear. It waits only when a genuine question requires your answer. Plan Mode does not restrict tools, use execution phases, or require control markers. Disabled by default for new chats; enable it by default with `pi-code.planMode.defaultEnabled`.

### Language Server tools (opt-in)
Nine semantic-navigation tools that ask your active language extension instead of guessing from grep: `find_references`, `document_symbols`, `goto_definition`, `hover`, `find_implementations`, `type_definition`, `workspace_symbols`, `call_hierarchy_incoming`, and `call_hierarchy_outgoing`. Each tool returns authoritative `(file, line, column)` positions plus surrounding context, annotates results in external dependency sources (NuGet, cargo registry, `node_modules`) as `[external]`, and accepts either positional or symbol-name addressing. Off by default — enable with `pi-code.lsp.enabled` for projects where semantic accuracy is worth the extra system-prompt footprint (large Unity / Rust / TS codebases with name collisions, partial classes, overloaded methods). Requires a language extension for each file's language; for C# call hierarchy specifically, install **C# Dev Kit** (the OmniSharp-only extension does not implement it).

### Streaming with thinking
Watch the agent reason in real time with collapsible thinking blocks. Cycle through `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` to control depth. `max` is natively supported by GPT-5.6 and adaptive Claude models; other models fall back to their closest supported level.

### Per-turn and cumulative timing
Each assistant message footer shows the elapsed wall-clock time for that turn plus the cumulative active time across the chat (idle gaps excluded), alongside token usage.

### Image attachments
Paste, drop, or pick images via the paperclip button. Previews stay in chat history; image-capable models receive them inline.

### Workspace `@` file mentions
Type `@` to fuzzy-match files in your workspace. Mentions are highlighted in the input and sent to the agent as path references it can choose to inspect.

### Claude project compatibility
Claude compatibility activates only when the workspace contains real Claude infrastructure such as `CLAUDE.md`, `CLAUDE.local.md`, `.claude` rules, skills or commands, nested resources, or a project-scoped Claude plugin. Ordinary projects receive no Claude-specific hooks or prompt content, and user-level Claude resources are considered only after a project marker activates compatibility.

Root, ancestor, local, explicitly imported, and directory-scoped instructions are injected as hidden context without spending read-tool calls. `@file` imports are contained to the workspace and limited to four recursive hops; generated, dependency, and build directories are excluded from nested discovery. Project-wide and path-scoped `.claude/rules` are applied when relevant. Project and activated user skills and legacy commands become native slash commands, while nested skills use directory-qualified names such as `/apps/web:deploy` and enter context only inside their scope. Claude tool names map only to capabilities already available through Pi, preserving the current agent, model, permissions, and MCP configuration. Run `/claude-compat` in an active Claude project to inspect what was loaded. Native `AGENTS.md` handling remains unchanged.

### Message queuing and steering
Queue follow-up messages while the agent is streaming (they auto-send when the turn finishes), or steer mid-generation with `Ctrl+Enter` to inject guidance into the current response.

### Slash commands and skills
Type `/` to open a slash-command menu. Cross-client Agent Skills are discovered from `~/.agents/skills/` and workspace `.agents/skills/`; Pi Code also retains legacy `~/.pi/agent/skills/` and workspace `.pi/skills/` discovery. In Claude-enabled projects, compatible project/user Claude skills and legacy `.claude/commands` are surfaced alongside them, with directory-scoped skills activated only when the agent works in their subtree.

### Subagents
Per-chat opt-in toggle in the launcher sidebar (disabled by default) that gives the parent agent a `subagent` tool for delegating work to child agents. Named agents are discovered from user and trusted-project `.agents/agents/*.md` resources, Claude-compatible definitions, and bundled packages; the parent can also create ad-hoc roles on the fly. Each child runs with an exact cross-provider `provider/id` model constrained by the configured policy and allowlist, or explicitly inherits the parent model. Foreground children return inside the parent turn; background children run independently and post a compact result when they finish. The launcher's **Subagents** section shows every child spawned from the active chat with live status, elapsed time, and expandable results. For isolated background writes the parent reviews, applies, and cleans up the worktree diff — child agents never touch the project workspace directly. Tune concurrency, timeouts, and turn limits via `pi-code.subagents.*` settings.

### Per-chat ToDo
Each chat has its own persistent task list the agent manages via a built-in `todo` tool — pending / in-progress / completed states, dependencies, and inline display in the launcher. Toggle per-tab on or off.

### Codex subscription usage indicator
When using a Codex (GPT-5.x) model with a ChatGPT subscription, the chat footer shows percent-used in the 5-hour and weekly windows, plus a per-turn delta on each assistant message.

### Prompt cache retention controls
A `cache: …` chip in the footer chooses `short` / `long` / provider-aware `auto` so cached prefixes are kept around exactly as long as you need them.

### Windows turn-completion notifications
Two opt-in toggles in the launcher sidebar, both off by default: **Show Popup** displays a native toast outside VS Code when an agent turn finishes, and **Play Sound** plays the standard Windows notification sound. Both use PowerShell and are currently Windows-only; non-Windows platforms log a notice instead.

### Settings page with OAuth login
A dedicated settings panel handles API keys, default model, thinking level, ToDo behaviour, subagents, Claude compatibility controls, Raw Mode recording, performance diagnostics and prewarm, Claude Code MCP import, Language Server tools, file-mention indexing, and chat appearance. Provider credentials entered there are stored via VS Code's `SecretStorage` — never in `settings.json`. The same panel hosts OAuth sign-in for Anthropic Claude (Pro/Max), ChatGPT (Plus/Pro/Codex), GitHub Copilot, Gemini CLI, and Antigravity, with a manual paste-the-code fallback when the local OAuth callback can't be reached.

### Bundled web access and MCP
`web_search`, `fetch_content` (web pages, GitHub, YouTube transcripts, PDFs, local videos), and `get_search_content` ship inside the extension as the bundled `pi-web-access` package. In automatic mode, search uses OpenAI when suitable and available, then falls back through Exa, Brave, Parallel, Tavily, Perplexity, and Gemini; Exa MCP works without an API key. The bundled `pi-mcp-adapter` picks up servers from `.mcp.json` / `.pi/mcp.json` automatically. Enable `pi-code.mcp.importClaudeCode` in settings to add a managed compatibility import that references your user-level Claude Code MCP servers — server definitions and credentials stay in your Claude config; only an import entry is written to Pi's global MCP config.

### Chat renaming
Use the pencil button in a chat panel or type `/name <new name>` to rename a chat locally without contacting the model. The name is reused in the editor tab and launcher history. Renamed chats keep their full conversation history, tracked file changes, and checkpoint state.

### Raw Mode (developer diagnostics)
Raw Mode records the complete unredacted stream of provider payloads and agent events for a chat session into a local JSONL file under VS Code global storage. Disabled by default — toggle `pi-code.rawMode.enabled` to start capturing for active and future chats. Capture is unbounded while enabled and may include system prompts, tool schemas and results, provider headers, model exchanges, and workspace file contents. Existing recordings persist on disk after you disable the setting; clear them per session or delete all Raw Mode data from Pi Code Settings, or delete the corresponding History entry to remove its recording. Open the Raw View with the **Pi Code: Open Raw View for Active Chat** command or the inspect icon in the chat toolbar.

### Startup and performance diagnostics
The extension warms up behind the scenes so the launcher sidebar and first chat tab open without perceptible delay. Enable `pi-code.prewarm.full` to bring up the entire Pi session (SDK import, auth, model registry, resource loader) at VS Code startup — every subsequent chat opens nearly instantly, at the cost of ~3 seconds added to window reload and ~50 MB extra memory. For troubleshooting slow activation or session bring-up, toggle `pi-code.perf.enabled` to record detailed timing events to a JSONL file under the extension's global storage; the file path is printed to the Pi Code output channel on activation.

## Getting Started

1. **Install** the extension from the Marketplace.
2. **Open** the Pi Code icon in the activity bar — that's the launcher sidebar with **+ New chat**, **Settings**, history, and per-chat ToDo.
3. **Connect a provider** in *Settings* (gear icon, top-right of the launcher):
   - paste an API key for any supported provider, **or**
   - click the **Sign in** button next to your subscription provider (Claude Pro/Max, ChatGPT Plus/Pro/Codex, GitHub Copilot, Gemini CLI, Antigravity) to authenticate via your browser.
4. **Click + New chat** (`Ctrl+Shift+N`). The chat opens as a regular editor tab — split, drag, or move it wherever you like.
5. **Pick a model** with the picker at the bottom of the chat, then type your prompt and press Enter.
6. **While the agent works:** review tool calls inline, queue follow-ups (Enter), or steer mid-stream (`Ctrl+Enter`).
7. **Review and roll back:** click *Review* on a diff to open VS Code's diff editor, or use the per-message checkpoint button to roll the workspace back to that turn.
8. **Optional:** toggle **Plan Mode** above ToDo in the sidebar for unfamiliar codebases or risky refactors — the agent will study and outline change-heavy work before executing once the approach is clear.

## Supported Providers

**API key:** Anthropic, OpenAI, Google Gemini, DeepSeek, Azure OpenAI, Google Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, Hugging Face, Fireworks, Kimi For Coding, MiniMax, Qwen (Alibaba DashScope), Z.ai (GLM).

**Subscription (OAuth login):** Anthropic Claude Pro/Max, ChatGPT Plus/Pro/Codex, GitHub Copilot, Google Gemini CLI, Google Antigravity.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` (`Cmd+Shift+L`) | Reveal the active chat panel, or focus the launcher if no chat is open |
| `Ctrl+Shift+N` (`Cmd+Shift+N`) | Open a new chat as an editor tab |
| `Enter` | Send prompt, or queue a message while streaming |
| `Ctrl+Enter` (`Cmd+Enter`) | Steer the agent mid-generation |
| `Escape` | Stop the current generation |

## Commands

Main user-facing commands are available from the command palette (`Ctrl+Shift+P`):

- **Pi Code: New Chat** — open a fresh agent session as an editor tab
- **Pi Code: New Agent Tab** — open a fresh chat from the launcher or Command Palette
- **Pi Code: Session History** — reveal the launcher with previous sessions
- **Pi Code: Stop Generation** — abort the current streaming response
- **Pi Code: Select Model** — choose an AI model
- **Pi Code: Toggle Thinking Level** — cycle through thinking verbosity levels
- **Pi Code: Focus Chat** — reveal the active chat panel, or fall back to the launcher
- **Pi Code: Open Settings** — open the Pi Code settings page
- **Pi Code: Open Raw View for Active Chat** — open the Raw Mode diagnostic viewer for the active chat
- **Pi Code: Run Subagent Smoke Test** — *(developer)* validate subagent lifecycle, worktree isolation, and policy enforcement

## Settings

Settings can be configured through the dedicated settings page (gear icon in the launcher) or via VS Code's standard settings editor.

| Setting | Type | Default | Description |
|---|---|---|---|
| `pi-code.apiProvider` | `string` | `""` | Provider whose API key the Settings page is currently managing. Runtime provider is chosen by the selected model — this only picks the key slot to edit. |
| `pi-code.defaultModel` | `string` | `""` | Default model ID for new sessions |
| `pi-code.thinkingLevel` | `string` | `off` | Default thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `pi-code.allowedTools` | `string[]` | `[]` | Restrict which tools the agent can use. Empty = allow all. |
| `pi-code.fileMentions.enabled` | `boolean` | `true` | Enable `@` file mentions in chat input |
| `pi-code.fileMentions.useDefaultExcludes` | `boolean` | `true` | Use built-in exclude patterns for `@` mention indexing |
| `pi-code.fileMentions.exclude` | `string[]` | `[]` | Extra glob patterns to exclude from `@` mention suggestions |
| `pi-code.fileMentions.maxSuggestions` | `number` | `30` | Maximum `@` mention suggestions to show |
| `pi-code.fileMentions.configPath` | `string` | `.pi/file-mentions.json` | Workspace-relative config file for `@` mention indexing |
| `pi-code.planMode.defaultEnabled` | `boolean` | `false` | Enable prompt-guided Plan Mode for new chats by default; it does not restrict tools or require a separate execution phase |
| `pi-code.fileUndoView.defaultEnabled` | `boolean` | `false` | Show the File Undo View (Undo / Redo / Review bar above the prompt) by default for new chats |
| `pi-code.todo.defaultEnabled` | `boolean` | `true` | Enable the per-chat ToDo for new chats by default |
| `pi-code.todo.promptGuidelines` | `string` | *(multiline)* | Prompt guidelines for the ToDo tool |
| `pi-code.subagents.defaultEnabled` | `boolean` | `false` | Expose the subagent delegation tool to new chats by default. Each chat keeps its own opt-in state. |
| `pi-code.subagents.defaultModel` | `string` | `""` | Default child model in canonical `provider/id` format. Empty = use agent definition then parent model. |
| `pi-code.subagents.allowedModels` | `string[]` | `[]` | Exact `provider/id` models allowed for child agents. Empty = allow all configured models. |
| `pi-code.subagents.allowInvocationModelOverride` | `boolean` | `true` | Allow the parent to select an exact child provider/model in a subagent tool call. |
| `pi-code.subagents.defaultMaxTurns` | `number` | `60` | Default maximum turns for a foreground child agent (1–100). |
| `pi-code.subagents.defaultTimeoutMinutes` | `number` | `30` | Default execution timeout in minutes for a child agent (1–120). |
| `pi-code.subagents.maxConcurrentGlobal` | `number` | `4` | Maximum child agents running across all Pi Code chats (1–16). |
| `pi-code.subagents.maxConcurrentPerChat` | `number` | `2` | Maximum child agents from one parent chat (1–8). |
| `pi-code.mcp.importClaudeCode` | `boolean` | `false` | Import user-level Claude Code MCP servers via a managed compatibility entry. Server definitions and credentials remain in Claude config. |
| `pi-code.claudeCompat.enabled` | `boolean` | `true` | Master switch for Claude Code compatibility; disable to bypass all Claude bridge logic regardless of workspace mode |
| `pi-code.claudeCompat.mode` | `string` | `auto` | Per-workspace Claude compatibility mode: `auto` (detect), `on` (force), or `off` (bypass) |
| `pi-code.lsp.enabled` | `boolean` | `false` | Expose Language Server tools (find_references, goto_definition, hover, etc.) to the agent. Opt-in; requires a language extension per file's language. |
| `pi-code.rawMode.enabled` | `boolean` | `false` | Record complete unredacted provider payloads and agent events to local global-storage JSONL; existing recordings persist after disabling |
| `pi-code.perf.enabled` | `boolean` | `false` | Record activation and session-bring-up timings to a local JSONL file for troubleshooting slow startup |
| `pi-code.prewarm.full` | `boolean` | `false` | Perform full Pi session bring-up at VS Code startup. Adds about 3 seconds to reload, roughly 50 MB of memory, and a startup model-metadata request |
| `pi-code.userMessageGlowColor` | `string` | `#00aaff` | Glow colour around user messages in the chat |
| `pi-code.userMessageGlowOpacity` | `number` | `40` | Glow opacity, 0–100 |

API keys are managed through the settings page and stored via VS Code's `SecretStorage`, never in `settings.json`.

## Privacy

Provider API keys and OAuth tokens entered in Pi Code settings are stored in VS Code's `SecretStorage`, never in `settings.json` or a plaintext file. Network requests go only to providers and services you configure or invoke, including enabled MCP servers and bundled web tools. Optional web-search credentials can be supplied separately through `~/.pi/web-search.json`. Opt-in managed config writes, such as the Claude Code MCP import, are explicit in their setting. No telemetry or usage data of any kind is sent to the publisher.

**Raw Mode:** When `pi-code.rawMode.enabled` is on, Pi Code mirrors complete unredacted provider payloads and agent events for each chat session to a local JSONL file under VS Code global storage. Recordings may contain sensitive data such as system prompts, tool schemas and results, provider headers, model exchanges, and workspace file contents. Pi Code does not upload the recording; the captured exchanges still use the providers and services you configured. Capture is unbounded while enabled, and existing recordings persist after the setting is disabled. Clear one session or all Raw Mode data from Pi Code Settings, or delete the corresponding History entry. Raw Mode is disabled by default.

## Credits

Pi Code embeds [Mario Zechner's Pi coding agent SDK](https://github.com/badlogic/pi-mono).

## License

MIT. Source code, contribution guidelines, architecture notes, and changelog: [GitHub repository](https://github.com/Avhatar/pi-vscode-extension-avr).

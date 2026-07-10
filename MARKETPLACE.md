# Pi Code for VS Code

[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.110%2B-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)

A visual VS Code wrapper around the [Pi coding agent](https://pi.dev/) — built as a friendly UI for non-engineers and as a smooth landing pad for anyone moving over from Claude Code who wants the same familiar ergonomics, extra quality-of-life features, and the freedom to use any AI model behind the scenes.

![Pi Code in action — chat panel as an editor tab, with launcher sidebar, ToDo list, inline tool calls and diffs](https://raw.githubusercontent.com/Avhatar/pi-vscode-extension-avr/main/media/screenshots/screenshot1.png)

## Why Pi Code?

- **Claude Code-style ergonomics.** Chats are normal editor tabs — split, drag into another editor group, move into a separate window, restore across `Reload Window`. Multiple chats run in parallel, each with its own history, file changes, and checkpoints.
- **Bring your own model.** Works with the major AI providers via API key, or sign in with your existing subscription — no separate setup, no second invoice.
- **Web access and MCP servers out of the box.** Web search, page/PDF/YouTube fetch, and any MCP server you declare in `.mcp.json` work immediately after install. No CLI step, no global `~/.pi/` writes.
- **Plan-before-execute.** Optional Plan Mode toggle has the agent study the task with read-only tools and propose a plan before any file changes — useful for unfamiliar codebases or risky refactors.
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
The launcher sidebar has a **Tools** panel that lists every tool the active chat exposes to the model, with a checkbox per tool. Unchecking a tool hides it from the model on the next turn. Tools sharing a prefix (`unity_*`, `blueprint_*`, `task_workspace_*`, …) are grouped into collapsible sections with per-group Enable / Disable buttons — one click drops 50+ Unity tools from the prompt when they aren't needed. Named categories (**Pi built-ins**, **Web**, **ToDo**, **MCP**, **Language Server**) sit alongside prefix groups, and a filter box searches both tool names and descriptions. **Copy** / **Paste** buttons serialise the current selection to the clipboard so you can transplant a curated tool set between chats or between VS Code windows. Selection is per-chat and persists across `Reload Window`.

### Inline diffs and rollback
File modifications are tracked automatically. Review unified diffs inline or open them in VS Code's native diff editor. Undo a single file or every change at once.

### File Undo View
Optional always-visible bar above the prompt input that lists every file the agent has changed in the current chat, each row with **Undo** / **Redo** / **Review** buttons for one-click revert or diff-editor inspection. File-edit tracking always runs regardless — this bar just surfaces it up-front so pending changes stay in your eye-line. Per-chat toggle in the launcher sidebar; enable by default for new chats with `pi-code.fileUndoView.defaultEnabled`.

### Checkpoints
Every user message creates a checkpoint. Roll the workspace back to any earlier turn, then redo to bring changes back. The conversation history is preserved so you can branch from any point.

### Plan Mode
Per-chat toggle in the launcher sidebar (above ToDo) that makes the agent study the task with read-only tools and propose a plan before making any changes. The first message of a task is sent with only `read`, `grep`, `find`, `ls`, and the web/search tools active — the agent analyses the codebase, asks clarifying questions, and presents an approach. When the plan is finalised the agent ends its message with a `<plan-ready/>` marker; the extension detects it, auto-transitions into execution and dispatches a synthetic proceed prompt so the plan flows straight into changes — no need to type "go" yourself. Reply during the plan phase if you want to iterate before execution. After execution, the next prompt restarts the planning cycle. Disabled by default for new chats; flip on with the `pi-code.planMode.defaultEnabled` setting.

### Language Server tools (opt-in)
Eight semantic-navigation tools that ask your active language extension instead of guessing from grep: `find_references`, `document_symbols`, `goto_definition`, `hover`, `find_implementations`, `type_definition`, `workspace_symbols`, and `call_hierarchy_incoming` / `call_hierarchy_outgoing`. Each tool returns authoritative `(file, line, column)` positions plus surrounding context, annotates results in external dependency sources (NuGet, cargo registry, `node_modules`) as `[external]`, and accepts either positional or symbol-name addressing. Off by default — enable with `pi-code.lsp.enabled` for projects where semantic accuracy is worth the extra system-prompt footprint (large Unity / Rust / TS codebases with name collisions, partial classes, overloaded methods). Requires a language extension for each file's language; for C# call hierarchy specifically, install **C# Dev Kit** (the OmniSharp-only extension does not implement it).

### Streaming with thinking
Watch the agent reason in real time with collapsible thinking blocks. Cycle through `off`, `minimal`, `low`, `medium`, `high` to control verbosity.

### Per-turn and cumulative timing
Each assistant message footer shows the elapsed wall-clock time for that turn plus the cumulative active time across the chat (idle gaps excluded), alongside token usage.

### Image attachments
Paste, drop, or pick images via the paperclip button. Previews stay in chat history; image-capable models receive them inline.

### Workspace `@` file mentions
Type `@` to fuzzy-match files in your workspace. Mentions are highlighted in the input and sent to the agent as path references it can choose to inspect.

### Auto-loaded workspace instructions
`CLAUDE.md` (and any files it `@`-imports up to depth 5) is read automatically at the start of each turn so project rules apply without you pointing at them. Per-folder `CLAUDE.md` files are surfaced when the agent touches that subtree.

### Message queuing and steering
Queue follow-up messages while the agent is streaming (they auto-send when the turn finishes), or steer mid-generation with `Ctrl+Enter` to inject guidance into the current response.

### Slash commands and skills
Type `/` to open a slash-command menu over Pi skills loaded from `~/.pi/agent/skills/` and your workspace's `.pi/skills/`.

### Per-chat ToDo
Each chat has its own persistent task list the agent manages via a built-in `todo` tool — pending / in-progress / completed states, dependencies, and inline display in the launcher. Toggle per-tab on or off.

### Codex subscription usage indicator
When using a Codex (GPT-5.x) model with a ChatGPT subscription, the chat footer shows percent-used in the 5-hour and weekly windows, plus a per-turn delta on each assistant message.

### Prompt cache retention controls
A `cache: …` chip in the footer chooses `short` / `long` / provider-aware `auto` so cached prefixes are kept around exactly as long as you need them.

### Settings page with OAuth login
A dedicated settings panel handles API keys, default model, thinking level, ToDo behaviour, file-mention indexing, and chat appearance. API keys are stored via VS Code's `SecretStorage` — never in `settings.json`. The same panel hosts OAuth sign-in for Anthropic Claude (Pro/Max), ChatGPT (Plus/Pro/Codex), GitHub Copilot, Gemini CLI, and Antigravity, with a manual paste-the-code fallback when the local OAuth callback can't be reached.

### Bundled web access and MCP
Web search, code search, content fetching (web pages, GitHub, YouTube transcripts, PDFs, local videos), and an MCP adapter that picks up servers from `.mcp.json` / `.pi/mcp.json` ship inside the extension and load automatically. Uses Exa MCP by default with no API keys; optionally reads `~/.pi/web-search.json` to switch backends.

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
8. **Optional:** toggle **Plan Mode** above ToDo in the sidebar for unfamiliar codebases or risky refactors — the agent will plan first and only execute after you confirm.

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

All commands are available from the command palette (`Ctrl+Shift+P`):

- **Pi Code: New Chat** — open a fresh agent session as an editor tab
- **Pi Code: Session History** — reveal the launcher with previous sessions
- **Pi Code: Stop Generation** — abort the current streaming response
- **Pi Code: Select Model** — choose an AI model
- **Pi Code: Toggle Thinking Level** — cycle through thinking verbosity levels
- **Pi Code: Focus Chat** — reveal the active chat panel, or fall back to the launcher
- **Pi Code: Open Settings** — open the Pi Code settings page

## Settings

Settings can be configured through the dedicated settings page (gear icon in the launcher) or via VS Code's standard settings editor.

| Setting | Type | Default | Description |
|---|---|---|---|
| `pi-code.apiProvider` | `string` | `""` | Provider whose API key the Settings page is currently managing. Runtime provider is chosen by the selected model — this only picks the key slot to edit. |
| `pi-code.defaultModel` | `string` | `""` | Default model ID for new sessions |
| `pi-code.thinkingLevel` | `string` | `off` | Default thinking level (`off`, `minimal`, `low`, `medium`, `high`) |
| `pi-code.allowedTools` | `string[]` | `[]` | Restrict which tools the agent can use. Empty = allow all. |
| `pi-code.fileMentions.enabled` | `boolean` | `true` | Enable `@` file mentions in chat input |
| `pi-code.fileMentions.useDefaultExcludes` | `boolean` | `true` | Use built-in exclude patterns for `@` mention indexing |
| `pi-code.fileMentions.exclude` | `string[]` | `[]` | Extra glob patterns to exclude from `@` mention suggestions |
| `pi-code.fileMentions.maxSuggestions` | `number` | `30` | Maximum `@` mention suggestions to show |
| `pi-code.fileMentions.configPath` | `string` | `.pi/file-mentions.json` | Workspace-relative config file for `@` mention indexing |
| `pi-code.planMode.defaultEnabled` | `boolean` | `false` | Enable Plan Mode for new chats by default |
| `pi-code.fileUndoView.defaultEnabled` | `boolean` | `false` | Show the File Undo View (Undo / Redo / Review bar above the prompt) by default for new chats |
| `pi-code.todo.defaultEnabled` | `boolean` | `true` | Enable the per-chat ToDo for new chats by default |
| `pi-code.todo.promptGuidelines` | `string` | *(multiline)* | Prompt guidelines for the ToDo tool |
| `pi-code.lsp.enabled` | `boolean` | `false` | Expose Language Server tools (find_references, goto_definition, hover, etc.) to the agent. Opt-in; requires a language extension per file's language. |
| `pi-code.userMessageGlowColor` | `string` | `#00aaff` | Glow colour around user messages in the chat |
| `pi-code.userMessageGlowOpacity` | `number` | `40` | Glow opacity, 0–100 |

API keys are managed through the settings page and stored via VS Code's `SecretStorage`, never in `settings.json`.

## Privacy

API keys and OAuth tokens are stored exclusively in VS Code's `SecretStorage` — never written to `settings.json` or any plaintext file. The extension itself contacts only the AI provider you configure (and, if you use the bundled web tools, the chosen search backend). No telemetry is sent to the publisher.

## Credits

Pi Code embeds [Mario Zechner's Pi coding agent SDK](https://github.com/badlogic/pi-mono).

## License

MIT. Source code, contribution guidelines, architecture notes, and changelog: [GitHub repository](https://github.com/Avhatar/pi-vscode-extension-avr).

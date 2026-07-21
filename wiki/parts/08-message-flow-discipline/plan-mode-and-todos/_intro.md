# Chapter: plan-mode-and-todos

Two independent affordances share this chapter because both live in the "message-flow discipline" band. **Plan Mode** prepends a preamble to new prompts telling the agent to analyze / plan first, not write code. **ToDo** is a Pi tool the agent calls to track tasks; the ToDo state is projected into the launcher and persists per-session (via replay from the JSONL transcript, not a separate store).

They're independent — Plan Mode changes prompts, ToDo is a tool — but both are user-visible toggles that alter what appears on the screen mid-conversation, so they're grouped here.

## Article roster

- [plan-mode-and-todos](plan-mode-and-todos.md) — Plan Mode preamble decoration, per-session persistence key, ToDo store / tool / replay, task graph invariants, and the response-envelope shape the tool returns.

## Reader task

The reader arrives here to answer one of:

- "What does Plan Mode actually do to my messages?"
- "How does the ToDo list survive across window reloads without a separate persistence file?"
- "Can the agent create a task that depends on itself?"
- "Is Plan Mode per-tab or per-window?"

## Neighborhood

- **The Plan Mode setting** — `pi-code.planMode.defaultEnabled` — is [Part I § configuration-and-secrets](../../01-extension-host-substrate/configuration-and-secrets/configuration-and-secrets.md).
- **The ToDo tool registration** is part of the resource loader in [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
- **Launcher rendering** of ToDo items is [Part VI § launcher-view](../../06-ui-surfaces-webview/launcher-view/launcher-view.md).

## Non-goals

- ToDo UI layout (checkbox states, indentation, expand/collapse) is not enumerated here.
- Plan Mode's specific instruction wording — the exact text lives in [chat-preferences.ts](../../../../src/core/chat/chat-preferences.ts) and can drift; the article documents the mechanism, not the words.
- Provider-specific compliance with Plan Mode is a system-prompt hygiene concern outside this surface.

# Chapter: slash-commands-and-skills-menu

Typing `/` in the chat input triggers a floating menu of matched slash commands and skills. Built-in commands (`/compact`, `/name`, `/model`, `/new`, `/settings`, `/hotkeys`, `/changelog`) live in the webview; skills come from the Pi SDK via a `getSkills` client message. This chapter documents the menu detection, rendering, and selection flow.

The extension host side of `/name` and `/compact` parsing lives in [Part III § chat-command-service](../../03-portable-chat-core/chat-command-service/chat-command-service.md); this chapter is about what the *user sees* when typing.

## Article roster

- [slash-commands-and-skills-menu](slash-commands-and-skills-menu.md) — `BUILTIN_SLASH_COMMANDS`, the `/` detection regex, keyboard navigation, skill fetching + rendering.

## Reader task

The reader arrives here to answer one of:

- "Where does `/compact` come from — the SDK or the webview?"
- "How does the menu detect that the user just typed `/`?"
- "What arrow-key navigation is bound?"
- "How does a selected skill get inserted into the input?"

## Neighborhood

- **The parsing side of `/name`** at command dispatch time lives in [Part III § chat-command-service](../../03-portable-chat-core/chat-command-service/chat-command-service.md).
- **`/compact` semantics** — how the SDK interprets it — is [Part V § session-lifecycle](../../05-pi-sdk-integration/session-lifecycle/session-lifecycle.md).
- **Skill loading** on the SDK side is a Pi SDK feature; the webview only consumes the resulting `SkillInfo[]`.

## Non-goals

- Skill authoring / discovery (where skills live on disk, how they're picked up) is a Pi SDK concern.
- Localizing slash commands — the current set is English-only per the repo's English-only rule.
- Fuzzy-match algorithm — the current filter is case-insensitive substring, deliberately simple.

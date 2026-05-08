# Workspace File Mentions

Status legend:

- `[x]` Done
- `[ ]` Not done
- `[~]` In progress

## Current Status

- [x] Product design agreed.
- [x] Implementation task tracker created.
- [x] Protocol changes implemented.
- [x] Workspace file index implemented.
- [x] Webview autocomplete implemented.
- [x] Prompt augmentation implemented.
- [x] Settings and project config implemented.
- [~] Tests/build verification completed.
- [x] Keyboard navigation fix: active file suggestion now scrolls into view and handled keys stop propagation while the menu is open.
- [x] Input highlighting improvement: file mention tokens are rendered in blue inside the chat input.

## Final Design

Workspace file mentions let the user quickly reference files from the currently opened VS Code workspace by typing `@` in the chat input.

This feature is intentionally **not** a file attachment system. It does not read, upload, inline, or attach file contents. Real file attachments will be implemented later through the existing attachment button flow that already handles image attachments.

The purpose of file mentions is to make the user's intent explicit and give the agent a reliable path to inspect if needed.

### User Experience

- Typing `@` in the chat input opens a file suggestion menu above the input area.
- Suggestions are sourced from the currently opened workspace folder.
- The user can navigate suggestions with `ArrowUp` and `ArrowDown`.
- The user can select a suggestion with `Enter`, `Tab`, or mouse click.
- Selecting a file inserts a mention into the message text.
- File mention tokens are highlighted in blue inside the chat input so referenced files are easy to see before sending.
- Normal paths are inserted as:

```text
@src/webview/main.ts
```

- Paths containing spaces are inserted with braces:

```text
@{docs/architecture notes.md}
```

- Queued messages remain plain strings. If a queued message contains file mentions, the same prompt augmentation is applied when it is eventually sent.
- Multi-root workspaces are not a target scenario. Pi Code assumes the user opens one project folder per VS Code window.

### Prompt Behavior

The original user message remains mostly unchanged. Before the message is sent to the agent, Pi Code appends a minimal list of referenced workspace files when valid mentions are present.

Example user input:

```text
Please inspect @src/controllers/chat-controller.ts and suggest where to add the search handler.
```

Example final prompt:

```text
Please inspect @src/controllers/chat-controller.ts and suggest where to add the search handler.

Referenced workspace files to inspect if needed:
- src/controllers/chat-controller.ts
```

The prompt augmentation must stay token-efficient. File contents are never inserted by this feature. The referenced file list tells the agent that these files are useful to read with file tools if needed.

Only mentions that resolve to known files in the workspace index should be added to the referenced file list. This avoids accidentally treating social handles, email-like text, or arbitrary `@word` tokens as file references.

### File Indexing Design

The feature uses a hybrid cache strategy:

1. Pi Code starts indexing workspace files in the background after the chat UI becomes available.
2. If the user types `@` before the background index is ready, the same index build is triggered lazily.
3. While indexing is in progress, the webview shows an indexing/loading item in the suggestion menu.
4. After indexing, searches are served from memory only.

The index is built with the VS Code API:

```ts
vscode.workspace.findFiles(include, exclude)
```

The index stores only path metadata. It must not read file contents and should avoid per-file `stat` calls.

Each indexed file entry should contain at least:

```ts
interface WorkspaceFileEntry {
    uri: vscode.Uri;
    relativePath: string;
    relativePathLower: string;
    basename: string;
    basenameLower: string;
}
```

### File Watcher

A workspace file watcher should keep the index fresh:

- Created files are added to the index.
- Deleted files are removed from the index.
- Changed files are ignored because contents are not indexed.
- Large bursts of create/delete events should trigger a debounced full rebuild instead of many individual mutations.

The index should also rebuild when relevant settings or project config values change.

### Excludes and Configuration

The extension ships with built-in default exclude patterns. Users can customize excludes both through VS Code settings and through a project config file.

Suggested built-in defaults:

```text
**/.git/**
**/node_modules/**
**/.next/**
**/.nuxt/**
**/dist/**
**/out/**
**/build/**
**/coverage/**
**/.vscode-test/**
**/*.map
**/.DS_Store
**/Thumbs.db
**/.env
**/.env.*
**/*.pem
**/*.key
**/id_rsa
**/id_ed25519
```

Suggested VS Code settings:

```json
{
  "pi-code.fileMentions.enabled": true,
  "pi-code.fileMentions.useDefaultExcludes": true,
  "pi-code.fileMentions.exclude": [],
  "pi-code.fileMentions.maxSuggestions": 30,
  "pi-code.fileMentions.configPath": ".pi/file-mentions.json"
}
```

Suggested project config file:

```json
{
  "useDefaultExcludes": true,
  "exclude": [
    "**/generated/**",
    "**/*.generated.ts",
    "**/fixtures/large/**"
  ],
  "maxSuggestions": 40
}
```

Effective config order:

1. Built-in defaults, when default excludes are enabled.
2. VS Code settings.
3. Project config file.

The project config may override `useDefaultExcludes` and `maxSuggestions`.

### Search Ranking

Search runs only against the in-memory index. The result limit comes from configuration.

Suggested ranking order:

1. Basename exact match.
2. Basename starts with query.
3. Basename contains query.
4. Relative path starts with query.
5. Relative path contains query.
6. Fuzzy character match.
7. Shorter paths rank higher when scores are otherwise similar.

### Webview Protocol

Suggested protocol additions:

```ts
export interface WorkspaceFileSuggestion {
    relativePath: string;
    basename: string;
    insertText: string;
}
```

Client to extension:

```ts
{ type: 'searchWorkspaceFiles'; query: string; requestId: number }
```

Extension to client:

```ts
{
    type: 'workspaceFileSuggestions';
    requestId: number;
    query: string;
    isIndexing?: boolean;
    items: WorkspaceFileSuggestion[];
}
```

The webview should ignore stale suggestion responses by comparing `requestId`.

## Implementation Tasks

### Shared Protocol

- [x] Add `WorkspaceFileSuggestion` to `src/shared/protocol.ts`.
- [x] Add `searchWorkspaceFiles` to `ClientMessage`.
- [x] Add `workspaceFileSuggestions` to `ServerMessage`.

### Workspace File Index

- [x] Add a workspace file mention/index module.
- [x] Define built-in exclude patterns.
- [x] Load VS Code settings for file mentions.
- [x] Load project config from `.pi/file-mentions.json` by default.
- [x] Merge built-in defaults, VS Code settings, and project config.
- [x] Build the initial index with `vscode.workspace.findFiles`.
- [x] Support lazy indexing on first search.
- [x] Support background warmup after chat startup.
- [x] Implement in-memory search and ranking.
- [x] Implement mention parsing for `@path` and `@{path with spaces}`.
- [x] Validate parsed mentions against the index.
- [x] Implement minimal prompt augmentation.
- [x] Add a file watcher for create/delete events.
- [x] Add debounced rebuild for large event bursts.
- [x] Rebuild on relevant settings/config changes.
- [x] Dispose watchers and listeners correctly.

### Chat Controller Integration

- [x] Instantiate and dispose the workspace file mention service.
- [x] Handle `searchWorkspaceFiles` messages.
- [x] Trigger background warmup when appropriate.
- [x] Apply prompt augmentation before `prompt` messages are sent.
- [x] Apply prompt augmentation before queued messages are sent after `agent_end`.
- [x] Keep `queuedMessages` as `string[]`.

### Webview UI

- [x] Add a dedicated file mention menu above the input area.
- [x] Detect the active `@` token near the cursor.
- [x] Support brace syntax for paths with spaces.
- [x] Debounce search requests.
- [x] Show indexing/loading state while the index is being built.
- [x] Render file suggestions.
- [x] Support keyboard navigation with `ArrowUp` and `ArrowDown`.
- [x] Support selection with `Enter`, `Tab`, and mouse click.
- [x] Support closing with `Escape`.
- [x] Avoid conflicts with the existing slash command menu.
- [x] Insert selected paths as `@relative/path ` or `@{relative/path with spaces} `.
- [x] Hide stale or irrelevant suggestion results.

### Settings

- [x] Add `pi-code.fileMentions.enabled` to `package.json` configuration.
- [x] Add `pi-code.fileMentions.useDefaultExcludes` to `package.json` configuration.
- [x] Add `pi-code.fileMentions.exclude` to `package.json` configuration.
- [x] Add `pi-code.fileMentions.maxSuggestions` to `package.json` configuration.
- [x] Add `pi-code.fileMentions.configPath` to `package.json` configuration.
- [x] Decide whether the dedicated settings webview should expose these settings now or later.

### Styling

- [x] Add CSS for the file mention menu.
- [x] Match existing webview theme variables.
- [x] Ensure the menu works in narrow sidebar and editor panel layouts.
- [x] Ensure active item styling is keyboard-visible.

### Validation and Testing

- [ ] Test single-root workspace behavior.
- [ ] Test repositories with tens of thousands of files.
- [ ] Test excludes from defaults.
- [ ] Test excludes from VS Code settings.
- [ ] Test excludes from `.pi/file-mentions.json`.
- [ ] Test paths with spaces.
- [ ] Test `@` mentions in queued messages.
- [ ] Test that contents are not read or inlined.
- [ ] Test that unknown `@word` values are not added to referenced files.
- [x] Run `npm run compile`.
- [ ] Add or update automated tests if practical.
- [x] Run `npm run test:unit`. Result: failed in existing model-registry/session expectations because the configured test model `ollama/local/Qwen3.6-27B-Coding` is unavailable and the runtime selected `gpt-5.5`; unrelated to file mentions.

### Documentation and Release Notes

- [x] Create this implementation tracker.
- [x] Update README or user-facing docs if needed. Decision: no README change in this implementation; the tracker documents the feature design and configuration.
- [x] Update `CHANGELOG.md` when implementation changes are made.

## Open Decisions

- [x] Whether lock files should be excluded by default. Decision: do not exclude lock files by default; they can be useful references and users can exclude them via settings or project config.
- [x] Whether file mention settings should appear in the custom settings page in the first implementation or only in VS Code settings. Decision: first implementation exposes them through VS Code settings and `.pi/file-mentions.json`; the dedicated settings page can be extended later.
- [x] Whether to add a command to manually rebuild the file mention index. Decision: not in the first implementation; the index rebuilds on settings/config changes and debounced create/delete bursts.

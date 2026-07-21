# slash-commands-and-skills-menu

## Stance

The slash menu is **client-side.** Detection, filtering, rendering, keyboard navigation — all in the chat webview. The extension host only supplies the skill list on request; it never sees the intermediate keystrokes. When the user commits a selection, the webview either (a) rewrites the input to include the resolved text (`/skill:name `) so the message dispatches naturally, or (b) fires a synthetic action (`newChat`, `openSettings`, `showModelPicker`) that skips the message pipeline entirely.

## Role

Data lives in [src/webview/main.ts](../../../../src/webview/main.ts):

- `SlashMenuItem` type [main.ts:108](../../../../src/webview/main.ts#L108):
  - `kind: 'builtin' | 'skill'`
  - `name`, `displayName`, `description`, `insertText`
  - `action?: 'openSettings' | 'newChat' | 'showModelPicker' | 'openKeybindings' | 'openChangelog'` — when set, selection triggers the action instead of inserting text.
- `BUILTIN_SLASH_COMMANDS` [main.ts:117](../../../../src/webview/main.ts#L117): `/compact`, `/name`, `/model`, `/new`, `/settings`, `/hotkeys`, `/changelog`. Each carries a description and either an `insertText` (for `/compact`, `/name`) or an `action` (for `/new`, `/settings`, `/model`, `/hotkeys`, `/changelog`).

Detection [main.ts:4754](../../../../src/webview/main.ts#L4754): a regex `/(^|\s)\/(\S*)$/` runs against the input text truncated to cursor position. On match, `updateSlashMenu()` filters `BUILTIN_SLASH_COMMANDS + skills.map(toItem)` by case-insensitive substring against `name`, `displayName`, `description`; resets `slashMenuIndex` to zero; renders.

Rendering [main.ts:4793](../../../../src/webview/main.ts#L4793): each item becomes a `.slash-item` div; `.slash-item-active` highlights the current index; a `mousedown` handler calls `selectSlashItem(index)`; `scrollActiveSlashItemIntoView()` keeps the active row visible.

Keyboard navigation [main.ts:4228](../../../../src/webview/main.ts#L4228): ArrowDown / ArrowUp adjust `slashMenuIndex` with wraparound; Enter (or Tab) calls `selectSlashItem`; Escape hides.

Selection [main.ts:4822](../../../../src/webview/main.ts#L4822): if the item has `action`, `runSlashAction(action)` posts the relevant client message (or executes VS Code command). Otherwise, replace the fragment from the last `/` to cursor with `item.insertText` (e.g., `/skill:my-skill `), keeping any pre-slash text intact.

Skill fetching: on connection init, the webview sends `getSkills`; the extension host responds with `{ type: 'skills', skills: SkillInfo[] }` [main.ts:307](../../../../src/webview/main.ts#L307), which stores in `state.skills`. Subsequent skill changes push new lists.

## Keywords

**Types — data:**
- `SlashMenuItem` — [main.ts:108](../../../../src/webview/main.ts#L108)
- `BUILTIN_SLASH_COMMANDS` — const [main.ts:117](../../../../src/webview/main.ts#L117)
- `SkillInfo` — from [Part II § message-protocol](../../02-shared-protocol-and-contracts/message-protocol/message-protocol.md)

**Methods — menu:**
- `updateSlashMenu()` — [main.ts:4754](../../../../src/webview/main.ts#L4754); detection + filter
- `renderSlashMenu()` — [main.ts:4793](../../../../src/webview/main.ts#L4793); DOM assembly
- `selectSlashItem(index)` — [main.ts:4822](../../../../src/webview/main.ts#L4822); commit
- `runSlashAction(action)` — synthetic actions (openSettings, newChat, showModelPicker, openKeybindings, openChangelog)
- `scrollActiveSlashItemIntoView()` — keeps highlight visible

**Methods — server exchange:**
- `getSkills` client message — [main.ts:5263](../../../../src/webview/main.ts#L5263); sent on init
- `skills` server message — [main.ts:307](../../../../src/webview/main.ts#L307); updates `state.skills`

**Attributes / markers:**
- Detection regex: `/(^|\s)\/(\S*)$/` — matches slash at input start or after whitespace
- CSS class: `.slash-item-active` for the highlighted row
- Insert-text convention: `/skill:<name> ` — trailing space so the user continues typing arguments immediately

**Namespaces:**
- [src/webview/main.ts](../../../../src/webview/main.ts) — the whole menu implementation lives here
- [src/webview/styles/main.css](../../../../src/webview/styles/main.css) — `.slash-menu`, `.slash-item`, `.slash-item-active`

## Lifecycle edges

**Depends on:**
- [webview-architecture](../webview-architecture/webview-architecture.md) — transport + DOM patterns.
- [chat-panel-provider](../chat-panel-provider/chat-panel-provider.md) — the slash menu only exists inside the chat panel.
- [Part III § chat-command-service](../../03-portable-chat-core/chat-command-service/chat-command-service.md) — `/name` and `/compact` are parsed there when the prompt actually dispatches.
## See also

- **Rule — the menu is a suggestion, not a router.** Selecting `/compact` inserts text; the extension host parses the eventual prompt. Adding a new slash command should either (a) provide an insertion string the command service already knows how to parse, or (b) map to a `runSlashAction` synthetic action.
- **Rule — regex first character matters.** `/(^|\s)\/(\S*)$/` matches only when `/` follows whitespace or start-of-input. Adding a colon-prefixed variant (e.g. `/skill:name/`) would require regex extension — plan carefully.
- **Pattern — actions bypass the message pipeline.** `newChat`, `openSettings`, `showModelPicker` fire VS Code commands or client messages directly. This keeps side-effects local instead of round-tripping through the extension host reducer.
- **Pattern — filter is substring, case-insensitive.** Simple, predictable, no fuzzy scoring. Users get a stable ordering; adding fuzzy match invites arguments about scoring rules.
- **Pitfall — the menu closes on Escape and on input blur.** If a new UI element (autocomplete, hover) grabs focus, it must not blur the input or the menu vanishes mid-selection.
- **Pitfall — `getSkills` returns after the first render.** The menu handles this gracefully (empty skill list until the response arrives), but new features that depend on skills being present at boot must arrange their own load ordering.
- **Pattern — insertText ends with a space.** After `/name My chat`, the user types more; the trailing space in `insertText: '/name '` keeps their next keystroke separate from the command token.

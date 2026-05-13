# ToDo

Backlog of items to revisit later — future tasks, investigations, and open questions. Not a roadmap; just things we want to keep in sight so they don't get lost.

Format:
- One section (`##`) per item, with a short title.
- Include **Status**, **Notes**, and (when we dig in) **Investigation** subsections.
- Delete an item once it's done or no longer relevant.

---

## Modes

**Status:** open
**Notes:** _Existing placeholder — clarify scope before investigating._
**Investigation:** _empty — to be filled when we dig in._

## Tool timeline rail trails past the last tool icon

**Status:** open — researched, ready to fix
**Notes:** In the chat, the vertical rail that connects tool icons sometimes extends below the last tool icon into empty space — as if pointing at a not-yet-rendered next icon. The rail should terminate at the last existing icon.

**Investigation:**

The rail was introduced in commit `47dbb3c` ("Add chat timeline rail connecting action icons"). It is purely CSS-driven in [src/webview/styles/main.css](src/webview/styles/main.css) — there is no JS layer for it.

There are **two stacked rails** drawn at `left: 24px; width: 2px`:

1. A parent rail on each `.message-group-assistant::before` (defined at [src/webview/styles/main.css:397-415](src/webview/styles/main.css#L397-L415)), spanning `top:0` → `bottom:0` of the assistant group.
2. A per-tool rail on each `.tool-card-wrapper::before` (defined at [src/webview/styles/main.css:996-1010](src/webview/styles/main.css#L996-L1010)), also `top:0` → `bottom:0` of the wrapper.

Tool icons sit at vertical center `y:15` and `z-index:1` with a `box-shadow: 0 0 0 4px var(--bg)` halo that punches the rail visually behind them.

Bottom-trim selectors at [src/webview/styles/main.css:1023-1033](src/webview/styles/main.css#L1023-L1033) shorten rails to `height: 15px` when:
- next sibling is a `.message-group-user`, OR
- the element is `:last-child` inside `#streaming-message`, OR
- next sibling is `#streaming-message:empty`.

**Root cause.** `#streaming-message` itself carries the class `message-group-assistant` (set in [src/webview/main.ts:493](src/webview/main.ts#L493): `el('div', 'streaming-message message-group-assistant')`), so its own `::before` draws a rail spanning the FULL streaming container — including the container's `padding-bottom: 8px` AND any `.preparing-placeholder` appended at the bottom by `showPreparingPlaceholder()` ([src/webview/main.ts:1910-1929](src/webview/main.ts#L1910-L1929)). That outer rail is never trimmed by any of the existing `:has(+ ...)` / `:last-child` selectors, so it extends below the last actual tool icon into empty space — exactly the "pointing at a not-yet-existing next icon" symptom.

Two compounding effects:
- The inner `.tool-card-wrapper:last-child::before` trim does fire, but only on the inner rail; the outer streaming rail keeps going.
- When `.preparing-placeholder` is the last child of `#streaming-message`, the last `.tool-card-wrapper` is no longer `:last-child`, so its inner rail also stops being trimmed.

**Proposed fix.**
1. Suppress the parent rail on `#streaming-message` itself: `#streaming-message::before { display: none; }` (or scope `.message-group-assistant::before` to not apply when the element is `#streaming-message`). The inner per-wrapper rails plus their trim selectors are sufficient.
2. Add a trim case for `.tool-card-wrapper:has(+ .preparing-placeholder)::before` and `.message-group-assistant:has(+ .preparing-placeholder)::before` so the last action's rail terminates at its icon when the only thing below it is the busy placeholder.
3. Sanity-check finalized turns: a text-only `.message-group-assistant` (no tool icon, no thinking icon) currently still draws a rail with nothing to anchor — consider suppressing the rail when the group contains no icon at all (`:not(:has(.tool-icon)):not(:has(.thinking-indicator))`).

**Files to touch:** [src/webview/styles/main.css](src/webview/styles/main.css) only — no TS changes expected.

**Verification:** F5 dev host, open a chat, watch the rail during a multi-tool turn (one tool → preparing → next tool), at end of turn, and for plain text-only assistant replies. Confirm rail starts/ends at icon centers in each case.

## "Agent busy, no tool yet" indicator doesn't match icon style

**Status:** open — researched, ready to fix
**Notes:** While the agent is working but has not yet invoked a specific tool, we render a blue spinning loader. It clashes with the surrounding tool-icon style. Replace it with a large dot in the same color as the tool icons, gently pulsing in blue.

**Investigation:**

The "busy, no tool yet" UI is the **preparing placeholder**, not the thinking indicator (which is a separate `.thinking-indicator` icon inside `<details class="thinking-block">`).

**Rendering side (TS).** `showPreparingPlaceholder()` at [src/webview/main.ts:1910-1929](src/webview/main.ts#L1910-L1929) appends:
```
<div class="preparing-placeholder" id="preparing-placeholder">
  <span class="preparing-spinner" aria-hidden="true"></span>
  <span class="preparing-label">Preparing next moves...</span>
</div>
```
into `#streaming-message`. It is gated by `ensurePreparingPlaceholder()` at [src/webview/main.ts:1931-1938](src/webview/main.ts#L1931-L1938), which only shows it when no `.tool-status.running` exists — exactly the "agent busy, no tool yet" state. Label switches to `Compacting...` when `state.isCompacting`. Removed by `removePreparingPlaceholder()` at [src/webview/main.ts:1906-1908](src/webview/main.ts#L1906-L1908) once streaming text or a tool arrives.

**Styles to replace** ([src/webview/styles/main.css:1182-1222](src/webview/styles/main.css#L1182-L1222)):
- `.preparing-spinner` — 12×12 circular border with blue top, rotated by `@keyframes preparing-spin` (0.8s linear infinite). This is the offending blue spinner.
- `.preparing-label` — pulses opacity 0.6↔1 via `@keyframes preparing-pulse` (2s ease-in-out). Keep.

**Proposed fix.**
1. Drop the rotating-border spinner. Replace `.preparing-spinner` with a solid filled circle (`background: var(--icon-color, var(--fg))`, `border-radius: 50%`, no border) sized to roughly match tool icons. Tool icons are 18×18 (`.tool-icon-img` / `.action-card-icon`). Use ~14–16 px so the dot reads as an icon-class element, not a tiny status dot.
2. Animate by pulsing color toward blue. Two viable options:
   - `box-shadow: 0 0 0 3px <blue-glow>` pulsing in/out, keeping the fill in icon color.
   - `background` animated between icon color and a blue accent (e.g., `var(--btn-bg)` which is what the current spinner uses for its top edge).
   Keep `@keyframes preparing-pulse` cadence (2s ease-in-out) so dot pulse and label fade feel unified — possibly merge into a single keyframe targeting the whole `.preparing-placeholder`.
3. Make sure the dot sits at `left: 24px` so it lines up with the tool-icon rail (the placeholder sits inside `#streaming-message` and currently has `padding: 12px 16px` — center of a 16-px-wide dot at `padding-left: 16px` does NOT land on `x:24`). After the rail fix above, the dot should slot onto the rail like a real tool icon. Easiest: give `.preparing-placeholder` `padding-left: 16px` and `.preparing-spinner` `margin-left: 0` with a `width:18px` so its center hits `x:24` (16 + 18/2 = 25 — close enough, fine-tune by eye). Equally clean: copy the `.tool-icon` rules (16-wide center column, `box-shadow: 0 0 0 4px var(--bg)` to mask the rail behind it, `z-index: 1`).
4. While at it, decide whether the dot itself should erase the rail behind it the way tool icons do (`box-shadow` halo). Visually consistent with tools; keep it.

**Reference colors.** Tool icons render via `<img class="tool-icon-img">` with `opacity` around 0.7 — there isn't a CSS variable for "icon color"; they're pre-tinted PNGs. For the dot, `var(--fg)` (or `var(--muted)` at full opacity) is the closest match to the visual weight of a tool icon at rest; pulse toward `var(--btn-bg)` (current blue accent) for the active state.

**Files to touch:** [src/webview/styles/main.css](src/webview/styles/main.css) (replace `.preparing-spinner` rules + keyframes). No TS changes needed unless we rename the class — the existing markup is fine.

**Verification:** F5 dev host, send a prompt with thinking enabled, watch the placeholder appear before the first tool. Trigger context compaction (or send a very long context) to verify the `Compacting...` variant. Confirm the dot lines up with the rail and pulses in blue.

## Caret and inserted-character position diverge after `@` file mention (windowed mode)

**Status:** open — researched, ready to fix
**Notes:** When the VS Code window is not maximized and the user types an `@` file reference in the prompt input, the caret position and the actual insertion point drift apart: the caret shows one column, but typed characters land a few columns to the right of it. Likely related to the `@`-mention overlay/measurement. Reproduces in windowed (non-maximized) mode.

**Investigation:**

The prompt input uses a **transparent-textarea-over-highlight-layer** pattern:

- `<textarea id="input">` at [src/webview/main.ts:525](src/webview/main.ts#L525) has `color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--input-fg)` ([src/webview/styles/main.css:1342-1360](src/webview/styles/main.css#L1342-L1360)). Only the caret is visible from the textarea.
- Behind it sits `<div id="input-highlight" class="input-highlight" aria-hidden="true">` which renders the visible text with `<span class="input-file-mention">…</span>` wrappers around `@…` tokens. Built by `renderInputHighlightHtml()` at [src/webview/main.ts:3657-3673](src/webview/main.ts#L3657-L3673) and refreshed on every input via `updateInputHighlights()` at [src/webview/main.ts:3641-3648](src/webview/main.ts#L3641-L3648). Scroll is synced by `syncInputHighlightScroll()` at [src/webview/main.ts:3650-3655](src/webview/main.ts#L3650-L3655).

For the caret (positioned by the textarea using its own glyph metrics) to align with the visible glyphs (rendered by the highlight div), the two layers MUST lay out characters identically.

**Two mismatches in the current CSS** ([src/webview/styles/main.css:1322-1366](src/webview/styles/main.css#L1322-L1366)):

1. **Different wrap behavior.** `.input-highlight` has `overflow-wrap: anywhere` ([line 1333](src/webview/styles/main.css#L1333)). `#input` (textarea) has no `overflow-wrap`/`word-break` set, so it uses the browser default (`overflow-wrap: normal`, i.e. break only at whitespace). A long unbreakable token like `@src/very/long/path/file.ts` wraps mid-token in the highlight layer but stays on a single line that overflows in the textarea — or vice versa. Past the wrap-point divergence the caret position drifts by exactly the size of the disagreement. This is **the primary cause** and explains the "only in windowed mode" repro: maximized window is wide enough that lines don't wrap, so the mismatch never bites; narrow the window and any long mention immediately wraps differently in the two layers.

2. **Different font-weight for mention spans.** `.input-file-mention { color: var(--link); font-weight: 500; }` ([src/webview/styles/main.css:1337-1340](src/webview/styles/main.css#L1337-L1340)). The textarea renders all characters at the inherited normal weight; the highlight renders mention characters at weight 500. Different weight → slightly different glyph widths → caret and visible glyph drift "a few characters to the right" as the user described. Secondary cause; would still be visible even on a single line.

**Proposed fix.**
1. Mirror wrap rules between the two layers. Either:
   - Add `overflow-wrap: normal; word-break: normal` to `.input-highlight` (matches textarea default — long paths overflow horizontally; the textarea scrolls and `syncInputHighlightScroll` keeps the highlight in sync).
   - OR add `overflow-wrap: anywhere` to `#input` (matches highlight — long paths wrap inside the token).
   The second option is friendlier for narrow windows; pick that one.
2. Remove `font-weight: 500` from `.input-file-mention`. Convey the mention chip via `color`, `background`, `border-radius`, or `text-decoration` — anything that does NOT change glyph metrics. A subtle `background: rgba(<link>, 0.15)` with `border-radius: 3px` and a slightly muted color would read as a chip without affecting widths.
3. As a belt-and-braces check, audit every other CSS property between `#input` and `.input-highlight` that affects glyph layout: `font-family`, `font-size`, `font-weight`, `font-style`, `letter-spacing`, `word-spacing`, `tab-size`, `line-height`, `padding`, `border`, `box-sizing`, `white-space`. All must match exactly. The current rules already match for most of these; the two listed above are the divergences.

**Files to touch:** [src/webview/styles/main.css](src/webview/styles/main.css) only (~3-4 lines changed). No TS changes needed — `renderInputHighlightHtml()` is correct as long as the span is metric-neutral.

**Verification:**
- F5 dev host, undock the chat into a narrow window (or just narrow the sidebar).
- Type `@src/webview/styles/main.css` and continue typing. Caret should sit at the same visual column as the last typed character on every line, including after the mention wraps.
- Try a single-line case too: `Look at @package.json and tell me about it` — caret should be exactly under the next character. Without the font-weight fix, the drift after the mention is ~1-2 px per character; with it, zero.
- Test the soft-wrap case: extremely long single-token mention near the right edge; confirm wrap point matches in both layers.

## Audit settings page for dead options inherited from the upstream fork

**Status:** open
**Notes:** The settings page exposes a number of options that look suspicious — likely leftovers from the implementation we forked from, never wired up to anything on our side. Need to walk through every setting in the settings UI and the `contributes.configuration` block, check whether it's actually read anywhere (extension host + webview + Pi SDK bridge), and either delete or document each one. Removing dead settings cleans up the UI and avoids users twiddling switches that do nothing.
**Investigation:** _empty — to be filled when we dig in._

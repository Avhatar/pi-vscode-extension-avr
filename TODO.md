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

## Audit settings page for dead options inherited from the upstream fork

**Status:** open
**Notes:** The settings page exposes a number of options that look suspicious — likely leftovers from the implementation we forked from, never wired up to anything on our side. Need to walk through every setting in the settings UI and the `contributes.configuration` block, check whether it's actually read anywhere (extension host + webview + Pi SDK bridge), and either delete or document each one. Removing dead settings cleans up the UI and avoids users twiddling switches that do nothing.
**Investigation:** _empty — to be filled when we dig in._

## Turn duration sometimes missing at the end of a turn

**Status:** open
**Notes:** In some situations the elapsed time for a turn is not shown when the turn ends — usually it appears in the footer/stats area at the bottom of the assistant turn, but occasionally it's absent. Need to figure out which code paths fail to stamp/render the duration: candidates to check include early-aborted turns (cancel button, stream errors), turns ending via Plan Mode `<plan-complete/>`, turns ending right after tool-approval rejection, compaction turns, and resumed/replayed turns loaded from a checkpoint. Turn durations were added in commit `ca560b9` ("Add turn durations; update ToDo sidebar markers") — that's the place to start.
**Investigation:** _empty — to be filled when we dig in._

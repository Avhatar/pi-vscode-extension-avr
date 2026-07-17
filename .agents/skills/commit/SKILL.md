---
name: commit
description: Inspect all uncommitted changes (modified + untracked), decide on commit grouping, verify CHANGELOG and version, draft a concise commit message in the project's existing style, iterate with the user until approved, then commit. Use when the user asks to commit, write a commit message, finalize changes, create a commit, or wrap up work.
---

# Commit — Pi Code VS Code Extension

Run this skill when the user wants to turn the current uncommitted state into
one or more git commits.

**This skill is context-blind.** Ignore what was discussed earlier in the
chat. Every invocation must re-inspect the full working-tree state from
scratch and consider *every* uncommitted change — both modified/staged files
and untracked files. Do not assume that files mentioned in the conversation
are the only ones in scope, and do not assume that files *not* mentioned are
out of scope. The git working tree is the authoritative input; the chat
history is not.

## Workflow

### 1. Inspect the working tree

Run in parallel:
- `git status` — capture both modified and untracked entries
- `git diff --stat` — modified files
- `git diff` for the substantive modified files (skip large lock files)
- For each untracked file: read it (or, for binaries, note the path and size)
  so you can describe what it is
- `git log --oneline -10` to learn the project's commit-message style

You must end this step with a complete mental list of every uncommitted
path, modified or untracked, and a one-line understanding of what each
contains.

### 2. Decide on grouping

Look at all the changes (modified + untracked) and judge whether they belong
in:

- **One commit** — changes are part of a single coherent feature/fix, or are
  small enough that splitting would be churn.
- **Multiple commits** — changes touch unrelated areas (e.g. a feature + an
  unrelated bug fix + tooling tweaks), each large enough to stand alone.

Default to one commit unless the split is obvious. If you propose splitting,
explain the proposed groups to the user before staging.

For untracked files, propose for each one whether it should be:
- Included in a commit (and which one), or
- Left untracked (e.g. local-only notes, generated artefacts, machine-
  specific files), or
- Added to `.gitignore`.

Present this proposal to the user as part of the draft (step 5) so they can
override before anything is staged.

**Never commit** files that look like secrets (`.env`, `*.key`,
`credentials.*`, `*.pem`, anything containing API tokens). If such files
appear in the working tree, flag them prominently and refuse to include
them even if the user asks — confirm twice first.

### 3. Verify CHANGELOG and version

If the change is user-visible (new feature, fixed bug, changed behavior):

- Open `CHANGELOG.md`. Confirm every user-visible change in the diff has an
  entry under `## [Unreleased]` or under the most recently stamped version.
- If entries are missing, tell the user what's missing and ask whether to add
  them before committing.
- If `package.json` version was bumped in the diff, confirm the matching
  `[x.y.z] - YYYY-MM-DD` section exists in CHANGELOG.md.
- If the user says they're about to deploy, remind them that
  `npm run deploy:patch|minor|major` will refuse to run with an empty
  `[Unreleased]`.

Skip this step for purely internal changes (refactors with no behavior
change, tooling-only edits, doc tweaks) — but mention you skipped it.

### 4. Draft the commit message

Match the existing style. Inspect `git log --oneline -10` first — for this
repo the conventions are:

- **Imperative present** — "Add", "Fix", "Persist", "Bump", "Forward".
- **Single-line subject**, typically under 72 characters.
- Multiple related changes joined with `;` ("Fix X; add Y").
- Sometimes a `:` to expand the headline ("Fix VSIX packaging: include
  hoisted deps and webview styles").
- **No body** for most commits. Only add a body when the subject genuinely
  cannot fit the change (e.g. a major release combining several features).
- **No trailers**: never `Co-Authored-By: Claude`, never
  `Generated with Claude Code`, never any AI attribution. This is a strict
  rule — commits must look human-authored.

Keep it lean. Skip details a reader can see in the diff. Focus on the *what*
and, if non-obvious, the *why*.

### 5. Show and iterate

Present the draft to the user inside a fenced block and ask whether it is
ready to commit. If they push back, propose another variant (shorter, longer,
different framing) and ask again. Repeat until they approve.

Do **not** stage or commit before approval.

### 6. Commit

After explicit approval:

1. Stage only the files that belong in this commit. Prefer naming files
   explicitly over `git add -A` / `git add .` to avoid sweeping in untracked
   noise.
2. Run `git commit -m "<approved subject>"`. For multi-line messages, pipe
   the body via a single-quoted heredoc so PowerShell does not interpolate.
3. Run `git log -1 --format=fuller` and confirm the author line is the user
   (not Claude) and there is no AI-attribution trailer.
4. Report the short SHA and a one-line confirmation.

If the user requested multiple commits, repeat steps 5–6 for each group.

## Hard rules

- **Never** include `Co-Authored-By: Claude ...` or any AI attribution.
- **Never** use `--no-verify` to bypass hooks. If a hook fails, fix the
  underlying issue and create a fresh commit (do not amend a failed commit).
- **Never** amend or force-push without explicit user instruction.
- **Never** commit before the user approves the message.
- **Never** push to remote unless the user explicitly asks.

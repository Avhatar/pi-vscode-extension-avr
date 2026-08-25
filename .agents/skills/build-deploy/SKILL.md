---
name: build-deploy
description: >-
  Build, package, and install the Pi Code VS Code extension locally.
  Always build and install on request, even when there are no local changes.
  Includes versioning: bump version only when there are changes since the previous build;
  otherwise rebuild and install the current version without changing it.
  A standalone '-' in the request means a test deploy: build and install only, with no
  version bump, changelog handling, or release bookkeeping.
  Owns both changelogs: the per-build CHANGELOG.md, and the user-facing RELEASES.md,
  whose top entry the bump rolls forward and whose bullets are written as the builds
  happen. Which version users actually received lives in release-state.json and is
  recorded only when the user says so, via npm run mark-released.
  Use when: user asks to build, compile, deploy, package, install, update the extension,
  create a VSIX, apply code changes, bump version, release, publish, states that a
  specific build goes to users, asks to write or update release notes or patch notes,
  or asks what changed since the version users are running.
  Triggers: build, deploy, package, install, vsix, compile, ship, release, publish,
  update extension, bump version, version, changelog, release notes, patch notes.
---

# Build & Deploy — Pi Code VS Code Extension

## Versioning & Changelog

The project uses [Semantic Versioning](https://semver.org/) and maintains
`CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/) format.

### Workflow for the agent

When the user asks to build, package, deploy, install, update the extension, or get a fresh VSIX:

### Test deploy shortcut

If the build/deploy request includes a standalone `-` sign (for example `build-deploy -`,
`deploy -`, or `build -`), treat it as an explicit test-build request:

- Run plain `npm run deploy` only.
- Do not check whether a version bump is needed.
- Do not edit, validate, or require `CHANGELOG.md`.
- Do not touch `RELEASES.md`. A test build is not a release and must not appear
  in the user-facing notes. `npm run package` still verifies the file, but that
  check only reads it.
- Do not run `npm run deploy:patch`, `npm run deploy:minor`, or `npm run deploy:major`.
- Ignore unreleased local changes for versioning purposes; the user wants to package and
  install the current `package.json` version exactly as-is for manual testing.

For all other build/deploy requests:

1. **Always build and install. Do not refuse or ask whether to proceed just because there
   are no local changes.** The requested outcome is a current VSIX installed into VS Code.
2. **Check whether a version bump is needed:**
   - If there are no changes compared with the previous build/release, or the user only
     wants to reinstall the already-versioned build, run plain `npm run deploy`.
   - If there are local code/product changes that have not been released yet, document them
     in `CHANGELOG.md`, choose the appropriate bump type, and run the matching deploy script.
3. **Every time you make code changes**, before deploying with a version bump:
   - Add entries to `CHANGELOG.md` under `## [Unreleased]` using the appropriate
     subsections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
   - Choose the bump type based on what changed:
     - **patch** (`0.1.1` → `0.1.2`) — bug fixes, small tweaks, no new features
     - **minor** (`0.1.2` → `0.2.0`) — new features, backward-compatible
     - **major** (`0.2.0` → `1.0.0`) — breaking changes
   - Deploy with version bump:
     ```bash
     npm run deploy:patch   # or deploy:minor / deploy:major
     ```
4. **Write the user-facing bullets for what you just changed** into the top
   `RELEASES.md` entry, which the bump has already retitled to the new version.
   Assume the build stays local — almost all of them do — and never record a
   handout on your own initiative. Recording one is `npm run mark-released`,
   run only when the user says that version went out. See the section below.

Plain deploy without a bump:
```bash
npm run deploy
```

Versioned deploy commands will:
- Validate that `[Unreleased]` in CHANGELOG.md has content (fails if empty)
- Bump version in `package.json`
- Stamp `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` in CHANGELOG.md
- Add a fresh empty `[Unreleased]` section on top
- Retitle the top `RELEASES.md` entry to the new version and today's date, or
  open a fresh entry above it if the top one is the published version
- Sync `package-lock.json`
- Compile, prune, verify, package VSIX, restore deps, install into VS Code

Plain `npm run deploy` will:
- Compile the extension
- Prune dev dependencies
- Package the current `package.json` version into a VSIX
- Restore dev dependencies
- Install that VSIX into VS Code with `--force`

### CHANGELOG.md format

```markdown
## [Unreleased]

### Added
- New feature description

### Fixed
- Bug fix description

## [0.1.2] - 2026-05-07

### Fixed
- Previous release notes...
```

**Rules for the agent:**
- Write entries from the user's perspective, not implementation details
- Each entry is one line starting with `- `
- Group by type: Added, Changed, Deprecated, Removed, Fixed, Security
- If `[Unreleased]` is empty, the bump script will refuse to run — you must
  document your changes first

### RELEASES.md — the user-facing notes

`CHANGELOG.md` is the per-build history for contributors and is excluded from
the VSIX. `RELEASES.md` is the user-facing history; `npm run package` ships it
as the VSIX's `changelog.md` via `vsce --changelog-path`, which is what the
Marketplace Changelog tab and the in-chat `/changelog` command show.

**How the file is shaped.** Newest entry on top. Each entry consolidates
everything that arrived since the entry directly below it, so a user reads
exactly one entry — the one for the version they are upgrading to. Versions
that were only ever built locally never get an entry of their own; their
changes are folded into the entry above them and their numbers are not
mentioned.

**The top entry is the newest build, not a release.** It accumulates: the bump
retitles it to the version just built and its bullets keep growing build after
build, until the maintainer hands that build out. A top entry naming a version
nobody received is therefore correct and must be extended, never deleted.

**The handout is recorded separately, in `release-state.json`.**
`lastPublishedVersion` is the only place that knows what users actually have.
Read it instead of asking; do not infer a handout from git tags, from the
`.vsix` files lying in the repo root, from `CHANGELOG.md`, or from a commit
message that happens to say "release".

**Every build with user-visible changes owes bullets, in the same work.** The
bump has already retitled the top entry and rewritten its
*"Everything new since X."* line from the marker; what it cannot do is decide
what a user can observe. So after the bump:

1. Take every `CHANGELOG.md` section added since the previous published
   version that is not represented in the entry yet — usually just the one you
   stamped, since the earlier ones were folded in as they happened.
2. Merge them into the entry's existing themed bullets, grouped as `Added` /
   `Changed` / `Fixed` / `Security`. One theme per bullet, not one build per
   bullet: extend the bullet that already covers the area instead of appending
   a near-duplicate.
3. Drop anything a user cannot observe: refactors, port extractions, internal
   diagnostics, packaging plumbing, test coverage, and work on the private
   standalone app, which is not part of this extension at all.

**Recording a handout.** The trigger is the user saying so — *"we're giving
users 0.72.0"*, *"publish this one"*, *"this build goes out"* — and nothing
else. Then, without being asked twice:

1. `npm run mark-released -- <version>`. It refuses any version that is not the
   newest entry, and refuses an entry still holding its placeholder or with no
   bullets.
2. Make sure that entry actually reads as the whole story since the previous
   published version.
3. Rebuild, because the notes ship *inside* the package and cannot be added to
   an existing VSIX; then verify the packaged `changelog.md`.
4. Report. Do not hand the release notes back as a follow-up task.

Ask only what the repository cannot answer: which artefact, if the named
version is not `package.json`'s; whether to rebuild, when tree and VSIX
disagree; and what was last published, only if `release-state.json` records
nothing yet.

**Rules.**

- Never record a handout on your own initiative, and never delete an entry to
  "correct" the file — an unpublished top entry is the accumulator working as
  designed.
- `npm run package` runs `verify:release-notes`. It fails when the top entry's
  version does not match `package.json`, when an entry's since-line does not
  name the entry below it, or when `release-state.json` points at a version
  with no entry. A placeholder or an empty entry is only a warning, because the
  check cannot tell a local build from a release.
- If it is genuinely unclear whether the build is going to users, that is the
  one thing worth asking about.

### Version-only bump (no deploy)

```bash
npm run version:patch    # or version:minor / version:major
```

### Deploy without version bump

Use plain `npm run deploy` when there are no changes compared with the previous build,
when version was already bumped, or for any re-deploy/reinstall request. This still
builds, packages, and installs the extension.

## Pipeline Steps (manual)

Run from the project root.

### 1. Compile

```bash
npm run compile
```

Runs `esbuild.js` producing the extension-host bundle and three browser webview bundles:

| Target | Entry | Output | Environment |
|--------|-------|--------|-------------|
| Extension host | `src/extension.ts` | `out/extension.js` | Node.js, CJS |
| Webview chat UI | `src/webview/main.ts` | `out/webview/main.js` | Browser, IIFE |
| Webview settings | `src/webview/settings.ts` | `out/webview/settings.js` | Browser, IIFE |
| Webview launcher | `src/webview/launcher.ts` | `out/webview/launcher.js` | Browser, IIFE |

Pi SDK packages are **externalized** — not bundled, resolved at runtime by VS Code.

### 2. Prune dev dependencies

```bash
npm prune --omit=dev
```

**Required** because `vsce` packages everything in `node_modules/`.
Pruning guarantees the VSIX contains only the runtime tree. With the current
bundled SDK, provider integrations, web tooling, and native helper binaries,
the compressed VSIX is roughly 90 MB; dependency updates can change this.

**Do NOT** add `node_modules/**` to `.vscodeignore` with selective `!` exceptions —
that strips hoisted transitive deps and breaks activation.

Pi SDK 0.82.1 shrinkwraps vulnerable `brace-expansion` 5.0.7. The root pins 5.0.9,
and the install-time repair removes the nested copy so Pi resolves the safe root package.
Because `npm prune` restores the shrinkwrapped copy, `npm run package` starts by repairing
again and then runs `verify:runtime-dependencies`; it must fail if the resulting physical
resolution is unsafe. Until upstream updates its shrinkwrap, `npm audit` may still report
the removed nested copy from lock metadata; inspect the verifier result and packaged tree.

### 3. Package into VSIX

```bash
npm run package
```

Produces `pi-code-<version>.vsix` in the project root.

### 4. Restore dev dependencies

```bash
npm install
```

The root `postinstall` reruns `repair:runtime-dependencies`, keeping the restored
development tree on the same safe runtime resolution as the packaged tree.

### 5. Install into VS Code

```bash
code --install-extension pi-code-<version>.vsix --force
```

### 6. Reload VS Code

`Ctrl+Shift+P` → **Developer: Reload Window**

## Marketplace publication and GitHub release

Local `deploy:*` commands never publish to the Marketplace. After the installed-VSIX
smoke test passes, publish only on an explicit user request with maintainer credentials:

```bash
npx @vscode/vsce publish --packagePath pi-code-<version>.vsix
```

Publishing is the moment a version becomes real for users, so the VSIX being
published must already carry its `RELEASES.md` entry — it ships inside the
package as the Changelog tab and cannot be added afterwards without repackaging.
Write the entry and rebuild before publishing, never after.

Then verify `Avhatar.pi-code` reports the intended version through the Marketplace page
or Gallery API. GitHub Releases are created separately by pushing a matching `v<version>`
tag; CI rejects a tag whose version does not match `package.json`. Do not publish, tag,
or push merely because a local deploy completed.

## Development mode (F5)

Press **F5** for Extension Development Host. Uses `out/` directly — no VSIX needed.

**Caveat:** Dev host resolves the full `node_modules` tree and will **hide
packaging bugs**. Always verify with `npm run deploy` before considering done.

Watch mode for auto-recompilation:

```bash
npm run watch
```

## npm scripts reference

| Script | What it does |
|--------|-------------|
| `npm run compile` | esbuild: TS → JS |
| `npm run watch` | esbuild in watch mode |
| `npm run repair:runtime-dependencies` | Remove the vulnerable shrinkwrapped `brace-expansion` copy so Pi resolves root 5.0.9 |
| `npm run verify:runtime-dependencies` | Fail unless Pi physically resolves a patched `brace-expansion` version |
| `npm run verify:release-notes` | Fail unless `RELEASES.md` agrees with `package.json` and `release-state.json` |
| `npm run mark-released -- <version>` | Record that this version was handed to users (maintainer's word only) |
| `npm run deploy` | compile → prune → package → install (no version bump) |
| `npm run deploy:patch` | bump patch + deploy |
| `npm run deploy:minor` | bump minor + deploy |
| `npm run deploy:major` | bump major + deploy |
| `npm run version:patch` | bump patch only (no deploy) |
| `npm run version:minor` | bump minor only |
| `npm run version:major` | bump major only |
| `npm run test:unit` | vitest unit tests |
| `npm run test:all` | unit + integration tests |

## Verification checklist

After deploy + window reload:

1. Extension activates without errors (check Output → Pi Code channel)
2. Sidebar opens and shows the chat UI
3. Tabs work (create, switch, close)
4. Settings page opens
5. Agent responds to a prompt
6. `package.json` version matches the VSIX filename
7. CHANGELOG.md has stamped version with today's date
8. The top `RELEASES.md` entry names the version just built and carries this
   build's user-visible changes
9. For a build going to users: `release-state.json` names that version, and
   `unzip -p pi-code-<version>.vsix extension/changelog.md | head` shows the
   release notes rather than the per-build history

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[Unreleased] section is empty` | No changelog entries | Add changes to CHANGELOG.md under `[Unreleased]` |
| `Cannot find package 'proper-lockfile'` | `node_modules` was selectively excluded from the VSIX or the production install is incomplete | Keep `node_modules` unfiltered, run `npm install`, then use `npm run deploy` |
| Code changes not visible | Old VSIX installed | `npm run deploy`, then Reload Window |
| VSIX is materially larger than the previous release or contains test/build packages | Dev dependencies were not pruned, or a runtime dependency grew | Run `npm prune --omit=dev`, inspect `npx @vscode/vsce ls`, then package again |
| Extension works in F5 but not installed | Packaging bug | Always test with real VSIX install |

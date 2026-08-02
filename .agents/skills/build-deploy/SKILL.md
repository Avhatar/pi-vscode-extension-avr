---
name: build-deploy
description: >-
  Build, package, and install the Pi Code VS Code extension locally.
  Always build and install on request, even when there are no local changes.
  Includes versioning: bump version only when there are changes since the previous build;
  otherwise rebuild and install the current version without changing it.
  A standalone '-' in the request means a test deploy: build and install only, with no
  version bump, changelog handling, or release bookkeeping.
  Use when: user asks to build, compile, deploy, package, install, update the extension,
  create a VSIX, apply code changes, bump version, or release.
  Triggers: build, deploy, package, install, vsix, compile, ship, release, update extension,
  bump version, version, changelog.
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

Plain deploy without a bump:
```bash
npm run deploy
```

Versioned deploy commands will:
- Validate that `[Unreleased]` in CHANGELOG.md has content (fails if empty)
- Bump version in `package.json`
- Stamp `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` in CHANGELOG.md
- Add a fresh empty `[Unreleased]` section on top
- Sync `package-lock.json`
- Compile, prune, package VSIX, restore deps, install into VS Code

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
the compressed VSIX is roughly 120 MB; dependency updates can change this.

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

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[Unreleased] section is empty` | No changelog entries | Add changes to CHANGELOG.md under `[Unreleased]` |
| `Cannot find package 'proper-lockfile'` | `node_modules` was selectively excluded from the VSIX or the production install is incomplete | Keep `node_modules` unfiltered, run `npm install`, then use `npm run deploy` |
| Code changes not visible | Old VSIX installed | `npm run deploy`, then Reload Window |
| VSIX is materially larger than the previous release or contains test/build packages | Dev dependencies were not pruned, or a runtime dependency grew | Run `npm prune --omit=dev`, inspect `npx @vscode/vsce ls`, then package again |
| Extension works in F5 but not installed | Packaging bug | Always test with real VSIX install |

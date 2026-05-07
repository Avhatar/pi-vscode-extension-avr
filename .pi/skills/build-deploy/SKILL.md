---
name: build-deploy
description: >-
  Build, package, and install the Pi Agent VS Code extension locally.
  Includes versioning: bump version, maintain CHANGELOG.md, deploy with auto-increment.
  Use when: user asks to build, compile, deploy, package, install, update the extension,
  create a VSIX, apply code changes, bump version, or release.
  Triggers: build, deploy, package, install, vsix, compile, ship, release, update extension,
  bump version, version, changelog.
---

# Build & Deploy — Pi Agent VS Code Extension

## Versioning & Changelog

The project uses [Semantic Versioning](https://semver.org/) and maintains
`CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/) format.

### Workflow for the agent

**Every time you make code changes**, before deploying:

1. **Add entries to `CHANGELOG.md`** under `## [Unreleased]` using the appropriate
   subsections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
2. **Choose the bump type** based on what changed:
   - **patch** (`0.1.1` → `0.1.2`) — bug fixes, small tweaks, no new features
   - **minor** (`0.1.2` → `0.2.0`) — new features, backward-compatible
   - **major** (`0.2.0` → `1.0.0`) — breaking changes
3. **Deploy with version bump:**
   ```bash
   npm run deploy:patch   # or deploy:minor / deploy:major
   ```

This single command will:
- Validate that `[Unreleased]` in CHANGELOG.md has content (fails if empty)
- Bump version in `package.json`
- Stamp `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` in CHANGELOG.md
- Add a fresh empty `[Unreleased]` section on top
- Sync `package-lock.json`
- Compile, prune, package VSIX, restore deps, install into VS Code

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

Use plain `npm run deploy` if version was already bumped, or for re-deploys.

## Pipeline Steps (manual)

Run from the project root.

### 1. Compile

```bash
npm run compile
```

Runs `esbuild.js` producing two bundle targets:

| Target | Entry | Output | Environment |
|--------|-------|--------|-------------|
| Extension host | `src/extension.ts` | `out/extension.js` | Node.js, CJS |
| Webview chat UI | `src/webview/main.ts` | `out/webview/main.js` | Browser, IIFE |
| Webview settings | `src/webview/settings.ts` | `out/webview/settings.js` | Browser, IIFE |

Pi SDK packages are **externalized** — not bundled, resolved at runtime by VS Code.

### 2. Prune dev dependencies

```bash
npm prune --omit=dev
```

**Required** because `vsce` packages everything in `node_modules/`.
Pruning guarantees the VSIX contains only the runtime tree (~40 MB).

**Do NOT** add `node_modules/**` to `.vscodeignore` with selective `!` exceptions —
that strips hoisted transitive deps and breaks activation.

### 3. Package into VSIX

```bash
npm run package
```

Produces `pi-agent-<version>.vsix` in the project root.

### 4. Restore dev dependencies

```bash
npm install
```

### 5. Install into VS Code

```bash
code --install-extension pi-agent-<version>.vsix --force
```

### 6. Reload VS Code

`Ctrl+Shift+P` → **Developer: Reload Window**

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

1. Extension activates without errors (check Output → Pi Agent channel)
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
| `Cannot find package 'proper-lockfile'` | VSIX built without prune | Use `npm run deploy` |
| Code changes not visible | Old VSIX installed | `npm run deploy`, then Reload Window |
| VSIX is ~130 MB | Packaged with devDependencies | `npm prune --omit=dev` before package |
| Extension works in F5 but not installed | Packaging bug | Always test with real VSIX install |

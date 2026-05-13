# AGENTS.md

## Project Overview

Pi Code is a VS Code extension providing editor-tab chat panels (with an activity-bar launcher sidebar) for the Pi coding agent SDK (`@mariozechner/pi-coding-agent`). It supports multi-tab sessions, inline diffs, checkpoints/rollback, a dedicated settings page, message queuing during streaming, mid-stream steering, slash-command skills, per-chat ToDo, Plan Mode, and opt-in LSP tools.

## Language

**English only.** Every artefact that lives in the repository must be written in English: source code, identifiers, comments, commit messages, CHANGELOG entries, READMEs, design docs, agent skills (`.pi/skills/**`), issue templates, configuration files, UI strings — without exception. This applies even when the conversation with the user is in another language.

The chat with the user can be in any language they prefer; the moment something is being written to a file or commit message in this repo, switch to English.

```bash
npm install          # install dependencies
npm run compile      # build extension + webview bundles (esbuild)
npm run watch        # watch mode
npm run test:unit    # vitest unit tests
npm run test:all     # unit + integration tests
```

Press F5 in VS Code to launch an Extension Development Host for manual testing.

## Packaging (VSIX)

```bash
npm prune --omit=dev    # strip devDeps from node_modules
npm run package         # vsce produces pi-code-<version>.vsix
npm install             # restore devDeps for further development
```

The prune step is required because `vsce` packages everything in
`node_modules/` that isn't ignored, and the hoisted layout makes it
non-trivial to walk only production dependencies. Pruning first
guarantees the VSIX contains exactly the runtime tree (~40 MB).

Install the resulting `.vsix` with `code --install-extension <file>
--force` or via the **Extensions: Install from VSIX...** command.

`.vscodeignore` keeps `src/**` out of the package but unignores
`src/webview/styles/**`, because `chat-panel.ts`, `launcher-view.ts`,
and `settings-panel.ts` load CSS via `vscode.Uri.joinPath(extensionUri,
'src', 'webview', 'styles', ...)` at runtime. Do not add a
`node_modules/**` ignore rule
with a `!node_modules/@mariozechner/**` exception -- that strips the
hoisted transitive deps (`proper-lockfile`, `undici`, `glob`, ...) and
breaks activation with `Cannot find package 'proper-lockfile'`.

## Architecture

There are two separate bundle targets (configured in `esbuild.js`):

1. **Extension host** (Node.js, CJS) -- `src/extension.ts` entry point, output to `out/extension.js`. Has access to the `vscode` API and the Pi SDK (both externalized, not bundled).
2. **Webview bundles** (browser, IIFE) -- `src/webview/main.ts` and `src/webview/settings.ts`, output to `out/webview/`. These run inside VS Code webview iframes with no Node.js or vscode API access. They communicate with the extension host via `postMessage`.

The Pi SDK packages (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`) are externalized in esbuild and loaded at runtime by the extension host.

## Key Conventions

- **Typed message protocol**: All communication between extension host and webviews goes through typed message unions defined in `src/shared/protocol.ts`. Add new message types there before implementing handlers.
- **Tab isolation**: Each chat tab has its own `PiSessionManager`, `DiffManager`, and `CheckpointManager`. State is never shared between tabs.
- **No direct DOM libraries**: The webview UI is built with vanilla TypeScript and DOM APIs. No React, no framework. Rendering uses an `el()` helper for element creation and manual DOM updates.
- **CSS variables**: Webview styles use VS Code's CSS custom properties (e.g. `--vscode-editor-background`) for theme compatibility. Never hardcode colors.
- **SecretStorage for secrets**: API keys are stored via `vscode.SecretStorage`, never in `settings.json` or plaintext.
- **Message queuing**: While streaming, user messages are queued (stored in `TabState.queuedMessages`) and auto-dispatched as new prompts on `agent_end`. Steering (mid-stream injection) is a separate path via `AgentSession.steer()`.
- **Skills / slash commands**: Skills are loaded from the Pi SDK and surfaced in the webview via a `getSkills` message. The webview renders a slash-command menu triggered by `/` in the input.

## Bundled Pi extensions

Pi extensions (npm packages keyed `pi-package`, e.g. `pi-web-access`) ship **inside the VSIX** and are surfaced to Pi via `DefaultResourceLoader.additionalExtensionPaths`. We do **not** invoke `pi install` at activation, and we do **not** mutate the user's `~/.pi/settings.json`.

**Why this approach:** the VSIX must be self-contained. `pi install npm:<pkg>` writes into `~/.pi/settings.json` and `~/.pi/npm/node_modules/`, neither of which is owned by us, bundled in the VSIX, or guaranteed to survive a marketplace install. Feeding paths directly to the resource loader keeps the install fully offline, deterministic, and removable when the user uninstalls the extension.

**Tradeoff:** Pi extension versions are pinned to the VSIX release. Bumping `pi-web-access` (or any other Pi extension) requires cutting a new extension version. The upside is that an upstream regression in a Pi extension cannot break the plugin between our releases.

### How to add a new Pi extension

1. `npm install <package> --save` — it MUST be a production dependency. `devDependencies` are stripped by `npm prune --omit=dev` before packaging and will not appear in the VSIX.
2. Append the package name to `BUNDLED_PI_PACKAGES` in `src/pi/bundled-packages.ts`. That list is consumed by `_buildResourceLoader` in `src/pi/session.ts`, which resolves each name to an absolute path under `node_modules/<pkg>/` and passes the directory to `DefaultResourceLoader` via `additionalExtensionPaths`. Pi's package manager treats it as a local pi-package and auto-discovers `pi.extensions` and `pi.skills` from the package's own `package.json` manifest — no separate skills wiring needed.
3. Confirm `.vscodeignore` does not exclude `node_modules/<pkg>/**`. The current rules leave `node_modules/` alone, so most packages ship without changes.
4. Smoke-test the produced VSIX in a clean VS Code window: open a chat, confirm the new tools appear in the active tool list, and any new skills show up in the slash-command menu (`/`).

### Don't

- Don't call `pi install npm:<pkg>` from extension code, activation, or a `postinstall` script. It pollutes user-global state, requires network on first run, and the package lands outside the VSIX.
- Don't rely on a transitive dependency to bring the package in — declare it explicitly in our root `package.json` so `npm prune --omit=dev` cannot drop it.
- Don't write registration files into `~/.pi/` or `<workspace>/.pi/` to make Pi see the package. The resource loader picks bundled extensions up directly from `node_modules/` via `additionalExtensionPaths` — no settings round-trip needed.

## File Layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation, command/provider registration |
| `src/shared/protocol.ts` | Typed message interfaces (ClientMessage, ServerMessage, etc.) |
| `src/pi/session.ts` | Wraps Pi SDK AgentSession lifecycle |
| `src/pi/bundled-packages.ts` | List of Pi extensions shipped in the VSIX (see "Bundled Pi extensions") |
| `src/pi/models.ts` | Model registry helpers |
| `src/pi/auth.ts` | Auth storage singleton |
| `src/pi/events.ts` | EventRouter for agent session events |
| `src/controllers/chat-controller.ts` | Shared tab lifecycle + message routing between launcher and chat panels |
| `src/providers/launcher-view.ts` | Activity-bar `WebviewViewProvider` (launcher: new chat, settings, history, Plan Mode toggle, per-tab ToDo) |
| `src/providers/chat-panel.ts` | Editor-area `WebviewPanel` per chat |
| `src/providers/chat-panel-serializer.ts` | Restores chat panels across `Reload Window` |
| `src/providers/settings-panel.ts` | WebviewPanel for the settings page |
| `src/providers/diff.ts` | File change tracking, unified diff generation |
| `src/providers/checkpoint.ts` | Per-turn file snapshots, rollback/redo |
| `src/providers/status-bar.ts` | Status bar item |
| `src/pi/todo/` | Per-chat persistent ToDo (reducer, replay, store, tool schema) |
| `src/pi/lsp/` | Opt-in Language Server tools (find_references, hover, …) gated by `pi-code.lsp.enabled` |
| `src/utils/diff.ts` | Myers diff algorithm |
| `src/webview/main.ts` | Chat UI (runs in webview) |
| `src/webview/launcher.ts` | Launcher sidebar UI (runs in webview) |
| `src/webview/settings.ts` | Settings UI (runs in webview) |
| `src/webview/styles/main.css` | Chat styles |
| `src/webview/styles/launcher.css` | Launcher styles |
| `src/webview/styles/settings.css` | Settings page styles |
| `media/icons/` | UI icons (36x36 grayscale PNGs) |

## Versioning & Changelog

The project uses [Semantic Versioning](https://semver.org/) and maintains
`CHANGELOG.md` in [Keep a Changelog](https://keepachangelog.com/) format.

**Every time you make code changes**, you must add entries to `CHANGELOG.md`
under `## [Unreleased]` using the appropriate subsections: `Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, `Security`.

Rules:
- Write entries from the user's perspective, not implementation details.
- Each entry is one line starting with `- `.
- Group by type (Added, Changed, Fixed, etc.).
- Never leave `[Unreleased]` empty before a deploy — the bump script will refuse to run.

When deploying, use one of:
```bash
npm run deploy:patch   # bug fixes, small tweaks
npm run deploy:minor   # new features, backward-compatible
npm run deploy:major   # breaking changes
```

These commands automatically:
1. Validate that `[Unreleased]` has content
2. Bump version in `package.json`
3. Stamp `[Unreleased]` → `[x.y.z] - YYYY-MM-DD`
4. Add a fresh empty `[Unreleased]` section on top
5. Compile, prune, package VSIX, restore deps, install into VS Code

## Common Pitfalls

- The webview bundles (`src/webview/`) cannot import `vscode` or Node.js modules. They are browser-only IIFE bundles.
- `tsconfig.json` excludes `src/webview/**/*` from the main TypeScript compilation. The webview files are compiled by esbuild only.
- The Pi SDK is dynamically imported (`await import(...)`) in `session.ts` because it is externalized and must be resolved at runtime by VS Code's module loader.
- When adding new settings, update both `package.json` (`contributes.configuration`) and `src/shared/protocol.ts` (`SettingsData` interface), then wire them in `settings-panel.ts` and `settings.ts`.
- API keys saved via the settings panel are bridged into Pi's `AuthStorage` by `src/pi/auth.ts` (which calls `setRuntimeApiKey` for every known provider). `extension.ts` subscribes to `secrets.onDidChange` so a newly saved key takes effect without a window reload. Adding support for a new provider means appending its id to the `KNOWN_PROVIDERS` list in `auth.ts`.
- Verify the build by installing the produced VSIX into a real VS Code instance (`code --install-extension ... --force`) and reloading the window. The dev host (F5) resolves the full `node_modules` tree and will hide packaging bugs that only surface after install.

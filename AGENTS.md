# AGENTS.md

## Project Overview

Pi Code is a VS Code extension providing editor-tab chat panels (with an activity-bar launcher sidebar) for the Pi coding agent SDK (`@earendil-works/pi-coding-agent`). It supports multi-tab sessions, cross-provider named and ad-hoc subagents, inline diffs, checkpoints/rollback, a dedicated settings page, message queuing during streaming, mid-stream steering, slash-command skills, per-chat ToDo, Plan Mode, and opt-in LSP tools.

## Language

**English only.** Every artefact that lives in the repository must be written in English: source code, identifiers, comments, commit messages, CHANGELOG entries, READMEs, design docs, agent skills (`.agents/skills/**`), issue templates, configuration files, UI strings — without exception. This applies even when the conversation with the user is in another language.

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
with a `!node_modules/@earendil-works/**` exception -- that strips the
hoisted transitive deps (`proper-lockfile`, `undici`, `glob`, ...) and
breaks activation with `Cannot find package 'proper-lockfile'`.

## Architecture

There are two separate bundle targets (configured in `esbuild.js`):

1. **Extension host** (Node.js, CJS) -- `src/extension.ts` entry point, output to `out/extension.js`. Has access to the `vscode` API and the Pi SDK (both externalized, not bundled).
2. **Webview bundles** (browser, IIFE) -- `src/webview/main.ts` and `src/webview/settings.ts`, output to `out/webview/`. These run inside VS Code webview iframes with no Node.js or vscode API access. They communicate with the extension host via `postMessage`.

The Pi SDK packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`) are externalized in esbuild and loaded at runtime by the extension host.

## Key Conventions

- **Typed message protocol**: All communication between extension host and webviews goes through typed message unions defined in `src/shared/protocol.ts`. Add new message types there before implementing handlers.
- **Tab isolation**: Each chat tab has its own `PiSessionManager`, `DiffManager`, and `CheckpointManager`. State is never shared between tabs.
- **No direct DOM libraries**: The webview UI is built with vanilla TypeScript and DOM APIs. No React, no framework. Rendering uses an `el()` helper for element creation and manual DOM updates.
- **CSS variables**: Webview styles use VS Code's CSS custom properties (e.g. `--vscode-editor-background`) for theme compatibility. Never hardcode colors.
- **SecretStorage for secrets**: API keys are stored via `vscode.SecretStorage`, never in `settings.json` or plaintext.
- **Message queuing**: While streaming, user messages are queued (stored in `TabState.queuedMessages`) and auto-dispatched as new prompts on `agent_end`. Steering (mid-stream injection) is a separate path via `AgentSession.steer()`.
- **Skills / slash commands**: Skills are loaded from the Pi SDK and surfaced in the webview via a `getSkills` message. The webview renders a slash-command menu triggered by `/` in the input.

## Cross-Harness Agent Resources

Keep repository guidance portable across Pi Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Claude Code, Hermes, and other compatible harnesses.

- **Always-on instructions:** This root [`AGENTS.md`](https://agents.md) is the canonical source of project policy. It must remain self-contained because import syntax is not universal. Add nested `AGENTS.md` files only for directory-scoped overrides; the closest applicable file wins.
- **Reusable workflows:** Store project skills in `.agents/skills/<skill-name>/SKILL.md` following the [Agent Skills](https://agentskills.io) specification. `.agents/skills` is the cross-client discovery convention; do not make `.pi/skills`, `.claude/skills`, `.cursor/skills`, or another vendor directory the source of truth.
- **Named implementation agents:** Store neutral definitions in `.agents/agents/*.md`. There is not yet a mature cross-harness subagent-definition standard: Claude/Cursor use Markdown with differing fields, Codex uses TOML, and `.agents/agents` remains an emerging draft convention. Therefore `AGENTS.md` must also describe each project agent's routing boundary so a harness can reproduce the role even when it cannot parse the definition natively.
- **Compatibility shims:** Vendor files may only bridge to canonical resources. `CLAUDE.md` intentionally contains `@AGENTS.md`; it must not accumulate independent policy. Do not duplicate skill bodies or agent instructions across vendor directories because copies drift.
- **Runtime capability remains local:** Instructions never grant tools, permissions, models, trust, or isolation. A harness must map canonical intent onto capabilities it actually provides and report unsupported constraints rather than silently weakening them.

### Skill discovery and routing

Harnesses with native `.agents/skills` discovery use the standard metadata automatically. Other harnesses must use the catalogs below for routing. Before entering a matching workflow, read its canonical `SKILL.md` completely and follow supporting files only when that skill directs it.

- Match both the trigger and the target scope; a useful-sounding skill from another domain is not automatically applicable.
- Load only the skills needed for the current phase. Do not turn every task into the longest possible workflow.
- When several skills apply, follow the composition rules below rather than running them as unrelated checklists.
- Skills refine the workflow but never override this `AGENTS.md`, grant tools or agents, relax isolation, or transfer parent-owned review and verification to a child.
- Do not re-run a completed gate without cause: for example, an approved design proceeds to planning or execution rather than returning to brainstorming.

#### Pi Code project workflows

These skills apply to work on this TypeScript VS Code extension. The `pi-code-` prefix avoids collisions with user-level skills loaded alongside project resources.

| Skill | Invoke when | Canonical file |
|---|---|---|
| `pi-code-brainstorming` | A feature or technical problem has unresolved requirements, meaningful design choices, or cross-boundary architecture trade-offs. Skip it for exact, approved, read-only, or repository-answerable work. | `.agents/skills/pi-code-brainstorming/SKILL.md` |
| `pi-code-writing-plans` | An approved design must become an ordered, file-specific, verifiable implementation plan. Do not use it to reopen design or begin implementation unless execution was also requested. | `.agents/skills/pi-code-writing-plans/SKILL.md` |
| `pi-code-executing-plans` | Executing an approved Pi Code implementation, migration, documentation, or investigation plan while preserving order, scope, and verification gates. | `.agents/skills/pi-code-executing-plans/SKILL.md` |
| `pi-code-systematic-debugging` | Investigating a bug, unexpected behavior, flaky test, performance regression, activation/build/package failure, or F5-versus-installed-VSIX difference. Establish root cause before fixing. | `.agents/skills/pi-code-systematic-debugging/SKILL.md` |
| `pi-code-test-driven-development` | Implementing testable behavior or a regression fix where an automated test or deterministic guard can fail before production code changes. | `.agents/skills/pi-code-test-driven-development/SKILL.md` |
| `pi-code-dispatching-parallel-agents` | A task has at least two independently understandable, verifiable, non-overlapping slices. Use it as an independence gate, not a reason to manufacture parallel work. | `.agents/skills/pi-code-dispatching-parallel-agents/SKILL.md` |
| `pi-code-requesting-code-review` | A meaningful or risky change is ready for independent review before merge, release, or handoff. | `.agents/skills/pi-code-requesting-code-review/SKILL.md` |
| `pi-code-code-reviewer` | Performing an independent review: requirement compliance first, then Pi Code implementation quality and production readiness. | `.agents/skills/pi-code-code-reviewer/SKILL.md` |
| `pi-code-receiving-code-review` | Evaluating or implementing review feedback; verify each technical claim and push back with evidence when needed. | `.agents/skills/pi-code-receiving-code-review/SKILL.md` |
| `pi-code-verification-before-completion` | Before claiming work is fixed, complete, passing, performant, merge-ready, package-ready, or release-ready. Unavailable checks remain explicitly unverified. | `.agents/skills/pi-code-verification-before-completion/SKILL.md` |
| `build-deploy` | The user asks to build, compile, package, deploy, install, create a VSIX, bump/release a version, or supplies the documented standalone test-deploy shortcut. | `.agents/skills/build-deploy/SKILL.md` |
| `commit` | The user asks to inspect/finalize uncommitted work, draft a commit message, or commit changes. | `.agents/skills/commit/SKILL.md` |

#### Workflow composition

- **Unclear feature:** `pi-code-brainstorming` -> user approval -> `pi-code-writing-plans` when a standalone plan is requested or needed -> `pi-code-executing-plans` when executing that approved plan.
- **Exact or already-approved feature:** skip brainstorming. Use `pi-code-test-driven-development` for each testable behavior and execute directly, or use the planning/execution pair when scope warrants an explicit plan.
- **Defect or failing check:** start with `pi-code-systematic-debugging`; after identifying the cause, use `pi-code-test-driven-development` or the nearest deterministic regression guard before the focused fix.
- **Parallel work:** apply `pi-code-dispatching-parallel-agents` only after decomposition proves independence; all root subagent isolation and parent-ownership rules still apply.
- **Review:** for meaningful or risky changes, use `pi-code-requesting-code-review`; the reviewer follows `pi-code-code-reviewer`. Process findings with `pi-code-receiving-code-review`, then re-review materially changed areas.
- **Completion:** apply `pi-code-verification-before-completion` before final status claims. Verification is proportional to the claim; compile, unit, integration, manual F5, and installed-VSIX checks prove different boundaries.
- **Deployment and commit:** `build-deploy` and `commit` are explicit user-intent workflows, not automatic final steps. Never package, install, bump a version, or commit merely because implementation finished.

The parent agent always retains integration, final diff review, fresh verification, package/release acceptance, and user-facing reporting.

#### Wiki skill package

`.agents/packages/wiki-skill-package/` is a deployment bundle, not an active project skill. It lives outside `.agents/skills/` because skill discovery is recursive and its nested `files/.claude/skills/` tree is a target template that must not auto-load in this repository. Read the package's `AGENTS.md` and then `AGENT_DEPLOY.md` only when the user explicitly asks to deploy the wiki system to a named target repository. Do not invoke its templated `wiki-read` or `wiki-maintain` workflows until the package has been deployed to that target and its wiki exists. During deployment, preserve the target's existing instructions and content, require explicit consent before overwriting, and do not treat generated `.claude/` copies as replacements for a target repository's `.agents/` source-of-truth policy.

Keep these catalogs and package-routing notes synchronized when project skills or workflow bundles are added, renamed, or removed.

## Subagent Orchestration

Subagents are implementation hands owned by the parent agent. The user defines reusable agent types in Markdown and gives goals to the parent; the parent proactively chooses, delegates to, reviews, and integrates child work. Do not ask the user to select agents or manage child lifecycle operations unless they explicitly requested a particular named agent.

### Discovery and routing

- Treat an active `subagent` tool as the user's opt-in to autonomous delegation; do not ask for per-child permission when delegation is useful.
- Treat each loaded agent definition's `description` as its routing contract. Select a matching named agent automatically when the delegated task fits that description.
- If no named definition fits, synthesize a temporary ad-hoc role with focused instructions instead of asking the user to define or select an agent.
- Honor an explicitly requested named agent when it is available and policy-allowed.
- Do not hardcode assumptions that `scout`, `planner`, `reviewer`, or any other profile must exist. Definitions may come from trusted `.agents/agents/**/*.md`, legacy or user agent files, adapted harness resources, packages, or ad-hoc invocation instructions.
- Run independent children concurrently through sibling tool calls in one response; keep dependent work sequential and keep fan-out to the minimum useful number.
- Use exact `provider/id` model references or explicit parent-model inheritance. Never silently fall back when a named definition or invocation selected an unavailable model.
- Keep delegation depth at one: child agents never receive the `subagent` tool.

### Current project agent

| Agent | Use when | Do not use when | Canonical file |
|---|---|---|---|
| `deepseek-v4-implementer` | A non-trivial task has already been decomposed into one small, concrete implementation change with explicit target paths, constraints, and acceptance criteria. Good examples: a localized bug fix, one focused refactor, a test addition, protocol plumbing after the parent designed it, or a mechanical documentation/code update. | Architecture is undecided, requirements are ambiguous, the change is cross-cutting, security policy must be designed, or the task is so trivial that delegation costs more than doing it directly. | `.agents/agents/deepseek-v4-implementer.md` |

When more named agents are added, extend this table with a precise routing boundary. Keep the agent file's description and this table consistent.

### Delegation contract

Before spawning a child, the parent must provide:

- one self-contained outcome;
- relevant file or directory paths;
- invariants and behavior that must remain unchanged;
- explicit acceptance criteria;
- the expected report or artifact;
- a narrow tool allowlist whenever the full agent tool set is unnecessary.

Prefer delegating at least one suitable implementation slice during non-trivial code work so the subagent path remains continuously exercised. Do not manufacture busywork merely to invoke an agent, and do not delegate tasks the parent cannot review.

### Execution and integration

- Use foreground execution when the parent needs the result before continuing. Use background execution only for genuinely independent work.
- Narrow read-only investigations to `read`, `grep`, `find`, and `ls`.
- Write-capable background runs require `isolation: worktree`. Worktree isolation is also the preferred default for substantial child edits. Parallel/background writes must be rejected in non-Git workspaces until an equivalent isolation strategy exists.
- The parent owns all child lifecycle decisions. Inspect results, steer or stop when needed, review isolated diffs, apply accepted patches, run verification, and clean preserved worktrees without asking the user to manage these steps.
- Never apply a worktree patch before reviewing it. Never treat a child's claim that tests pass as evidence; children do not have `bash`, and the parent must run the relevant commands.
- Shared-workspace child writes must remain foreground, use the writer lease, and flow through the parent Diff/Checkpoint pipeline.
- After integration, report delegation transparently in chat: what task was sent, what the child returned, what the parent accepted or rejected, and which verification the parent ran. The launcher is an observation surface with expandable Task/Result rows and Dismiss only, not a lifecycle control panel.

### Parent-only responsibilities

Do not delegate final ownership of:

- architecture and product behavior;
- security, trust, permission, model-fallback, or isolation policy;
- cross-subsystem integration decisions;
- final diff review and conflict resolution;
- compilation, tests, packaging, deployment, or release acceptance;
- changelog/version decisions unless the delegated task names a purely mechanical edit and the parent reviews it afterward.

## Bundled Pi extensions

Pi extensions (npm packages keyed `pi-package`, e.g. `pi-web-access`) ship **inside the VSIX** and are surfaced to Pi via `DefaultResourceLoader.additionalExtensionPaths`. We do **not** invoke `pi install` at activation, and we do **not** mutate the user's `~/.pi/settings.json`.

**Why this approach:** the VSIX must be self-contained. `pi install npm:<pkg>` writes into `~/.pi/settings.json` and `~/.pi/npm/node_modules/`, neither of which is owned by us, bundled in the VSIX, or guaranteed to survive a marketplace install. Feeding paths directly to the resource loader keeps the install fully offline, deterministic, and removable when the user uninstalls the extension.

**Tradeoff:** Pi extension versions are pinned to the VSIX release. Bumping `pi-web-access` (or any other Pi extension) requires cutting a new extension version. The upside is that an upstream regression in a Pi extension cannot break the plugin between our releases.

### How to add a new Pi extension

1. `npm install <package> --save` — it MUST be a production dependency. `devDependencies` are stripped by `npm prune --omit=dev` before packaging and will not appear in the VSIX.
2. Append the package name to `BUNDLED_PI_PACKAGES` in `src/pi/bundled-packages.ts`. Extension activation resolves that list from `ExtensionContext.extensionUri.fsPath` with `getBundledPiPackagePaths(...)`, injects the absolute package directories through the session resource paths, and `_buildResourceLoader` passes them to `DefaultResourceLoader` via `additionalExtensionPaths`. Pi's package manager treats each directory as a local pi-package and auto-discovers `pi.extensions` and `pi.skills` from the package's own `package.json` manifest — no separate skills wiring needed.
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
| `src/pi/subagents/` | Agent registry/resolution, child runtime, persistence, lifecycle, worktree isolation, compatibility sources, and smoke scenarios |
| `.agents/skills/` | Cross-harness project workflows using the Agent Skills `SKILL.md` standard |
| `.agents/agents/` | Neutral project-scoped named-agent definitions; Pi loads these natively and other harnesses use the routing contract above or adapters |
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

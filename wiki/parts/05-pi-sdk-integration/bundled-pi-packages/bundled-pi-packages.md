# bundled-pi-packages

## Stance

Bundled Pi packages are a policy, not a mechanism. The mechanism is trivial (a hardcoded list + absolute path resolution + feeding paths to `DefaultResourceLoader`). The policy is: **the VSIX is self-contained**. `pi install npm:<pkg>` writes to `~/.pi/settings.json` and downloads to `~/.pi/npm/node_modules/`, which is not part of the VSIX, not owned by the extension, and not guaranteed to survive a marketplace install. Bundling costs one entry in `BUNDLED_PI_PACKAGES` and one production dependency; the upshot is deterministic, offline, uninstallable behavior.

## Role

[`BUNDLED_PI_PACKAGES`](../../../../src/pi/bundled-packages.ts#L11) is a `readonly string[]` naming npm packages that ship in the VSIX. Current entries:

- `pi-web-access` — HTTP fetch / URL tooling extension
- `pi-mcp-adapter` — MCP adapter Pi extension (independent of the Claude-compat MCP import path)

[`getBundledPiPackagePaths(extensionRoot, log?)`](../../../../src/pi/bundled-packages.ts#L25) resolves each name against `${extensionRoot}/node_modules/<name>`, checks existence, and returns the surviving absolute paths. Missing packages are skipped and logged — a defensive behavior for stale dev checkouts where a listed package was uninstalled without updating the list.

The paths are then handed to `DefaultResourceLoader.additionalExtensionPaths` in [`_buildResourceLoader`](../../../../src/pi/session.ts#L670). The SDK's own package-manager machinery treats each directory as a local `pi-package`: it reads the package's `package.json`, finds the `pi.extensions` and `pi.skills` manifests, and auto-registers whatever the package declares. No separate skills wiring in Pi Code is needed.

Bundled packages may declare `pi.skills` we did not opt into — pi-web-access ships a `librarian` research skill alongside its web tools. Pi Code hides those at the loader boundary via `DefaultResourceLoader.skillsOverride`: [`filterBundledPackageSkills`](../../../../src/pi/bundled-packages.ts#L50) drops any skill whose name is in [`HIDDEN_BUNDLED_PACKAGE_SKILLS`](../../../../src/pi/bundled-packages.ts#L37) **and** whose `filePath` physically lives inside one of the bundled package directories. A same-named skill in `.agents/skills` or `~/.pi/agent/skills` is never hidden. The package's extension tools keep loading; only the skill disappears from the agent's skill list and the `/` menu.

## Role — packaging constraints

The mechanism only works if the VSIX actually contains the packages. Four rules:

1. **The package must be a production dependency in the root `package.json`.** `devDependencies` are stripped by `npm prune --omit=dev` before packaging (see [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md)) and will not be in the VSIX.
2. **`.vscodeignore` must not filter `node_modules/**`.** Any broad filter (even with `!node_modules/@earendil-works/**` exceptions) strips hoisted transitive dependencies and breaks activation. Current `.vscodeignore` leaves `node_modules/` alone, keep it that way. **Narrow per-file globs are safe and in use**: `node_modules/pi-web-access/banner.png`, `node_modules/pi-mcp-adapter/cli.js`, `**/*.map`, etc. prune only specific files and never touch the hoisted `@earendil-works` tree. Note the vsce quirk: a bare pattern like `*.map` matches **root-level files only**, so recursive pruning needs `**/*.map`.
3. **Don't call `pi install` from extension code or lifecycle scripts.** No activation-time package install and no calls into `~/.pi/`; bundled resources still arrive only through `additionalExtensionPaths`.
4. **Repair and verify the physical runtime tree after every reification step.** Pi SDK 0.82.1 ships a shrinkwrap that pins vulnerable nested `brace-expansion` 5.0.7. The root declares patched 5.0.9, and `scripts/ensure-safe-brace-expansion.js --repair` removes the nested copy so Pi's `minimatch` resolves the safe root package. Root `postinstall` repairs after install; because `npm prune` restores the shrinkwrapped copy, packaging repairs again and then verifies before `vsce` runs. This local deterministic repair never downloads packages or writes user-global Pi state.

## Keywords

**Types:**
- `BUNDLED_PI_PACKAGES` — const array [bundled-packages.ts:11](../../../../src/pi/bundled-packages.ts#L11)
- `HIDDEN_BUNDLED_PACKAGE_SKILLS` — denylist of bundled-package skills hidden from agents (`librarian` today) [bundled-packages.ts:37](../../../../src/pi/bundled-packages.ts#L37)

**Methods:**
- `getBundledPiPackagePaths(extensionRoot, log?)` — [bundled-packages.ts:61](../../../../src/pi/bundled-packages.ts#L61)
- `filterBundledPackageSkills(skills)` — drops denylisted skills that live inside bundled package dirs; wired as `DefaultResourceLoader.skillsOverride` [bundled-packages.ts:50](../../../../src/pi/bundled-packages.ts#L50)
- `ensure-safe-brace-expansion.js --repair` — install-time nested-package repair and package-time physical-resolution verification

**Attributes / markers:**
- Path resolution: `${extensionRoot}/node_modules/<name>`
- Missing package handling: skip + log (never throw)
- Handed to SDK as: `DefaultResourceLoader.additionalExtensionPaths`

**Namespaces:**
- [src/pi/bundled-packages.ts](../../../../src/pi/bundled-packages.ts) — the entire module

## Lifecycle edges

**Depends on:**
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — the resource loader that consumes the paths is built there.
- [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md) — the packaging invariants that keep the packages inside the VSIX.

**Used by:**
- [bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md) — VSIX contents depend on `node_modules/` hoisting rules honored by the current `.vscodeignore`; bundled Pi extensions ride the same tree.
- [packaging-and-release](../../11-auxiliary-systems/packaging-and-release/packaging-and-release.md) — bundled Pi extensions must be production deps so `npm prune --omit=dev` doesn't strip them.
- [session-lifecycle](../session-lifecycle/session-lifecycle.md) — `additionalExtensionPaths` is fed from this list.

## See also

- **Rule — add a new bundled Pi extension in four steps.** (1) `npm install <package> --save` — MUST be a production dependency. (2) Append the name to `BUNDLED_PI_PACKAGES`. (3) Confirm `.vscodeignore` doesn't exclude `node_modules/<pkg>/**`. (4) Smoke-test the produced VSIX in a clean VS Code window; new tools should show in the tool list, new skills in the `/` menu (minus any names in `HIDDEN_BUNDLED_PACKAGE_SKILLS`).
- **Rule — never call `pi install npm:<pkg>` from extension code or lifecycle scripts.** It writes to user-global state and pollutes the install; the local `brace-expansion` repair is not a Pi package install and never touches `~/.pi/`.
- **Rule — do not rely on transitive dependencies.** Declare the Pi package explicitly in the root `package.json`. `npm prune --omit=dev` cannot drop what's a direct production dep; it can drop packages only reachable through another dep.
- **Pattern — the SDK reads the package manifest.** You don't wire skills or extensions manually. Ensure the package's `package.json` correctly declares `pi.extensions` and `pi.skills`; the SDK does the rest. Skills the project did not request are filtered via `skillsOverride` (`HIDDEN_BUNDLED_PACKAGE_SKILLS`) before they reach agents.
- **Pitfall — Pi extension versions are pinned to the VSIX release.** Upgrading a bundled Pi extension requires cutting a new Pi Code release. Tradeoff: an upstream regression in a bundled extension can't break the plugin between our releases; a fix requires a release.
- **Pitfall — missing package = silent skip.** If the extensionRoot's `node_modules` is missing a listed package (e.g. developer nuked `node_modules` and forgot `npm install`), `getBundledPiPackagePaths` logs and moves on. Activation will not crash; the affected extension will simply be unavailable at runtime.
- **Pitfall — audit metadata can lag behind the repaired tree.** The upstream SDK shrinkwrap still names `brace-expansion` 5.0.7, so `npm audit` can report it after postinstall removed that nested directory. Release acceptance checks `verify:runtime-dependencies` and the VSIX contents; remove the workaround only after an upstream shrinkwrap resolves a safe version itself.

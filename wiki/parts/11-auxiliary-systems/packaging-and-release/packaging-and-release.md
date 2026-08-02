# packaging-and-release

## Stance

The release pipeline is **strict and scripted**. `[Unreleased]` in `CHANGELOG.md` must have content before a bump script will run — this catches "forgot to document what changed" at pipeline time, not at review time. The VSIX boundary verifier refuses to build if `standalone/` files somehow made it past `.vscodeignore` — this catches "forgot to update the ignore list" before a bad VSIX ships. Every one of these gates is a pre-run assertion, not a runtime check; a failure aborts the pipeline with a specific error rather than producing a subtly wrong artifact.

## Role

Manifest scripts [package.json](../../../../package.json):

- `compile` → `node esbuild.js`
- `postinstall` / `repair:runtime-dependencies` → remove the Pi SDK's shrinkwrapped vulnerable `brace-expansion` copy so its `minimatch` resolves root 5.0.9
- `verify:runtime-dependencies` → fail unless Pi physically resolves patched `brace-expansion`
- `package` → post-prune runtime repair + runtime-dependency verification + VSIX boundary verification + `vsce package --readme-path MARKETPLACE.md`
- `test`, `test:unit`, `test:integration`
- `version:patch/minor/major` → `node scripts/bump-version.js <bump> --sync-lock`
- `deploy` → compile + prune devDeps + package + reinstall devDeps + `code --install-extension`
- `deploy:patch/minor/major` → version bump + deploy chain

`.vscodeignore` invariants [.vscodeignore:1](../../../../.vscodeignore#L1):

- `.vscode/**`, `.github/**`, `docs/**`, `standalone/**`, `.dev-notes/**`, `scripts/**`, `.pi/**`, `.claude/**` — excluded
- `src/**` excluded **except** `!src/webview/styles/**` — CSS must ship for runtime loading
- `vitest.config.ts`, `tsconfig*.json`, `esbuild.js` — excluded
- `AGENTS.md`, `CLAUDE.md`, `README.md` — excluded (README replaced at package time)
- `*.map`, `*.vsix` — excluded
- **Never filter `node_modules/**`** — hoisted transitive deps must remain intact (see [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md))

Version bump [scripts/bump-version.js:1](../../../../scripts/bump-version.js#L1):

1. Read current version from `package.json`.
2. Parse `CHANGELOG.md`; validate `[Unreleased]` section exists and is non-empty [bump-version.js:49](../../../../scripts/bump-version.js#L49); abort with exit 1 if empty.
3. Compute new version [bump-version.js:35](../../../../scripts/bump-version.js#L35) — semver bump on patch / minor / major.
4. Stamp — write `newVersion` to `package.json`; replace `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` in `CHANGELOG.md`; prepend a fresh empty `[Unreleased]` [bump-version.js:75](../../../../scripts/bump-version.js#L75).
5. Optional `--sync-lock` [bump-version.js:85](../../../../scripts/bump-version.js#L85) — `npm install --package-lock-only` syncs `package-lock.json`.

Boundary verification [scripts/verify-vsix-boundary.js:1](../../../../scripts/verify-vsix-boundary.js#L1):

- Runs `npx @vscode/vsce ls` (handles Windows `.cmd` wrapper [verify-vsix-boundary.js:9](../../../../scripts/verify-vsix-boundary.js#L9)).
- Enumerates every file that would be packaged.
- Checks against forbidden prefixes: `['standalone/']` [verify-vsix-boundary.js:13](../../../../scripts/verify-vsix-boundary.js#L13).
- Fails with exit 1 + file list on violation; success message: `"VSIX boundary verified: standalone/** is excluded."` [verify-vsix-boundary.js:25](../../../../scripts/verify-vsix-boundary.js#L25).

`CHANGELOG.md` format [CHANGELOG.md:1](../../../../CHANGELOG.md#L1):

- Standard "Keep a Changelog" + "Semantic Versioning" reference at the top.
- Sections `### Added`, `### Changed`, `### Removed`, `### Fixed` under each version.
- Dates in ISO 8601 (`YYYY-MM-DD`).
- Newest at top; the bump script stamps and prepends `[Unreleased]`.

`MARKETPLACE.md` [MARKETPLACE.md:1](../../../../MARKETPLACE.md#L1):

- Marketing-oriented README, replaces the developer-facing `README.md` in the packaged VSIX via `--readme-path MARKETPLACE.md` flag on `vsce package`.
- Contains display name + icon badge + feature descriptions.

Deploy chain (all `deploy:*` scripts):

1. `npm run version:<level>` — bump version + stamp CHANGELOG.
2. `npm run compile` — esbuild bundles.
3. `npm prune --omit=dev` — strip devDeps from `node_modules`.
4. `npm run package` — repair the shrinkwrapped runtime dependency restored by prune, verify the physical tree, verify the public/private boundary, then run `vsce package`.
5. `npm install` — restore devDeps and rerun the deterministic runtime repair through `postinstall`.
6. `code --install-extension pi-code-<version>.vsix --force` — local install for smoke test.

Pruning guarantees that only production dependencies remain; it does not make the package small by itself. The current bundled SDK, provider integrations, web tooling, and native helpers produce a compressed VSIX of roughly 120 MB, and dependency upgrades can change that size.

Marketplace publication is a separate explicit maintainer action after the installed-VSIX smoke test:

```bash
npx @vscode/vsce publish --packagePath pi-code-<version>.vsix
```

After publishing, verify the intended version on the Marketplace page or Gallery API. A matching `v<version>` tag independently triggers the GitHub Release workflow; CI rejects tags that disagree with `package.json`.

## Keywords

**Types / files:**
- [package.json](../../../../package.json) — script pipeline
- [.vscodeignore](../../../../.vscodeignore) — inclusion rules
- [CHANGELOG.md](../../../../CHANGELOG.md) — release history
- [MARKETPLACE.md](../../../../MARKETPLACE.md) — VSIX README
- [scripts/bump-version.js](../../../../scripts/bump-version.js) — version bump
- [scripts/verify-vsix-boundary.js](../../../../scripts/verify-vsix-boundary.js) — boundary verifier
- [scripts/ensure-safe-brace-expansion.js](../../../../scripts/ensure-safe-brace-expansion.js) — install-time repair and package-time physical dependency verifier

**Methods — scripts:**
- `bump-version.js` steps: read → validate `[Unreleased]` → compute → stamp → sync-lock (optional)
- `verify-vsix-boundary.js`: `vsce ls` → check prefixes → exit code
- `ensure-safe-brace-expansion.js`: resolve Pi's `minimatch` dependency → remove vulnerable nested copy in repair mode → require safe root fallback → accept only valid, stable SemVer at or above 5.0.8 (build metadata is allowed; prereleases are rejected)

**Attributes / markers:**
- Release SemVer: stable `MAJOR.MINOR.PATCH`; generic SemVer may also carry `-PRERELEASE` and `+BUILD` identifiers
- Date format: `YYYY-MM-DD` (ISO 8601)
- Bump-abort condition: empty `[Unreleased]`
- Boundary abort condition: any `standalone/` prefix in packaged files
- vsce flags: `--allow-missing-repository`, `--no-rewrite-relative-links`, `--readme-path MARKETPLACE.md`

**Namespaces:**
- [scripts/](../../../../scripts/) — release automation
- [.vscodeignore](../../../../.vscodeignore) — inclusion policy
- [MARKETPLACE.md](../../../../MARKETPLACE.md), [CHANGELOG.md](../../../../CHANGELOG.md) — release artefacts

## Lifecycle edges

**Depends on:**
- [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md) — `compile` invokes esbuild; the CSS unignore rule is critical.
- [Part V § bundled-pi-packages](../../05-pi-sdk-integration/bundled-pi-packages/bundled-pi-packages.md) — bundled Pi extensions must be production deps so `npm prune --omit=dev` doesn't strip them.
- [Part X § desktop-host-lifecycle](../../10-standalone-desktop-host/desktop-host-lifecycle/desktop-host-lifecycle.md) — the retired Electron host remains a historical snapshot, while the private `standalone/` successor is excluded wholesale from the public VSIX.
## See also

- **Rule — `[Unreleased]` cannot be empty before bumping.** The bump script aborts. Add entries under `### Added / Changed / Removed / Fixed` before running `deploy:*`.
- **Rule — always `npm prune --omit=dev` before `vsce package`.** Otherwise every dev dep (vitest, esbuild, TypeScript) lands in the VSIX. Restore afterward with `npm install`.
- **Rule — `standalone/` must never appear in `vsce ls` output.** The boundary verifier is the gate; do not `--skip` it.
- **Pattern — `MARKETPLACE.md` for users, `README.md` for contributors.** The two READMEs serve different audiences; `README.md` documents the repo (build steps, contribution guide), `MARKETPLACE.md` is the product page.
- **Pattern — sync-lock is optional but recommended.** `--sync-lock` runs `npm install --package-lock-only`; guarantees `package-lock.json` reflects the new version. Skip only if you know the lock is already correct.
- **Pitfall — `code --install-extension --force` overwrites the existing install.** Fine for developer machines; do not run inside CI without a clean profile.
- **Pitfall — the boundary verifier hardcodes `['standalone/']`.** If a new subtree needs to be excluded from the VSIX, add it to the list; do not rely on `.vscodeignore` alone.
- **Pattern — deploy is local by default.** The `deploy:*` scripts install the VSIX into local VS Code; publishing requires an explicit `vsce publish --packagePath ...` maintainer action after smoke testing.
- **Rule — release tags must match the manifest.** The GitHub workflow accepts only `v<package.json version>` tags before packaging and creating a GitHub Release.
- **Rule — package the physically resolved dependency tree, not audit metadata alone.** Pi SDK 0.82.1 shrinkwraps vulnerable `brace-expansion` 5.0.7. Install-time repair removes that nested copy, and packaging aborts unless Pi resolves root 5.0.9; the upstream lock metadata can continue to trigger an `npm audit` advisory until its shrinkwrap is updated.

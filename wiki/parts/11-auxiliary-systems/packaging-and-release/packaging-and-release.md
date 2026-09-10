# packaging-and-release

## Stance

The release pipeline is **strict and scripted**. `[Unreleased]` in `CHANGELOG.md` must have content before a bump script will run — this catches "forgot to document what changed" at pipeline time, not at review time. The VSIX boundary verifier refuses to build if `standalone/` files somehow made it past `.vscodeignore` — this catches "forgot to update the ignore list" before a bad VSIX ships. The release-notes verifier refuses to build if `RELEASES.md` disagrees with `package.json` or with the handout record — the notes travel inside the package, so a wrong entry cannot be corrected after the fact. Every one of these gates is a pre-run assertion, not a runtime check; a failure aborts the pipeline with a specific error rather than producing a subtly wrong artifact.

## Role

Manifest scripts [package.json](../../../../package.json):

- `compile` → `node esbuild.js`
- `postinstall` / `repair:runtime-dependencies` → remove the Pi SDK's shrinkwrapped `brace-expansion` copy when it is vulnerable, so its `minimatch` resolves root 5.0.9. Since Pi SDK 0.84.4 the shrinkwrap pins the patched 5.0.9 itself, so the step verifies the nested copy instead of removing it
- `verify:runtime-dependencies` → fail unless Pi physically resolves patched `brace-expansion`
- `package` → post-prune runtime repair + runtime-dependency verification + VSIX boundary verification + release-notes verification + `vsce package --readme-path MARKETPLACE.md --changelog-path RELEASES.md`
- `verify:release-notes` → fail unless `RELEASES.md` agrees with `package.json` and `release-state.json`
- `mark-released -- <version>` → record that a version was handed to users
- `test`, `test:unit`, `test:integration`
- `version:patch/minor/major` → `node scripts/bump-version.js <bump> --sync-lock`
- `deploy` → compile + prune devDeps + package + reinstall devDeps + `code --install-extension`
- `deploy:patch/minor/major` → version bump + deploy chain

`.vscodeignore` invariants [.vscodeignore:1](../../../../.vscodeignore#L1):

- `.vscode/**`, `.github/**`, `docs/**`, `standalone/**`, `.dev-notes/**`, `scripts/**`, `.pi/**`, `.claude/**` — excluded
- `src/**` excluded **except** `!src/webview/styles/**` — CSS must ship for runtime loading
- `vitest.config.ts`, `tsconfig*.json`, `esbuild.js` — excluded
- `AGENTS.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `release-state.json` — excluded; both the README and the changelog are replaced at package time from `MARKETPLACE.md` and `RELEASES.md`
- `**/*.map`, `*.vsix` — excluded; source maps require the recursive glob because a bare `*.map` matches only the package root
- **Never filter `node_modules/**` broadly** — hoisted transitive deps must remain intact (see [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md)). Narrow per-package globs are allowed and are used for bundled-package baggage and for `node_modules/**/@esbuild/**`; what is forbidden is a blanket rule with allowlist exceptions

Version bump [scripts/bump-version.js:1](../../../../scripts/bump-version.js#L1):

1. Read current version from `package.json`.
2. Parse `CHANGELOG.md`; validate `[Unreleased]` section exists and is non-empty [bump-version.js:66](../../../../scripts/bump-version.js#L66); abort with exit 1 if empty.
3. Compute new version [bump-version.js:46](../../../../scripts/bump-version.js#L46) — semver bump on patch / minor / major.
4. Stamp — write `newVersion` to `package.json`; replace `[Unreleased]` → `[x.y.z] - YYYY-MM-DD` in `CHANGELOG.md`; prepend a fresh empty `[Unreleased]` [bump-version.js:78](../../../../scripts/bump-version.js#L78).
5. Roll `RELEASES.md` forward [bump-version.js:93](../../../../scripts/bump-version.js#L93) — `updateForBump` retitles the top entry to the new version and today's date while it is still unpublished, or inserts a fresh stub entry above it once the top entry equals `lastPublishedVersion`. Bullets are never generated; the console output tells the operator to write them.
6. Optional `--sync-lock` [bump-version.js:117](../../../../scripts/bump-version.js#L117) — `npm install --package-lock-only` syncs `package-lock.json`.

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
- Per **build**, not per release. Most stamped versions are only installed locally, so this file is a contributor artefact and is excluded from the VSIX.

`RELEASES.md` [RELEASES.md:1](../../../../RELEASES.md#L1):

- Newest entry first; each entry consolidates everything that arrived since the entry directly below it, so a user reads exactly one entry. Locally-only builds never get an entry of their own — their changes fold into the entry above them and their numbers are not mentioned.
- Replaces `CHANGELOG.md` inside the VSIX via `--changelog-path RELEASES.md`; `vsce` installs it as `extension/changelog.md`, which is what the Marketplace Changelog tab renders and what the in-chat `/changelog` command opens [chat-controller.ts:1559](../../../../src/controllers/chat-controller.ts#L1559).
- The **top entry is the newest build, not a release**: it is an accumulator that `bump-version.js` retitles on every bump and whose bullets grow build after build until a handout is recorded. A top entry naming a version nobody received is correct by design.
- Entry headings are `## <version> — <YYYY-MM-DD>` (em dash) and the consolidation line is `*Everything new since <version>.*`; both forms are parsed, rewritten, and verified, so their shape is load-bearing rather than cosmetic.
- Bullet prose is hand-written. The scripts own the heading, the date, and the since-line; deciding what a user can observe is not mechanizable.

`release-state.json` [release-state.json:1](../../../../release-state.json#L1):

- Records `lastPublishedVersion` plus an optional `publishedAt` — the only place that knows which version users actually received. Git tags are incomplete, the root `.vsix` files include local-only builds, `CHANGELOG.md` stamps every bump, and the newest `RELEASES.md` entry is a build rather than a handout.
- Written only by `mark-released.js`, which refuses a version that is not the newest `RELEASES.md` entry and refuses an entry still holding its placeholder or carrying no bullets.
- Excluded from the VSIX: it is maintainer bookkeeping, not a packaged artefact.
- Moving the marker is what closes the current entry; the next bump then opens a new one above it instead of extending it.

`MARKETPLACE.md` [MARKETPLACE.md:1](../../../../MARKETPLACE.md#L1):

- Marketing-oriented README, replaces the developer-facing `README.md` in the packaged VSIX via `--readme-path MARKETPLACE.md` flag on `vsce package`.
- Contains display name + icon badge + feature descriptions.

Deploy chain (all `deploy:*` scripts):

1. `npm run version:<level>` — bump version + stamp CHANGELOG.
2. `npm run compile` — esbuild bundles.
3. `npm prune --omit=dev` — strip devDeps from `node_modules`.
4. `npm run package` — repair the shrinkwrapped runtime dependency restored by prune, verify the physical tree, verify the public/private boundary, verify the release notes against `package.json` and `release-state.json`, then run `vsce package`.
5. `npm install` — restore devDeps and rerun the deterministic runtime repair through `postinstall`.
6. `code --install-extension pi-code-<version>.vsix --force` — local install for smoke test.

Pruning guarantees that only production dependencies remain; it does not make the package small by itself. After source-map and bundled-package baggage exclusions, the current SDK, provider integrations, web tooling, and native helpers produce a compressed VSIX of roughly 90 MB; dependency upgrades can change that size.

A dependency upgrade can also drag in per-platform binaries that no single user can use. Pi 0.85 added `@earendil-works/chord`, which depends on `esbuild`; because Pi's shrinkwrap enumerates all 26 of esbuild's optional platform packages, npm installs every one and the VSIX went from 87 MB to 204 MB. `node_modules/**/@esbuild/**` is excluded, which is safe here because `chord` is reachable only from Pi's own `dist/bundle/` CLI chunks and the extension host imports the package root instead. Verified by loading the SDK out of the installed extension directory with the binaries absent, not by reasoning alone.

Marketplace publication is a separate explicit maintainer action after the installed-VSIX smoke test:

```bash
npx @vscode/vsce publish --packagePath pi-code-<version>.vsix
```

After publishing, verify the intended version on the Marketplace page or Gallery API. A matching `v<version>` tag independently triggers the GitHub Release workflow; CI rejects tags that disagree with `package.json`.

## Keywords

**Types / files:**
- [package.json](../../../../package.json) — script pipeline
- [.vscodeignore](../../../../.vscodeignore) — inclusion rules
- [CHANGELOG.md](../../../../CHANGELOG.md) — per-build history, contributors only
- [RELEASES.md](../../../../RELEASES.md) — user-facing notes, ships as the VSIX changelog
- [release-state.json](../../../../release-state.json) — `lastPublishedVersion` / `publishedAt`, the handout record
- [MARKETPLACE.md](../../../../MARKETPLACE.md) — VSIX README
- [scripts/bump-version.js](../../../../scripts/bump-version.js) — version bump
- [scripts/release-notes-core.js](../../../../scripts/release-notes-core.js) — filesystem-free `RELEASES.md` parsing, rolling, and verification rules
- [scripts/release-state.js](../../../../scripts/release-state.js) — read/write access to the handout record
- [scripts/verify-release-notes.js](../../../../scripts/verify-release-notes.js) — package-time release-notes gate
- [scripts/mark-released.js](../../../../scripts/mark-released.js) — records a handout
- [scripts/verify-vsix-boundary.js](../../../../scripts/verify-vsix-boundary.js) — boundary verifier
- [scripts/ensure-safe-brace-expansion.js](../../../../scripts/ensure-safe-brace-expansion.js) — install-time repair and package-time physical dependency verifier

**Methods — scripts:**
- `bump-version.js` steps: read → validate `[Unreleased]` → compute → stamp → roll `RELEASES.md` → sync-lock (optional)
- `release-notes-core.js`: `parseEntries` → `retitleTopEntry` / `insertTopEntry` → `updateForBump` (chooses between them) → `verifyReleaseNotes` (build gate) → `verifyReadyToPublish` (handout gate)
- `mark-released.js`: parse version → refuse a non-newest or unwritten entry → write `lastPublishedVersion`; idempotent when the version is already recorded
- `verify-vsix-boundary.js`: `vsce ls` → check prefixes → exit code
- `ensure-safe-brace-expansion.js`: resolve Pi's `minimatch` dependency → remove vulnerable nested copy in repair mode → require safe root fallback → accept only valid, stable SemVer at or above 5.0.8 (build metadata is allowed; prereleases are rejected)

**Attributes / markers:**
- Release SemVer: stable `MAJOR.MINOR.PATCH`; generic SemVer may also carry `-PRERELEASE` and `+BUILD` identifiers
- Date format: `YYYY-MM-DD` (ISO 8601)
- Bump-abort condition: empty `[Unreleased]`
- Boundary abort condition: any `standalone/` prefix in packaged files
- Release-notes abort conditions: top entry version ≠ `package.json` version; an entry's since-line naming something other than the entry below it; `lastPublishedVersion` with no entry of its own
- Release-notes warn-only conditions: unfilled placeholder comment; top entry with no bullets
- Entry heading form: `## <version> — <YYYY-MM-DD>`; consolidation line: `*Everything new since <version>.*`
- vsce flags: `--allow-missing-repository`, `--no-rewrite-relative-links`, `--readme-path MARKETPLACE.md`, `--changelog-path RELEASES.md`
- Packaged names: `vsce` lowercases the sourced files into `extension/readme.md` and `extension/changelog.md`

**Namespaces:**
- [scripts/](../../../../scripts/) — release automation
- [.vscodeignore](../../../../.vscodeignore) — inclusion policy
- [MARKETPLACE.md](../../../../MARKETPLACE.md), [RELEASES.md](../../../../RELEASES.md) — packaged release artefacts
- [CHANGELOG.md](../../../../CHANGELOG.md) — contributor-only build history

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
- **Pattern — `RELEASES.md` for users, `CHANGELOG.md` for contributors.** The same split applied to history: `CHANGELOG.md` stamps every build, while `RELEASES.md` carries one consolidated entry per version actually published plus the accumulating entry for the newest build. Users receive roughly one build in ten, so the per-build history reads as noise to them and cannot answer "what did this upgrade give me".
- **Rule — the top `RELEASES.md` entry accumulates; it is never a claim of publication.** The bump retitles it to the version just built, and each build with user-visible changes adds its bullets to it. Publication is asserted only by `release-state.json`, so a top entry naming a version nobody received is the pipeline working, not a defect.
- **Pitfall — never delete an entry to "fix" the file.** An entry for an unpublished version looks like a lie about what users have and invites removal; removing it throws away the consolidated prose and breaks the since-chain. Extend it and let the next bump retitle it.
- **Rule — a handout is recorded only on the maintainer's word.** `mark-released.js` exists so the fact is written deliberately; never infer it from a commit message that says "release", from a built `.vsix`, or from a finished release-looking task.
- **Rule — release-notes verification is a build gate, not a review item.** The notes ship inside the VSIX as `extension/changelog.md` and cannot be corrected afterwards without repackaging, so `verify:release-notes` runs inside `npm run package`. Structural disagreement fails the build; an unfinished-looking entry only warns, because the check cannot tell a local build from a release.
- **Pattern — mechanical parts scripted, judgement left to the author.** Heading, date, and since-line are rewritten from `release-state.json`; consolidating `CHANGELOG.md` into what a user can observe stays hand-written. `release-notes-core.js` is filesystem-free precisely so those rules are unit-tested in [scripts/release-notes-core.test.js](../../../../scripts/release-notes-core.test.js).
- **Pitfall — `/changelog` resolves by probing.** `chat-controller.ts` tries `RELEASES.md`, then `changelog.md`, then `CHANGELOG.md`, because a source checkout and an installed VSIX have different layouts and only Windows would forgive the case difference. Do not collapse it back to one hardcoded name.
- **Pattern — sync-lock is optional but recommended.** `--sync-lock` runs `npm install --package-lock-only`; guarantees `package-lock.json` reflects the new version. Skip only if you know the lock is already correct.
- **Pitfall — `code --install-extension --force` overwrites the existing install.** Fine for developer machines; do not run inside CI without a clean profile.
- **Pitfall — the boundary verifier hardcodes `['standalone/']`.** If a new subtree needs to be excluded from the VSIX, add it to the list; do not rely on `.vscodeignore` alone.
- **Pitfall — `npm run test:integration` exits 0 without running the suite.** [runTest.ts](../../../../src/test/integration/runTest.ts) spawns the `code.cmd` CLI wrapper returned by `resolveCliArgsFromVSCodeExecutablePath()`, which is meant for CLI operations such as installing an extension. On Windows, with VS Code already running, that wrapper forwards its arguments to the live instance and exits 0 immediately, so mocha never starts and the exit code proves nothing. Confirmed by adding a test that writes a marker file: exit 0, no marker. Treat the integration gate as unproven until it launches the Electron binary through `runTests()`.
- **Rule — check the VSIX size after every dependency upgrade.** A transitive dependency can add per-platform binaries that npm installs for all platforms at once; the pipeline has no size gate, so the only signal is the `vsce` summary line. See the `@esbuild` case above.
- **Pattern — deploy is local by default.** The `deploy:*` scripts install the VSIX into local VS Code; publishing requires an explicit `vsce publish --packagePath ...` maintainer action after smoke testing.
- **Rule — release tags must match the manifest.** The GitHub workflow accepts only `v<package.json version>` tags before packaging and creating a GitHub Release.
- **Rule — package the physically resolved dependency tree, not audit metadata alone.** Pi SDK 0.82.1 shrinkwrapped vulnerable `brace-expansion` 5.0.7; 0.84.4 ships the patched 5.0.9 nested instead. Install-time repair removes a nested copy only while it is vulnerable, and packaging aborts unless Pi physically resolves a safe `brace-expansion`. The guard stays because the resolution, not the upstream lock metadata, is what ships.
- **Rule — dependency changes require separate approval.** Release preparation and audit review may report dependency advisories and propose a tested upgrade, but must not change dependency versions, pins, overrides, lockfiles, or repair logic without the user's explicit approval for that separate change.

# bundle-targets-and-esbuild

## Stance

Two build targets, one repo, three constraints. First: **the extension host and every webview are different platforms** — Node.js CJS and browser IIFE respectively — so a single ambient import list is impossible. Second: **the Pi SDK is not bundled**. It's externalized in the extension-host config and resolved at runtime from the hoisted `node_modules/` tree that ships in the VSIX. Third: **`.vscodeignore` has to keep CSS in the VSIX even after excluding `src/**`**, because chat / launcher / settings / raw panels load their CSS with `vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'styles', ...)` at runtime.

## Role

[esbuild.js](../../../../esbuild.js) is a small orchestration script producing five bundles:

1. **Extension host** — [src/extension.ts](../../../../src/extension.ts) → `out/extension.js`. Format CJS, platform Node, target `node22`. External packages: `vscode`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`. Everything else is bundled (helper deps, shared code, adapters).
2. **Chat webview** — [src/webview/main.ts](../../../../src/webview/main.ts) → `out/webview/main.js`. Format IIFE, platform browser, target ES2022. No externals — the browser has to be able to run this without `require`.
3. **Launcher webview** — [src/webview/launcher.ts](../../../../src/webview/launcher.ts) → `out/webview/launcher.js`.
4. **Settings webview** — [src/webview/settings.ts](../../../../src/webview/settings.ts) → `out/webview/settings.js`.
5. **Raw Mode webview** — [src/webview/raw.ts](../../../../src/webview/raw.ts) → `out/webview/raw.js`.

`tsconfig.json` is the extension-host authority: it excludes `src/webview/**/*` from `tsc`. Webview TypeScript is therefore never type-checked as part of the Node build; esbuild handles compilation but does not enforce strict typing. In practice this means the webview code is edited with the same `tsc` running in the editor (via the IDE integration) but the production build path skips it.

`.vscodeignore` starts by excluding `src/**` so raw TypeScript never ships, then re-includes `src/webview/styles/**` because runtime CSS paths point back into `src/webview/styles/`. Any move of the styles directory has to be reflected in both `.vscodeignore` and the panel constructors.

`package.json` scripts wire everything together: `compile` runs esbuild once, `watch` runs esbuild's context/watch mode for incremental rebuilds, `package` runs a boundary verifier followed by `vsce package`, and `deploy:{patch,minor,major}` runs the full compile → prune devDeps → package → install → restore chain.

## Keywords

**Types — build orchestration:**
- `esbuild.js` — root script [esbuild.js](../../../../esbuild.js); pure Node ES module
- Extension-host config — [esbuild.js:7](../../../../esbuild.js#L7)
- Webview config template — reused for each of `main / launcher / settings / raw`

**Types — outputs:**
- `out/extension.js` — extension-host CJS bundle
- `out/extension.js.map` — sourcemap for extension-host
- `out/webview/main.js` — chat webview IIFE
- `out/webview/launcher.js` — launcher webview IIFE
- `out/webview/settings.js` — settings webview IIFE
- `out/webview/raw.js` — RawMode webview IIFE

**Methods — package scripts:**
- `npm run compile` — build once
- `npm run watch` — incremental rebuilds
- `npm run package` — `verify:vsix-boundary` + `vsce package`
- `npm run test:unit` — vitest
- `npm run test:all` — unit + integration
- `npm run deploy:patch|minor|major` — full release pipeline (see [Part XI § packaging-and-release](../../../index.md#part-xi--auxiliary-systems))

**Attributes / markers:**
- `external` — esbuild option [esbuild.js:10](../../../../esbuild.js#L10). Extension-host externals: `vscode`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`
- `format: 'cjs' | 'iife'` — CJS for Node, IIFE for browsers
- `platform: 'node' | 'browser'` — pairs with format
- `target: 'node22' | 'ES2022'` — LTS Node for host; ES2022 for VS Code webviews
- `bundle: true` — inline non-external deps
- `.vscodeignore` re-include rule — `!src/webview/styles/**` guarantees CSS reaches the VSIX

**Namespaces:**
- [esbuild.js](../../../../esbuild.js) — build orchestrator
- [tsconfig.json](../../../../tsconfig.json) — extension-host type-check scope
- [.vscodeignore](../../../../.vscodeignore) — VSIX file selection
- [package.json](../../../../package.json) — script pipeline + externals dependency declaration

## Lifecycle edges

**Depends on:**
- [activation-and-registration](../activation-and-registration/activation-and-registration.md) — extension host bundle target has to include everything `activate()` transitively imports; changing entry point layout ripples here.
- [Part V § bundled-pi-packages](../../05-pi-sdk-integration/bundled-pi-packages/bundled-pi-packages.md) — VSIX contents depend on `node_modules/` hoisting rules honored by the current `.vscodeignore`; bundled Pi extensions ride the same tree.

**Used by:**
- [activation-and-registration](../activation-and-registration/activation-and-registration.md) — activation code lives in the extension-host CJS bundle; the packaging invariants (externalized SDK, hoisted `node_modules`) determine what it can `require`.
- [bundled-pi-packages](../../05-pi-sdk-integration/bundled-pi-packages/bundled-pi-packages.md) — the packaging invariants that keep the packages inside the VSIX.
- [packaging-and-release](../../11-auxiliary-systems/packaging-and-release/packaging-and-release.md) — `compile` invokes esbuild; the CSS unignore rule is critical.
- [webview-architecture](../../06-ui-surfaces-webview/webview-architecture/webview-architecture.md) — every webview is one IIFE bundle produced by esbuild.

## See also

- **Rule — do NOT filter `node_modules/**` in `.vscodeignore`.** The VSIX must ship the hoisted transitive dependency tree intact. A rule like `node_modules/**` with an exception `!node_modules/@earendil-works/**` strips packages like `proper-lockfile`, `undici`, `glob`, and activation fails with `Cannot find package 'proper-lockfile'`. See [AGENTS.md § Packaging](../../../../AGENTS.md).
- **Rule — before `vsce package`, run `npm prune --omit=dev`.** Otherwise every devDep (esbuild, vitest, TypeScript) lands in the VSIX. After packaging, re-run `npm install` to restore.
- **Rule — CSS lives at `src/webview/styles/**` and MUST be unignored.** Panel constructors call `vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'styles', <file>.css)`. Move the directory or rename a file without updating both `.vscodeignore` and the constructors and the panel loads unstyled with no error message.
- **Pattern — externalize what VS Code resolves for you.** `vscode` is provided by the runtime, so bundling it is pointless. The Pi SDK is externalized because it is large, hoisted at the workspace root, and needed by other harnesses (Codex, Pi CLI); duplicating it into the bundle wastes bytes.
- **Pattern — one esbuild config per webview.** Each has its own entry point + output. Adding a new webview means adding a new config in [esbuild.js](../../../../esbuild.js). Do not try to share code paths across the extension host and a webview at build time; use the typed message protocol at runtime instead.
- **Pitfall — webview TS is not type-checked at build time.** `tsc` excludes `src/webview/**` and esbuild does not run the TypeScript checker. Rely on the IDE integration or explicit `tsc --noEmit -p src/webview/tsconfig.json` if that file existed. If you introduce a type error in webview code, `npm run compile` will happily produce broken JavaScript.
- **Pitfall — watch mode runs bundles in parallel.** If one fails, the others continue. Check the whole terminal on rebuild failure rather than assuming a single line of output represents the whole state.
- **Pattern — SDK is loaded at runtime.** [src/pi/session.ts](../../../../src/pi/session.ts) uses `await import('@earendil-works/pi-coding-agent')` for the same reason it's externalized — the extension host resolves the package through VS Code's own module loader against the shipped `node_modules/`.

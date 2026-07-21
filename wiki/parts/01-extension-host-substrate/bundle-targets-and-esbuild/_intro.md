# Chapter: bundle-targets-and-esbuild

Pi Code compiles into two entirely different environments from one source tree: an **extension-host CJS bundle** that runs in the VS Code Node.js host, and one **IIFE webview bundle per webview** (chat main, launcher, settings, RawMode) that runs inside a browser iframe with no `vscode` API and no Node. Both are produced by the same [esbuild.js](../../../../esbuild.js) script; `tsc` only type-checks the extension-host side (`src/webview/**` is explicitly excluded from the TypeScript compilation and only reaches JavaScript through esbuild).

This chapter documents the packaging invariants that fall out of that split: which packages are externalized, which are inlined, why the `node_modules` tree must remain intact in the VSIX, and how CSS files avoid being stripped by `.vscodeignore`.

## Article roster

- [bundle-targets-and-esbuild](bundle-targets-and-esbuild.md) — the two esbuild configs, the externalized Pi SDK dependency chain, `tsconfig.json` scoping, `.vscodeignore` invariants, and the `compile / watch / package / deploy` script chain.

## Reader task

The reader arrives here to answer one of:

- "Where do I add a new webview bundle?" (Answer: [esbuild.js](../../../../esbuild.js) — new entry with matching output path.)
- "Why can't the webview import `vscode` or `path`?" (It's a browser IIFE, not a Node module.)
- "Activation is failing with `Cannot find package 'proper-lockfile'` after `npm run package`. What went wrong?" (Someone tried to filter `node_modules/**` in `.vscodeignore`; hoisted transitive deps got stripped.)
- "The chat panel loads without styles. Why?" (`.vscodeignore` no longer unignores `src/webview/styles/**`, or the CSS path was renamed without updating panel constructors.)

## Neighborhood

- Activation code (previous chapters) lives in the extension-host CJS bundle. What it is *allowed to import* is constrained here.
- Webview code (`src/webview/**`) reaches the browser only via esbuild. Its runtime behavior belongs to [Part VI § webview-architecture](../../06-ui-surfaces-webview/webview-architecture/webview-architecture.md); this chapter stops at "the bundle is produced and shipped".
- Release cadence — VSIX packaging, deploy scripts — is treated at length in [Part XI § packaging-and-release](../../../index.md#part-xi--auxiliary-systems); this chapter overlaps with it in the sense that both describe the `npm run package` command, but the focus here is on *why* the current build is structured this way.

## Non-goals

- Individual webview UI structure (DOM, styling, DOM diffing patterns) is not covered here.
- Provider-specific packaging quirks (which pi-extension ships in the VSIX, why `pi-web-access` needs to be a production dep) belong to [Part V § bundled-pi-packages](../../05-pi-sdk-integration/bundled-pi-packages/bundled-pi-packages.md).
- CI configuration (workflows, release automation) is not part of this documentation surface.

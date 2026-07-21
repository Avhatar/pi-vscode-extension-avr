# Chapter: bundled-pi-packages

The Pi SDK's package manager can install "pi-packages" — npm modules keyed `pi-package` in their manifest — that expose Pi extensions and skills. The user-visible way is `pi install npm:<pkg>`, which writes to `~/.pi/settings.json` and populates `~/.pi/npm/node_modules/`. That's not viable inside a VSIX: user-global state, first-run network dependency, no packaging guarantee.

Instead, Pi Code **ships a hand-picked set of Pi packages inside the VSIX** and feeds their absolute paths straight to `DefaultResourceLoader.additionalExtensionPaths`. This chapter documents which packages ship, how their paths are resolved, and what to do when adding a new one.

## Article roster

- [bundled-pi-packages](bundled-pi-packages.md) — `BUNDLED_PI_PACKAGES`, `getBundledPiPackagePaths`, integration with the resource loader, and the constraints imposed on packaging.

## Reader task

The reader arrives here to answer one of:

- "How do I add a new Pi extension to Pi Code?"
- "The user sees a bundled tool disappear after `npm run package` — what went wrong?"
- "Where does the resource loader learn about the shipped packages?"
- "Why is the Pi package pinned to the VSIX release?"

## Neighborhood

- **Resource loader construction** happens in [session-lifecycle](../session-lifecycle/session-lifecycle.md); this chapter is the data source for the `additionalExtensionPaths` argument.
- **Packaging invariants** — `npm prune --omit=dev`, `.vscodeignore` `node_modules` handling — are in [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md).
- **Claude-compat MCP import** is a separate mechanism; do not confuse "bundled Pi extension" with "imported Claude Code MCP server".

## Non-goals

- Auto-updating shipped Pi packages between releases (they're pinned; cutting a Pi Code release bumps them).
- Auto-discovering Pi packages the user has installed globally via `pi install` — the extension deliberately doesn't touch user-global state.
- The Pi SDK's `pi-package` manifest schema is the SDK's concern.

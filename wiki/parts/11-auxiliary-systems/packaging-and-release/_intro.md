# Chapter: packaging-and-release

Packaging a VS Code extension is more ceremony than compilation: the VSIX must contain the right files, exclude the wrong ones, ship an accurate `CHANGELOG.md` for the marketplace listing, use a bespoke `MARKETPLACE.md` instead of the developer-facing README, and pass a boundary verifier that catches accidental inclusion of the standalone desktop project. This chapter documents the pipeline: manifest, ignore rules, deploy scripts, boundary verifier.

## Article roster

- [packaging-and-release](packaging-and-release.md) — `package.json` scripts, `.vscodeignore` invariants, `scripts/bump-version.js`, `scripts/verify-vsix-boundary.js`, `CHANGELOG.md` stamping, `MARKETPLACE.md` swap.

## Reader task

The reader arrives here to answer one of:

- "How do I ship a bug-fix release?"
- "What does `npm run deploy:patch` actually do?"
- "Why does the VSIX have a different README than the repo?"
- "How is the CHANGELOG stamped — manual or automated?"

## Neighborhood

- **Bundle production** (esbuild targets, tsconfig scope, `.vscodeignore` CSS unignore) is [Part I § bundle-targets-and-esbuild](../../01-extension-host-substrate/bundle-targets-and-esbuild/bundle-targets-and-esbuild.md).
- **Bundled Pi packages** invariants (production-dep declaration) are [Part V § bundled-pi-packages](../../05-pi-sdk-integration/bundled-pi-packages/bundled-pi-packages.md).
- **Standalone desktop build** (a separate esbuild + Electron packager) is [Part X § desktop-host-lifecycle](../../10-standalone-desktop-host/desktop-host-lifecycle/desktop-host-lifecycle.md).

## Non-goals

- Signing / notarization of the standalone desktop app — Electron-specific, not documented here.
- CI workflow definitions (`.github/workflows/*`) — out of scope; the wiki describes the *local* pipeline.
- Marketplace publisher account setup — one-time, documented outside the repo.

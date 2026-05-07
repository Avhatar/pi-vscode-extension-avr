# Changelog

All notable changes to the Pi Agent VS Code extension are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-05-07

### Added
- Versioning pipeline with `deploy:patch/minor/major` npm scripts
- `CHANGELOG.md` with Keep a Changelog format
- `scripts/bump-version.js` — auto-bump with changelog validation
- Build-deploy skill for the agent (`.pi/skills/build-deploy/`)

## [0.1.2] - 2026-05-07

### Added
- Preserve draft text in input field across tab switches
- `npm run deploy` one-command build pipeline
- Build-deploy skill for the agent (`.pi/skills/build-deploy/`)

### Fixed
- Draft input text lost when switching between agent tabs

## [0.1.1] - 2025-05-07

### Added
- Persist tabs across window reloads
- Move header action buttons to VS Code view title bar

### Fixed
- Auto-scroll when user scrolls up during streaming
- Name sessions from first user message
- Forward SecretStorage API keys into Pi AuthStorage
- VSIX packaging: include hoisted deps and webview styles
- CI: prune devDeps before vsce package

## [0.1.0] - 2025-05-06

### Added
- Initial release
- Sidebar chat UI with multi-tab sessions
- Inline diffs and file change tracking
- Tool approval with allow/deny round-trip
- Checkpoints and rollback per turn
- Settings page with API key management via SecretStorage
- Message queuing during streaming
- Mid-stream steering (Ctrl+Enter)
- Slash-command skills
- Context usage display in footer

# CRT Agent Desktop Experience Spike

This directory contains the disposable Phase 0 desktop spike for the standalone Pi Code CRT client. Electron provides a dedicated application window while a private local Node/Pi SDK host runs as its child process. The renderer uses browser technology internally, but the user-facing path does not open or depend on a normal browser window.

It is intentionally isolated from the VS Code extension build:

- it has its own `package.json`, lockfile, TypeScript configuration, build script, dependencies, and output directory;
- the root `.vscodeignore` excludes `standalone/**` from every VSIX;
- the root extension esbuild configuration has no entry point under `standalone/`;
- no extension-host or webview source imports this directory;
- the root packaging command verifies the exclusion before producing a VSIX.

Do not grow this host into a second production implementation of Pi Code. Production work should follow `.dev-notes/docs/CRT_STANDALONE_ARCHITECTURE.md` and extract a shared host used by both clients.

## Requirements

- Node.js 22.19 or newer
- At least one Pi model provider configured through Pi auth or environment variables

## Install

```powershell
cd standalone\crt-spike
npm install
npm run typecheck
```

## Build the portable EXE

```powershell
npm run package:portable
```

The double-clickable application is written to:

```text
release\Pi-CRT-Portable-0.1.0.exe
```

It does not install anything and opens a native workspace picker on launch. The executable is not code-signed, so Windows SmartScreen may show an Unknown Publisher warning during local testing. A portable Electron executable extracts its runtime to a temporary directory at launch, so its first startup can take a few seconds.

## Run from source

Choose the workspace through a native folder dialog:

```powershell
npm start
```

Or provide it explicitly:

```powershell
npm run desktop -- --cwd "X:\Projects\example"
```

Optional desktop flags:

```text
--fullscreen   Start in fullscreen mode
--devtools     Open detached Chromium developer tools
```

Inside the application:

- `F11` toggles fullscreen;
- `Escape` leaves fullscreen;
- closing the application shuts down its local Pi host;
- a second launch focuses the existing application instead of starting a second host.

The Electron renderer has Node integration disabled, context isolation enabled, and sandbox mode enabled. The Pi SDK, credentials, filesystem tools, and shell access remain in the child host process.

## Development-only browser mode

The browser path remains available only for renderer debugging:

```powershell
npm run browser -- --cwd "X:\Projects\example"
```

This command prints and opens a loopback URL. It is not the intended user experience and must not become the production launch path.

## Security boundary

The child host:

- binds to a random port on `127.0.0.1`;
- generates a host-lifetime authentication token;
- accepts one authenticated renderer at a time;
- validates the exact loopback HTTP `Host` and WebSocket `Origin`;
- runs tools with the permissions of the current user account.

The selected workspace is treated as explicitly approved for this disposable spike. It is not a sandbox.

## Supported spike behavior

- dedicated Electron application window;
- native workspace selection;
- one persistent Pi session;
- prompt submission;
- streamed assistant text and thinking;
- tool start/end indicators;
- abort;
- transport reconnection with restoration of active/idle state;
- CSS CRT effects;
- opt-in synthesized audio;
- reduced-effects and mute controls.

Not included in this disposable stage:

- an installer or code signing;
- Pi Code tabs and complete session navigation;
- steering/follow-up queues;
- ToDo and subagent UI;
- diff/checkpoint UI;
- settings and authentication UI;
- standalone LSP tools;
- production shared-host extraction.

## Local protocol

The Electron renderer currently uses the same authenticated loopback WebSocket as browser development mode. Reconnection restores whether the session is active and makes Abort available again, but this spike does not replay transcript deltas emitted while the renderer was disconnected.

Client messages:

```text
auth, prompt, abort
```

Server events:

```text
authenticated, ready, prompt_accepted, abort_accepted, agent_start,
agent_settled, text_delta, thinking_delta, tool_start, tool_end, error
```

This protocol is spike-only. The production architecture will replace the Electron production transport with a narrow preload/IPC bridge after the shared host is extracted.

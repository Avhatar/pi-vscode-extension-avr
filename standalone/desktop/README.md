# Pi Code Desktop

Production Electron host for the standalone Pi Code client. It composes the same portable chat backend used by the VS Code extension and communicates with a sandboxed browser renderer through validated Electron IPC.

The current renderer is a transport shell for Phase 4 validation. It opens on an in-application workspace welcome screen, starts the shared Agent Host only after trust approval, and confirms that the host connects and recovers. It does not yet expose the functional chat interface planned for Phase 5.

## Requirements

- Windows x64
- Node.js 22.19 or newer when building from source
- A trusted workspace directory
- Provider credentials available through the environment until the secure desktop credential UI is implemented

## Run from source

```powershell
npm install
npm run desktop
```

Use **Open Workspace** in the application welcome screen, or pass a suggested workspace explicitly:

```powershell
npm run desktop -- --cwd "X:\Projects\example"
```

Add `--devtools` to open detached Chromium developer tools.

Every launch creates an independent OS process with one workspace window. Launch the executable again, or use **New Window**, to work on another project without sharing a failure boundary. Each workspace window will contain multiple isolated chat tabs when the functional renderer is enabled.

`npm run desktop` always rebuilds the desktop bundles before launch.

## Build the portable EXE

```powershell
npm run package:portable
```

The command runs desktop tests, typechecking, and a fresh build before packaging. The output is:

```text
release\Pi-Code-Desktop-Portable-0.1.0.exe
```

The executable is portable and does not install the application. It is not code-signed, so Windows SmartScreen may report an unknown publisher. First startup can take several seconds while the portable Electron runtime is extracted.

## Security boundary

- The Electron main process owns the Pi SDK, filesystem, tools, sessions, and process lifecycle.
- The renderer has Node integration disabled, context isolation enabled, and sandbox mode enabled.
- Preload exposes only the fixed validated agent request and event channels.
- Renderer reload requests a new state snapshot and does not replay prompts or tools.
- Each desktop process has process-local Electron session/cache data; shared app state uses cross-process-serialized writes.
- Project `standalone/**` sources and dependencies are excluded from the Pi Code VSIX.

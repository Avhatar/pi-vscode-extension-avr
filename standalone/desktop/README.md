# Pi Code Desktop

Production Electron host for the standalone Pi Code client. It composes the same portable chat backend used by the VS Code extension and communicates with a sandboxed browser renderer through validated Electron IPC.

The renderer provides a responsive phosphor-terminal interface with real isolated chat tabs, a compact transcript and live thinking/tool activity, prompt queue/steer/stop controls, session history, changed-file previews, model/thinking/cache status, and a slide-out operational panel for Plan Mode, File Undo View, ToDo, subagent visibility, and per-chat tool selection. The shared Agent Host still starts only after canonical workspace trust approval. Renderer reload reconnects to the existing host and restores an authoritative snapshot without replaying prompts or tools.

Credential entry, attachments, workspace mentions, native diff opening, OS notification effects, direct ToDo editing, and subagent lifecycle/worktree actions remain later renderer slices. The packaged renderer bundles fonts, images, and sounds from the private assets submodule at [renderer/assets/](renderer/assets/).

## Requirements

- Windows x64
- Node.js 22.19 or newer when building from source
- A trusted workspace directory
- Provider credentials available through the environment until the encrypted credential settings UI is implemented

## Run from source

The renderer assets under [renderer/assets/](renderer/assets/) live in a private git submodule. Initialize it before building the desktop bundle:

```powershell
git submodule update --init standalone/desktop/renderer/assets
```

Cloning the main repository with `git clone --recurse-submodules` initializes the submodule automatically. Access to the private assets repository is required; contributors without access can still build and test the VS Code extension itself.

```powershell
npm install
npm run desktop
```

Use **Open Workspace** in the application welcome screen, or pass a suggested workspace explicitly:

```powershell
npm run desktop -- --cwd "X:\Projects\example"
```

Add `--devtools` to open detached Chromium developer tools.

Every launch creates an independent OS process with one workspace window. Launch the executable again, or use **New Window**, to work on another project without sharing a failure boundary. Canonical workspace trust is remembered in shared app data after explicit approval. Each workspace window owns multiple isolated chat tabs.

In the prompt composer, **Enter** sends while idle and queues while the agent is running, **Ctrl+Enter** steers the active turn, **Shift+Enter** inserts a newline, and **Escape** stops active work. The CRT control cycles LOW, MED, and HIGH intensity and persists locally for that desktop profile.

The control panel is snapshot-authoritative: model, thinking, Plan Mode, File Undo View, ToDo, subagent, and tool-selection mutations are rejected while the active tab is busy rather than being applied optimistically. Queued prompts retain the active Plan Mode decoration when they are dispatched after settlement.

When File Undo View is enabled, a compact changed-files bar appears above the composer. **Undo** restores the last user turn checkpoint, **Redo** reapplies the suspended checkpoint, and file rows scroll to the corresponding inline diff. Native diff-editor opening remains a later desktop slice. **Play Sound** controls local CRT interaction feedback and the authoritative turn-completion cue emitted only after `agent_settled`; OS popup notifications remain explicitly unavailable.

`npm run desktop` always rebuilds the desktop bundles before launch.

## Build the portable EXE

```powershell
npm run package:portable
```

The command runs desktop tests, typechecking, and a fresh build before packaging. The output is:

```text
release\Pi-Code-Desktop-Portable-0.1.0.exe
```

The executable is portable and does not install the application. It is not code-signed, so Windows SmartScreen may report an unknown publisher. Each portable launch extracts its Electron runtime before the window appears and can take tens of seconds on slower disks; this is separate from Agent Host connection time.

Run the packaged two-workspace acceptance smoke with:

```powershell
npm run smoke:portable
```

The smoke approves two fresh canonical workspaces, verifies independent process ownership, gracefully closes one without terminating the other, relaunches a trusted path without another prompt, and checks process cleanup. Native trust dialogs are detected by their top-level window title rather than `Get-Process.MainWindowTitle`, which may continue reporting the renderer title for Electron secondary dialogs.

## Packaged asset boundary

All files under [renderer/assets/](renderer/assets/) are bundled from the private assets submodule and copied into `dist/assets/` as-is; the desktop build does not gate any file per license. Because `standalone/**` is excluded from the VSIX, no standalone asset ever enters the VS Code extension package. The public/private repository split is the only asset boundary the desktop build relies on.

## Security boundary

- The Electron main process owns the Pi SDK, filesystem, tools, sessions, and process lifecycle.
- The renderer has Node integration disabled, context isolation enabled, and sandbox mode enabled.
- Preload exposes only the fixed validated agent request and event channels.
- Renderer reload requests a new state snapshot and does not replay prompts or tools.
- Credentials use Electron `safeStorage` and persist only encrypted bytes. When protected storage is unavailable, the welcome surface reports it and plaintext fallback remains disabled.
- Canonical workspace trust, recent workspaces, and desktop session settings persist under shared app data with cross-process-serialized writes.
- Each desktop process has process-local Electron session/cache data.
- Final-window shutdown records active turns as interrupted, aborts parent and child work, and applies a bounded process-only disposal deadline.
- Project `standalone/**` sources and dependencies are excluded from the Pi Code VSIX.

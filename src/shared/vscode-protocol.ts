/** Commands implemented only by the VS Code chat adapter. */
export type VsCodeClientMessage =
    | { type: 'openDiff'; filePath: string; toolCallId: string }
    | { type: 'openSettings' }
    | { type: 'openKeybindings' }
    | { type: 'openChangelog' }
    | { type: 'openRawView' };

/** Lifecycle and host-configuration messages specific to the VS Code webview transport. */
export type VsCodeServerMessage =
    | { type: 'ready' }
    | { type: 'rawModeEnabled'; enabled: boolean };

/**
 * Platform-neutral logging port.
 *
 * PiSessionManager and other core code depend on this interface
 * instead of a real `vscode.OutputChannel`. Adapters (e.g. the
 * VS Code output channel) implement it at composition time.
 */
export interface Logger {
    appendLine(message: string): void;
}

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export interface CodexResponseSnapshot {
    status: number;
    headers: Record<string, string>;
}

export interface CodexMonitorOptions {
    /** Called once per provider response with status and HTTP headers. */
    onResponse: (snapshot: CodexResponseSnapshot) => void;
}

/**
 * Inline Pi extension that observes Codex provider responses. Mounted via
 * DefaultResourceLoader.extensionFactories, so it lives in our process and the
 * handler closes over the host extension's state directly — no IPC, no files.
 */
export function createCodexMonitorExtension(options: CodexMonitorOptions): (pi: ExtensionAPI) => void {
    return (pi) => {
        pi.on('after_provider_response', (event) => {
            options.onResponse({ status: event.status, headers: event.headers });
        });
    };
}

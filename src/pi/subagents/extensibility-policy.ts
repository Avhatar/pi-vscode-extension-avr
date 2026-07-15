export interface RemoteAgentConfiguration {
    enabled: boolean;
    workspaceTrusted: boolean;
    endpoint?: string;
    authConfigured: boolean;
}

export type RemoteAgentGate =
    | { allowed: false; code: 'disabled' | 'untrusted-workspace' | 'missing-endpoint' | 'missing-auth' | 'protocol-deferred'; message: string }
    | { allowed: true; code: 'ready'; endpoint: string; message: string };

/** Pure policy gate: deterministic checks never contact the endpoint. Runtime
 * A2A remains disabled until a protocol adapter is explicitly configured. */
export function evaluateRemoteAgentGate(
    configuration: RemoteAgentConfiguration,
    protocolAdapterConfigured = false,
): RemoteAgentGate {
    if (!configuration.enabled) return { allowed: false, code: 'disabled', message: 'Remote agents are disabled.' };
    if (!configuration.workspaceTrusted) return { allowed: false, code: 'untrusted-workspace', message: 'Remote agents require a trusted workspace.' };
    const endpoint = configuration.endpoint?.trim();
    if (!endpoint) return { allowed: false, code: 'missing-endpoint', message: 'Remote agent endpoint is not configured.' };
    let url: URL;
    try { url = new URL(endpoint); } catch { return { allowed: false, code: 'missing-endpoint', message: 'Remote agent endpoint is invalid.' }; }
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
        return { allowed: false, code: 'missing-endpoint', message: 'Remote agent endpoint must use HTTPS unless it is loopback.' };
    }
    if (!configuration.authConfigured) return { allowed: false, code: 'missing-auth', message: 'Remote agent authentication is not configured.' };
    if (!protocolAdapterConfigured) return { allowed: false, code: 'protocol-deferred', message: 'Remote A2A protocol execution is not enabled in this release.' };
    return { allowed: true, code: 'ready', endpoint: url.toString(), message: 'Remote agent policy checks passed.' };
}

function isLoopback(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export const PHASE_8_EXTENSIBILITY_DECISIONS = Object.freeze({
    persistentAgentMemory: 'deferred-until-encrypted-scope-and-retention-policy' as const,
    remoteA2A: 'gated-but-runtime-deferred' as const,
    forkContext: 'deferred-to-avoid-parent-context-and-secret-leakage' as const,
    nestedDelegation: 'disabled-max-depth-one' as const,
});

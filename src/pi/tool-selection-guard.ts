import type { ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';

function normalizeToolName(name: string): string {
    // pi-mcp-adapter accepts hyphen/underscore aliases when resolving a tool.
    // Apply the same normalization so an alias cannot bypass the active set.
    return name.replace(/-/g, '_');
}

function getDisabledRegisteredTarget(pi: ExtensionAPI, requestedName: string): string | undefined {
    const normalizedRequested = normalizeToolName(requestedName);
    const registeredMatch = pi.getAllTools().find((tool) =>
        tool.name !== 'mcp' && normalizeToolName(tool.name) === normalizedRequested);
    if (!registeredMatch) return undefined;

    const activeNames = new Set(pi.getActiveTools().map(normalizeToolName));
    return activeNames.has(normalizeToolName(registeredMatch.name))
        ? undefined
        : registeredMatch.name;
}

/**
 * Enforce the active-tool set across meta-tools that can dispatch another
 * registered tool internally. In particular, pi-mcp-adapter's `mcp` gateway
 * can address the same MCP operation exposed as a direct Pi tool; removing the
 * direct tool schema alone must not leave that alternate execution route open.
 */
export function createToolSelectionGuard(
    onBlocked?: (gateway: string, target: string) => void,
): (pi: ExtensionAPI) => void {
    return (pi) => {
        pi.on('tool_call', (event: ToolCallEvent) => {
            if (event.toolName !== 'mcp') return;

            const requestedName = event.input.tool;
            if (typeof requestedName !== 'string' || requestedName.length === 0) return;

            const disabledTarget = getDisabledRegisteredTarget(pi, requestedName);
            if (!disabledTarget) return;

            onBlocked?.('mcp', disabledTarget);
            return {
                block: true,
                reason: `Tool "${disabledTarget}" is disabled for this chat and cannot be called through the MCP gateway. Enable it in the Tools panel to use it.`,
            };
        });
    };
}

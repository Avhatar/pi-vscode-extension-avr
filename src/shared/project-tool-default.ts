export interface ProjectToolSelectionDefault {
    version: 1;
    /** Exact allowlist that new agents should start with in this workspace. */
    enabled: string[];
}

function uniqueToolNames(values: readonly string[]): string[] {
    return [...new Set(values.filter((value) => value.length > 0))];
}

/** Validate the workspaceState payload before using it for a new agent. */
export function parseProjectToolSelectionDefault(value: unknown): ProjectToolSelectionDefault | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as { version?: unknown; enabled?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.enabled)) return undefined;
    if (!candidate.enabled.every((tool) => typeof tool === 'string' && tool.length > 0)) return undefined;
    return { version: 1, enabled: uniqueToolNames(candidate.enabled) };
}

/** Capture the exact currently enabled registry surface as a project default. */
export function createProjectToolSelectionDefault(
    registered: readonly string[],
    disabled: readonly string[],
): ProjectToolSelectionDefault {
    const disabledSet = new Set(disabled);
    return {
        version: 1,
        enabled: uniqueToolNames(registered).filter((tool) => !disabledSet.has(tool)),
    };
}

/** Convert the saved allowlist into the denylist expected by an agent session. */
export function disabledToolsFromProjectDefault(
    selection: ProjectToolSelectionDefault,
    registered: readonly string[],
): string[] {
    const enabledSet = new Set(selection.enabled);
    return uniqueToolNames(registered).filter((tool) => !enabledSet.has(tool));
}

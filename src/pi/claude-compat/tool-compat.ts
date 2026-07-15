const CLAUDE_MCP_REFERENCE = /\bmcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_*-]+)(?![A-Za-z0-9_*-])/g;
const EXPLICIT_CLAUDE_TOOL = /`(Read|Write|Edit|Bash|Grep|Glob|LS|Skill|Agent|Task|AskUserQuestion|WebFetch|WebSearch|TodoWrite|NotebookEdit)`/g;

const NATIVE_TOOL_CANDIDATES: Record<string, string[]> = {
    Read: ['read'],
    Write: ['write'],
    Edit: ['edit'],
    Bash: ['bash'],
    Grep: ['grep'],
    Glob: ['find'],
    LS: ['ls'],
    WebFetch: ['fetch_content'],
    WebSearch: ['web_search'],
    TodoWrite: ['todo'],
    Agent: ['subagent'],
    Task: ['subagent'],
};
const RUNTIME_ONLY_TOOLS = new Set(['Skill', 'AskUserQuestion', 'NotebookEdit']);

export interface ClaudeToolResolution {
    reference: string;
    status: 'native' | 'mapped' | 'proxy' | 'unavailable' | 'deferred-agent' | 'runtime-only';
    target?: string;
    message: string;
}

export function extractClaudeToolReferences(content: string, metadataValues: unknown[] = []): string[] {
    const references = new Set<string>();
    for (const match of content.matchAll(CLAUDE_MCP_REFERENCE)) references.add(match[0]);
    for (const match of content.matchAll(EXPLICIT_CLAUDE_TOOL)) references.add(match[1]);
    for (const value of metadataValues) {
        const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
        for (const entry of values) {
            if (typeof entry !== 'string') continue;
            const trimmed = entry.trim();
            if (/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_*-]+$/.test(trimmed)) {
                references.add(trimmed);
                continue;
            }
            const base = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)(?:\(|$)/)?.[1];
            if (base) references.add(base);
        }
    }
    return Array.from(references);
}

function serverPrefixes(server: string): string[] {
    const full = server.replace(/-/g, '_');
    const short = server.replace(/-?mcp$/i, '').replace(/-/g, '_') || 'mcp';
    return Array.from(new Set([full, short]));
}

function matchingTool(pattern: string, available: string[]): string | undefined {
    if (!pattern.includes('*')) return available.includes(pattern) ? pattern : undefined;
    const expression = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return available.find((name) => expression.test(name));
}

export function resolveClaudeToolReference(reference: string, availableTools: Iterable<string>): ClaudeToolResolution {
    const available = Array.from(new Set(availableTools));
    const availableLower = new Map(available.map((name) => [name.toLowerCase(), name]));
    const mcpMatch = reference.match(/^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_*-]+)$/);
    if (mcpMatch) {
        const [, server, tool] = mcpMatch;
        const direct = serverPrefixes(server)
            .map((prefix) => matchingTool(`${prefix}_${tool}`, available))
            .find((name): name is string => Boolean(name));
        if (direct) {
            return {
                reference,
                status: 'mapped',
                target: direct,
                message: `Use the available Pi MCP direct tool ${direct}.`,
            };
        }
        if (availableLower.has('mcp')) {
            return {
                reference,
                status: 'proxy',
                target: 'mcp',
                message: `Use the Pi mcp adapter to search/call server "${server}" tool "${tool}"; do not call the Claude-form name literally.`,
            };
        }
        return { reference, status: 'unavailable', message: 'No matching direct tool or Pi mcp proxy is active.' };
    }

    if (RUNTIME_ONLY_TOOLS.has(reference)) {
        const alternatives: Record<string, string> = {
            Skill: 'Load the applicable adapted skill with read or invoke its Pi slash command.',
            AskUserQuestion: 'Ask the user directly in the conversation.',
            NotebookEdit: 'No equivalent tool is currently available; use supported file tools only when the file format permits it.',
        };
        return { reference, status: 'runtime-only', message: alternatives[reference] };
    }

    const candidates = NATIVE_TOOL_CANDIDATES[reference] ?? [];
    for (const candidate of candidates) {
        const actual = availableLower.get(candidate.toLowerCase());
        if (actual) {
            return {
                reference,
                status: actual === reference ? 'native' : 'mapped',
                target: actual,
                message: `Use the available Pi tool ${actual}.`,
            };
        }
    }
    return { reference, status: 'unavailable', message: `No compatible active Pi tool was found for ${reference}.` };
}

export function resolveClaudeToolReferences(
    references: Iterable<string>,
    availableTools: Iterable<string>,
): ClaudeToolResolution[] {
    return Array.from(new Set(references), (reference) => resolveClaudeToolReference(reference, availableTools));
}

export function formatClaudeToolCompatibility(
    references: Iterable<string>,
    availableTools: Iterable<string>,
): string {
    const resolutions = resolveClaudeToolReferences(references, availableTools);
    if (resolutions.length === 0) return '';
    const lines = [
        '# Claude tool reference adaptation',
        '',
        'Interpret these source-harness names through the current Pi tool registry. The mappings do not grant permissions or add tools.',
    ];
    for (const resolution of resolutions) {
        const target = resolution.target ? ` → ${resolution.target}` : '';
        lines.push(`- ${resolution.reference}${target} [${resolution.status}]: ${resolution.message}`);
    }
    return lines.join('\n');
}

import type {
    SerializedAgentState,
    TabInfo,
    TodoSnapshot,
    ToolSelectionSnapshot,
} from '../../../src/shared/agent-protocol';

export interface RendererSnapshotSelection {
    activeTabId?: string;
    visibleState?: SerializedAgentState;
    snapshots: Record<string, SerializedAgentState>;
    tabs: TabInfo[];
}

export interface FeedItem {
    kind: 'user' | 'assistant' | 'tool' | 'error' | 'compaction';
    text: string;
    thinking?: string;
    title?: string;
    meta?: string;
    timestamp?: number;
    isError?: boolean;
}

export interface LiveToolState {
    id: string;
    name: string;
    label: string;
    status: 'running' | 'done' | 'error';
    startedAt: number;
    args?: unknown;
    output?: string;
}

export interface LivePresentation {
    streamingText: string;
    streamingThinking: string;
    isThinking: boolean;
    tools: Record<string, LiveToolState>;
}

export type ComposerAction = 'none' | 'newline' | 'prompt' | 'queue' | 'steer' | 'abort';

export const THINKING_LEVELS = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;

export function resolveNewWindowControl(input: {
    shellPhase: 'welcome' | 'opening' | 'ready' | 'error';
    agentReady: boolean;
    launchPending: boolean;
}): { visible: boolean; disabled: boolean; label: 'NEW WINDOW' | 'OPENING…' } {
    const visible = input.shellPhase === 'welcome'
        || (input.shellPhase === 'ready' && input.agentReady);
    return {
        visible,
        disabled: !visible || input.launchPending,
        label: input.launchPending ? 'OPENING…' : 'NEW WINDOW',
    };
}

export function getTodoProgress(todos: TodoSnapshot): { completed: number; total: number } {
    const active = todos.tasks.filter((task) => task.status !== 'deleted');
    return {
        completed: active.filter((task) => task.status === 'completed').length,
        total: active.length,
    };
}

export function getVisibleTools(
    selection: ToolSelectionSnapshot,
    query: string,
): Array<{ name: string; enabled: boolean }> {
    const normalizedQuery = query.trim().toLowerCase();
    const disabled = new Set(selection.disabled);
    return selection.registered
        .filter((tool) => !normalizedQuery || tool.name.toLowerCase().includes(normalizedQuery))
        .map((tool) => ({ name: tool.name, enabled: !disabled.has(tool.name) }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

export function applyStateSnapshot(
    previous: RendererSnapshotSelection | undefined,
    eventTabId: string | undefined,
    snapshot: SerializedAgentState,
): RendererSnapshotSelection {
    const snapshotTabId = eventTabId ?? snapshot.activeTabId;
    const snapshots = { ...(previous?.snapshots ?? {}) };
    if (snapshotTabId) snapshots[snapshotTabId] = snapshot;

    const activeTabId = snapshot.activeTabId ?? previous?.activeTabId;
    const tabs = snapshot.tabs ?? previous?.tabs ?? [];
    const isBackgroundSnapshot = eventTabId !== undefined
        && activeTabId !== undefined
        && eventTabId !== activeTabId;

    let visibleState = previous?.visibleState;
    if (!isBackgroundSnapshot) {
        visibleState = snapshot;
    } else if (!visibleState && activeTabId) {
        visibleState = snapshots[activeTabId];
    }

    return { activeTabId, visibleState, snapshots, tabs };
}

export function projectFeedItems(snapshot: SerializedAgentState): FeedItem[] {
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const items: FeedItem[] = [];
    const unmatchedToolCalls: ToolCallInfo[] = [];

    for (const value of messages) {
        if (!isRecord(value)) continue;
        const role = stringValue(value.role);
        const timestamp = numberValue(value.timestamp);

        if (role === 'user') {
            const text = extractText(value.content);
            if (text) items.push({ kind: 'user', text, timestamp });
            continue;
        }

        if (role === 'assistant') {
            const calls = extractToolCalls(value);
            unmatchedToolCalls.push(...calls);
            const text = extractText(value.content);
            const thinking = extractThinking(value.content);
            if (text || thinking) {
                items.push({
                    kind: 'assistant',
                    text,
                    ...(thinking ? { thinking } : {}),
                    timestamp,
                });
            }
            continue;
        }

        if (role === 'toolResult' || role === 'tool') {
            const toolCallId = stringValue(value.toolCallId) || stringValue(value.tool_call_id);
            let callIndex = toolCallId
                ? unmatchedToolCalls.findIndex((call) => call.id === toolCallId)
                : unmatchedToolCalls.length - 1;
            if (callIndex < 0) callIndex = unmatchedToolCalls.length - 1;
            const [call] = callIndex >= 0 ? unmatchedToolCalls.splice(callIndex, 1) : [];
            const name = stringValue(value.toolName) || call?.name || 'tool';
            const args = call?.args ?? value.args;
            const text = extractText(value.content) || extractText(value.result);
            const title = buildToolLabel(name, args);
            items.push({
                kind: 'tool',
                title,
                text,
                timestamp,
                isError: value.isError === true,
            });
            continue;
        }

        if (role === 'error') {
            const text = extractText(value.content)
                || stringValue(value.message)
                || stringValue(value.errorMessage);
            if (text) items.push({ kind: 'error', text, timestamp, isError: true });
            continue;
        }

        if (role === 'compactionSummary') {
            const text = stringValue(value.summary) || extractText(value.content);
            if (!text) continue;
            const before = numberValue(value.tokensBefore);
            const after = numberValue(value.tokensAfter);
            const meta = before !== undefined && after !== undefined
                ? `${before} → ${after} tokens`
                : undefined;
            items.push({ kind: 'compaction', text, meta, timestamp });
        }
    }

    if (snapshot.errorMessage && !items.some((item) => item.kind === 'error' && item.text === snapshot.errorMessage)) {
        items.push({ kind: 'error', text: snapshot.errorMessage, isError: true });
    }
    return items;
}

export function createLivePresentation(snapshot: SerializedAgentState): LivePresentation {
    const tools: Record<string, LiveToolState> = {};
    for (const tool of snapshot.pendingTools ?? []) {
        tools[tool.toolCallId] = {
            id: tool.toolCallId,
            name: tool.toolName,
            label: buildToolLabel(tool.toolName, tool.args),
            status: 'running',
            startedAt: tool.startTime,
            ...(tool.args === undefined ? {} : { args: tool.args }),
        };
    }
    return {
        streamingText: snapshot.streamingText ?? '',
        streamingThinking: snapshot.streamingThinking ?? '',
        isThinking: snapshot.isThinking ?? false,
        tools,
    };
}

export function applyAgentEvent(
    previous: LivePresentation,
    event: unknown,
    now: number,
): LivePresentation {
    if (!isRecord(event)) return previous;
    const type = stringValue(event.type);

    if (type === 'agent_start') {
        return { streamingText: '', streamingThinking: '', isThinking: false, tools: {} };
    }

    if (type === 'message_update') {
        const assistantEvent = isRecord(event.assistantMessageEvent)
            ? event.assistantMessageEvent
            : event;
        const assistantType = stringValue(assistantEvent.type);
        switch (assistantType) {
            case 'thinking_start':
                return { ...previous, isThinking: true, streamingThinking: '' };
            case 'thinking_delta':
                return {
                    ...previous,
                    streamingThinking: previous.streamingThinking + stringValue(assistantEvent.delta),
                };
            case 'thinking_end':
                return { ...previous, isThinking: false };
            case 'text_delta':
                return {
                    ...previous,
                    streamingText: previous.streamingText + stringValue(assistantEvent.delta),
                };
            default:
                return previous;
        }
    }

    if (type === 'tool_execution_start') {
        const id = stringValue(event.toolCallId);
        if (!id) return previous;
        const name = stringValue(event.toolName) || 'tool';
        const startedAt = numberValue(event.startedAt) ?? now;
        return {
            ...previous,
            tools: {
                ...previous.tools,
                [id]: {
                    id,
                    name,
                    label: buildToolLabel(name, event.args),
                    status: 'running',
                    startedAt,
                    ...(event.args === undefined ? {} : { args: event.args }),
                },
            },
        };
    }

    if (type === 'tool_execution_update') {
        const id = stringValue(event.toolCallId);
        const existing = previous.tools[id];
        if (!existing) return previous;
        const output = extractText(event.partialResult)
            || extractText(event.result)
            || extractText(event.output)
            || existing.output;
        return {
            ...previous,
            tools: {
                ...previous.tools,
                [id]: { ...existing, ...(output ? { output } : {}) },
            },
        };
    }

    if (type === 'tool_execution_end') {
        const id = stringValue(event.toolCallId);
        const existing = previous.tools[id];
        if (!existing) return previous;
        const isError = event.isError === true || event.error === true || typeof event.error === 'string';
        const output = extractText(event.result)
            || extractText(event.output)
            || stringValue(event.error)
            || existing.output;
        return {
            ...previous,
            tools: {
                ...previous.tools,
                [id]: {
                    ...existing,
                    status: isError ? 'error' : 'done',
                    ...(output ? { output } : {}),
                },
            },
        };
    }

    if (type === 'compaction_start') {
        return { ...previous, isThinking: true, streamingThinking: '', streamingText: '' };
    }
    if (type === 'compaction_end') return { ...previous, isThinking: false };
    return previous;
}

export function resolveComposerAction(input: {
    key: string;
    shiftKey: boolean;
    modifierKey: boolean;
    isBusy: boolean;
    hasText: boolean;
}): ComposerAction {
    if (input.key === 'Enter' && input.shiftKey) return 'newline';
    if (input.key === 'Escape') return input.isBusy ? 'abort' : 'none';
    if (input.key !== 'Enter' || !input.hasText) return 'none';
    if (!input.isBusy) return 'prompt';
    return input.modifierKey ? 'steer' : 'queue';
}

type ToolCallInfo = {
    id?: string;
    name: string;
    args?: unknown;
};

function extractToolCalls(message: Record<string, unknown>): ToolCallInfo[] {
    const directCalls = Array.isArray(message.toolCalls)
        ? message.toolCalls
        : Array.isArray(message.tool_calls)
            ? message.tool_calls
            : [];
    const contentCalls = Array.isArray(message.content)
        ? message.content.filter((block) => isRecord(block)
            && ['toolCall', 'tool_call', 'tool_use'].includes(stringValue(block.type)))
        : [];
    return [...directCalls, ...contentCalls]
        .filter(isRecord)
        .map((call) => {
            const fn = isRecord(call.function) ? call.function : undefined;
            return {
                id: stringValue(call.id) || stringValue(call.toolCallId) || undefined,
                name: stringValue(call.name) || stringValue(fn?.name) || 'tool',
                args: call.arguments ?? call.args ?? call.input ?? fn?.arguments,
            };
        });
}

function extractText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map((block) => {
            if (typeof block === 'string') return block;
            if (!isRecord(block)) return '';
            if (['text', 'output_text'].includes(stringValue(block.type))) {
                return stringValue(block.text) || stringValue(block.content);
            }
            return '';
        }).join('');
    }
    if (!isRecord(value)) return '';
    return stringValue(value.text)
        || extractText(value.content)
        || extractText(value.output)
        || extractText(value.result);
}

function extractThinking(value: unknown): string {
    if (!Array.isArray(value)) return '';
    return value.map((block) => {
        if (!isRecord(block) || stringValue(block.type) !== 'thinking') return '';
        return stringValue(block.thinking) || stringValue(block.text);
    }).join('');
}

function buildToolLabel(name: string, args: unknown): string {
    const normalizedName = name ? `${name[0].toUpperCase()}${name.slice(1)}` : 'Tool';
    const parsedArgs = parseArgs(args);
    const path = stringValue(parsedArgs?.path) || stringValue(parsedArgs?.file_path);
    return path ? `${normalizedName} ${path}` : normalizedName;
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
    if (isRecord(value)) return value;
    if (typeof value !== 'string') return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

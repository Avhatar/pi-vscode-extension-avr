import type { TurnCompletionOutcome } from '../../shared/turn-notification';

export interface TurnIssue {
    readonly kind: 'provider-error' | 'notice';
    readonly message?: string;
    readonly severity?: 'warning' | 'info';
}

export interface OrphanedToolInfo {
    readonly id: string;
    readonly name: string;
    readonly elapsedMs: number;
}

export function findLastAssistantMessage(messages: readonly any[]): any | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'assistant') return messages[index];
    }
    return undefined;
}

export function classifyAssistantTurnIssue(message: any): TurnIssue | undefined {
    if (!message) return undefined;
    const stopReason = message.stopReason;
    if (stopReason === 'error') {
        return { kind: 'provider-error', message: message.errorMessage };
    }
    if (stopReason !== 'aborted' && isEmptyAssistantResponse(message)) {
        return { kind: 'provider-error', message: buildEmptyResponseMessage(message) };
    }
    if (stopReason === 'length') {
        return {
            kind: 'notice',
            severity: 'warning',
            message: 'Response was cut off — the model hit its output token limit for this turn. Ask it to continue where it left off.',
        };
    }
    if (stopReason !== 'stop' && stopReason !== 'aborted' && stopReason !== undefined) {
        return {
            kind: 'notice',
            severity: 'info',
            message: `Turn ended with unexpected stop reason "${String(stopReason)}". The response above may be incomplete.`,
        };
    }
    return undefined;
}

export function turnCompletionOutcome(message: any): TurnCompletionOutcome {
    if (!message) return 'completed';
    if (message.stopReason === 'aborted') return 'stopped';
    if (message.stopReason === 'error' || isEmptyAssistantResponse(message)) return 'failed';
    if (message.stopReason === 'length') return 'truncated';
    return 'completed';
}

export function collectOrphanedTools(
    pendingTools: ReadonlyMap<string, { name: string; startTime: number }>,
    now: number,
): OrphanedToolInfo[] {
    return [...pendingTools.entries()].map(([id, tool]) => ({
        id,
        name: tool.name,
        elapsedMs: Math.max(0, now - tool.startTime),
    }));
}

export function shouldDispatchQueueAfterTerminal(
    eventType: string,
    state: { isStreamingLocal: boolean; isSessionStreaming: boolean },
): boolean {
    if (eventType === 'agent_end') return !state.isSessionStreaming;
    if (eventType === 'agent_settled') return !state.isStreamingLocal;
    return false;
}

const STATE_SYNC_EVENTS = new Set([
    'agent_start',
    'agent_end',
    'message_end',
    'turn_end',
    'compaction_start',
    'compaction_end',
]);

export function shouldSyncStateForEvent(eventType: string): boolean {
    return STATE_SYNC_EVENTS.has(eventType);
}

function isEmptyAssistantResponse(message: any): boolean {
    if (!message || message.role !== 'assistant') return false;
    const content = message.content;
    if (!Array.isArray(content) || content.length === 0) return true;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) return false;
        if (block.type === 'thinking'
            && typeof block.thinking === 'string'
            && block.thinking.length > 0) return false;
        if (block.type === 'toolCall') return false;
    }
    return true;
}

function buildEmptyResponseMessage(message: any): string {
    const provider = message?.provider ? String(message.provider) : 'the provider';
    const model = message?.model ? `/${message.model}` : '';
    return (
        `${provider}${model} returned an empty response (HTTP succeeded but no content was streamed). ` +
        'This usually means an invalid API key, exhausted quota/balance, or a region/endpoint mismatch ' +
        '(e.g. a China DashScope key on the international endpoint, or vice versa). ' +
        'Check the "Pi Code" output channel and your provider dashboard.'
    );
}

import type { TranscriptPage, TranscriptItem } from '../shared/agent-protocol';

export interface ClientTranscriptState {
    sessionId?: string;
    messages: any[];
    beforeCursor?: string;
    hasMoreBefore: boolean;
    totalUserMessages: number;
}

function toMessage(item: TranscriptItem): any {
    const message = item.message && typeof item.message === 'object'
        ? { ...item.message }
        : { role: 'unknown', content: String(item.message ?? '') };
    message._transcriptItemId = item.id;
    message._sessionEntryId = item.entryId;
    return message;
}

function pageMessages(page: TranscriptPage): any[] {
    return page.items.map(toMessage);
}

function localErrors(messages: readonly any[]): any[] {
    return messages.filter((message) => (
        message?.role === 'error' && typeof message?._transcriptItemId !== 'string'
    ));
}

export function createTranscriptState(
    page: TranscriptPage,
    preservedErrors: readonly any[] = [],
): ClientTranscriptState {
    return {
        sessionId: page.sessionId,
        messages: [...pageMessages(page), ...localErrors(preservedErrors)],
        beforeCursor: page.beforeCursor,
        hasMoreBefore: page.hasMoreBefore,
        totalUserMessages: page.totalUserMessages,
    };
}

/** Merge a refreshed latest page while retaining already-loaded ancestors. */
export function mergeTranscriptTail(
    current: ClientTranscriptState,
    page: TranscriptPage,
): ClientTranscriptState {
    const errors = localErrors(current.messages);
    if (page.reset || current.sessionId !== page.sessionId) {
        return createTranscriptState(page, errors);
    }

    const currentTranscript = current.messages.filter((message) => (
        typeof message?._transcriptItemId === 'string'
    ));
    const incoming = pageMessages(page);
    const currentIndexById = new Map<string, number>();
    currentTranscript.forEach((message, index) => {
        currentIndexById.set(message._transcriptItemId, index);
    });
    const overlapIncomingIndex = incoming.findIndex((message) => (
        currentIndexById.has(message._transcriptItemId)
    ));

    if (overlapIncomingIndex < 0) {
        return createTranscriptState(page, errors);
    }

    const overlapCurrentIndex = currentIndexById.get(
        incoming[overlapIncomingIndex]._transcriptItemId,
    )!;
    const retained = currentTranscript.slice(0, overlapCurrentIndex);
    const seen = new Set(retained.map((message) => message._transcriptItemId));
    const reconciled = [...retained];
    for (const message of incoming) {
        if (seen.has(message._transcriptItemId)) continue;
        seen.add(message._transcriptItemId);
        reconciled.push(message);
    }

    return {
        sessionId: page.sessionId,
        messages: [...reconciled, ...errors],
        beforeCursor: retained.length > 0 ? current.beforeCursor : page.beforeCursor,
        hasMoreBefore: retained.length > 0 ? current.hasMoreBefore : page.hasMoreBefore,
        totalUserMessages: page.totalUserMessages,
    };
}

/** Prepend an older page returned for the current first-entry cursor. */
export function prependTranscriptPage(
    current: ClientTranscriptState,
    page: TranscriptPage,
): ClientTranscriptState {
    const errors = localErrors(current.messages);
    if (page.reset || current.sessionId !== page.sessionId) {
        return createTranscriptState(page, errors);
    }

    const currentTranscript = current.messages.filter((message) => (
        typeof message?._transcriptItemId === 'string'
    ));
    const currentIds = new Set(currentTranscript.map((message) => message._transcriptItemId));
    const older = pageMessages(page).filter((message) => !currentIds.has(message._transcriptItemId));
    return {
        sessionId: page.sessionId,
        messages: [...older, ...currentTranscript, ...errors],
        beforeCursor: page.beforeCursor ?? current.beforeCursor,
        hasMoreBefore: page.hasMoreBefore,
        totalUserMessages: page.totalUserMessages,
    };
}

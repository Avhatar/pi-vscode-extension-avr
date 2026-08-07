export interface TranscriptSourceEntry {
    readonly id: string;
}

export interface TranscriptPageItem<TMessage = unknown> {
    readonly id: string;
    readonly entryId: string;
    readonly message: TMessage;
}

export interface TranscriptPageSlice<TMessage = unknown> {
    readonly items: TranscriptPageItem<TMessage>[];
    readonly beforeCursor?: string;
    readonly hasMoreBefore: boolean;
    readonly cursorFound: boolean;
}

export interface TranscriptPageOptions {
    readonly beforeEntryId?: string;
    readonly limit: number;
}

/**
 * Projects one backwards page from a root-to-leaf session branch.
 * Pagination counts renderable entries rather than generated messages so an
 * entry that expands into multiple messages is never split across pages.
 */
export function buildTranscriptPage<TEntry extends TranscriptSourceEntry, TMessage>(
    entries: readonly TEntry[],
    project: (entry: TEntry) => readonly TMessage[],
    options: TranscriptPageOptions,
): TranscriptPageSlice<TMessage> {
    const requestedLimit = Math.max(1, Math.trunc(options.limit));
    const requestedCursorIndex = options.beforeEntryId === undefined
        ? entries.length
        : entries.findIndex((entry) => entry.id === options.beforeEntryId);
    const cursorFound = options.beforeEntryId === undefined || requestedCursorIndex >= 0;
    const endIndex = requestedCursorIndex >= 0 ? requestedCursorIndex : entries.length;
    const selected: Array<{ entry: TEntry; messages: readonly TMessage[] }> = [];
    let scanIndex = endIndex - 1;

    while (scanIndex >= 0 && selected.length < requestedLimit) {
        const entry = entries[scanIndex--];
        const messages = project(entry);
        if (messages.length > 0) selected.unshift({ entry, messages });
    }

    let hasMoreBefore = false;
    for (let index = scanIndex; index >= 0; index--) {
        if (project(entries[index]).length > 0) {
            hasMoreBefore = true;
            break;
        }
    }

    const items = selected.flatMap(({ entry, messages }) => (
        messages.map((message, index) => ({
            id: `${entry.id}:${index}`,
            entryId: entry.id,
            message,
        }))
    ));

    return {
        items,
        beforeCursor: selected[0]?.entry.id,
        hasMoreBefore,
        cursorFound,
    };
}

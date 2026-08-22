// Chronological placement for transcript entries the session appends out of
// order.
//
// Two kinds of entry arrive later than the moment they describe:
//
// - **Compaction summaries** are written when compaction runs, but describe the
//   span of conversation before them.
// - **Background subagent notifications** are buffered while the parent turn is
//   streaming and flushed at `agent_end`. They cannot be appended when the child
//   actually settles: a custom message participates in the LLM context, and
//   inserting one between an assistant message carrying tool calls and its tool
//   results breaks the adjacency providers require. So a child that finished
//   mid-turn always lands after the parent's final message, which reads as "the
//   report came first and the children finished afterwards" — the opposite of
//   what happened.
//
// Both are repositioned here for display only. The transcript on disk keeps its
// append order and stays a valid provider context.

export interface DisplayMessageItem {
    msg: any;
    sourceIndex: number;
    /** Chronological position, when it differs from the message's own timestamp. */
    displayTimestamp?: number;
}

export const SUBAGENT_NOTIFICATION_TYPE = 'pi-code.subagent-notification';

/**
 * Orders displayable messages chronologically.
 *
 * `messages` is the raw transcript projection; `isDisplayable` filters out
 * entries the chat does not render. The result preserves transcript order for
 * everything except the two repositioned kinds above.
 */
export function orderDisplayMessages(
    messages: readonly any[],
    isDisplayable: (msg: any) => boolean,
): DisplayMessageItem[] {
    const items: DisplayMessageItem[] = [];
    const compactions: Array<{ item: DisplayMessageItem; at: number }> = [];
    const notifications: Array<{ item: DisplayMessageItem; at: number }> = [];

    for (let index = 0; index < messages.length; index++) {
        const msg = messages[index];
        if (!isDisplayable(msg)) continue;
        if ((msg?.role ?? 'unknown') === 'compactionSummary') {
            const at = typeof msg?.timestamp === 'number' ? msg.timestamp : Number.MAX_SAFE_INTEGER;
            compactions.push({ item: { msg, sourceIndex: index }, at });
            continue;
        }
        const finishedAt = subagentFinishedAt(msg);
        if (finishedAt !== undefined) {
            notifications.push({
                item: { msg, sourceIndex: index, displayTimestamp: finishedAt },
                at: finishedAt,
            });
            continue;
        }
        items.push({ msg, sourceIndex: index });
    }

    // Notifications first: they are fine-grained and land among the turn's tool
    // cards. Compaction markers are coarse and are placed against the result.
    for (const entry of notifications.sort((left, right) => left.at - right.at)) {
        insertByTimestamp(items, entry.item, entry.at);
    }

    const latestCompaction = compactions.reduce((latest, entry) => Math.max(latest, entry.at), -Infinity);
    for (const entry of compactions.sort((left, right) => left.at - right.at)) {
        insertByTimestamp(items, {
            ...entry.item,
            msg: { ...entry.item.msg, _latestCompaction: entry.at === latestCompaction },
        }, entry.at);
    }

    return items;
}

/**
 * When a subagent notification should appear, or `undefined` when it must keep
 * its append position.
 *
 * Only notifications that carry a real `finishedAt` are moved. Transcripts
 * written before that field existed have no trustworthy completion time, and
 * guessing one would scatter old cards to arbitrary places in the history.
 */
function subagentFinishedAt(msg: any): number | undefined {
    if (msg?.role !== 'custom' || msg?.customType !== SUBAGENT_NOTIFICATION_TYPE) return undefined;
    const finishedAt = msg?.details?.finishedAt;
    return typeof finishedAt === 'number' && Number.isFinite(finishedAt) ? finishedAt : undefined;
}

/** Inserts before the first item that is chronologically later. */
function insertByTimestamp(items: DisplayMessageItem[], entry: DisplayMessageItem, at: number): void {
    let insertAt = items.length;
    for (let index = 0; index < items.length; index++) {
        const timestamp = items[index].displayTimestamp ?? items[index].msg?.timestamp;
        if (typeof timestamp === 'number' && timestamp > at) {
            insertAt = index;
            break;
        }
    }
    items.splice(insertAt, 0, entry);
}

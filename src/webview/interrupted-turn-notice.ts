export const INTERRUPTED_TURN_NOTICE =
    'The previous turn was interrupted before completion, most likely by an extension host restart. '
    + 'It cannot resume automatically because tools may have side effects. Send a new message to continue.';

const NOTICE_MARKER = '_piInterruptedTurnNotice';

/** Preserves transient UI errors while representing restored interrupted turns once. */
export function mergeStateMessages(
    incomingMessages: readonly any[],
    currentMessages: readonly any[],
    interrupted: boolean,
): any[] {
    const localErrors = currentMessages.filter((message) => message?.role === 'error');
    const previousNotice = localErrors.find((message) => message?.[NOTICE_MARKER] === true);
    const otherErrors = localErrors.filter((message) => message?.[NOTICE_MARKER] !== true);
    const notice = interrupted
        ? previousNotice ?? {
            role: 'error',
            content: INTERRUPTED_TURN_NOTICE,
            severity: 'warning',
            timestamp: Date.now(),
            [NOTICE_MARKER]: true,
        }
        : undefined;

    return [
        ...incomingMessages,
        ...otherErrors,
        ...(notice ? [notice] : []),
    ];
}

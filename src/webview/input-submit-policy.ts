export interface InputSubmitContext {
    /** Raw input text; trimming is the policy's job. */
    readonly text: string;
    /** The tab runs an agent turn (`isStreamingLocal` on the host). */
    readonly isStreaming: boolean;
    /** The session compacts its context, inside or outside a turn. */
    readonly isCompacting: boolean;
    readonly hasAttachments: boolean;
    /** The user asked for mid-stream injection (Ctrl/Cmd+Enter). */
    readonly steerRequested: boolean;
}

export type InputSubmitDecision =
    | { readonly kind: 'send' }
    | { readonly kind: 'queue' }
    | { readonly kind: 'steer' }
    | { readonly kind: 'compact' }
    | { readonly kind: 'reject'; readonly message: string }
    | { readonly kind: 'ignore' };

export function isCompactCommandText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === '/compact' || trimmed.startsWith('/compact ');
}

/**
 * Decide how a submitted input should reach the agent.
 *
 * Compaction counts as busy. It runs both inside a turn (Pi's overflow check
 * after an assistant message, which lands after `agent_end` has already cleared
 * the streaming flag) and outside one (a direct `/compact`). In both cases the
 * SDK rejects a plain prompt with its `streamingBehavior` error, so anything
 * typed then belongs in the queue rather than on the wire.
 */
export function decideInputSubmit(context: InputSubmitContext): InputSubmitDecision {
    const text = context.text.trim();
    const busy = context.isStreaming || context.isCompacting;
    if (!busy) return { kind: 'send' };

    if (isCompactCommandText(text)) {
        if (context.hasAttachments) {
            return {
                kind: 'reject',
                message: 'Slash commands cannot include attachments. Remove attachments before running /compact.',
            };
        }
        if (context.isCompacting) {
            return {
                kind: 'reject',
                message: 'Compaction is already running. Wait for it to finish before starting another one.',
            };
        }
        return { kind: 'compact' };
    }

    if (context.hasAttachments) {
        return {
            kind: 'reject',
            message: 'Attachments cannot be queued while the agent is busy. Send them after the current response finishes.',
        };
    }

    if (!text) return { kind: 'ignore' };

    // Steering injects into the current turn; without a turn there is nothing to
    // inject into, so a compaction-time Ctrl+Enter queues like a plain Enter.
    if (context.steerRequested && context.isStreaming) return { kind: 'steer' };
    return { kind: 'queue' };
}

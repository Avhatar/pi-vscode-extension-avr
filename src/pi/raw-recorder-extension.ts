import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RAW_HARNESS_EVENT_KINDS } from '../shared/raw-protocol';
import type { RawRecorder } from '../core/raw/raw-recorder';

/**
 * Inline Pi extension that mirrors every event exposed via {@link ExtensionAPI}
 * into the shared {@link RawRecorder}. The recorder captures everything: system
 * prompts, tool schemas, message history, provider request payload, provider
 * response headers, streamed chunks, tool calls/results — verbatim, in the
 * order events fire.
 *
 * Handlers return `undefined` so no side effect is imposed on the agent's
 * control flow (no headers deleted, no tool calls blocked, no messages
 * rewritten). If Pi later adds a new event kind, expand
 * {@link RAW_HARNESS_EVENT_KINDS} rather than editing this factory.
 */
export function createRawRecorderExtension(recorder: RawRecorder): (pi: ExtensionAPI) => void {
    return (pi) => {
        for (const kind of RAW_HARNESS_EVENT_KINDS) {
            const handler = (event: unknown) => {
                recorder.record(kind, event);
                return undefined as any;
            };
            // ExtensionAPI.on is overloaded per event kind; a runtime cast is
            // required because we iterate the union rather than binding each
            // discriminator statically.
            (pi.on as unknown as (kind: string, handler: (event: unknown) => unknown) => void)(
                kind,
                handler,
            );
        }
    };
}

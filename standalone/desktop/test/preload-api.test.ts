import { describe, expect, it, vi } from 'vitest';
import {
    DESKTOP_AGENT_EVENT_CHANNEL,
    DESKTOP_AGENT_REQUEST_CHANNEL,
} from '../src/ipc-contract';
import { createDesktopPreloadApi } from '../src/preload-api';

describe('desktop preload API', () => {
    it('uses only the fixed agent request and event channels', async () => {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const ipc = {
            invoke: vi.fn(async () => ({ ok: true })),
            on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
                listeners.set(channel, listener);
            }),
            removeListener: vi.fn((channel: string) => { listeners.delete(channel); }),
        };
        const api = createDesktopPreloadApi(ipc, 'document-1');
        const eventListener = vi.fn();
        const unsubscribe = api.subscribe(eventListener);

        await expect(api.request({ requestId: 'request-1' })).resolves.toEqual({ ok: true });
        expect(ipc.invoke).toHaveBeenCalledWith(
            DESKTOP_AGENT_REQUEST_CHANNEL,
            {
                documentId: 'document-1',
                request: { requestId: 'request-1' },
            },
        );
        listeners.get(DESKTOP_AGENT_EVENT_CHANNEL)?.({}, { type: 'event' });
        expect(eventListener).toHaveBeenCalledWith({ type: 'event' });

        unsubscribe();
        expect(ipc.removeListener).toHaveBeenCalledWith(
            DESKTOP_AGENT_EVENT_CHANNEL,
            expect.any(Function),
        );
    });
});

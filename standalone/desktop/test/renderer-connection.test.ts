import { describe, expect, it, vi } from 'vitest';
import { createSuccessResponse } from '../../../src/shared/connection-protocol';
import type { DesktopPreloadApi } from '../src/ipc-contract';
import { DesktopAgentConnection } from '../src/renderer-connection';

describe('DesktopAgentConnection', () => {
    it('uses correlated invoke responses and sequenced preload events', async () => {
        let emit!: (value: unknown) => void;
        const received: unknown[] = [];
        const api: Pick<DesktopPreloadApi, 'request' | 'subscribe'> = {
            request: vi.fn(async (value: any) => createSuccessResponse(value, { accepted: true })),
            subscribe: vi.fn((listener) => {
                emit = listener;
                return () => undefined;
            }),
        };
        const connection = new DesktopAgentConnection(api, { clientId: 'desktop-client' });
        connection.subscribe((event) => received.push(event));

        await expect(connection.request({ type: 'getState' })).resolves.toMatchObject({
            ok: true,
            result: { accepted: true },
        });
        emit({
            protocolVersion: 2,
            clientId: 'desktop-client',
            epoch: 'epoch-1',
            sequence: 1,
            type: 'error',
            payload: { message: 'event' },
        });
        expect(received).toHaveLength(1);
        await connection.close();
    });
});

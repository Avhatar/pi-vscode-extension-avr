import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSession } from '../../setup';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

describe('Session management', () => {
    let session: AgentSession;

    beforeAll(async () => {
        session = await createTestSession();
    }, 60_000);

    afterAll(() => {
        session?.dispose();
    });

    it('session has an id', () => {
        expect(session.sessionId).toBeDefined();
        expect(typeof session.sessionId).toBe('string');
        expect(session.sessionId.length).toBeGreaterThan(0);
    });

    it('session has a session file', () => {
        expect(session.sessionFile).toBeDefined();
    });

    it('getSessionStats returns stats', () => {
        const stats = session.getSessionStats();
        expect(stats).toBeDefined();
    });

    it('can set session name', () => {
        session.setSessionName('Test Session');
        expect(session.sessionName).toBe('Test Session');
    });

    it('messages persist across prompts', async () => {
        await session.prompt('say "session-test-marker"');
        const msgs = session.messages;
        expect(msgs.length).toBeGreaterThanOrEqual(2);
    }, 120_000);
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSession } from '../../setup';
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';

describe('Pi Code session', () => {
    let session: AgentSession;

    beforeAll(async () => {
        session = await createTestSession();
    }, 60_000);

    afterAll(() => {
        session?.dispose();
    });

    it('session is created and has a model', () => {
        expect(session).toBeDefined();
        const model = session.model;
        expect(model).toBeDefined();
        expect(typeof model!.provider).toBe('string');
        expect(typeof model!.id).toBe('string');
    });

    it('session has active tools', () => {
        const tools = session.getActiveToolNames();
        expect(tools.length).toBeGreaterThan(0);
    });

    it('session has a sessionId', () => {
        expect(session.sessionId).toBeDefined();
        expect(typeof session.sessionId).toBe('string');
    });

    it('can send a prompt and receive streaming events', async () => {
        const events: AgentSessionEvent[] = [];
        const unsub = session.subscribe((e) => events.push(e));

        await session.prompt('respond with only the word "test"');

        unsub();

        const types = events.map(e => e.type);
        expect(types).toContain('agent_start');
        expect(types).toContain('message_start');
        expect(types).toContain('message_update');
        expect(types).toContain('message_end');
        expect(types).toContain('turn_end');
        expect(types).toContain('agent_end');
    }, 120_000);

    it('messages are persisted after prompt', () => {
        const msgs = session.messages;
        expect(msgs.length).toBeGreaterThan(0);
        const hasUser = msgs.some(m => m.role === 'user');
        const hasAssistant = msgs.some(m => m.role === 'assistant');
        expect(hasUser).toBe(true);
        expect(hasAssistant).toBe(true);
    });

    it('isStreaming is false after prompt completes', () => {
        expect(session.isStreaming).toBe(false);
    });
});

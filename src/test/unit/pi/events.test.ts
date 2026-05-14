import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventRouter } from '../../../pi/events';
import { createTestSession } from '../../setup';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

describe('EventRouter', () => {
    it('dispatches events to global handlers', () => {
        const router = new EventRouter();
        const received: any[] = [];
        router.onAll((e) => received.push(e));

        const fakeEvent = { type: 'agent_start' } as AgentSessionEvent;
        router.dispatch(fakeEvent);

        expect(received).toHaveLength(1);
        expect(received[0].type).toBe('agent_start');
    });

    it('dispatches events to type-specific handlers', () => {
        const router = new EventRouter();
        const starts: any[] = [];
        const ends: any[] = [];
        router.on('agent_start', (e) => starts.push(e));
        router.on('agent_end', (e) => ends.push(e));

        router.dispatch({ type: 'agent_start' } as AgentSessionEvent);
        router.dispatch({ type: 'agent_end', messages: [] } as any);

        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
    });

    it('unsubscribe works', () => {
        const router = new EventRouter();
        const received: any[] = [];
        const unsub = router.onAll((e) => received.push(e));

        router.dispatch({ type: 'agent_start' } as AgentSessionEvent);
        expect(received).toHaveLength(1);

        unsub();
        router.dispatch({ type: 'agent_start' } as AgentSessionEvent);
        expect(received).toHaveLength(1);
    });

    it('swallows listener errors without crashing', () => {
        const router = new EventRouter();
        const received: any[] = [];
        router.onAll(() => { throw new Error('boom'); });
        router.onAll((e) => received.push(e));

        router.dispatch({ type: 'agent_start' } as AgentSessionEvent);
        expect(received).toHaveLength(1);
    });

    it('clear removes all handlers', () => {
        const router = new EventRouter();
        const received: any[] = [];
        router.onAll((e) => received.push(e));
        router.on('agent_start', (e) => received.push(e));
        router.clear();

        router.dispatch({ type: 'agent_start' } as AgentSessionEvent);
        expect(received).toHaveLength(0);
    });
});

describe('EventRouter with real Pi session', () => {
    let session: AgentSession;

    beforeAll(async () => {
        session = await createTestSession();
    }, 60_000);

    afterAll(() => {
        session?.dispose();
    });

    it('receives real agent events through the router', async () => {
        const router = new EventRouter();
        const events: AgentSessionEvent[] = [];
        router.onAll((e) => events.push(e));

        const unsub = session.subscribe(router.asSessionListener());

        await session.prompt('respond with only the word "hello"');

        unsub();

        const eventTypes = events.map(e => e.type);
        expect(eventTypes).toContain('agent_start');
        expect(eventTypes).toContain('agent_end');
    }, 120_000);
});

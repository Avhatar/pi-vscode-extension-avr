import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSession } from '../../setup';
import { EventRouter } from '../../../pi/events';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

describe('Tool execution events', () => {
    let session: AgentSession;

    beforeAll(async () => {
        session = await createTestSession();
    }, 60_000);

    afterAll(() => {
        session?.dispose();
    });

    it('tool events fire when agent uses tools', async () => {
        const router = new EventRouter();
        const toolEvents: AgentSessionEvent[] = [];

        router.on('tool_execution_start', (e) => toolEvents.push(e));
        router.on('tool_execution_end', (e) => toolEvents.push(e));
        router.on('tool_execution_update', (e) => toolEvents.push(e));

        const unsub = session.subscribe(router.asSessionListener());

        await session.prompt('list files in the current directory using the bash tool. only run "ls" and nothing else.');

        unsub();

        const starts = toolEvents.filter(e => e.type === 'tool_execution_start');
        const ends = toolEvents.filter(e => e.type === 'tool_execution_end');

        expect(starts.length).toBeGreaterThan(0);
        expect(ends.length).toBeGreaterThan(0);

        const startEvent = starts[0] as any;
        expect(startEvent.toolName).toBeDefined();
        expect(startEvent.toolCallId).toBeDefined();
    }, 120_000);
});

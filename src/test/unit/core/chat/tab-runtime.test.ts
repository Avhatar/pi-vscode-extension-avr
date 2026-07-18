import { describe, expect, it, vi } from 'vitest';
import { TabRuntime } from '../../../../core/chat/tab-runtime';
import type { ProjectToolSelectionDefault } from '../../../../shared/project-tool-default';

function createResources(order: string[] = []) {
    return {
        session: { dispose: vi.fn(async () => { order.push('session'); }) },
        diffManager: { dispose: vi.fn(() => { order.push('diff'); }) },
        checkpointManager: { dispose: vi.fn(() => { order.push('checkpoint'); }) },
    };
}

function createRuntime(id = 'tab-1', order: string[] = []) {
    return new TabRuntime({ id, ...createResources(order) });
}

describe('TabRuntime', () => {
    it('initializes a complete independent tab projection', () => {
        const first = createRuntime('tab-a');
        const second = createRuntime('tab-b');

        expect(first).toMatchObject({
            id: 'tab-a',
            name: 'New Agent',
            turnCounter: 0,
            suspendedMessages: [],
            streamingText: '',
            streamingThinking: '',
            isThinking: false,
            thinkingStartTime: 0,
            streamingThinkingDuration: 0,
            agentStartTime: 0,
            totalTurnDurationMs: 0,
            hasNotification: false,
            queuedMessages: [],
            isStreamingLocal: false,
            isCompacting: false,
            errorReportedThisRun: false,
            lastTurnEndAt: 0,
            maxIdleGapMs: 0,
            cacheEffective: 'short',
        });
        expect(first.messageMeta).toEqual(new Map());
        expect(first.pendingTools).toEqual(new Map());

        first.queuedMessages.push('first-only');
        first.messageMeta.set(1, { thinkingDurationSec: 1, messageEndTime: 2 });
        first.pendingTools.set('call-1', { name: 'read', startTime: 3 });

        expect(second.queuedMessages).toEqual([]);
        expect(second.messageMeta.size).toBe(0);
        expect(second.pendingTools.size).toBe(0);
    });

    it('unsubscribes each registered listener exactly once', () => {
        const runtime = createRuntime();
        const first = vi.fn();
        const second = vi.fn();
        runtime.addSubscription(first);
        runtime.addSubscription(second);

        runtime.unsubscribe();
        runtime.unsubscribe();

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
    });

    it('resets the existing new/load session projection without replacing its resources', () => {
        const originalDefault: ProjectToolSelectionDefault = { version: 1, enabled: ['read'] };
        const nextDefault: ProjectToolSelectionDefault = { version: 1, enabled: ['read', 'grep'] };
        const resources = createResources();
        const runtime = new TabRuntime({ id: 'tab-1', ...resources, projectToolDefault: originalDefault });

        runtime.name = 'Previous chat';
        runtime.turnCounter = 4;
        runtime.suspendedMessages = [{ role: 'assistant' }];
        runtime.streamingText = 'answer';
        runtime.streamingThinking = 'thought';
        runtime.isThinking = true;
        runtime.thinkingStartTime = 10;
        runtime.streamingThinkingDuration = 11;
        runtime.agentStartTime = 12;
        runtime.totalTurnDurationMs = 13;
        runtime.messageMeta.set(0, { thinkingDurationSec: 1, messageEndTime: 2 });
        runtime.queuedMessages.push('queued');
        runtime.isStreamingLocal = true;
        runtime.isCompacting = true;
        runtime.lastTurnEndAt = 14;
        runtime.maxIdleGapMs = 15;
        runtime.hasNotification = true;
        runtime.errorReportedThisRun = true;
        runtime.pendingTools.set('call-1', { name: 'read', startTime: 16 });
        runtime.codexTurnBaseline = null;
        runtime.codexTurnModelId = 'codex-model';
        runtime.cacheEffective = 'long';
        const armedToken = runtime.turnNotificationGate.arm();
        expect(armedToken).toBeGreaterThan(0);

        runtime.resetSessionProjection(nextDefault);

        expect(runtime).toMatchObject({
            name: 'New Agent',
            turnCounter: 0,
            suspendedMessages: [],
            streamingText: '',
            streamingThinking: '',
            isThinking: false,
            thinkingStartTime: 0,
            streamingThinkingDuration: 0,
            agentStartTime: 0,
            totalTurnDurationMs: 0,
            queuedMessages: [],
            isStreamingLocal: false,
            isCompacting: false,
            lastTurnEndAt: 0,
            maxIdleGapMs: 0,
            projectToolDefault: nextDefault,
        });
        expect(runtime.session).toBe(resources.session);
        expect(runtime.diffManager).toBe(resources.diffManager);
        expect(runtime.checkpointManager).toBe(resources.checkpointManager);
        expect(runtime.messageMeta.size).toBe(0);
        expect(runtime.hasNotification).toBe(true);
        expect(runtime.errorReportedThisRun).toBe(true);
        expect(runtime.pendingTools.get('call-1')).toEqual({ name: 'read', startTime: 16 });
        expect(runtime.codexTurnBaseline).toBeNull();
        expect(runtime.codexTurnModelId).toBe('codex-model');
        expect(runtime.cacheEffective).toBe('long');
        runtime.turnNotificationGate.onAgentStart();
        runtime.turnNotificationGate.onAgentEnd({ tabName: 'Reset tab', outcome: 'completed' });
        expect(runtime.turnNotificationGate.onAgentSettled()).toBeUndefined();

        runtime.resetSessionProjection(undefined);
        expect(runtime.projectToolDefault).toBeUndefined();
    });

    it('disposes subscriptions and resources once in ownership order', async () => {
        const order: string[] = [];
        const runtime = createRuntime('tab-1', order);
        runtime.addSubscription(() => { order.push('subscription'); });

        await Promise.all([runtime.disposeResources(), runtime.disposeResources()]);

        expect(order).toEqual(['subscription', 'diff', 'checkpoint', 'session']);
        expect(runtime.diffManager.dispose).toHaveBeenCalledOnce();
        expect(runtime.checkpointManager.dispose).toHaveBeenCalledOnce();
        expect(runtime.session.dispose).toHaveBeenCalledOnce();
    });

    it('attempts every teardown stage once and reports the first failure', async () => {
        const order: string[] = [];
        const runtime = new TabRuntime({
            id: 'tab-1',
            session: {
                dispose: vi.fn(async () => {
                    order.push('session');
                    throw new Error('session failed');
                }),
            },
            diffManager: {
                dispose: vi.fn(() => {
                    order.push('diff');
                    throw new Error('diff failed');
                }),
            },
            checkpointManager: {
                dispose: vi.fn(() => {
                    order.push('checkpoint');
                    throw new Error('checkpoint failed');
                }),
            },
        });
        runtime.addSubscription(() => {
            order.push('subscription-1');
            throw new Error('subscription failed');
        });
        runtime.addSubscription(() => { order.push('subscription-2'); });

        await expect(runtime.disposeResources()).rejects.toThrow('subscription failed');
        await expect(runtime.disposeResources()).rejects.toThrow('subscription failed');

        expect(order).toEqual(['subscription-1', 'subscription-2', 'diff', 'checkpoint', 'session']);
        expect(runtime.diffManager.dispose).toHaveBeenCalledOnce();
        expect(runtime.checkpointManager.dispose).toHaveBeenCalledOnce();
        expect(runtime.session.dispose).toHaveBeenCalledOnce();
    });

    it('does not affect another tab when one runtime is disposed', async () => {
        const first = createRuntime('tab-a');
        const second = createRuntime('tab-b');
        second.queuedMessages.push('keep');
        const secondUnsubscribe = vi.fn();
        second.addSubscription(secondUnsubscribe);

        await first.disposeResources();

        expect(second.queuedMessages).toEqual(['keep']);
        expect(secondUnsubscribe).not.toHaveBeenCalled();
        expect(second.session.dispose).not.toHaveBeenCalled();
    });
});

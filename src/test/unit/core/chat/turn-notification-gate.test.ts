import { describe, expect, it } from 'vitest';
import { TurnNotificationGate } from '../../../../core/chat/turn-notification-gate';
import type { TurnCompletionInfo } from '../../../../shared/turn-notification';

function completion(outcome: TurnCompletionInfo['outcome'] = 'completed'): TurnCompletionInfo {
    return { tabName: 'Task', outcome, durationMs: 1_000 };
}

describe('TurnNotificationGate', () => {
    it('returns one completion for an explicitly armed parent task', () => {
        const gate = new TurnNotificationGate();
        gate.arm();
        gate.onAgentStart();
        gate.onAgentEnd(completion());

        expect(gate.onAgentSettled()).toEqual(completion());
        expect(gate.onAgentSettled()).toBeUndefined();
    });

    it('ignores internal unarmed parent runs', () => {
        const gate = new TurnNotificationGate();
        gate.onAgentStart();
        gate.onAgentEnd(completion());

        expect(gate.onAgentSettled()).toBeUndefined();
    });

    it('keeps the latest completion across retries and continuations', () => {
        const gate = new TurnNotificationGate();
        gate.arm();
        gate.onAgentStart();
        gate.onAgentEnd(completion('failed'));
        gate.onAgentStart();
        gate.onAgentEnd(completion('completed'));

        expect(gate.onAgentSettled()).toEqual(completion('completed'));
    });

    it('cancels an unused arm without affecting a newer queued-task arm', () => {
        const gate = new TurnNotificationGate();
        const first = gate.arm();
        gate.arm();
        gate.cancelArm(first);
        gate.onAgentStart();
        gate.onAgentEnd(completion());

        expect(gate.onAgentSettled()).toEqual(completion());
    });

    it('preserves an arm for the next task through continuations and settlement', () => {
        const gate = new TurnNotificationGate();
        gate.arm();
        gate.onAgentStart();
        gate.onAgentEnd(completion());
        gate.arm();
        gate.onAgentStart(); // continuation of the current run must not consume the next arm

        expect(gate.onAgentSettled()).toEqual(completion());

        gate.onAgentStart();
        gate.onAgentEnd(completion('stopped'));
        expect(gate.onAgentSettled()).toEqual(completion('stopped'));
    });

    it('reset clears both active and pending task eligibility', () => {
        const gate = new TurnNotificationGate();
        gate.arm();
        gate.onAgentStart();
        gate.onAgentEnd(completion());
        gate.arm();
        gate.reset();

        expect(gate.onAgentSettled()).toBeUndefined();
        gate.onAgentStart();
        gate.onAgentEnd(completion());
        expect(gate.onAgentSettled()).toBeUndefined();
    });
});

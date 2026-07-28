import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_RUNTIME_PORTS, type SessionRuntimePorts } from '../../../core/ports/session-platform';
import { createRawRecorderExtension } from '../../../pi/raw-recorder-extension';
import { PiSessionManager } from '../../../pi/session';

describe('RawMode capture gate', () => {
    it('suppresses harness events while disabled and resumes without rebuilding handlers', () => {
        let enabled = false;
        const handlers = new Map<string, (event: unknown) => unknown>();
        const recorder = { record: vi.fn() };
        const extension = createRawRecorderExtension(recorder as any, () => enabled);

        extension({
            on: (kind: string, handler: (event: unknown) => unknown) => {
                handlers.set(kind, handler);
            },
        } as any);

        expect(handlers.get('agent_start')?.({ type: 'agent_start' })).toBeUndefined();
        expect(recorder.record).not.toHaveBeenCalled();

        enabled = true;
        expect(handlers.get('agent_start')?.({ type: 'agent_start' })).toBeUndefined();
        expect(recorder.record).toHaveBeenCalledWith('agent_start', { type: 'agent_start' });
    });

    it('suppresses session-only events immediately when the setting is disabled', async () => {
        let enabled = false;
        const settings = {
            get: (key: string, fallback: unknown) => key === 'rawMode.enabled' ? enabled : fallback,
        };
        const ports: SessionRuntimePorts = {
            ...DEFAULT_SESSION_RUNTIME_PORTS,
            settings: settings as SessionRuntimePorts['settings'],
        };
        const manager = new PiSessionManager(
            { appendLine: vi.fn() },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            ports,
        ) as any;
        const recorder = { record: vi.fn() };
        manager._currentRawRecorder = recorder;

        manager.events.dispatch({ type: 'queue_update' } as any);
        expect(recorder.record).not.toHaveBeenCalled();

        enabled = true;
        manager.events.dispatch({ type: 'queue_update' } as any);
        expect(recorder.record).toHaveBeenCalledWith('queue_update', { type: 'queue_update' });

        manager._currentRawRecorder = undefined;
        await manager.dispose();
    });
});

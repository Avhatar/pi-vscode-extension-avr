import { describe, expect, it } from 'vitest';
import { projectLauncherState } from '../../../../core/chat/launcher-projection';

describe('portable launcher projection', () => {
    const first = {
        id: 'first',
        name: 'First',
        isStreamingLocal: false,
        isCompacting: false,
        hasNotification: false,
        sessionPath: '/sessions/first.jsonl',
        modelLabel: 'model-a',
    };
    const second = {
        id: 'second',
        name: 'Second',
        isStreamingLocal: false,
        isCompacting: true,
        hasNotification: true,
        sessionPath: '/sessions/second.jsonl',
        modelLabel: 'model-b',
    };
    const notificationSettings = { showPopup: true, playSound: false };
    const active = {
        todos: { tasks: [], nextId: 1 },
        todoEnabled: true,
        planModeEnabled: false,
        fileUndoViewEnabled: true,
        subagents: {
            enabled: true,
            toggleDisabled: false,
            activeCount: 0,
            queuedCount: 0,
            runs: [],
        },
        toolSelection: { registered: [{ name: 'read' }], disabled: ['write'] },
    };

    it('projects only visible tabs and marks matching history sessions open', () => {
        const state = projectLauncherState({
            tabs: [first, second],
            visibleTabIds: new Set(['second']),
            recentSessions: [
                { path: '/sessions/first.jsonl', name: 'First history' },
                { path: '/sessions/second.jsonl', name: 'Second history', lastModified: 5 },
            ],
            activeTabId: 'second',
            notificationSettings,
            active,
        });

        expect(state.tabs).toEqual([{
            id: 'second',
            name: 'Second',
            isStreaming: true,
            hasNotification: true,
            isOpen: true,
            modelLabel: 'model-b',
        }]);
        expect(state.recentSessions).toEqual([
            {
                path: '/sessions/first.jsonl',
                name: 'First history',
                firstMessage: undefined,
                lastModified: undefined,
                isOpen: false,
            },
            {
                path: '/sessions/second.jsonl',
                name: 'Second history',
                firstMessage: undefined,
                lastModified: 5,
                isOpen: true,
            },
        ]);
        expect(state).toMatchObject({
            notificationSettings,
            todos: active.todos,
            todoEnabled: true,
            todoToggleDisabled: true,
            planModeEnabled: false,
            planModeToggleDisabled: true,
            fileUndoViewEnabled: true,
            subagents: { enabled: true, toggleDisabled: true },
            toolSelection: { disabled: ['write'], toggleDisabled: true },
        });
    });

    it('omits active-tab projections when the active runtime has no visible panel', () => {
        const state = projectLauncherState({
            tabs: [first],
            visibleTabIds: new Set(),
            recentSessions: [],
            activeTabId: 'first',
            notificationSettings,
            active,
        });

        expect(state.tabs).toEqual([]);
        expect(state).not.toHaveProperty('todos');
        expect(state).not.toHaveProperty('subagents');
        expect(state).not.toHaveProperty('toolSelection');
    });
});

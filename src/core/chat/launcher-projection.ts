import type {
    LauncherState,
    LauncherSubagentSnapshot,
    TodoSnapshot,
    ToolSelectionSnapshot,
    TurnNotificationSettings,
} from '../../shared/protocol';

export interface LauncherProjectionTab {
    readonly id: string;
    readonly name: string;
    readonly isStreamingLocal: boolean;
    readonly isCompacting: boolean;
    readonly hasNotification: boolean;
    readonly sessionPath?: string;
    readonly modelLabel?: string;
}

export interface LauncherProjectionSession {
    readonly path: string;
    readonly name?: string;
    readonly firstMessage?: string;
    readonly lastModified?: number;
}

export interface ActiveLauncherProjection {
    readonly todos: TodoSnapshot;
    readonly todoEnabled: boolean;
    readonly planModeEnabled: boolean;
    readonly fileUndoViewEnabled: boolean;
    readonly subagents: LauncherSubagentSnapshot;
    readonly toolSelection: Omit<ToolSelectionSnapshot, 'toggleDisabled'>;
}

export interface LauncherProjectionInput {
    readonly tabs: readonly LauncherProjectionTab[];
    readonly visibleTabIds: ReadonlySet<string>;
    readonly recentSessions: readonly LauncherProjectionSession[];
    readonly activeTabId: string;
    readonly notificationSettings: TurnNotificationSettings;
    readonly active?: ActiveLauncherProjection;
}

export type PortableLauncherProjection = Omit<
    LauncherState,
    'historyCollapsed' | 'notificationsCollapsed' | 'todoCollapsed' | 'subagentsCollapsed' | 'toolsCollapsed'
>;

/** Project launcher data without owning panel discovery, history I/O, or host effects. */
export function projectLauncherState(input: LauncherProjectionInput): PortableLauncherProjection {
    const tabs = input.tabs
        .filter((tab) => input.visibleTabIds.has(tab.id))
        .map((tab) => ({
            id: tab.id,
            name: tab.name,
            isStreaming: tab.isStreamingLocal || tab.isCompacting,
            hasNotification: tab.hasNotification,
            isOpen: true,
            ...(tab.modelLabel === undefined ? {} : { modelLabel: tab.modelLabel }),
        }));
    const openPaths = new Set(
        input.tabs
            .filter((tab) => input.visibleTabIds.has(tab.id))
            .map((tab) => tab.sessionPath)
            .filter((path): path is string => Boolean(path)),
    );
    const recentSessions = input.recentSessions.map((session) => ({
        path: session.path,
        name: session.name,
        firstMessage: session.firstMessage,
        lastModified: session.lastModified,
        isOpen: openPaths.has(session.path),
    }));
    const base = {
        tabs,
        recentSessions,
        notificationSettings: input.notificationSettings,
    };
    const activeTab = input.tabs.find((tab) => tab.id === input.activeTabId);
    if (!activeTab || !input.visibleTabIds.has(activeTab.id) || !input.active) return base;

    const busy = activeTab.isStreamingLocal || activeTab.isCompacting;
    return {
        ...base,
        todos: input.active.todos,
        todoEnabled: input.active.todoEnabled,
        todoToggleDisabled: busy,
        planModeEnabled: input.active.planModeEnabled,
        planModeToggleDisabled: busy,
        fileUndoViewEnabled: input.active.fileUndoViewEnabled,
        subagents: {
            ...input.active.subagents,
            toggleDisabled: busy,
        },
        toolSelection: {
            ...input.active.toolSelection,
            toggleDisabled: busy,
        },
    };
}

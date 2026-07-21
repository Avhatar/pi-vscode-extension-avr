export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskInfo {
    id: number;
    subject: string;
    description?: string;
    activeForm?: string;
    status: TaskStatus;
    blockedBy?: number[];
}

export interface TodoSnapshot {
    tasks: TaskInfo[];
    nextId: number;
}

export interface RegisteredToolInfo {
    name: string;
    description?: string;
    source?: string;
    hasGuidelines?: boolean;
}

export interface ToolSelectionSnapshot {
    registered: RegisteredToolInfo[];
    disabled: string[];
    toggleDisabled: boolean;
}

export type LauncherSubagentStatus =
    | 'queued'
    | 'starting'
    | 'running'
    | 'waiting_for_permission'
    | 'retrying'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface LauncherSubagentRun {
    agentId: string;
    name: string;
    task: string;
    taskPreview: string;
    result?: string;
    resultPreview?: string;
    status: LauncherSubagentStatus;
    modelLabel?: string;
    currentTool?: string;
    activity?: string;
    elapsedMs: number;
    queueWaitMs?: number;
    turnCount: number;
    error?: string;
    canDismiss: boolean;
}

export interface LauncherSubagentSnapshot {
    enabled: boolean;
    toggleDisabled: boolean;
    activeCount: number;
    queuedCount: number;
    runs: LauncherSubagentRun[];
    smokeSimulation?: boolean;
}

/** Portable active-tab controls shared by desktop and future non-VS Code clients. */
export interface AgentTabControls {
    todos: TodoSnapshot;
    todoEnabled: boolean;
    todoToggleDisabled: boolean;
    planModeEnabled: boolean;
    planModeToggleDisabled: boolean;
    subagents: LauncherSubagentSnapshot;
    toolSelection: ToolSelectionSnapshot;
}

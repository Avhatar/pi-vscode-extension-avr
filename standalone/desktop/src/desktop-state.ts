import { createHash } from 'node:crypto';
import type { StateStore } from '../../../src/core/ports/chat-platform';
import type {
    SessionSettingValues,
    SessionSettingsPort,
} from '../../../src/core/ports/session-platform';

const WORKSPACE_KEY_PREFIX = 'pi-code.desktop.workspace.';
const SETTING_KEY_PREFIX = 'pi-code.desktop.setting.';

interface PersistedWorkspaceRecord {
    readonly version: 1;
    readonly workspacePath: string;
    readonly trusted: boolean;
    readonly lastOpenedAt: number;
}

export interface DesktopRecentWorkspace {
    readonly workspacePath: string;
    readonly trusted: boolean;
    readonly lastOpenedAt: number;
}

export interface EnumerableStateStore extends StateStore {
    entries(): ReadonlyArray<readonly [string, unknown]>;
}

export interface TransactionalEnumerableStateStore extends EnumerableStateStore {
    mutate<T>(key: string, update: (value: T | undefined) => T | undefined): Promise<void>;
}

/** Shared app-data projection for canonical workspace trust and recent paths. */
export class DesktopWorkspaceStore {
    constructor(
        private readonly state: TransactionalEnumerableStateStore,
        private readonly now: () => number = Date.now,
    ) {}

    stateKey(canonicalWorkspacePath: string): string {
        const digest = createHash('sha256').update(canonicalWorkspacePath).digest('hex');
        return `${WORKSPACE_KEY_PREFIX}${digest}`;
    }

    isTrusted(canonicalWorkspacePath: string): boolean {
        const record = this.read(canonicalWorkspacePath);
        return record?.workspacePath === canonicalWorkspacePath && record.trusted;
    }

    async trustAndRecordOpened(canonicalWorkspacePath: string): Promise<void> {
        await this.write(canonicalWorkspacePath, () => true, this.now());
    }

    async recordOpened(canonicalWorkspacePath: string): Promise<void> {
        await this.write(
            canonicalWorkspacePath,
            (current) => Boolean(
                current?.workspacePath === canonicalWorkspacePath && current.trusted,
            ),
            this.now(),
        );
    }

    async revokeTrust(canonicalWorkspacePath: string): Promise<void> {
        const revokedAt = this.now();
        await this.state.mutate<unknown>(this.stateKey(canonicalWorkspacePath), (value) => {
            const current = parseWorkspaceRecord(value);
            return {
                version: 1,
                workspacePath: canonicalWorkspacePath,
                trusted: false,
                lastOpenedAt: current?.workspacePath === canonicalWorkspacePath
                    ? current.lastOpenedAt
                    : revokedAt,
            } satisfies PersistedWorkspaceRecord;
        });
    }

    listRecent(limit = 20): DesktopRecentWorkspace[] {
        return this.state.entries()
            .filter(([key]) => key.startsWith(WORKSPACE_KEY_PREFIX))
            .flatMap(([, value]) => {
                const record = parseWorkspaceRecord(value);
                return record ? [{
                    workspacePath: record.workspacePath,
                    trusted: record.trusted,
                    lastOpenedAt: record.lastOpenedAt,
                }] : [];
            })
            .sort((left, right) => (
                right.lastOpenedAt - left.lastOpenedAt
                || left.workspacePath.localeCompare(right.workspacePath)
            ))
            .slice(0, Math.max(0, Math.trunc(limit)));
    }

    private read(canonicalWorkspacePath: string): PersistedWorkspaceRecord | undefined {
        return parseWorkspaceRecord(this.state.get<unknown>(this.stateKey(canonicalWorkspacePath)));
    }

    private async write(
        canonicalWorkspacePath: string,
        trusted: (current: PersistedWorkspaceRecord | undefined) => boolean,
        lastOpenedAt: number,
    ): Promise<void> {
        await this.state.mutate<unknown>(this.stateKey(canonicalWorkspacePath), (value) => {
            const current = parseWorkspaceRecord(value);
            return {
                version: 1,
                workspacePath: canonicalWorkspacePath,
                trusted: trusted(current),
                lastOpenedAt,
            } satisfies PersistedWorkspaceRecord;
        });
    }
}

/** Persistent desktop implementation of the portable session-settings reader. */
export class DesktopSessionSettings implements SessionSettingsPort {
    constructor(
        private readonly state: StateStore,
        private readonly forcedValues: Partial<SessionSettingValues> = {},
    ) {}

    get<Key extends keyof SessionSettingValues>(
        key: Key,
        fallback: SessionSettingValues[Key],
    ): SessionSettingValues[Key] {
        const forced = this.forcedValues[key];
        if (forced !== undefined) return forced as SessionSettingValues[Key];
        const value = this.state.get<unknown>(`${SETTING_KEY_PREFIX}${key}`);
        return isSessionSettingValue(key, value)
            ? value as SessionSettingValues[Key]
            : fallback;
    }

    async update<Key extends keyof SessionSettingValues>(
        key: Key,
        value: SessionSettingValues[Key],
    ): Promise<void> {
        if (!isSessionSettingValue(key, value)) {
            throw new Error(`Invalid desktop session setting: ${key}`);
        }
        if (this.forcedValues[key] !== undefined) return;
        await this.state.update(`${SETTING_KEY_PREFIX}${key}`, value);
    }
}

function parseWorkspaceRecord(value: unknown): PersistedWorkspaceRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<PersistedWorkspaceRecord>;
    return candidate.version === 1
        && typeof candidate.workspacePath === 'string'
        && candidate.workspacePath.length > 0
        && typeof candidate.trusted === 'boolean'
        && typeof candidate.lastOpenedAt === 'number'
        && Number.isFinite(candidate.lastOpenedAt)
        ? {
            version: 1,
            workspacePath: candidate.workspacePath,
            trusted: candidate.trusted,
            lastOpenedAt: candidate.lastOpenedAt,
        }
        : undefined;
}

function isSessionSettingValue<Key extends keyof SessionSettingValues>(
    key: Key,
    value: unknown,
): value is SessionSettingValues[Key] {
    switch (key) {
        case 'allowedTools':
        case 'subagents.allowedModels':
            return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
        case 'lsp.enabled':
        case 'mcp.importClaudeCode':
        case 'subagents.allowInvocationModelOverride':
            return typeof value === 'boolean';
        case 'subagents.defaultMaxTurns':
        case 'subagents.defaultTimeoutMinutes':
        case 'subagents.maxConcurrentPerChat':
            return typeof value === 'number' && Number.isInteger(value) && value > 0;
        case 'todo.promptGuidelines':
            return value === undefined || typeof value === 'string';
        case 'thinkingLevel':
        case 'defaultModel':
        case 'subagents.defaultModel':
            return typeof value === 'string';
    }
}

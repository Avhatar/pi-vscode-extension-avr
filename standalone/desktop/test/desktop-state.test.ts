import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStateStore } from '../../../src/adapters/node/json-state-store';
import { NodeSessionLock } from '../../../src/adapters/node/session-lock';
import type { StateStore } from '../../../src/core/ports/chat-platform';
import {
    DesktopSessionSettings,
    DesktopWorkspaceStore,
    type TransactionalEnumerableStateStore,
} from '../src/desktop-state';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
        fs.rm(directory, { recursive: true, force: true })
    )));
});

class MemoryStateStore implements TransactionalEnumerableStateStore {
    readonly values = new Map<string, unknown>();

    get<T>(key: string, fallback?: T): T | undefined {
        return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, value);
    }

    entries(): ReadonlyArray<readonly [string, unknown]> {
        return [...this.values.entries()];
    }

    async mutate<T>(key: string, update: (value: T | undefined) => T | undefined): Promise<void> {
        await this.update(key, update(this.values.get(key) as T | undefined));
    }
}

describe('DesktopWorkspaceStore', () => {
    it('persists trust for the exact canonical workspace and records recency independently', async () => {
        const state = new MemoryStateStore();
        const workspaces = new DesktopWorkspaceStore(state, () => 100);
        const first = path.resolve('C:/workspace-one');
        const second = path.resolve('C:/workspace-two');

        expect(workspaces.isTrusted(first)).toBe(false);
        await workspaces.trustAndRecordOpened(first);
        await workspaces.recordOpened(second);

        expect(workspaces.isTrusted(first)).toBe(true);
        expect(workspaces.isTrusted(second)).toBe(false);
        expect(workspaces.listRecent()).toEqual([
            { workspacePath: first, trusted: true, lastOpenedAt: 100 },
            { workspacePath: second, trusted: false, lastOpenedAt: 100 },
        ]);

        await workspaces.revokeTrust(first);
        expect(workspaces.isTrusted(first)).toBe(false);
    });

    it('preserves trust and revocation across stale independently opened processes', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-code-desktop-trust-'));
        temporaryDirectories.push(directory);
        const statePath = path.join(directory, 'global.json');
        const open = (applicationId: string) => JsonStateStore.open(statePath, {
            lock: new NodeSessionLock({ applicationId, staleAfterMs: 0 }),
            lockTimeoutMs: 1_000,
            retryDelayMs: 1,
        });
        const first = new DesktopWorkspaceStore(await open('trust-first'), () => 100);
        const second = new DesktopWorkspaceStore(await open('trust-second'), () => 200);
        const workspace = path.resolve('C:/shared-workspace');

        await first.trustAndRecordOpened(workspace);
        await second.recordOpened(workspace);
        expect(new DesktopWorkspaceStore(await open('trust-check-1')).isTrusted(workspace)).toBe(true);

        await second.revokeTrust(workspace);
        await first.recordOpened(workspace);
        expect(new DesktopWorkspaceStore(await open('trust-check-2')).isTrusted(workspace)).toBe(false);
    });

    it('does not trust a hash collision or differently cased record without an exact path match', () => {
        const state = new MemoryStateStore();
        const workspaces = new DesktopWorkspaceStore(state);
        const workspace = path.resolve('C:/workspace');
        state.values.set(workspaces.stateKey(workspace), {
            version: 1,
            workspacePath: `${workspace}-other`,
            trusted: true,
            lastOpenedAt: 1,
        });

        expect(workspaces.isTrusted(workspace)).toBe(false);
    });
});

describe('DesktopSessionSettings', () => {
    it('persists validated session settings while preserving forced desktop overrides', async () => {
        const state: StateStore = new MemoryStateStore();
        const settings = new DesktopSessionSettings(state, {
            'lsp.enabled': false,
            'mcp.importClaudeCode': false,
        });

        await settings.update('thinkingLevel', 'high');
        await settings.update('subagents.defaultMaxTurns', 24);
        await settings.update('allowedTools', ['read', 'edit']);
        await settings.update('lsp.enabled', true);

        expect(settings.get('thinkingLevel', 'medium')).toBe('high');
        expect(settings.get('subagents.defaultMaxTurns', 8)).toBe(24);
        expect(settings.get('allowedTools', [])).toEqual(['read', 'edit']);
        expect(settings.get('lsp.enabled', true)).toBe(false);
    });

    it('ignores malformed persisted values and returns the caller fallback', () => {
        const state = new MemoryStateStore();
        state.values.set('pi-code.desktop.setting.subagents.defaultMaxTurns', -2);
        state.values.set('pi-code.desktop.setting.allowedTools', ['read', 42]);
        const settings = new DesktopSessionSettings(state);

        expect(settings.get('subagents.defaultMaxTurns', 8)).toBe(8);
        expect(settings.get('allowedTools', ['read'])).toEqual(['read']);
    });
});

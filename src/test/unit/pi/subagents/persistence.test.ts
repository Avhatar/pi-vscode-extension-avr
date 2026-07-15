import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubagentRunStore } from '../../../../pi/subagents/persistence';
import type { ResolvedAgentSpec, SubagentRun } from '../../../../pi/subagents/types';

let root: string;
let store: SubagentRunStore;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-store-test-'));
    store = new SubagentRunStore(root);
    await store.initialize();
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('persistent subagent run store', () => {
    it('round-trips run metadata, definition snapshot, and transcript', async () => {
        const directory = await store.ensureTranscriptDirectory('parent');
        const transcriptPath = path.join(directory, 'child.jsonl');
        await fs.writeFile(transcriptPath, 'transcript', 'utf8');
        await store.save('parent', '/history/parent.jsonl', run({ transcriptPath }), spec(), 100);

        const loaded = await store.loadParent('parent', 200);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]).toMatchObject({
            parentSessionId: 'parent', parentSessionPath: '/history/parent.jsonl', agentId: 'child',
            definitionSnapshot: { name: 'reviewer', model: { provider: 'deepseek', id: 'reasoner' } },
        });
        expect(await store.readTranscript('parent', 'child')).toBe('transcript');
        expect(store.isChildTranscriptPath(transcriptPath)).toBe(true);
    });

    it('marks an active run failed when restored after restart', async () => {
        await store.save('parent', undefined, run({ status: 'running' }), spec(), 100);
        const loaded = await store.loadParent('parent', 500);
        expect(loaded[0].run).toMatchObject({
            status: 'failed', finishedAt: 500,
            error: 'Subagent execution was interrupted by an extension restart.',
        });
    });

    it('hides dismissed metadata while retaining its transcript', async () => {
        const directory = await store.ensureTranscriptDirectory('parent');
        const transcriptPath = path.join(directory, 'child.jsonl');
        await fs.writeFile(transcriptPath, 'detail', 'utf8');
        await store.save('parent', undefined, run({ transcriptPath }), spec(), 100);
        expect(await store.dismiss('parent', 'child', 200)).toBe(true);
        expect(await store.loadParent('parent', 300)).toEqual([]);
        expect(await store.readTranscript('parent', 'child')).toBe('detail');
    });

    it('cleans parent-owned storage when ordinary parent history is deleted', async () => {
        await store.save('parent', '/history/parent.jsonl', run(), spec(), 100);
        expect(await store.deleteByParentSessionPath('/history/parent.jsonl')).toBe(1);
        expect(await store.get('parent', 'child')).toBeUndefined();
    });

    it('removes expired records and bounded transcript files', async () => {
        const directory = await store.ensureTranscriptDirectory('parent');
        const transcriptPath = path.join(directory, 'child.jsonl');
        await fs.writeFile(transcriptPath, 'old', 'utf8');
        await store.save('parent', undefined, run({ transcriptPath }), spec(), 100);
        const result = await store.cleanup(50, 200);
        expect(result).toEqual({ recordsRemoved: 1, transcriptsRemoved: 1, parentDirectoriesRemoved: 1 });
        await expect(fs.access(transcriptPath)).rejects.toThrow();
    });
});

function run(patch: Partial<SubagentRun> = {}): SubagentRun {
    return {
        agentId: 'child', parentSessionId: 'parent', parentTabId: 'tab',
        name: 'reviewer', source: 'project', taskPreview: 'Review', status: 'completed',
        model: { provider: 'deepseek', id: 'reasoner' }, turnCount: 1, finishedAt: 90,
        ...patch,
    };
}

function spec(): ResolvedAgentSpec {
    return {
        name: 'reviewer', source: 'project', task: 'Review',
        model: { provider: 'deepseek', id: 'reasoner' }, modelSource: 'definition',
        tools: ['read'], toolTrace: {
            registered: ['read'], active: ['read'], childSafe: ['read'], denied: [], effective: ['read'],
        },
        maxTurns: 5, timeoutMinutes: 1, background: false,
        contextMode: 'fresh', isolation: 'shared-workspace', diagnostics: [],
    };
}

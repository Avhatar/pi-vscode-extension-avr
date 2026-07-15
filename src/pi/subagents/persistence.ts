import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ResolvedAgentSpec, SubagentRun } from './types';

const RECORD_VERSION = 1;
const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running', 'waiting_for_permission', 'retrying']);

export interface PersistedSubagentRecord {
    version: 1;
    parentSessionId: string;
    parentSessionPath?: string;
    agentId: string;
    updatedAt: number;
    dismissed?: boolean;
    run: SubagentRun;
    definitionSnapshot: ResolvedAgentSpec;
}

export interface SubagentCleanupResult {
    recordsRemoved: number;
    transcriptsRemoved: number;
    parentDirectoriesRemoved: number;
}

export class SubagentRunStore {
    readonly root: string;
    private readonly recordsRoot: string;
    private readonly transcriptsRoot: string;

    constructor(root: string) {
        this.root = path.resolve(root, 'subagents');
        this.recordsRoot = path.join(this.root, 'records');
        this.transcriptsRoot = path.join(this.root, 'transcripts');
    }

    async initialize(): Promise<void> {
        await Promise.all([
            fs.mkdir(this.recordsRoot, { recursive: true }),
            fs.mkdir(this.transcriptsRoot, { recursive: true }),
        ]);
    }

    transcriptDirectory(parentSessionId: string): string {
        return path.join(this.transcriptsRoot, safeSegment(parentSessionId));
    }

    async ensureTranscriptDirectory(parentSessionId: string): Promise<string> {
        const directory = this.transcriptDirectory(parentSessionId);
        await fs.mkdir(directory, { recursive: true });
        return directory;
    }

    async save(
        parentSessionId: string,
        parentSessionPath: string | undefined,
        run: SubagentRun,
        definitionSnapshot: ResolvedAgentSpec,
        now = Date.now(),
    ): Promise<void> {
        const record: PersistedSubagentRecord = {
            version: RECORD_VERSION,
            parentSessionId,
            ...(parentSessionPath ? { parentSessionPath } : {}),
            agentId: run.agentId,
            updatedAt: now,
            run: cloneRun(run),
            definitionSnapshot: cloneSpec(definitionSnapshot),
        };
        await this.writeRecord(record);
    }

    async loadParent(parentSessionId: string, now = Date.now()): Promise<PersistedSubagentRecord[]> {
        const directory = this.recordDirectory(parentSessionId);
        let names: string[];
        try { names = await fs.readdir(directory); } catch (error: any) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }
        const records: PersistedSubagentRecord[] = [];
        for (const name of names.filter((value) => value.endsWith('.json')).sort()) {
            const record = await this.readRecord(path.join(directory, name));
            if (!record || record.parentSessionId !== parentSessionId || record.dismissed) continue;
            if (ACTIVE_STATUSES.has(record.run.status)) {
                record.run = {
                    ...record.run,
                    status: 'failed',
                    currentTool: undefined,
                    activity: 'Interrupted by extension restart',
                    error: 'Subagent execution was interrupted by an extension restart.',
                    finishedAt: now,
                };
                record.updatedAt = now;
                await this.writeRecord(record);
            }
            records.push(record);
        }
        return records.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    async get(parentSessionId: string, agentId: string): Promise<PersistedSubagentRecord | undefined> {
        return this.readRecord(this.recordPath(parentSessionId, agentId));
    }

    async dismiss(parentSessionId: string, agentId: string, now = Date.now()): Promise<boolean> {
        const record = await this.get(parentSessionId, agentId);
        if (!record) return false;
        record.dismissed = true;
        record.updatedAt = now;
        await this.writeRecord(record);
        return true;
    }

    async readTranscript(parentSessionId: string, agentId: string): Promise<string | undefined> {
        const record = await this.get(parentSessionId, agentId);
        const transcriptPath = record?.run.transcriptPath;
        if (!transcriptPath || !isWithin(this.transcriptsRoot, transcriptPath)) return undefined;
        try { return await fs.readFile(transcriptPath, 'utf8'); } catch (error: any) {
            if (error?.code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async deleteParent(parentSessionId: string): Promise<void> {
        const segment = safeSegment(parentSessionId);
        await Promise.all([
            fs.rm(path.join(this.recordsRoot, segment), { recursive: true, force: true }),
            fs.rm(path.join(this.transcriptsRoot, segment), { recursive: true, force: true }),
        ]);
    }

    async deleteByParentSessionPath(parentSessionPath: string): Promise<number> {
        let parentIds: string[];
        try { parentIds = await fs.readdir(this.recordsRoot); } catch { return 0; }
        let removed = 0;
        for (const parentId of parentIds) {
            const records = await this.loadAllRecords(parentId);
            if (records.some((record) => record.parentSessionPath === parentSessionPath)) {
                await this.deleteParent(parentId);
                removed += 1;
            }
        }
        return removed;
    }

    async cleanup(retentionMs: number, now = Date.now()): Promise<SubagentCleanupResult> {
        const result: SubagentCleanupResult = {
            recordsRemoved: 0,
            transcriptsRemoved: 0,
            parentDirectoriesRemoved: 0,
        };
        let parentIds: string[];
        try { parentIds = await fs.readdir(this.recordsRoot); } catch { return result; }
        for (const parentId of parentIds) {
            const records = await this.loadAllRecords(parentId);
            for (const record of records) {
                if (now - record.updatedAt < retentionMs) continue;
                await fs.rm(this.recordPath(record.parentSessionId, record.agentId), { force: true });
                result.recordsRemoved += 1;
                if (record.run.transcriptPath && isWithin(this.transcriptsRoot, record.run.transcriptPath)) {
                    try {
                        await fs.rm(record.run.transcriptPath, { force: true });
                        result.transcriptsRemoved += 1;
                    } catch { /* cleanup remains best-effort */ }
                }
            }
            const remaining = await this.loadAllRecords(parentId);
            if (remaining.length === 0) {
                await this.deleteParent(parentId);
                result.parentDirectoriesRemoved += 1;
            }
        }
        return result;
    }

    isChildTranscriptPath(candidate: string): boolean {
        return isWithin(this.transcriptsRoot, candidate);
    }

    private recordDirectory(parentSessionId: string): string {
        return path.join(this.recordsRoot, safeSegment(parentSessionId));
    }

    private recordPath(parentSessionId: string, agentId: string): string {
        return path.join(this.recordDirectory(parentSessionId), `${safeSegment(agentId)}.json`);
    }

    private async writeRecord(record: PersistedSubagentRecord): Promise<void> {
        const destination = this.recordPath(record.parentSessionId, record.agentId);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await fs.rename(temporary, destination);
    }

    private async readRecord(filePath: string): Promise<PersistedSubagentRecord | undefined> {
        try {
            const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as PersistedSubagentRecord;
            if (parsed?.version !== RECORD_VERSION || typeof parsed.agentId !== 'string' || !parsed.run || !parsed.definitionSnapshot) {
                return undefined;
            }
            return parsed;
        } catch (error: any) {
            if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
            throw error;
        }
    }

    private async loadAllRecords(parentId: string): Promise<PersistedSubagentRecord[]> {
        const directory = this.recordDirectory(parentId);
        let names: string[];
        try { names = await fs.readdir(directory); } catch { return []; }
        const values = await Promise.all(names
            .filter((name) => name.endsWith('.json'))
            .map((name) => this.readRecord(path.join(directory, name))));
        return values.filter((value): value is PersistedSubagentRecord => Boolean(value));
    }
}

function safeSegment(value: string): string {
    const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
    if (!safe || safe === '.' || safe === '..') throw new Error('Invalid subagent storage identifier.');
    return safe;
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function cloneRun(run: SubagentRun): SubagentRun {
    return { ...run, ...(run.model ? { model: { ...run.model } } : {}) };
}

function cloneSpec(spec: ResolvedAgentSpec): ResolvedAgentSpec {
    return JSON.parse(JSON.stringify(spec)) as ResolvedAgentSpec;
}

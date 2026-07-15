import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
    AgentSession,
    AgentSessionEvent,
    AuthStorage,
    ModelRegistry,
    SessionManager,
} from '@earendil-works/pi-coding-agent';
import { createCompleteSubagentTool } from './completion-tool';
import { formatModelRef } from './model-ref';
import type {
    ChildSessionEvent,
    ChildSessionFactory,
    ChildSessionHandle,
    SubagentCompletion,
} from './runtime';
import type { AvailableModel, ResolvedAgentSpec } from './types';
import type { WriteExecutionLease, WriteIsolationManager } from './write-isolation';
import type { ChildToolFactoryRegistry } from './child-tools';

export const CHILD_SAFE_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write'] as const;
export const READ_ONLY_CHILD_TOOLS = CHILD_SAFE_TOOLS.slice(0, 4);
const CHILD_SAFE_TOOL_SET = new Set<string>(CHILD_SAFE_TOOLS);

export interface PiChildSessionFactoryOptions {
    cwd: string;
    workspaceTrusted: boolean;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
    transcriptDirectory?: string;
    parentSessionPath?: string;
    writeIsolation?: WriteIsolationManager;
    childToolFactories?: ChildToolFactoryRegistry;
    log?: (message: string) => void;
}

export class PiChildSessionFactory implements ChildSessionFactory {
    constructor(private readonly options: PiChildSessionFactoryOptions) {}

    async create(spec: ResolvedAgentSpec, context: { agentId: string; signal: AbortSignal }): Promise<ChildSessionHandle> {
        const lease = this.options.writeIsolation
            ? await this.options.writeIsolation.prepare(this.options.cwd, context.agentId, spec)
            : { cwd: this.options.cwd, release: async () => {} };
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        let sessionManager: SessionManager;
        if (this.options.transcriptDirectory) {
            await fs.mkdir(this.options.transcriptDirectory, { recursive: true });
            sessionManager = SessionManager.create(lease.cwd, this.options.transcriptDirectory, {
                id: context.agentId,
                ...(this.options.parentSessionPath ? { parentSession: this.options.parentSessionPath } : {}),
            });
        } else {
            sessionManager = SessionManager.inMemory(lease.cwd, { id: context.agentId });
        }
        try {
            return await this.createWithSessionManager(spec, context, sessionManager, lease);
        } catch (error) {
            await lease.release();
            throw error;
        }
    }

    async resume(
        spec: ResolvedAgentSpec,
        transcriptPath: string,
        context: { agentId: string; signal: AbortSignal },
    ): Promise<ChildSessionHandle> {
        if (!this.options.transcriptDirectory || !isWithin(this.options.transcriptDirectory, transcriptPath)) {
            throw new Error('Subagent transcript is outside the configured child-session storage boundary.');
        }
        const { SessionManager } = await import('@earendil-works/pi-coding-agent');
        await fs.access(transcriptPath);
        if (this.options.writeIsolation?.hasWrites(spec) && spec.isolation === 'worktree') {
            throw new Error('Resume for a write-capable worktree subagent requires its preserved worktree control path.');
        }
        const lease = this.options.writeIsolation
            ? await this.options.writeIsolation.prepare(this.options.cwd, context.agentId, spec)
            : { cwd: this.options.cwd, release: async () => {} };
        const sessionManager = SessionManager.open(transcriptPath, this.options.transcriptDirectory, lease.cwd);
        try {
            return await this.createWithSessionManager(spec, context, sessionManager, lease);
        } catch (error) {
            await lease.release();
            throw error;
        }
    }

    private async createWithSessionManager(
        spec: ResolvedAgentSpec,
        context: { agentId: string; signal: AbortSignal },
        sessionManager: SessionManager,
        lease: WriteExecutionLease,
    ): Promise<ChildSessionHandle> {
        const contributedToolNames = new Set(this.options.childToolFactories?.listNames() ?? []);
        const unsafeTools = spec.tools.filter((tool) => !CHILD_SAFE_TOOL_SET.has(tool) && !contributedToolNames.has(tool));
        if (unsafeTools.length > 0) {
            throw new Error(`Unsupported child tools: ${unsafeTools.join(', ')}.`);
        }

        const model = this.options.modelRegistry.find(spec.model.provider, spec.model.id);
        if (!model) {
            throw new Error(`Subagent model ${formatModelRef(spec.model)} is unavailable; no fallback was applied.`);
        }
        if (!this.options.modelRegistry.hasConfiguredAuth(model)) {
            throw new Error(`Authentication is not configured for subagent model ${formatModelRef(spec.model)}; no fallback was applied.`);
        }

        const {
            createAgentSession,
            DefaultResourceLoader,
            getAgentDir,
            SettingsManager,
        } = await import('@earendil-works/pi-coding-agent');
        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.inMemory({}, { projectTrusted: this.options.workspaceTrusted });
        const resourceLoader = new DefaultResourceLoader({
            cwd: lease.cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: !this.options.workspaceTrusted,
            appendSystemPrompt: [buildChildSystemInstructions(spec)],
        });
        await resourceLoader.reload();

        let completion: SubagentCompletion | undefined;
        let lastAssistantText: string | undefined;
        const listeners = new Set<(event: ChildSessionEvent) => void>();
        const emit = (event: ChildSessionEvent): void => {
            for (const listener of listeners) {
                try { listener(event); } catch { /* listener isolation */ }
            }
        };
        const contributedTools = await this.options.childToolFactories?.createTools(spec.tools, {
            agentId: context.agentId,
            cwd: lease.cwd,
            signal: context.signal,
            spec,
        }) ?? [];
        const completionTool = createCompleteSubagentTool({
            onComplete(value) {
                completion = cloneCompletion(value);
                emit({ type: 'completion', completion: cloneCompletion(value) });
            },
        });

        const { session } = await createAgentSession({
            cwd: lease.cwd,
            model,
            thinkingLevel: spec.thinkingLevel as any,
            authStorage: this.options.authStorage,
            modelRegistry: this.options.modelRegistry,
            sessionManager,
            settingsManager,
            resourceLoader,
            tools: [...spec.tools, 'complete_subagent'],
            customTools: [completionTool as any, ...contributedTools as any[]],
        });
        const unsubscribe = session.subscribe((event) => {
            const mapped = mapSessionEvent(event);
            if (!mapped) return;
            if (mapped.type === 'turn-ended' && mapped.assistantText) lastAssistantText = mapped.assistantText;
            emit(mapped);
        });
        const abortFromSignal = (): void => { void session.abort(); };
        context.signal.addEventListener('abort', abortFromSignal, { once: true });
        if (context.signal.aborted) abortFromSignal();

        this.options.log?.(
            `[subagent child created] agentId=${context.agentId} sessionId=${session.sessionId} ` +
            `model=${formatModelRef(spec.model)} tools=${spec.tools.join(',') || '(none)'}`,
        );
        return new PiChildSessionHandle(
            session,
            sessionManager.getSessionFile(),
            lease.isolationPath,
            { provider: spec.model.provider, id: spec.model.id, name: spec.model.name },
            listeners,
            () => completion ? cloneCompletion(completion) : undefined,
            () => lastAssistantText,
            () => {
                context.signal.removeEventListener('abort', abortFromSignal);
                unsubscribe();
                void lease.release();
            },
        );
    }
}

class PiChildSessionHandle implements ChildSessionHandle {
    constructor(
        private readonly session: AgentSession,
        readonly transcriptPath: string | undefined,
        readonly isolationPath: string | undefined,
        readonly model: AvailableModel,
        private readonly listeners: Set<(event: ChildSessionEvent) => void>,
        private readonly completion: () => SubagentCompletion | undefined,
        private readonly lastAssistantText: () => string | undefined,
        private readonly cleanup: () => void,
    ) {}

    get sessionId(): string {
        return this.session.sessionId;
    }

    subscribe(listener: (event: ChildSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async prompt(text: string): Promise<void> {
        await this.session.prompt(text, { expandPromptTemplates: false });
    }

    async steer(text: string): Promise<void> {
        await this.session.steer(text);
    }

    async abort(): Promise<void> {
        await this.session.abort();
    }

    dispose(): void {
        this.cleanup();
        this.listeners.clear();
        this.session.dispose();
    }

    getCompletion(): SubagentCompletion | undefined {
        return this.completion();
    }

    getLastAssistantText(): string | undefined {
        return this.lastAssistantText();
    }
}

function mapSessionEvent(event: AgentSessionEvent): ChildSessionEvent | undefined {
    switch (event.type) {
        case 'turn_end':
            return { type: 'turn-ended', assistantText: extractAssistantText((event as any).message) };
        case 'tool_execution_start':
            return {
                type: 'tool-started',
                toolName: String((event as any).toolName ?? '?'),
                toolCallId: String((event as any).toolCallId ?? ''),
                args: (event as any).args,
            };
        case 'tool_execution_end':
            return {
                type: 'tool-ended',
                toolName: String((event as any).toolName ?? '?'),
                toolCallId: String((event as any).toolCallId ?? ''),
                isError: Boolean((event as any).isError),
                args: (event as any).args,
            };
        case 'auto_retry_start':
            return {
                type: 'retrying',
                attempt: event.attempt,
                delayMs: event.delayMs,
                error: event.errorMessage,
            };
        default:
            return undefined;
    }
}

function extractAssistantText(message: any): string | undefined {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
    const text = message.content
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
        .trim();
    return text || undefined;
}

function buildChildSystemInstructions(spec: ResolvedAgentSpec): string {
    return [
        '<subagent-instructions>',
        'You are an isolated child agent working on one delegated task.',
        'The parent conversation is not available. Use only the task and workspace evidence provided here.',
        spec.tools.some((tool) => tool === 'edit' || tool === 'write')
            ? `Write access is enabled with ${spec.isolation} isolation. Modify only files required by the delegated task.`
            : 'This child is read-only. Do not attempt to modify files or repository state.',
        'When finished, call complete_subagent exactly once and by itself. Put the complete parent-facing answer in result.',
        spec.instructions ? `\nSpecialized instructions:\n${spec.instructions}` : '',
        '</subagent-instructions>',
    ].filter(Boolean).join('\n');
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function cloneCompletion(completion: SubagentCompletion): SubagentCompletion {
    return {
        result: completion.result,
        ...(completion.summary ? { summary: completion.summary } : {}),
        ...(completion.artifacts ? { artifacts: completion.artifacts.map((artifact) => ({ ...artifact })) } : {}),
    };
}

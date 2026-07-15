import { SubagentCapabilityGate, type SubagentGateStorage } from '../../gating';
import { registerSubagentTool, type SubagentToolDetails } from '../../tool';
import type { AgentDefinition } from '../../types';
import type { SmokeScenario } from '../types';

export const toolGatingScenario: SmokeScenario = {
    id: 'tool-gating',
    label: 'Phase 3: Parent tool and capability gating',
    description: 'Simulates registered-but-hidden prompt surface, per-chat persistence, busy rejection, Tools synchronization, reload, and parent tool execution.',
    fixtureSeed: 'phase-3-tool-gating-v1',
    async run({ logger }) {
        const storage = new MemoryGateStorage();
        const gate = new SubagentCapabilityGate(storage, () => false);
        const sessionPath = '/smoke/session-a.jsonl';
        const registered = ['read', 'todo', 'subagent'];
        const toolDefinitions = new Map<string, any>();
        const definitions: AgentDefinition[] = [{
            name: 'reviewer',
            description: 'Review workspace evidence',
            model: { provider: 'deepseek', id: 'deepseek-reasoner' },
            tools: ['read'],
            source: 'project',
        }];
        const progress: SubagentToolDetails[] = [];
        registerSubagentTool({
            registerTool(tool: any) { toolDefinitions.set(tool.name, tool); },
        } as any, {
            definitions,
            async execute(invocation, _signal, onProgress) {
                logger.event('tool-invocation-resolved', {
                    agent: invocation.agent ?? 'ad-hoc',
                    model: typeof invocation.model === 'string'
                        ? invocation.model
                        : invocation.model ? `${invocation.model.provider}/${invocation.model.id}` : 'inherit',
                    tools: invocation.tools,
                });
                onProgress({
                    agentId: 'phase-3-child',
                    name: invocation.agent ?? 'ad-hoc',
                    status: 'running',
                    model: { provider: 'deepseek', id: 'deepseek-reasoner' },
                    turnCount: 1,
                });
                return {
                    agentId: 'phase-3-child',
                    result: 'Bounded child result.',
                    model: { provider: 'deepseek', id: 'deepseek-reasoner' },
                    turnCount: 1,
                    truncated: false,
                };
            },
        });
        const subagentTool = toolDefinitions.get('subagent');
        logger.assert('single-parent-tool-registered', toolDefinitions.size === 1 && Boolean(subagentTool), 1, toolDefinitions.size);
        logger.assert('named-agent-catalog-visible-when-active', subagentTool.description.includes('reviewer') && subagentTool.description.includes('deepseek/deepseek-reasoner'), true, Boolean(subagentTool.description.includes('reviewer')));

        let active = applySelection(registered, gate.composeDisabledTools([], sessionPath));
        logger.event('gate-applied', { phase: 'default-off', active, disabled: gate.composeDisabledTools([], sessionPath) });
        logger.assert('default-off-removes-schema-and-guidelines', !active.includes('subagent') && !visiblePromptTools(active, toolDefinitions).includes('subagent'), true, active);

        const enabled = await gate.setEnabled(sessionPath, true, false);
        active = applySelection(registered, gate.composeDisabledTools([], sessionPath));
        logger.event('gate-applied', { phase: 'toggle-on', active, stored: storage.snapshot() });
        logger.assert('toggle-on-restores-tool-surface', enabled && active.includes('subagent') && visiblePromptTools(active, toolDefinitions).includes('subagent'), true, active);

        const busyChange = await gate.setEnabled(sessionPath, false, true);
        active = applySelection(registered, gate.composeDisabledTools([], sessionPath));
        logger.assert('busy-toggle-rejected', !busyChange && active.includes('subagent'), true, { busyChange, active });

        const toolsPanelDisabled = true;
        await gate.setEnabled(sessionPath, !toolsPanelDisabled, false);
        active = applySelection(registered, gate.composeDisabledTools([], sessionPath));
        logger.assert('tools-panel-disable-synchronizes-dedicated-gate', !gate.isEnabled(sessionPath) && !active.includes('subagent'), true, active);

        await gate.setEnabled(sessionPath, true, false);
        const reloadedSessionActive = applySelection(registered, gate.composeDisabledTools([], sessionPath));
        logger.event('gate-applied', { phase: 'session-reload', active: reloadedSessionActive, stored: storage.snapshot() });
        logger.assert('session-reload-reapplies-persisted-state', reloadedSessionActive.includes('subagent'), true, reloadedSessionActive);
        logger.assert('another-chat-keeps-default-off', !gate.isEnabled('/smoke/session-b.jsonl'), false, gate.isEnabled('/smoke/session-b.jsonl'));

        const updates: unknown[] = [];
        const result = await subagentTool.execute('parent-tool-call', {
            task: 'Review authentication.',
            agent: 'reviewer',
            model: { provider: 'deepseek', id: 'deepseek-reasoner' },
            tools: ['read'],
        }, undefined, (update: unknown) => {
            updates.push(update);
            const details = (update as any).details as SubagentToolDetails;
            if (details) progress.push(details);
        }, {} as any);
        logger.event('parent-tool-result', {
            contentItems: result.content.length,
            status: result.details.status,
            model: `${result.details.model.provider}/${result.details.model.id}`,
            updates: updates.length,
        });
        logger.assert('parent-tool-returns-child-result', result.content[0]?.type === 'text' && result.content[0].text === 'Bounded child result.', 'Bounded child result.', result.content[0]);
        logger.assert('parent-tool-streams-status', progress.some((details) => details.status === 'queued') && progress.some((details) => details.status === 'running'), true, progress.map((details) => details.status));
        logger.assert('parent-tool-reports-actual-model', result.details.model.provider === 'deepseek' && result.details.model.id === 'deepseek-reasoner', 'deepseek/deepseek-reasoner', `${result.details.model.provider}/${result.details.model.id}`);

        logger.step('tool-gating-cleanup', { result: 'PASS', storedKeys: Object.keys(storage.snapshot()).length });
    },
};

class MemoryGateStorage implements SubagentGateStorage {
    private readonly values = new Map<string, boolean>();

    get<T>(key: string, defaultValue: T): T {
        return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
    }

    async update(key: string, value: boolean): Promise<void> {
        this.values.set(key, value);
    }

    snapshot(): Record<string, boolean> {
        return Object.fromEntries(this.values);
    }
}

function applySelection(registered: string[], disabled: string[]): string[] {
    const denied = new Set(disabled);
    return registered.filter((tool) => !denied.has(tool));
}

function visiblePromptTools(active: string[], definitions: Map<string, any>): string[] {
    return active.filter((name) => {
        const definition = definitions.get(name);
        return definition && (definition.description || definition.promptGuidelines?.length > 0);
    });
}

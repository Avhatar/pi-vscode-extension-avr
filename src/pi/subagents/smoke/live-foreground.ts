import * as vscode from 'vscode';
import type { PiSessionManager } from '../../session';
import type { ResolvedAgentSpec } from '../types';
import type { SmokeLogger } from './types';

export async function runLiveForegroundSmoke(
    session: PiSessionManager | undefined,
    logger: SmokeLogger,
): Promise<boolean> {
    const parentModel = session?.getCurrentModel();
    const manager = session?.subagentManager;
    if (!session?.isReady || !parentModel || !manager) {
        logger.assert('live-session-ready', false, 'ready active Pi chat with subagent runtime', 'unavailable');
        return true;
    }

    const childModels = session.getModels()
        .filter((model) => model.provider !== parentModel.provider)
        .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
    if (childModels.length === 0) {
        logger.assert(
            'live-cross-provider-model-available',
            false,
            `configured model outside parent provider ${parentModel.provider}`,
            'none',
        );
        return true;
    }

    const selected = await vscode.window.showQuickPick(
        childModels.map((model) => ({
            label: model.name ?? model.id,
            description: `${model.provider}/${model.id}`,
            model,
        })),
        {
            title: 'LIVE Subagent Smoke: Select Child Model',
            placeHolder: `Parent is ${parentModel.provider}/${parentModel.id}; select another provider`,
            ignoreFocusOut: true,
        },
    );
    if (!selected) return false;

    const confirmation = await vscode.window.showWarningMessage(
        `Run a live child request on ${selected.model.provider}/${selected.model.id}? Provider tokens may be billed.`,
        { modal: true },
        'Run Live Smoke Test',
    );
    if (confirmation !== 'Run Live Smoke Test') return false;

    logger.step('live-cross-provider-start', {
        parentModel: `${parentModel.provider}/${parentModel.id}`,
        childModel: `${selected.model.provider}/${selected.model.id}`,
        billingConfirmed: true,
    });
    const unsubscribe = manager.onDidChange((snapshot) => {
        const liveRun = snapshot.runs.find((run) => run.name === 'live-cross-provider');
        if (!liveRun) return;
        logger.event('live-runtime-snapshot', {
            agentId: liveRun.agentId,
            status: liveRun.status,
            model: liveRun.model ? `${liveRun.model.provider}/${liveRun.model.id}` : undefined,
            currentTool: liveRun.currentTool,
            turns: liveRun.turnCount,
        });
    });
    try {
        const result = await manager.runForeground(createLiveSpec(selected.model));
        const actualModel = `${result.model.provider}/${result.model.id}`;
        const expectedModel = `${selected.model.provider}/${selected.model.id}`;
        logger.event('live-result', {
            agentId: result.agentId,
            model: actualModel,
            turns: result.turnCount,
            resultBytes: Buffer.byteLength(result.result, 'utf8'),
            truncated: result.truncated,
        });
        logger.assert('live-child-model-exact', actualModel === expectedModel, expectedModel, actualModel);
        logger.assert('live-child-result-nonempty', result.result.trim().length > 0, 'non-empty result', `${result.result.length} characters`);
        logger.assert('live-child-used-different-provider', result.model.provider !== parentModel.provider, `not ${parentModel.provider}`, result.model.provider);
    } finally {
        unsubscribe();
    }
    return true;
}

function createLiveSpec(model: { provider: string; id: string; name?: string }): ResolvedAgentSpec {
    return {
        name: 'live-cross-provider',
        description: 'Live Phase 2 cross-provider smoke agent',
        source: 'invocation',
        task: [
            'Perform a minimal read-only smoke check of the current workspace.',
            'Read package.json if it exists; otherwise read one small relevant text file.',
            'Then call complete_subagent by itself with a concise result naming the file inspected and one verified fact.',
            'Do not modify files and do not run shell commands.',
        ].join(' '),
        instructions: 'This is a billed live smoke test. Minimize tokens and finish immediately after one read.',
        model: { ...model },
        modelSource: 'invocation',
        tools: ['read'],
        toolTrace: {
            registered: ['read', 'complete_subagent'],
            active: ['read', 'complete_subagent'],
            childSafe: ['read'],
            denied: ['subagent', 'bash', 'edit', 'write'],
            effective: ['read'],
        },
        maxTurns: 6,
        timeoutMinutes: 5,
        background: false,
        contextMode: 'fresh',
        isolation: 'shared-workspace',
        diagnostics: [],
    };
}

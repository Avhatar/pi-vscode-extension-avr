import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { PiSessionManager } from '../../session';
import { runLiveForegroundSmoke } from './live-foreground';
import { OutputSmokeLogger } from './logger';
import { foregroundCrossProviderScenario } from './scenarios/foreground-cross-provider';
import { registryResolutionScenario } from './scenarios/registry-resolution';
import { toolGatingScenario } from './scenarios/tool-gating';
import { launcherLifecycleScenario } from './scenarios/launcher-lifecycle';
import { persistenceControlScenario } from './scenarios/persistence-control';
import { backgroundConcurrencyScenario } from './scenarios/background-concurrency';
import { writeWorktreeScenario } from './scenarios/write-worktree';
import { compatibilitySourcesScenario } from './scenarios/compatibility-sources';
import type { LauncherSubagentSnapshot } from '../../../shared/protocol';
import type { SmokeScenario, SmokeScenarioResult } from './types';

const COMMAND_ID = 'pi-code.runSubagentSmokeTest';
const CHANNEL_NAME = 'Pi Code Subagent Smoke';
const LIVE_SCENARIO_ID = 'live-foreground-cross-provider';
const scenarios: readonly SmokeScenario[] = [
    registryResolutionScenario,
    foregroundCrossProviderScenario,
    toolGatingScenario,
    launcherLifecycleScenario,
    persistenceControlScenario,
    backgroundConcurrencyScenario,
    writeWorktreeScenario,
    compatibilitySourcesScenario,
];

interface SmokePick {
    label: string;
    description: string;
    scenarioIds?: string[];
    live?: boolean;
}

export function registerSubagentSmokeCommand(
    context: vscode.ExtensionContext,
    getActiveSession?: () => PiSessionManager | undefined,
    showLauncherSnapshot?: (
        snapshot: LauncherSubagentSnapshot,
        transcripts?: Readonly<Record<string, string>>,
    ) => void,
): vscode.Disposable {
    const channel = vscode.window.createOutputChannel(CHANNEL_NAME);
    context.subscriptions.push(channel);

    return vscode.commands.registerCommand(COMMAND_ID, async () => {
        const picks: SmokePick[] = [
            {
                label: '$(run-all) Run all implemented scenarios',
                description: `${scenarios.length} deterministic scenarios; no provider requests`,
                scenarioIds: scenarios.map((scenario) => scenario.id),
            },
            ...scenarios.map((scenario) => ({
                label: `$(beaker) ${scenario.label}`,
                description: scenario.description,
                scenarioIds: [scenario.id],
            })),
            {
                label: '$(warning) LIVE: Foreground cross-provider child',
                description: 'Makes one confirmed billed request using a configured provider different from the parent',
                live: true,
            },
        ];
        const selected = await vscode.window.showQuickPick(picks, {
            title: 'Pi Code: Run Subagent Smoke Test',
            placeHolder: 'Select a deterministic scenario or an explicitly billed LIVE check',
            ignoreFocusOut: true,
        });
        if (!selected) return;

        const selectedScenarios = (selected.scenarioIds ?? [])
            .map((id) => scenarios.find((scenario) => scenario.id === id))
            .filter((scenario): scenario is SmokeScenario => scenario !== undefined);
        const runId = `subagent-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const version = String(context.extension.packageJSON.version ?? 'unknown');
        const startedAt = Date.now();
        const logger = new OutputSmokeLogger(channel, runId);
        const scenarioNames = selected.live
            ? LIVE_SCENARIO_ID
            : selectedScenarios.map((scenario) => scenario.id).join(',');
        channel.show(true);
        logger.line('');
        logger.line('='.repeat(80));
        logger.line(
            `[smoke start] runId=${runId} scenarios=${scenarioNames} ` +
            `version=${version} workspaceTrusted=${vscode.workspace.isTrusted}`,
        );

        const results: SmokeScenarioResult[] = [];
        if (selected.live) {
            const passedBefore = logger.assertionsPassed;
            const failedBefore = logger.assertionsFailed;
            let errorMessage: string | undefined;
            try {
                const ran = await runLiveForegroundSmoke(getActiveSession?.(), logger);
                if (!ran) {
                    logger.line(`[smoke cancelled] runId=${runId} scenario=${LIVE_SCENARIO_ID}`);
                    return;
                }
            } catch (error) {
                errorMessage = error instanceof Error ? error.message : String(error);
                logger.assert(`${LIVE_SCENARIO_ID}-uncaught-error`, false, 'no uncaught error', errorMessage);
            }
            results.push({
                scenario: LIVE_SCENARIO_ID,
                passed: logger.assertionsPassed - passedBefore,
                failed: logger.assertionsFailed - failedBefore,
                durationMs: Date.now() - startedAt,
                ...(errorMessage ? { error: errorMessage } : {}),
            });
        } else {
            for (const scenario of selectedScenarios) {
                if (scenario.confirmationMessage) {
                    const confirmed = await vscode.window.showWarningMessage(
                        scenario.confirmationMessage,
                        { modal: true },
                        'Create temporary Git fixture',
                    );
                    if (confirmed !== 'Create temporary Git fixture') {
                        logger.line(`[smoke cancelled] runId=${runId} scenario=${scenario.id} reason=fixture-confirmation-declined`);
                        return;
                    }
                }
                const scenarioStartedAt = Date.now();
                const passedBefore = logger.assertionsPassed;
                const failedBefore = logger.assertionsFailed;
                logger.line(
                    `[smoke scenario] runId=${runId} scenario=${scenario.id} fixtureSeed=${scenario.fixtureSeed} result=START`,
                );
                let errorMessage: string | undefined;
                try {
                    await scenario.run({
                        metadata: {
                            runId,
                            extensionVersion: version,
                            workspaceTrusted: vscode.workspace.isTrusted,
                            fixtureSeed: scenario.fixtureSeed,
                        },
                        logger,
                        ...(showLauncherSnapshot ? { showLauncherSnapshot } : {}),
                    });
                } catch (error) {
                    errorMessage = error instanceof Error ? error.message : String(error);
                    logger.assert(`${scenario.id}-uncaught-error`, false, 'no uncaught error', errorMessage);
                }
                const result: SmokeScenarioResult = {
                    scenario: scenario.id,
                    passed: logger.assertionsPassed - passedBefore,
                    failed: logger.assertionsFailed - failedBefore,
                    durationMs: Date.now() - scenarioStartedAt,
                    ...(errorMessage ? { error: errorMessage } : {}),
                };
                results.push(result);
                logger.line(
                    `[smoke scenario] runId=${runId} scenario=${scenario.id} passed=${result.passed} ` +
                    `failed=${result.failed} durationMs=${result.durationMs} result=${result.failed === 0 ? 'PASS' : 'FAIL'}`,
                );
            }
        }

        const passed = results.reduce((sum, result) => sum + result.passed, 0);
        const failed = results.reduce((sum, result) => sum + result.failed, 0);
        logger.line(`[smoke cleanup] runId=${runId} result=${results.some((result) => result.error) ? 'FAIL' : 'PASS'}`);
        logger.line(
            `[smoke summary] runId=${runId} passed=${passed} failed=${failed} ` +
            `durationMs=${Date.now() - startedAt} result=${failed === 0 ? 'PASS' : 'FAIL'}`,
        );
        channel.show(true);
        if (failed === 0) {
            void vscode.window.showInformationMessage(`Subagent smoke test passed (${runId}). Inspect Output → ${CHANNEL_NAME}.`);
        } else {
            void vscode.window.showErrorMessage(`Subagent smoke test failed (${runId}). Inspect Output → ${CHANNEL_NAME}.`);
        }
    });
}

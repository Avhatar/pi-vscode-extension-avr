import { describe, expect, it } from 'vitest';
import { foregroundCrossProviderScenario } from '../../../../pi/subagents/smoke/scenarios/foreground-cross-provider';
import { registryResolutionScenario } from '../../../../pi/subagents/smoke/scenarios/registry-resolution';
import { toolGatingScenario } from '../../../../pi/subagents/smoke/scenarios/tool-gating';
import { launcherLifecycleScenario } from '../../../../pi/subagents/smoke/scenarios/launcher-lifecycle';
import { persistenceControlScenario } from '../../../../pi/subagents/smoke/scenarios/persistence-control';
import { backgroundConcurrencyScenario } from '../../../../pi/subagents/smoke/scenarios/background-concurrency';
import { writeWorktreeScenario } from '../../../../pi/subagents/smoke/scenarios/write-worktree';
import { compatibilitySourcesScenario } from '../../../../pi/subagents/smoke/scenarios/compatibility-sources';
import type { SmokeLogger, SmokeScenario } from '../../../../pi/subagents/smoke/types';

class MemorySmokeLogger implements SmokeLogger {
    assertionsPassed = 0;
    assertionsFailed = 0;
    readonly lines: string[] = [];

    line(message: string): void {
        this.lines.push(message);
    }

    step(name: string, details: Record<string, unknown> = {}): void {
        this.lines.push(`step:${name}:${JSON.stringify(details)}`);
    }

    event(name: string, details: Record<string, unknown> = {}): void {
        this.lines.push(`event:${name}:${JSON.stringify(details)}`);
    }

    assert(name: string, condition: boolean, expected?: unknown, actual?: unknown): void {
        if (condition) this.assertionsPassed += 1;
        else this.assertionsFailed += 1;
        this.lines.push(`assert:${name}:${condition ? 'PASS' : 'FAIL'}:${JSON.stringify({ expected, actual })}`);
    }
}

describe('cumulative subagent smoke scenarios', () => {
    it('passes the deterministic registry-resolution simulation', async () => {
        const logger = await runScenario(registryResolutionScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBeGreaterThanOrEqual(15);
        expect(logger.lines.some((line) => line.startsWith('event:spec-resolved:'))).toBe(true);
        expect(logger.lines.at(-1)).toContain('fixture-cleanup');
    });

    it('passes the deterministic foreground cross-provider runtime simulation', async () => {
        const logger = await runScenario(foregroundCrossProviderScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBeGreaterThanOrEqual(13);
        expect(logger.lines.some((line) => line.includes('event:runtime-failure:'))).toBe(true);
        expect(logger.lines.at(-1)).toContain('no-child-session-leaks');
    });

    it('passes the deterministic parent tool-gating simulation', async () => {
        const logger = await runScenario(toolGatingScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBeGreaterThanOrEqual(10);
        expect(logger.lines.some((line) => line.includes('event:gate-applied:'))).toBe(true);
        expect(logger.lines.at(-1)).toContain('tool-gating-cleanup');
    });

    it('passes the deterministic launcher lifecycle simulation', async () => {
        const logger = await runScenario(launcherLifecycleScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBe(10);
        expect(logger.lines.filter((line) => line.includes('event:launcher-row:'))).toHaveLength(7);
        expect(logger.lines.at(-1)).toContain('launcher-lifecycle-ready-for-inspection');
    });

    it('passes the deterministic persistence and control simulation', async () => {
        const logger = await runScenario(persistenceControlScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBeGreaterThanOrEqual(14);
        expect(logger.lines.some((line) => line.includes('event:persistence-reload:'))).toBe(true);
        expect(logger.lines.at(-1)).toContain('persistence-control-fixture-cleanup');
    });

    it('passes the deterministic background concurrency simulation', async () => {
        const logger = await runScenario(backgroundConcurrencyScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBe(15);
        expect(logger.lines.some((line) => line.includes('event:background-concurrency-observed:'))).toBe(true);
        expect(logger.lines.at(-1)).toContain('background-concurrency-cleanup');
    });

    it('passes the temporary Git write-worktree simulation', async () => {
        const logger = await runScenario(writeWorktreeScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBe(15);
        expect(logger.lines.some((line) => line.includes('event:worktree-review:'))).toBe(true);
        expect(logger.lines.at(-1)).toContain('write-worktree-cleanup');
    });

    it('passes the compatibility sources and capability-boundary simulation', async () => {
        const logger = await runScenario(compatibilitySourcesScenario);

        expect(logger.assertionsFailed, logger.lines.join('\n')).toBe(0);
        expect(logger.assertionsPassed).toBe(22);
        expect(logger.lines.some((line) => line.includes('event:compatibility-index:'))).toBe(true);
        expect(logger.lines.some((line) => line.includes('event:remote-agent-policy:'))).toBe(true);
        expect(logger.lines.at(-1)).toContain('compatibility-sources-cleanup');
    });
});

async function runScenario(scenario: SmokeScenario): Promise<MemorySmokeLogger> {
    const logger = new MemorySmokeLogger();
    await scenario.run({
        metadata: {
            runId: 'unit-smoke',
            extensionVersion: 'test',
            workspaceTrusted: true,
            fixtureSeed: scenario.fixtureSeed,
        },
        logger,
    });
    return logger;
}

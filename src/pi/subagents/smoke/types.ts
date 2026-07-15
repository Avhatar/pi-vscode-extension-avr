import type { LauncherSubagentSnapshot } from '../../../shared/protocol';

export interface SmokeRunMetadata {
    runId: string;
    extensionVersion: string;
    workspaceTrusted: boolean;
    fixtureSeed: string;
}

export interface SmokeLogger {
    readonly assertionsPassed: number;
    readonly assertionsFailed: number;
    line(message: string): void;
    step(name: string, details?: Record<string, unknown>): void;
    event(name: string, details?: Record<string, unknown>): void;
    assert(name: string, condition: boolean, expected?: unknown, actual?: unknown): void;
}

export interface SmokeScenarioContext {
    metadata: SmokeRunMetadata;
    logger: SmokeLogger;
    /** Installed smoke host hook. Unit tests omit this; the real extension
     *  uses it to place deterministic rows on the launcher state path. */
    showLauncherSnapshot?: (
        snapshot: LauncherSubagentSnapshot,
        transcripts?: Readonly<Record<string, string>>,
    ) => void;
}

export interface SmokeScenario {
    id: string;
    label: string;
    description: string;
    fixtureSeed: string;
    confirmationMessage?: string;
    run(context: SmokeScenarioContext): Promise<void>;
}

export interface SmokeScenarioResult {
    scenario: string;
    passed: number;
    failed: number;
    durationMs: number;
    error?: string;
}

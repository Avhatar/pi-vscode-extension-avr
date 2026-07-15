import type * as vscode from 'vscode';
import type { SmokeLogger } from './types';

export class OutputSmokeLogger implements SmokeLogger {
    assertionsPassed = 0;
    assertionsFailed = 0;

    constructor(
        private readonly channel: vscode.OutputChannel,
        private readonly runId: string,
    ) {}

    line(message: string): void {
        this.channel.appendLine(message);
    }

    step(name: string, details: Record<string, unknown> = {}): void {
        this.channel.appendLine(`[smoke step] runId=${this.runId} step=${token(name)}${fields(details)}`);
    }

    event(name: string, details: Record<string, unknown> = {}): void {
        this.channel.appendLine(`[smoke event] runId=${this.runId} type=${token(name)}${fields(details)}`);
    }

    assert(name: string, condition: boolean, expected?: unknown, actual?: unknown): void {
        if (condition) this.assertionsPassed += 1;
        else this.assertionsFailed += 1;
        const mismatch = condition
            ? ''
            : ` expected=${printValue(expected)} actual=${printValue(actual)}`;
        this.channel.appendLine(
            `[smoke assert] runId=${this.runId} name=${token(name)} result=${condition ? 'PASS' : 'FAIL'}${mismatch}`,
        );
    }
}

function fields(values: Record<string, unknown>): string {
    return Object.entries(values).map(([key, value]) => ` ${key}=${printValue(value)}`).join('');
}

function printValue(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(redact(value));
    if (value === undefined) return 'undefined';
    try {
        return redact(JSON.stringify(value));
    } catch {
        return JSON.stringify(String(value));
    }
}

function token(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
}

function redact(value: string): string {
    return value
        .replace(/(authorization["'=:\s]+)([^\s",}]+)/gi, '$1<redacted>')
        .replace(/(api[-_ ]?key["'=:\s]+)([^\s",}]+)/gi, '$1<redacted>');
}

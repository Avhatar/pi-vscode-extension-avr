import type * as vscode from 'vscode';
import type { Logger } from '../../core/ports/logger';

/** Adapts a VS Code output channel to the platform-neutral logger port. */
export class VsCodeOutputChannelLogger implements Logger {
    constructor(
        private readonly channel: Pick<vscode.OutputChannel, 'appendLine'>,
    ) {}

    appendLine(message: string): void {
        this.channel.appendLine(message);
    }
}

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../core/ports/logger';
import { VsCodeOutputChannelLogger } from '../../../adapters/vscode/output-channel-logger';
import { PiSessionManager } from '../../../pi/session';

describe('portable session logger port', () => {
    it('adapts VS Code output lines without exposing the channel to the session runtime', () => {
        const appendLine = vi.fn();
        const logger = new VsCodeOutputChannelLogger({ appendLine });

        logger.appendLine('session ready');

        expect(appendLine).toHaveBeenCalledWith('session ready');
    });

    it('preserves the portable logger for replacement session construction', async () => {
        const logger: Logger = { appendLine: vi.fn() };
        const manager = new PiSessionManager(logger);

        expect(manager.logger).toBe(logger);

        await manager.dispose();
    });
});

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('portable core boundaries', () => {
    it('keeps portable chat and file-change modules free of host platform imports', () => {
        const files = [
            'src/core/ports/file-state.ts',
            'src/core/files/diff-manager.ts',
            'src/core/files/checkpoint-manager.ts',
            'src/core/chat/chat-service.ts',
            'src/shared/safe-serialize.ts',
        ];

        for (const relativePath of files) {
            const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
            expect(source, relativePath).not.toMatch(
                /from ['"](?:vscode|electron|(?:node:)?(?:fs|fs\/promises|path|os))['"]/,
            );
            expect(source, relativePath).not.toMatch(/\b(?:vscode|electron)\./);
        }
    });
});

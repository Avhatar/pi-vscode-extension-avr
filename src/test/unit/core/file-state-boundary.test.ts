import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('portable file-change boundary', () => {
    it('keeps portable managers free of VS Code and Node platform imports', () => {
        const files = [
            'src/core/ports/file-state.ts',
            'src/core/files/diff-manager.ts',
            'src/core/files/checkpoint-manager.ts',
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

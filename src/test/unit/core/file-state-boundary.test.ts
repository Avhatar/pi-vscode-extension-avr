import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('portable core boundaries', () => {
    it('keeps portable chat and file-change modules free of host platform imports', () => {
        const files = [
            ...collectTypeScriptFiles(path.resolve('src/core')),
            'src/shared/safe-serialize.ts',
        ];

        for (const relativePath of files) {
            const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
            expect(source, relativePath).not.toMatch(
                /from ['"](?:vscode|electron|(?:node:)?(?:fs|fs\/promises|path|os|child_process))['"]/,
            );
            expect(source, relativePath).not.toMatch(
                /(?:require\s*\(|import\s*\(\s*)['"](?:vscode|electron|(?:node:)?(?:fs|fs\/promises|path|os|child_process))['"]/,
            );
            expect(source, relativePath).not.toMatch(/\b(?:vscode|electron)\./);
            expect(source, relativePath).not.toMatch(
                /\b(?:window|document|navigator|HTMLElement|WebSocket)\b/,
            );
        }
    });
});

function collectTypeScriptFiles(directory: string): string[] {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    return entries.flatMap((entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectTypeScriptFiles(absolutePath);
        return entry.isFile() && entry.name.endsWith('.ts')
            ? [path.relative(process.cwd(), absolutePath)]
            : [];
    });
}

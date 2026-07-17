import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            vscode: fileURLToPath(new URL('./src/test/mocks/vscode.ts', import.meta.url)),
        },
    },
    test: {
        include: ['src/test/unit/**/*.test.ts'],
        testTimeout: 120_000,
        hookTimeout: 60_000,
        setupFiles: ['src/test/setup.ts'],
    },
});

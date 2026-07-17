import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    getPiMcpConfigPath,
    syncClaudeCodeMcpImport,
} from '../../../../pi/mcp/claude-code-import';

let root: string;
let configPath: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-code-mcp-import-'));
    configPath = path.join(root, 'agent', 'mcp.json');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeConfig(value: unknown): string {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(configPath, text, 'utf8');
    return text;
}

function readConfig(): Record<string, any> {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

describe('getPiMcpConfigPath', () => {
    it('uses Pi defaults and mirrors PI_CODING_AGENT_DIR expansion', () => {
        const home = path.join(root, 'home');
        expect(getPiMcpConfigPath({}, home)).toBe(path.join(home, '.pi', 'agent', 'mcp.json'));
        expect(getPiMcpConfigPath({ PI_CODING_AGENT_DIR: '   ' }, home)).toBe(path.join(home, '.pi', 'agent', 'mcp.json'));
        expect(getPiMcpConfigPath({ PI_CODING_AGENT_DIR: '~' }, home)).toBe(path.join(home, 'mcp.json'));
        expect(getPiMcpConfigPath({ PI_CODING_AGENT_DIR: '~/custom' }, home)).toBe(path.join(home, 'custom', 'mcp.json'));
        expect(getPiMcpConfigPath({ PI_CODING_AGENT_DIR: `  ${root}  ` }, home)).toBe(path.join(root, 'mcp.json'));
    });
});

describe('syncClaudeCodeMcpImport', () => {
    it('does not create a missing config when disabled', () => {
        expect(syncClaudeCodeMcpImport(false, configPath)).toEqual({
            path: path.resolve(configPath),
            changed: false,
            claudeImportPresent: false,
        });
        expect(fs.existsSync(configPath)).toBe(false);
    });

    it('creates an adapter-compatible managed import when enabled', () => {
        expect(syncClaudeCodeMcpImport(true, configPath).changed).toBe(true);
        expect(readConfig()).toEqual({
            imports: ['claude-code'],
            mcpServers: {},
            piCode: { managedImports: ['claude-code'] },
        });
    });

    it('preserves existing fields and import order', () => {
        writeConfig({
            imports: ['cursor'],
            mcpServers: { wikijs: { command: 'wiki-server', env: { TOKEN: '${WIKI_TOKEN}' } } },
            settings: { directTools: false },
            custom: 42,
            piCode: { other: true, managedImports: ['cursor'] },
        });

        syncClaudeCodeMcpImport(true, configPath);
        expect(readConfig()).toEqual({
            imports: ['cursor', 'claude-code'],
            mcpServers: { wikijs: { command: 'wiki-server', env: { TOKEN: '${WIKI_TOKEN}' } } },
            settings: { directTools: false },
            custom: 42,
            piCode: { other: true, managedImports: ['cursor', 'claude-code'] },
        });
        expect(syncClaudeCodeMcpImport(true, configPath).changed).toBe(false);
    });

    it('does not claim or remove a manual Claude Code import', () => {
        const original = writeConfig({ imports: ['claude-code'], mcpServers: { existing: {} } });
        expect(syncClaudeCodeMcpImport(true, configPath).changed).toBe(false);
        const result = syncClaudeCodeMcpImport(false, configPath);
        expect(result).toMatchObject({ changed: false, claudeImportPresent: true });
        expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    });

    it('removes only the managed import and cleans owned metadata', () => {
        writeConfig({
            imports: ['cursor', 'claude-code'],
            mcpServers: { existing: {} },
            piCode: { other: true, managedImports: ['cursor', 'claude-code'] },
        });

        expect(syncClaudeCodeMcpImport(false, configPath)).toMatchObject({
            changed: true,
            claudeImportPresent: false,
        });
        expect(readConfig()).toEqual({
            imports: ['cursor'],
            mcpServers: { existing: {} },
            piCode: { other: true, managedImports: ['cursor'] },
        });
    });

    it('cleans a stale ownership marker without touching other fields', () => {
        writeConfig({ mcpServers: {}, piCode: { managedImports: ['claude-code'] } });
        syncClaudeCodeMcpImport(false, configPath);
        expect(readConfig()).toEqual({ mcpServers: {} });
        expect(syncClaudeCodeMcpImport(false, configPath).changed).toBe(false);
    });

    it.each([
        ['invalid JSON', '{broken', /not valid JSON/],
        ['non-object root', '[]', /must contain a JSON object/],
        ['invalid imports', { imports: ['claude-code', 1] }, /"imports".*array of strings/],
        ['invalid piCode', { piCode: [] }, /"piCode".*JSON object/],
        ['invalid managed imports', { piCode: { managedImports: 'claude-code' } }, /managedImports.*array of strings/],
    ])('rejects %s without overwriting the source', (_label, value, expected) => {
        const original = writeConfig(value);
        expect(() => syncClaudeCodeMcpImport(true, configPath)).toThrow(expected as RegExp);
        expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    });
});

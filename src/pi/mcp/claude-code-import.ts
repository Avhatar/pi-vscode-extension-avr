import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLAUDE_CODE_IMPORT = 'claude-code';
const PI_CODE_METADATA_KEY = 'piCode';
const MANAGED_IMPORTS_KEY = 'managedImports';

interface McpConfigDocument extends Record<string, unknown> {
    imports?: string[];
    piCode?: Record<string, unknown>;
}

export interface ClaudeCodeMcpImportSyncResult {
    path: string;
    changed: boolean;
    claudeImportPresent: boolean;
}

/** Resolve the same Pi agent directory used by pi-mcp-adapter. */
export function getPiMcpConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = os.homedir(),
): string {
    const configured = env.PI_CODING_AGENT_DIR?.trim();
    if (!configured) return path.join(homeDirectory, '.pi', 'agent', 'mcp.json');
    if (configured === '~') return path.join(homeDirectory, 'mcp.json');
    if (configured.startsWith('~/')) {
        return path.join(homeDirectory, configured.slice(2), 'mcp.json');
    }
    return path.join(path.resolve(configured), 'mcp.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`${label} must be an array of strings`);
    }
}

function readConfig(configPath: string): McpConfigDocument | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(`Unable to read Pi MCP config at ${configPath}: ${(error as Error).message}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Pi MCP config at ${configPath} is not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(parsed)) {
        throw new Error(`Pi MCP config at ${configPath} must contain a JSON object`);
    }

    if (parsed.imports !== undefined) {
        assertStringArray(parsed.imports, `Pi MCP config "imports" at ${configPath}`);
    }
    if (parsed[PI_CODE_METADATA_KEY] !== undefined && !isRecord(parsed[PI_CODE_METADATA_KEY])) {
        throw new Error(`Pi MCP config "${PI_CODE_METADATA_KEY}" at ${configPath} must be a JSON object`);
    }
    const metadata = parsed[PI_CODE_METADATA_KEY] as Record<string, unknown> | undefined;
    if (metadata?.[MANAGED_IMPORTS_KEY] !== undefined) {
        assertStringArray(
            metadata[MANAGED_IMPORTS_KEY],
            `Pi MCP config "${PI_CODE_METADATA_KEY}.${MANAGED_IMPORTS_KEY}" at ${configPath}`,
        );
    }

    return parsed as McpConfigDocument;
}

function writeConfig(configPath: string, document: McpConfigDocument): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporaryPath, configPath);
    } catch (error) {
        try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
        throw new Error(`Unable to update Pi MCP config at ${configPath}: ${(error as Error).message}`);
    }
}

/**
 * Add or remove Pi Code's opt-in Claude Code compatibility import.
 * Existing manual imports are never claimed or removed.
 */
export function syncClaudeCodeMcpImport(
    enabled: boolean,
    configPath: string = getPiMcpConfigPath(),
): ClaudeCodeMcpImportSyncResult {
    const resolvedPath = path.resolve(configPath);
    const document = readConfig(resolvedPath);
    if (!document) {
        if (!enabled) {
            return { path: resolvedPath, changed: false, claudeImportPresent: false };
        }
        writeConfig(resolvedPath, {
            imports: [CLAUDE_CODE_IMPORT],
            mcpServers: {},
            [PI_CODE_METADATA_KEY]: { [MANAGED_IMPORTS_KEY]: [CLAUDE_CODE_IMPORT] },
        });
        return { path: resolvedPath, changed: true, claudeImportPresent: true };
    }

    const imports = document.imports ?? [];
    const metadata = document.piCode;
    const managedImports = (metadata?.[MANAGED_IMPORTS_KEY] as string[] | undefined) ?? [];
    const importPresent = imports.includes(CLAUDE_CODE_IMPORT);
    const importManaged = managedImports.includes(CLAUDE_CODE_IMPORT);

    if (enabled) {
        if (importPresent) {
            return { path: resolvedPath, changed: false, claudeImportPresent: true };
        }
        document.imports = [...imports, CLAUDE_CODE_IMPORT];
        document.piCode = {
            ...metadata,
            [MANAGED_IMPORTS_KEY]: [...managedImports, CLAUDE_CODE_IMPORT],
        };
        writeConfig(resolvedPath, document);
        return { path: resolvedPath, changed: true, claudeImportPresent: true };
    }

    if (!importManaged) {
        return { path: resolvedPath, changed: false, claudeImportPresent: importPresent };
    }

    const remainingImports = imports.filter((entry) => entry !== CLAUDE_CODE_IMPORT);
    if (remainingImports.length > 0) document.imports = remainingImports;
    else delete document.imports;

    const remainingManaged = managedImports.filter((entry) => entry !== CLAUDE_CODE_IMPORT);
    const remainingMetadata = { ...metadata };
    if (remainingManaged.length > 0) remainingMetadata[MANAGED_IMPORTS_KEY] = remainingManaged;
    else delete remainingMetadata[MANAGED_IMPORTS_KEY];
    if (Object.keys(remainingMetadata).length > 0) document.piCode = remainingMetadata;
    else delete document.piCode;

    writeConfig(resolvedPath, document);
    return { path: resolvedPath, changed: true, claudeImportPresent: false };
}

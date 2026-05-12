// Temporary diagnostic command for the LSP-integration feature (Phase 0).
// Runs every provider we plan to expose against the symbol under the cursor
// in the active editor, and writes timing + result shape to a dedicated
// OutputChannel. Used to verify provider availability + result shape across
// language extensions (C# Dev Kit, built-in TS, Pylance, etc.) BEFORE
// committing to the tool registration. Remove once Phase 1 lands.
//
// Invoke from Command Palette: "Pi Code: LSP Smoke Test (cursor)".

import * as vscode from 'vscode';

const COMMAND_ID = 'pi-code.lspSmoke';
const CHANNEL_NAME = 'Pi Code: LSP Smoke';

export function registerLspSmokeCommand(
    context: vscode.ExtensionContext,
): vscode.Disposable {
    const channel = vscode.window.createOutputChannel(CHANNEL_NAME);
    context.subscriptions.push(channel);

    return vscode.commands.registerCommand(COMMAND_ID, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('LSP Smoke: no active editor');
            return;
        }
        const doc = editor.document;
        const pos = editor.selection.active;
        const wordRange = doc.getWordRangeAtPosition(pos);
        const word = wordRange ? doc.getText(wordRange) : '';

        channel.clear();
        channel.show(true);
        channel.appendLine(`=== LSP Smoke Test @ ${new Date().toISOString()} ===`);
        channel.appendLine(`File:     ${doc.uri.fsPath}`);
        channel.appendLine(`Language: ${doc.languageId}`);
        channel.appendLine(`Position: line ${pos.line + 1}, col ${pos.character + 1}`);
        channel.appendLine(`Word:     ${JSON.stringify(word)}`);
        channel.appendLine('');

        logRelevantExtensions(channel, doc.languageId);
        channel.appendLine('');

        const openBefore = new Set(
            vscode.workspace.textDocuments.map((d) => d.uri.toString()),
        );

        await runProvider(channel, 'vscode.executeDefinitionProvider', [doc.uri, pos]);
        await runProvider(channel, 'vscode.executeTypeDefinitionProvider', [doc.uri, pos]);
        await runProvider(channel, 'vscode.executeImplementationProvider', [doc.uri, pos]);
        await runProvider(channel, 'vscode.executeReferenceProvider', [doc.uri, pos]);
        await runProvider(channel, 'vscode.executeDocumentSymbolProvider', [doc.uri]);
        await runProvider(channel, 'vscode.executeHoverProvider', [doc.uri, pos]);
        await runCallHierarchy(channel, doc.uri, pos);

        if (word) {
            await runProvider(channel, 'vscode.executeWorkspaceSymbolProvider', [word]);
        } else {
            channel.appendLine('-- vscode.executeWorkspaceSymbolProvider: skipped (no word at cursor) --\n');
        }

        const openAfter = new Set(
            vscode.workspace.textDocuments.map((d) => d.uri.toString()),
        );
        const newlyOpened = [...openAfter].filter((u) => !openBefore.has(u));
        channel.appendLine(`Documents auto-opened during smoke: ${newlyOpened.length}`);
        for (const u of newlyOpened.slice(0, 10)) {
            channel.appendLine(`  ${u}`);
        }
        if (newlyOpened.length > 10) {
            channel.appendLine(`  ... and ${newlyOpened.length - 10} more`);
        }

        channel.appendLine('\n=== Done ===');
    });
}

async function runProvider(
    channel: vscode.OutputChannel,
    command: string,
    args: unknown[],
): Promise<void> {
    const label = `-- ${command} --`;
    const argSummary = args.map((a) => formatArg(a)).join(', ');
    channel.appendLine(`${label}  args: ${argSummary}`);
    const t0 = Date.now();
    try {
        const result = await vscode.commands.executeCommand<unknown>(
            command,
            ...args,
        );
        const dt = Date.now() - t0;
        const summary = summarize(result);
        channel.appendLine(`  ${dt}ms · ${summary.shape} · count=${summary.count}`);
        const sampleLimit = 10;
        const samples = summary.samples.slice(0, sampleLimit);
        for (const s of samples) {
            channel.appendLine(`    ${s}`);
        }
        if (summary.count > samples.length) {
            channel.appendLine(`    ... and ${summary.count - samples.length} more`);
        }
    } catch (err) {
        const dt = Date.now() - t0;
        channel.appendLine(`  ${dt}ms · ERROR · ${(err as Error).message ?? String(err)}`);
    }
    channel.appendLine('');
}

async function runCallHierarchy(
    channel: vscode.OutputChannel,
    uri: vscode.Uri,
    pos: vscode.Position,
): Promise<void> {
    channel.appendLine('-- prepareCallHierarchy --');
    const t0 = Date.now();
    let items: vscode.CallHierarchyItem[] | undefined;
    try {
        items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            uri,
            pos,
        );
        const dt = Date.now() - t0;
        channel.appendLine(`  ${dt}ms · count=${items?.length ?? 0}`);
        for (const item of (items ?? []).slice(0, 3)) {
            channel.appendLine(`    ${item.kind} ${item.name}  ${formatUri(item.uri)}`);
        }
    } catch (err) {
        const dt = Date.now() - t0;
        channel.appendLine(`  ${dt}ms · ERROR · ${(err as Error).message ?? String(err)}`);
    }
    channel.appendLine('');

    if (!items || items.length === 0) {
        return;
    }
    const root = items[0];

    channel.appendLine(`-- provideIncomingCalls (${root.name}) --`);
    const tIn = Date.now();
    try {
        const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls',
            root,
        );
        const dt = Date.now() - tIn;
        channel.appendLine(`  ${dt}ms · count=${incoming?.length ?? 0}`);
        for (const c of (incoming ?? []).slice(0, 3)) {
            channel.appendLine(`    from ${c.from.name}  ${formatUri(c.from.uri)}`);
        }
    } catch (err) {
        const dt = Date.now() - tIn;
        channel.appendLine(`  ${dt}ms · ERROR · ${(err as Error).message ?? String(err)}`);
    }
    channel.appendLine('');
}

interface Summary {
    shape: string;
    count: number;
    samples: string[];
}

function summarize(result: unknown): Summary {
    if (result == null) {
        return { shape: 'null/undefined', count: 0, samples: [] };
    }
    if (Array.isArray(result)) {
        const samples = result.map(formatItem);
        return { shape: `Array<${result.length ? typeofItem(result[0]) : 'empty'}>`, count: result.length, samples };
    }
    return { shape: typeof result, count: 1, samples: [formatItem(result)] };
}

function typeofItem(item: unknown): string {
    if (!item || typeof item !== 'object') return typeof item;
    const obj = item as Record<string, unknown>;
    if ('uri' in obj && 'range' in obj) return 'Location';
    if ('targetUri' in obj && 'targetRange' in obj) return 'LocationLink';
    if ('name' in obj && 'kind' in obj && 'location' in obj) return 'SymbolInformation';
    if ('name' in obj && 'kind' in obj && 'range' in obj) return 'DocumentSymbol';
    if ('contents' in obj) return 'Hover';
    return 'object';
}

function formatItem(item: unknown): string {
    if (!item || typeof item !== 'object') return String(item);
    const obj = item as Record<string, unknown>;

    if ('uri' in obj && 'range' in obj) {
        const range = obj.range as vscode.Range;
        return `Location ${formatUri(obj.uri as vscode.Uri)}:${range.start.line + 1}:${range.start.character + 1}`;
    }
    if ('targetUri' in obj && 'targetRange' in obj) {
        const range = obj.targetRange as vscode.Range;
        return `LocationLink ${formatUri(obj.targetUri as vscode.Uri)}:${range.start.line + 1}:${range.start.character + 1}`;
    }
    if ('name' in obj && 'location' in obj) {
        const loc = obj.location as vscode.Location;
        return `Symbol ${String(obj.name)} (${String(obj.kind)}) @ ${formatUri(loc.uri)}:${loc.range.start.line + 1}`;
    }
    if ('name' in obj && 'range' in obj) {
        const range = obj.range as vscode.Range;
        return `DocSymbol ${String(obj.name)} (${String(obj.kind)}) @ ${range.start.line + 1}-${range.end.line + 1}`;
    }
    if ('contents' in obj) {
        const contents = obj.contents as unknown[];
        const first = contents?.[0];
        const text = typeof first === 'string'
            ? first
            : (first as { value?: string })?.value ?? '';
        return `Hover "${text.replace(/\s+/g, ' ').slice(0, 80)}"`;
    }
    return JSON.stringify(obj).slice(0, 120);
}

function formatArg(arg: unknown): string {
    if (arg instanceof vscode.Uri) return formatUri(arg);
    if (arg && typeof arg === 'object' && 'line' in arg && 'character' in arg) {
        const p = arg as vscode.Position;
        return `Position(${p.line + 1},${p.character + 1})`;
    }
    return JSON.stringify(arg);
}

function formatUri(uri: vscode.Uri): string {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (ws) {
        const rel = vscode.workspace.asRelativePath(uri, false);
        return rel;
    }
    return uri.fsPath ?? uri.toString();
}

/**
 * Surface which language extensions are installed and whether they're
 * active. If a `csharp` document yields no provider results, the most
 * likely cause is that no C# extension is active in the Extension
 * Development Host — this output makes that obvious without guessing.
 */
function logRelevantExtensions(
    channel: vscode.OutputChannel,
    languageId: string,
): void {
    channel.appendLine('-- installed extensions (filtered) --');
    const interesting = vscode.extensions.all
        .filter((e) => isInteresting(e.id, languageId))
        .sort((a, b) => a.id.localeCompare(b.id));
    if (interesting.length === 0) {
        channel.appendLine('  (none — no language extension matched the active document)');
        channel.appendLine(`  total installed: ${vscode.extensions.all.length}`);
        return;
    }
    for (const ext of interesting) {
        const kind = ext.extensionKind === vscode.ExtensionKind.UI ? 'UI' : 'Workspace';
        channel.appendLine(`  ${ext.id}  active=${ext.isActive}  kind=${kind}`);
    }
}

function isInteresting(id: string, languageId: string): boolean {
    const lower = id.toLowerCase();
    if (languageId === 'csharp') {
        return (
            lower.includes('dotnet') ||
            lower.includes('csharp') ||
            lower.includes('omnisharp') ||
            lower.includes('unity')
        );
    }
    if (languageId === 'typescript' || languageId === 'typescriptreact'
        || languageId === 'javascript' || languageId === 'javascriptreact') {
        return lower.includes('typescript') || lower.includes('javascript') || lower.includes('vscode.typescript');
    }
    if (languageId === 'python') {
        return lower.includes('python') || lower.includes('pylance') || lower.includes('pyright');
    }
    if (languageId === 'rust') {
        return lower.includes('rust');
    }
    if (languageId === 'go') {
        return lower === 'golang.go' || lower.includes('.go');
    }
    return lower.includes(languageId);
}

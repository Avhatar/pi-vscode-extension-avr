import type * as vscode from 'vscode';

// Preflight normalizer for the built-in Pi `edit` tool.
//
// Some LLMs (notably DeepSeek) call `edit` with slightly wrong argument
// shapes — the most common failure is nesting `path` inside every
// `edits[i]` (treating `edits` as multi-file operations) or using
// Anthropic's `file_path` / `old_string` / `new_string` naming. The
// bundled `prepareEditArguments` handles two known mis-shapes (edits as
// JSON string, legacy top-level oldText/newText) but not these — the
// call fails schema validation and the model has to burn tokens on a
// retry.
//
// We wrap the tool's own `prepareArguments` with a normalizer that runs
// AFTER upstream's fixups and rescues the remaining shapes before
// validation. If we cannot confidently rescue the args, we return them
// unchanged so the SDK still reports the real error to the model.

type AnyTool = {
    name: string;
    prepareArguments?: (args: unknown) => unknown;
    // Set by us to make repeat-application idempotent.
    __piCodePreflightPatched?: boolean;
};

type SessionLike = {
    agent?: {
        state?: {
            tools?: AnyTool[];
        };
    };
    // Private internals; treated as best-effort.
    _toolRegistry?: Map<string, AnyTool>;
    _refreshToolRegistry?: (...args: unknown[]) => unknown;
    __piCodePreflightHooked?: boolean;
};

const OLD_TEXT_KEYS = ['oldText', 'old_string', 'oldStr', 'old'] as const;
const NEW_TEXT_KEYS = ['newText', 'new_string', 'newStr', 'new'] as const;

export function installEditToolPreflight(
    session: unknown,
    log?: vscode.OutputChannel,
): void {
    const s = session as SessionLike | null | undefined;
    if (!s || typeof s !== 'object') return;

    const apply = () => patchEditTools(s, log);

    apply();

    // Tool registry can be rebuilt (reload, extension changes) — re-apply
    // our patch after each rebuild. Best-effort: if the SDK internals ever
    // change, we silently fall back to no interception (model still gets
    // the plain SDK validation error, exactly as before this hook).
    if (s._refreshToolRegistry && !s.__piCodePreflightHooked) {
        const original = s._refreshToolRegistry.bind(s);
        s._refreshToolRegistry = (...args: unknown[]) => {
            const result = original(...args);
            try { apply(); } catch { /* non-fatal */ }
            return result;
        };
        s.__piCodePreflightHooked = true;
    }
}

function patchEditTools(session: SessionLike, log?: vscode.OutputChannel): void {
    const targets = collectEditTools(session);
    for (const tool of targets) {
        if (tool.__piCodePreflightPatched) continue;
        const upstream = tool.prepareArguments;
        tool.prepareArguments = (input: unknown) => {
            let args: unknown = input;
            if (upstream) {
                try { args = upstream(args); } catch { /* fall through with original */ }
            }
            return normalizeEditArgs(args, log);
        };
        tool.__piCodePreflightPatched = true;
    }
}

function collectEditTools(session: SessionLike): AnyTool[] {
    const found = new Map<AnyTool, true>();
    const active = session.agent?.state?.tools;
    if (Array.isArray(active)) {
        for (const t of active) {
            if (t?.name === 'edit') found.set(t, true);
        }
    }
    if (session._toolRegistry instanceof Map) {
        const t = session._toolRegistry.get('edit');
        if (t) found.set(t, true);
    }
    return [...found.keys()];
}

function normalizeEditArgs(input: unknown, log?: vscode.OutputChannel): unknown {
    if (!input || typeof input !== 'object') return input;
    const original = input as Record<string, unknown>;
    let args: Record<string, unknown> = original;
    let mutated = false;
    const notes: string[] = [];

    // (1) Rename Anthropic-style `file_path` to `path`.
    if (typeof args.path !== 'string' && typeof args.file_path === 'string') {
        args = { ...args, path: args.file_path };
        delete args.file_path;
        mutated = true;
        notes.push('renamed file_path → path');
    }

    // (2) Hoist path from edits[i] to top level if consistent.
    if (typeof args.path !== 'string' && Array.isArray(args.edits) && args.edits.length > 0) {
        const perEditPaths = args.edits.map((e) => extractPath(e));
        if (perEditPaths.every((p): p is string => typeof p === 'string' && p.length > 0)) {
            const unique = new Set(perEditPaths);
            if (unique.size === 1) {
                args = { ...args, path: perEditPaths[0] };
                mutated = true;
                notes.push('hoisted path from edits[]');
            }
        }
    }

    // (3) Sanitize each edit: accept name variants, strip extras.
    if (Array.isArray(args.edits)) {
        const before = args.edits;
        let editsMutated = false;
        const cleaned = before.map((edit) => {
            if (!edit || typeof edit !== 'object') return edit;
            const e = edit as Record<string, unknown>;
            const oldText = pickString(e, OLD_TEXT_KEYS);
            const newText = pickString(e, NEW_TEXT_KEYS);
            if (oldText === undefined || newText === undefined) {
                // Cannot confidently rescue — leave as-is so SDK reports the real error.
                return edit;
            }
            const alreadyClean =
                Object.keys(e).length === 2 &&
                typeof e.oldText === 'string' &&
                typeof e.newText === 'string';
            if (alreadyClean) return edit;
            editsMutated = true;
            return { oldText, newText };
        });
        if (editsMutated) {
            args = { ...args, edits: cleaned };
            mutated = true;
            notes.push('sanitized edits[] (stripped extras / renamed keys)');
        }
    }

    if (mutated && log) {
        log.appendLine(`[edit preflight] rewrote model args: ${notes.join('; ')}`);
    }

    return mutated ? args : original;
}

function extractPath(edit: unknown): string | null {
    if (!edit || typeof edit !== 'object') return null;
    const e = edit as Record<string, unknown>;
    if (typeof e.path === 'string' && e.path.length > 0) return e.path;
    if (typeof e.file_path === 'string' && e.file_path.length > 0) return e.file_path;
    if (typeof e.filePath === 'string' && e.filePath.length > 0) return e.filePath;
    return null;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'string') return value;
    }
    return undefined;
}

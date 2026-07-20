import type { CacheEffective, CacheMode } from '../../shared/agent-protocol';
import { getCacheCapability } from '../../shared/cache-info';
import {
    disabledToolsFromProjectDefault,
    type ProjectToolSelectionDefault,
} from '../../shared/project-tool-default';
import type { StateStore } from '../ports/chat-platform';

export const TODO_ENABLED_KEY_PREFIX = 'pi-code.todoEnabled.';
export const PLAN_MODE_KEY_PREFIX = 'pi-code.planModeEnabled.';
export const FILE_UNDO_VIEW_KEY_PREFIX = 'pi-code.fileUndoViewEnabled.';
export const TOOLS_DISABLED_KEY_PREFIX = 'pi-code.disabledTools.';
export const PROJECT_TOOL_DEFAULT_KEY = 'pi-code.projectToolSelectionDefault';

export const PLAN_MODE_INSTRUCTIONS =
    '<plan-mode-instructions>\n' +
    'Plan Mode is on. Not every prompt needs a plan — use judgment:\n' +
    '\n' +
    '- If the user is asking a question, requesting information, or\n' +
    '  discussing an approach: answer directly, no planning required.\n' +
    '- If the user is asking for changes to code or a multi-step task:\n' +
    '  first study the relevant files, then sketch a plan (use the todo\n' +
    '  tool for multi-step work), then execute. Confirm the approach is\n' +
    '  sound before doing anything invasive.\n' +
    '\n' +
    'When editing a file, oldText must match the current file\n' +
    'byte-for-byte (exact whitespace, indentation, line endings).\n' +
    'Re-read the target region if you are unsure — do not reconstruct\n' +
    'oldText from memory or from an earlier plan.\n' +
    '\n' +
    'You can execute the plan in the same turn once it is clear. Only\n' +
    'stop and wait for the user if you have a genuinely open question\n' +
    'they need to answer before you can proceed.\n' +
    '</plan-mode-instructions>';

const AUTO_IDLE_GAP_THRESHOLD_MS = 2 * 60 * 1000;
const AUTO_LARGE_CONTEXT_TOKENS = 20_000;

export interface CachePolicyInput {
    readonly cacheMode: CacheMode;
    readonly provider?: string;
    readonly modelId?: string;
    readonly lastTurnEndAt: number;
    readonly maxIdleGapMs: number;
    readonly contextTokens: number;
    readonly now: number;
}

export function sessionPreferenceKey(prefix: string, sessionPath?: string): string | undefined {
    return sessionPath ? `${prefix}${sessionPath}` : undefined;
}

export function readSessionBoolean(
    store: StateStore,
    prefix: string,
    sessionPath: string | undefined,
    fallback: boolean,
): boolean {
    const key = sessionPreferenceKey(prefix, sessionPath);
    if (!key) return fallback;
    const stored = store.get<unknown>(key);
    return typeof stored === 'boolean' ? stored : fallback;
}

export async function writeSessionBoolean(
    store: StateStore,
    prefix: string,
    sessionPath: string | undefined,
    value: boolean,
): Promise<void> {
    const key = sessionPreferenceKey(prefix, sessionPath);
    if (key) await store.update(key, value);
}

export function readDisabledTools(
    store: StateStore,
    sessionPath: string | undefined,
    projectDefault: ProjectToolSelectionDefault | undefined,
    registeredTools: readonly string[],
): string[] {
    const key = sessionPreferenceKey(TOOLS_DISABLED_KEY_PREFIX, sessionPath);
    const stored = key ? store.get<unknown>(key) : undefined;
    if (stored !== undefined) {
        return Array.isArray(stored)
            ? stored.filter((value): value is string => typeof value === 'string' && value.length > 0)
            : [];
    }
    if (!projectDefault) return [];
    return disabledToolsFromProjectDefault(projectDefault, registeredTools)
        .filter((tool) => tool !== 'todo' && tool !== 'subagent');
}

export async function writeDisabledTools(
    store: StateStore,
    sessionPath: string | undefined,
    disabled: readonly string[],
): Promise<void> {
    const key = sessionPreferenceKey(TOOLS_DISABLED_KEY_PREFIX, sessionPath);
    if (!key) return;
    const normalized = [...new Set(
        disabled.filter((tool) => typeof tool === 'string' && tool.length > 0),
    )];
    await store.update(key, normalized);
}

export function composeEffectiveDisabledTools(
    disabled: readonly string[],
    todoEnabled: boolean,
    subagentsEnabled: boolean,
): string[] {
    const effective = new Set(disabled);
    if (todoEnabled) effective.delete('todo');
    else effective.add('todo');
    if (subagentsEnabled) effective.delete('subagent');
    else effective.add('subagent');
    return [...effective];
}

export function decorateDirectPrompt(text: string, planModeEnabled: boolean): string {
    return planModeEnabled ? `${PLAN_MODE_INSTRUCTIONS}\n\n${text}` : text;
}

export function isChatTabBusy(tab: { isStreamingLocal: boolean; isCompacting: boolean }): boolean {
    return tab.isStreamingLocal || tab.isCompacting;
}

export function computeEffectiveCache(input: CachePolicyInput): CacheEffective {
    const capability = getCacheCapability(input.provider, input.modelId);
    if (capability.forcedEffective) return capability.forcedEffective;
    if (input.cacheMode === 'short' || input.cacheMode === 'long') return input.cacheMode;
    if (capability.writeFree) return 'long';
    const pendingIdleGap = input.lastTurnEndAt > 0
        ? Math.max(0, input.now - input.lastTurnEndAt)
        : 0;
    const observedMaxGap = Math.max(input.maxIdleGapMs, pendingIdleGap);
    if (observedMaxGap >= AUTO_IDLE_GAP_THRESHOLD_MS) return 'long';
    if (input.contextTokens >= AUTO_LARGE_CONTEXT_TOKENS) return 'long';
    return 'short';
}

export function prepareCacheForRequest(
    input: CachePolicyInput,
): { effective: CacheEffective; maxIdleGapMs: number } {
    const currentIdleGap = input.lastTurnEndAt > 0
        ? Math.max(0, input.now - input.lastTurnEndAt)
        : 0;
    const maxIdleGapMs = Math.max(input.maxIdleGapMs, currentIdleGap);
    return {
        effective: computeEffectiveCache({ ...input, maxIdleGapMs }),
        maxIdleGapMs,
    };
}

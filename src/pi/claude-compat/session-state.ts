import type { ExpandedInstructionFile } from './imports';
import type { ClaudeRule } from './rules';
import type { ClaudeSkillResource } from './resources';
import { CLAUDE_RULE_APPLIED_ENTRY } from './rules';
import { normalizePathForCompare } from './path-scope';

export const CLAUDE_INSTRUCTION_APPLIED_ENTRY = 'claude-compat-instruction-applied';
export const CLAUDE_CONTEXT_DELIVERED_ENTRY = 'claude-compat-context-delivered';
export const CLAUDE_NESTED_SKILL_APPLIED_ENTRY = 'claude-compat-nested-skill-applied';

export function getEntriesSinceLastCompaction(entries: any[]): any[] {
    for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index]?.type === 'compaction') return entries.slice(index + 1);
    }
    return entries;
}

export function wasClaudeContextDelivered(entries: any[], fingerprint: string): boolean {
    return getEntriesSinceLastCompaction(entries).some((entry) =>
        entry?.type === 'custom' &&
        entry.customType === CLAUDE_CONTEXT_DELIVERED_ENTRY &&
        entry.data?.fingerprint === fingerprint,
    );
}

export function getAppliedInstructionKeys(entries: any[]): Set<string> {
    const applied = new Set<string>();
    for (const entry of getEntriesSinceLastCompaction(entries)) {
        if (entry?.type !== 'custom' || entry.customType !== CLAUDE_INSTRUCTION_APPLIED_ENTRY) continue;
        if (typeof entry.data?.path !== 'string' || typeof entry.data?.fingerprint !== 'string') continue;
        applied.add(instructionKey(entry.data.path, entry.data.fingerprint));
    }
    return applied;
}

export function instructionKey(filePath: string, fingerprint: string): string {
    return `${normalizePathForCompare(filePath)}|${fingerprint}`;
}

export function filterUnappliedInstructions(
    files: ExpandedInstructionFile[],
    entries: any[],
): ExpandedInstructionFile[] {
    const applied = getAppliedInstructionKeys(entries);
    return files.filter((file) => !applied.has(instructionKey(file.canonicalPath, file.fingerprint)));
}

export function filterUnappliedNestedSkills(
    skills: ClaudeSkillResource[],
    entries: any[],
): ClaudeSkillResource[] {
    const applied = new Set<string>();
    for (const entry of getEntriesSinceLastCompaction(entries)) {
        if (entry?.type !== 'custom' || entry.customType !== CLAUDE_NESTED_SKILL_APPLIED_ENTRY) continue;
        if (typeof entry.data?.path === 'string') applied.add(normalizePathForCompare(entry.data.path));
    }
    return skills.filter((skill) => !applied.has(normalizePathForCompare(skill.canonicalPath)));
}

export function getCurrentAssistantTurnId(entries: any[], fallback?: string): string {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type === 'message' && entry.message?.role === 'assistant') {
            return String(entry.id ?? entry.message.id ?? fallback ?? 'unknown-turn');
        }
    }
    return fallback ?? 'unknown-turn';
}

export function getRuleApplicationState(
    rule: ClaudeRule,
    entries: any[],
    currentTurnId: string,
): 'unseen' | 'queued-this-turn' | 'applied' {
    let queued = false;
    for (const entry of getEntriesSinceLastCompaction(entries)) {
        if (entry?.type !== 'custom' || entry.customType !== CLAUDE_RULE_APPLIED_ENTRY) continue;
        if (normalizePathForCompare(String(entry.data?.path ?? '')) !== normalizePathForCompare(rule.canonicalPath)) continue;
        if (entry.data?.fingerprint !== rule.fingerprint) continue;
        if (entry.data?.sourceTurnId === currentTurnId) queued = true;
        else return 'applied';
    }
    return queued ? 'queued-this-turn' : 'unseen';
}

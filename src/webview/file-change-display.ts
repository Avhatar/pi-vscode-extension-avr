import type { FileChangeInfo } from '../shared/agent-protocol';

/** Child edits remain reviewable through File Undo View, but do not interrupt the parent chat timeline. */
export function shouldRenderInlineFileChange(change: FileChangeInfo): boolean {
    return !change.subagentAgentId;
}

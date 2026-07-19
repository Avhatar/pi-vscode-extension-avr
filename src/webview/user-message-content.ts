const FILE_BLOCK_RE = /\[File:\s*(.+?)\]\s*(?:\(binary file\))?[\s\S]*?\[\/File\]\s*\n?/g;
const PLAN_MODE_BLOCK_RE = /^<plan-mode-instructions>[\s\S]*?<\/plan-mode-instructions>\s*\n?/;

export interface UserMessageContent {
    cleanText: string;
    fileNames: string[];
}

/** Remove internal prompt decorations before rendering a user message. */
export function prepareUserMessageContent(rawText: string): UserMessageContent {
    const fileNames: string[] = [];
    const withoutFiles = rawText.replace(FILE_BLOCK_RE, (_, name: string) => {
        fileNames.push(name.trim());
        return '';
    });
    const cleanText = withoutFiles.replace(PLAN_MODE_BLOCK_RE, '');
    return { cleanText, fileNames };
}

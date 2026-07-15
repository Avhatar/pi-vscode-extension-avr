const FENCED_BLOCK = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[ \t]*(?=\n|$)|$)/g;
const INLINE_CODE = /(`+)([^\n]*?)\1/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

function preserveNewlines(value: string): string {
    return value.replace(/[^\n]/g, ' ');
}

/** Remove block HTML comments outside fenced and inline code. */
export function stripClaudeHtmlComments(markdown: string): string {
    const protectedRegions: string[] = [];
    const protect = (value: string): string => {
        const token = `\u0000CLAUDE_CODE_REGION_${protectedRegions.length}\u0000`;
        protectedRegions.push(value);
        return token;
    };
    let output = markdown.replace(FENCED_BLOCK, protect).replace(INLINE_CODE, protect);
    output = output.replace(HTML_COMMENT, '');
    return output.replace(/\u0000CLAUDE_CODE_REGION_(\d+)\u0000/g, (_token, index) =>
        protectedRegions[Number(index)] ?? '',
    );
}

/** Mask syntax regions where Claude Code does not interpret @file imports. */
export function maskNonImportMarkdown(markdown: string): string {
    let masked = markdown.replace(FENCED_BLOCK, (value) => preserveNewlines(value));
    masked = masked.replace(INLINE_CODE, (value) => preserveNewlines(value));
    masked = masked.replace(HTML_COMMENT, (value) => preserveNewlines(value));
    return masked;
}

export function extractClaudeImportReferences(markdown: string): string[] {
    const masked = maskNonImportMarkdown(markdown);
    const references: string[] = [];
    const pattern = /(?:^|[\s(])@([^\s`<>"'(){}\[\],;]+)/gm;
    for (const match of masked.matchAll(pattern)) {
        const reference = match[1]?.replace(/[.!?:]+$/, '');
        if (reference) references.push(reference);
    }
    return references;
}

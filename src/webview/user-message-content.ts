const FILE_BLOCK_RE = /\[File:\s*(.+?)\]\s*(?:\(binary file\))?[\s\S]*?\[\/File\]\s*\n?/g;
const PLAN_MODE_BLOCK_RE = /^<plan-mode-instructions>[\s\S]*?<\/plan-mode-instructions>\s*\n?/;
const ATTACHMENT_INSTRUCTIONS_BLOCK_RE = /<pi-code-attachment-instructions>[\s\S]*?<\/pi-code-attachment-instructions>\s*\n?/g;
const REFERENCED_WORKSPACE_FILES_BLOCK_RE = /\n\nReferenced workspace files to inspect if needed:\n[\s\S]*$/;

/** Build the model-facing fallback used when attachments are sent without user text. */
export function createAttachmentOnlyPromptText(imageCount: number, fileNames: readonly string[]): string {
    let instruction: string;
    if (imageCount > 0 && fileNames.length > 0) {
        instruction = 'Please inspect the attached images and files.';
    } else if (imageCount > 1) {
        instruction = 'Please inspect the attached images.';
    } else if (imageCount === 1) {
        instruction = 'Please inspect the attached image.';
    } else if (fileNames.length > 1) {
        instruction = 'Please inspect the attached files.';
    } else {
        instruction = 'Please inspect the attached file.';
    }
    return `<pi-code-attachment-instructions>\n${instruction}\n</pi-code-attachment-instructions>`;
}

function getLegacyAttachmentOnlyPromptText(imageCount: number, fileNames: readonly string[]): string | undefined {
    if (imageCount > 0 && fileNames.length > 0) {
        return 'Please inspect the attached images and files.';
    }
    if (imageCount > 1) {
        return 'Please inspect the attached images.';
    }
    if (imageCount === 1) {
        return 'Please inspect the attached image.';
    }
    if (fileNames.length > 1) {
        return `Please inspect the attached files: ${fileNames.join(', ')}.`;
    }
    if (fileNames.length === 1) {
        return `Please inspect the attached file: ${fileNames[0]}.`;
    }
    return undefined;
}

export interface UserMessageContent {
    cleanText: string;
    fileNames: string[];
}

/** Remove internal prompt decorations before rendering a user message. */
export function prepareUserMessageContent(rawText: string, imageCount = 0): UserMessageContent {
    const fileNames: string[] = [];
    const withoutFiles = rawText.replace(FILE_BLOCK_RE, (_, name: string) => {
        fileNames.push(name.trim());
        return '';
    });
    const withoutPlanMode = withoutFiles.replace(PLAN_MODE_BLOCK_RE, '');
    const withoutAttachmentInstructions = withoutPlanMode.replace(ATTACHMENT_INSTRUCTIONS_BLOCK_RE, '');
    const withoutFileMentionMetadata = withoutAttachmentInstructions.replace(REFERENCED_WORKSPACE_FILES_BLOCK_RE, '');
    const legacyAttachmentPrompt = getLegacyAttachmentOnlyPromptText(imageCount, fileNames);
    const cleanText = legacyAttachmentPrompt && withoutFileMentionMetadata.trim() === legacyAttachmentPrompt
        ? ''
        : withoutFileMentionMetadata;
    return { cleanText, fileNames };
}

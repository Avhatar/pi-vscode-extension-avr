import type { ContextEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const OMITTED_IMAGE_PLACEHOLDER = '[image omitted: the active model does not support image input]';

interface ImageCapableModel {
    input?: readonly string[];
}

/**
 * Keep an image-bearing history sendable after switching to a text-only model.
 *
 * Providers with mixed line-ups (DeepSeek ships vision as a separate model,
 * while Anthropic and OpenAI make every current model multimodal) make this
 * switch routine: attach a screenshot on the vision model, then move back to
 * the stronger text-only model in the same chat. The chat panel only blocks
 * *new* attachments for a text-only model; images already in the history would
 * still be serialized, and the `openai-completions` request builder emits image
 * blocks from user messages without checking `model.input`, so the next request
 * is rejected by the provider (DeepSeek answers 400 for images on a non-vision
 * model).
 *
 * The `context` event rewrites the messages for a single LLM call only, so the
 * session history keeps the original images and switching back to an
 * image-capable model restores them.
 *
 * A model without `input` metadata is treated as image-capable, matching the
 * optimistic `supportsImages !== false` rule the chat input uses.
 */
export function createImageCompatGuard(
    getActiveModel: () => ImageCapableModel | undefined,
): (pi: ExtensionAPI) => void {
    return (pi) => {
        pi.on('context', (event: ContextEvent) => {
            const input = getActiveModel()?.input;
            if (!input || input.includes('image')) return undefined;

            const messages = replaceImageBlocks(event.messages);
            return messages ? { messages } : undefined;
        });
    };
}

/** Returns a rewritten copy, or `undefined` when the history holds no images. */
function replaceImageBlocks(messages: ContextEvent['messages']): ContextEvent['messages'] | undefined {
    let changed = false;
    const next = messages.map((message) => {
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content) || !content.some(isImageBlock)) return message;
        changed = true;
        return {
            ...message,
            content: content.map((block) =>
                isImageBlock(block) ? { type: 'text', text: OMITTED_IMAGE_PLACEHOLDER } : block),
        };
    });
    return changed ? next : undefined;
}

function isImageBlock(block: unknown): boolean {
    return !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'image';
}

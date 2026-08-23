import { describe, expect, it } from 'vitest';
import { OMITTED_IMAGE_PLACEHOLDER, createImageCompatGuard } from '../../../pi/image-compat-guard';

function createHarness(model: { input?: readonly string[] } | undefined) {
    let active = model;
    let contextHandler: ((event: any, context: any) => any) | undefined;
    const pi = {
        on(name: string, handler: (event: any, context: any) => any) {
            if (name === 'context') contextHandler = handler;
        },
    };

    createImageCompatGuard(() => active)(pi as any);

    return {
        setModel(next: { input?: readonly string[] } | undefined) {
            active = next;
        },
        call(messages: any[]) {
            if (!contextHandler) throw new Error('context handler was not registered');
            return contextHandler({ type: 'context', messages }, {});
        },
    };
}

const imageBlock = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

describe('image compatibility guard', () => {
    it('replaces user-message images with a placeholder for a text-only model', () => {
        const harness = createHarness({ input: ['text'] });
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'look at this' }, imageBlock] },
        ];

        const result = harness.call(messages);

        expect(result).toEqual({
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'look at this' },
                        { type: 'text', text: OMITTED_IMAGE_PLACEHOLDER },
                    ],
                },
            ],
        });
    });

    it('strips images from tool results as well', () => {
        const harness = createHarness({ input: ['text'] });

        const result = harness.call([
            { role: 'toolResult', toolName: 'screenshot', content: [imageBlock] },
        ]);

        expect(result.messages[0]).toEqual({
            role: 'toolResult',
            toolName: 'screenshot',
            content: [{ type: 'text', text: OMITTED_IMAGE_PLACEHOLDER }],
        });
    });

    it('does not mutate the original history', () => {
        const harness = createHarness({ input: ['text'] });
        const original = { role: 'user', content: [imageBlock] };

        harness.call([original]);

        expect(original.content[0]).toEqual(imageBlock);
    });

    it('leaves the context untouched for an image-capable model', () => {
        const harness = createHarness({ input: ['text', 'image'] });

        expect(harness.call([{ role: 'user', content: [imageBlock] }])).toBeUndefined();
    });

    it('treats a model without input metadata as image-capable', () => {
        const harness = createHarness({});

        expect(harness.call([{ role: 'user', content: [imageBlock] }])).toBeUndefined();
    });

    it('skips rewriting when no active model is known', () => {
        const harness = createHarness(undefined);

        expect(harness.call([{ role: 'user', content: [imageBlock] }])).toBeUndefined();
    });

    it('returns nothing when the history holds no images', () => {
        const harness = createHarness({ input: ['text'] });

        const result = harness.call([
            { role: 'user', content: 'plain string content' },
            { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        ]);

        expect(result).toBeUndefined();
    });

    it('follows a mid-session model switch', () => {
        const harness = createHarness({ input: ['text', 'image'] });
        const messages = [{ role: 'user', content: [imageBlock] }];

        expect(harness.call(messages)).toBeUndefined();

        harness.setModel({ input: ['text'] });

        expect(harness.call(messages).messages[0].content).toEqual([
            { type: 'text', text: OMITTED_IMAGE_PLACEHOLDER },
        ]);
    });
});

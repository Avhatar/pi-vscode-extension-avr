import { describe, expect, it } from 'vitest';
import { shouldDisplayChatMessage } from '../../../shared/message-visibility';

describe('Chat message visibility', () => {
    it('hides custom messages explicitly marked as hidden', () => {
        expect(shouldDisplayChatMessage({ role: 'custom', display: false })).toBe(false);
    });

    it('keeps visible and legacy custom messages', () => {
        expect(shouldDisplayChatMessage({ role: 'custom', display: true })).toBe(true);
        expect(shouldDisplayChatMessage({ role: 'custom' })).toBe(true);
    });

    it('does not hide regular messages that happen to have a display flag', () => {
        expect(shouldDisplayChatMessage({ role: 'user', display: false })).toBe(true);
        expect(shouldDisplayChatMessage({ role: 'assistant', display: false })).toBe(true);
    });
});

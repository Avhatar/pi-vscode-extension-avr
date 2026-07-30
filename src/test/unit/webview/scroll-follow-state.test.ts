import { describe, expect, it } from 'vitest';

import { shouldResumeAutoFollow } from '../../../webview/scroll-follow-state';

describe('chat scroll auto-follow state', () => {
    it('does not resume auto-follow while the user is only near the bottom', () => {
        expect(shouldResumeAutoFollow({
            scrollHeight: 1000,
            scrollTop: 460,
            clientHeight: 500,
        })).toBe(false);
    });

    it('resumes auto-follow when the user reaches the bottom', () => {
        expect(shouldResumeAutoFollow({
            scrollHeight: 1000,
            scrollTop: 500,
            clientHeight: 500,
        })).toBe(true);
    });

    it('allows a tiny sub-pixel tolerance at the bottom', () => {
        expect(shouldResumeAutoFollow({
            scrollHeight: 1000,
            scrollTop: 499.5,
            clientHeight: 500,
        })).toBe(true);
    });
});

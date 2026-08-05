import { describe, expect, it } from 'vitest';

import {
    countForegroundSubagentTools,
    getTurnActivityIndicatorLabel,
    shouldShowTurnActivityIndicator,
} from '../../../webview/turn-activity-indicator';

describe('turn activity indicator', () => {
    const idleBetweenActions = {
        isStreaming: true,
        isCompacting: false,
        isThinking: false,
        isWritingText: false,
        hasStreamingText: true,
        pendingToolCount: 0,
        pendingSubagentCount: 0,
    };

    it('remains visible after assistant text ends while the turn is still active', () => {
        expect(shouldShowTurnActivityIndicator(idleBetweenActions)).toBe(true);
    });

    it('stays hidden while another visible activity is in progress', () => {
        expect(shouldShowTurnActivityIndicator({
            ...idleBetweenActions,
            isThinking: true,
        })).toBe(false);
        expect(shouldShowTurnActivityIndicator({
            ...idleBetweenActions,
            isWritingText: true,
        })).toBe(false);
        expect(shouldShowTurnActivityIndicator({
            ...idleBetweenActions,
            pendingToolCount: 1,
        })).toBe(false);
    });

    it('counts only foreground spawn and resume operations as awaited subagents', () => {
        expect(countForegroundSubagentTools([
            { toolCallId: 'foreground', toolName: 'subagent', startTime: 1, args: { action: 'spawn' } },
            { toolCallId: 'default-foreground', toolName: 'SubAgent', startTime: 1, args: {} },
            { toolCallId: 'resume', toolName: 'subagent', startTime: 1, args: { action: 'resume' } },
            { toolCallId: 'background', toolName: 'subagent', startTime: 1, args: { action: 'spawn', background: true } },
            { toolCallId: 'inspect', toolName: 'subagent', startTime: 1, args: { action: 'inspect' } },
            { toolCallId: 'edit', toolName: 'edit', startTime: 1, args: {} },
        ])).toBe(3);
    });

    it('summarizes foreground subagents without exposing each child activity', () => {
        expect(getTurnActivityIndicatorLabel({
            ...idleBetweenActions,
            pendingToolCount: 5,
            pendingSubagentCount: 5,
        })).toBe('Waiting for 5 subagents...');
        expect(getTurnActivityIndicatorLabel({
            ...idleBetweenActions,
            pendingToolCount: 1,
            pendingSubagentCount: 1,
        })).toBe('Waiting for 1 subagent...');
    });

    it('defers to an active parent tool until only foreground subagents remain', () => {
        expect(getTurnActivityIndicatorLabel({
            ...idleBetweenActions,
            pendingToolCount: 2,
            pendingSubagentCount: 1,
        })).toBeUndefined();
    });

    it('remains visible when a text event has no visible delta', () => {
        expect(shouldShowTurnActivityIndicator({
            ...idleBetweenActions,
            isWritingText: true,
            hasStreamingText: false,
        })).toBe(true);
    });

    it('is visible during compaction and hidden after the turn settles', () => {
        expect(shouldShowTurnActivityIndicator({
            ...idleBetweenActions,
            isStreaming: false,
            isCompacting: true,
        })).toBe(true);
        expect(shouldShowTurnActivityIndicator({
            ...idleBetweenActions,
            isStreaming: false,
            hasStreamingText: false,
        })).toBe(false);
    });
});

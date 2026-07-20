import type { TurnCompletionInfo } from '../../shared/turn-notification';

/**
 * Tracks whether a parent session run was started by an explicit user task.
 * Child sessions never touch this gate, so their lifecycle events cannot
 * produce a native turn-completion notification.
 */
export class TurnNotificationGate {
    private _nextArmToken = 0;
    private _armedToken: number | undefined;
    private _runActive = false;
    private _activeUserTask = false;
    private _completion: TurnCompletionInfo | undefined;

    /** Mark the next parent run as user initiated. */
    arm(): number {
        const token = ++this._nextArmToken;
        this._armedToken = token;
        return token;
    }

    /**
     * Cancel an arm only if it still belongs to this prompt attempt. This
     * avoids clearing an arm for a queued task that was dispatched while an
     * earlier prompt was settling.
     */
    cancelArm(token: number): void {
        if (this._armedToken === token) this._armedToken = undefined;
    }

    /** Consume a pending arm on the first agent_start of a parent run. */
    onAgentStart(): void {
        if (this._runActive) return;
        this._runActive = true;
        this._activeUserTask = this._armedToken !== undefined;
        this._armedToken = undefined;
    }

    /** Keep only the latest agent_end outcome for the active user task. */
    onAgentEnd(info: TurnCompletionInfo): void {
        if (this._activeUserTask) this._completion = info;
    }

    /**
     * Finish the current parent run and return its notification once. Any arm
     * already created for the next queued task is intentionally preserved.
     */
    onAgentSettled(): TurnCompletionInfo | undefined {
        const completion = this._activeUserTask ? this._completion : undefined;
        this._runActive = false;
        this._activeUserTask = false;
        this._completion = undefined;
        return completion;
    }

    /** Clear all transient state when the parent session is replaced. */
    reset(): void {
        this._armedToken = undefined;
        this._runActive = false;
        this._activeUserTask = false;
        this._completion = undefined;
    }
}

export interface SubagentGateStorage {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: boolean): PromiseLike<void>;
}

export class SubagentCapabilityGate {
    constructor(
        private readonly storage: SubagentGateStorage,
        private readonly defaultEnabled: () => boolean,
        private readonly keyPrefix = 'pi-code.subagentsEnabled.',
    ) {}

    key(sessionPath: string | undefined): string | undefined {
        return sessionPath ? `${this.keyPrefix}${sessionPath}` : undefined;
    }

    isEnabled(sessionPath: string | undefined): boolean {
        const fallback = this.defaultEnabled();
        const key = this.key(sessionPath);
        return key ? this.storage.get<boolean>(key, fallback) : fallback;
    }

    async setEnabled(
        sessionPath: string | undefined,
        enabled: boolean,
        busy: boolean,
    ): Promise<boolean> {
        if (busy) return false;
        const key = this.key(sessionPath);
        if (!key) return false;
        await this.storage.update(key, enabled);
        return true;
    }

    composeDisabledTools(base: readonly string[], sessionPath: string | undefined): string[] {
        const disabled = new Set(base);
        if (this.isEnabled(sessionPath)) disabled.delete('subagent');
        else disabled.add('subagent');
        return [...disabled];
    }
}

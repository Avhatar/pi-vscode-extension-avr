export type ClaudeActivationReason =
    | 'root-context'
    | 'root-local-context'
    | 'dot-claude-context'
    | 'project-skills'
    | 'project-commands'
    | 'project-agents'
    | 'project-rules'
    | 'plugin-manifest'
    | 'nested-context'
    | 'nested-skills'
    | 'project-plugin';

export interface ClaudePluginInstall {
    key: string;
    installPath: string;
    projectPath?: string;
}

export interface ClaudeInfrastructure {
    active: boolean;
    activationReasons: ClaudeActivationReason[];
    rootContextFiles: string[];
    /**
     * Root Claude context files that only redirect to a workspace AGENTS.md and
     * therefore never activate the bridge on their own. Recorded for the status
     * report so shims remain visible without contributing tokens to the session.
     */
    shimContextFiles: string[];
    nestedContextFiles: string[];
    nestedSkillFiles: string[];
    skillDirectories: string[];
    commandDirectories: string[];
    agentDirectories: string[];
    ruleDirectories: string[];
    pluginInstalls: ClaudePluginInstall[];
}

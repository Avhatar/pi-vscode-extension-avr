import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createClaudeContextExtension } from '../../../../pi/claude-compat/context-extension';
import { indexClaudeResources } from '../../../../pi/claude-compat/resources';

const temporaryDirectories: string[] = [];

function createWorkspace(prefix = 'pi-claude-context-'): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createHarness(cwd: string, options: {
    contextEnabled?: boolean;
    rulesEnabled?: boolean;
    resources?: ReturnType<typeof indexClaudeResources>;
    activeTools?: string[];
    sessionId?: string;
} = {}) {
    const hooks = new Map<string, (event: any, context: any) => Promise<any>>();
    const commands = new Map<string, any>();
    const entries: any[] = [];
    const sentMessages: any[] = [];
    const sentUserMessages: any[] = [];
    const pi = {
        on(name: string, handler: (event: any, context: any) => Promise<any>) {
            hooks.set(name, handler);
        },
        registerCommand(name: string, command: any) {
            commands.set(name, command);
        },
        appendEntry(customType: string, data: any) {
            entries.push({ type: 'custom', customType, data });
        },
        sendMessage(message: any, options: any) {
            sentMessages.push({ message, options });
        },
        sendUserMessage(content: any, options?: any) {
            sentUserMessages.push({ content, options });
        },
        getCommands() {
            return Array.from(commands, ([name, command]) => ({ name, description: command.description }));
        },
        getActiveTools() {
            return options.activeTools ?? [];
        },
    };
    createClaudeContextExtension({
        userClaudeDirectory: path.join(cwd, '.test-user-claude'),
        ...options,
    })(pi as any);
    const context = {
        cwd,
        isIdle: () => true,
        sessionManager: {
            getBranch: () => entries,
            getLeafId: () => entries.at(-1)?.id,
            getSessionId: () => options.sessionId ?? 'pi-test-session',
        },
    };
    return { hooks, commands, entries, sentMessages, sentUserMessages, context };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('Claude context extension', () => {
    it('discovers nested CLAUDE.md without requiring a root bootstrap file', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'src', 'CLAUDE.md'), '# Nested rules\n');
        writeFile(path.join(cwd, 'src', 'feature.ts'), 'export const feature = true;\n');
        const harness = createHarness(cwd);

        const result = await harness.hooks.get('tool_result')!(
            {
                toolName: 'read',
                input: { path: 'src/feature.ts' },
                content: [{ type: 'text', text: 'export const feature = true;' }],
            },
            harness.context,
        );

        const injected = result.content.at(-1).text as string;
        expect(injected).toContain('# Claude resource compatibility boundary');
        expect(injected).toContain('src/CLAUDE.md');
        expect(injected).toContain('# Nested rules');
        expect(injected).not.toContain('MUST READ');
    });

    it('injects root and imported instruction contents directly before the agent starts', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'CLAUDE.md'), '# Root rules\nYou are Claude Code. Use the Task tool.\n@docs/shared.md\n');
        writeFile(path.join(cwd, 'docs', 'shared.md'), 'Use the shared convention.\n');
        const harness = createHarness(cwd);

        const result = await harness.hooks.get('before_agent_start')!(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } },
            harness.context,
        );

        expect(result.systemPrompt).toBeUndefined();
        expect(result.message.content).toContain('# Claude resource compatibility boundary');
        expect(result.message.content).toContain('Remain the current Pi agent');
        expect(result.message.content).toContain('You are Claude Code. Use the Task tool.');
        expect(result.message.content).toContain('# Root rules');
        expect(result.message.content).toContain('Use the shared convention.');
        expect(result.message.content).not.toContain('MUST read');
        expect(result.message.display).toBe(false);
    });

    it('loads activated user, workspace, and dot-Claude instructions in precedence order', async () => {
        const cwd = createWorkspace();
        const userClaudeDirectory = path.join(cwd, '.test-user-claude');
        writeFile(path.join(userClaudeDirectory, 'CLAUDE.md'), 'USER_SENTINEL\n');
        writeFile(path.join(cwd, 'CLAUDE.md'), 'ROOT_SENTINEL\n');
        writeFile(path.join(cwd, '.claude', 'CLAUDE.md'), 'DOT_SENTINEL\n');
        writeFile(path.join(cwd, 'CLAUDE.local.md'), 'LOCAL_SENTINEL\n');
        const harness = createHarness(cwd);

        const result = await harness.hooks.get('before_agent_start')!(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } },
            harness.context,
        );

        const prompt = result.message.content as string;
        expect(prompt.indexOf('USER_SENTINEL')).toBeLessThan(prompt.indexOf('ROOT_SENTINEL'));
        expect(prompt.indexOf('ROOT_SENTINEL')).toBeLessThan(prompt.indexOf('DOT_SENTINEL'));
        expect(prompt.indexOf('DOT_SENTINEL')).toBeLessThan(prompt.indexOf('LOCAL_SENTINEL'));
    });

    it('does not duplicate a root file already loaded by Pi but still expands its imports', async () => {
        const cwd = createWorkspace();
        const root = path.join(cwd, 'CLAUDE.md');
        writeFile(root, 'ROOT_SENTINEL\n@docs/imported.md\n');
        writeFile(path.join(cwd, 'docs', 'imported.md'), 'IMPORTED_SENTINEL\n');
        const harness = createHarness(cwd);

        const result = await harness.hooks.get('before_agent_start')!(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [{ path: root, content: 'ROOT_SENTINEL' }] } },
            harness.context,
        );

        expect(result.message.content).not.toContain('ROOT_SENTINEL');
        expect(result.message.content).toContain('IMPORTED_SENTINEL');
    });

    it('delivers unchanged root context once and reapplies it after compaction', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'CLAUDE.md'), 'ROOT_CONTEXT_MESSAGE\n');
        const harness = createHarness(cwd);
        const event = { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } };

        const first = await harness.hooks.get('before_agent_start')!(event, harness.context);
        const repeated = await harness.hooks.get('before_agent_start')!(event, harness.context);
        harness.entries.push({ type: 'compaction', id: 'compact-1' });
        const afterCompaction = await harness.hooks.get('before_agent_start')!(event, harness.context);

        expect(first.message.content).toContain('ROOT_CONTEXT_MESSAGE');
        expect(repeated).toBeUndefined();
        expect(afterCompaction.message.content).toContain('ROOT_CONTEXT_MESSAGE');
    });

    it('does not apply instructions from a sibling path with the same prefix', async () => {
        const parent = createWorkspace();
        const cwd = path.join(parent, 'project');
        const sibling = path.join(parent, 'project-other');
        fs.mkdirSync(cwd);
        writeFile(path.join(sibling, 'CLAUDE.md'), '# Wrong project\n');
        writeFile(path.join(sibling, 'feature.ts'), 'export {};\n');
        const harness = createHarness(cwd);

        const result = await harness.hooks.get('tool_result')!(
            {
                toolName: 'read',
                input: { path: '../project-other/feature.ts' },
                content: [{ type: 'text', text: 'export {};' }],
            },
            harness.context,
        );

        expect(result).toBeUndefined();
    });

    it('applies path-scoped instructions once until compaction', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, 'src', 'CLAUDE.md'), 'PATH_SENTINEL\n');
        writeFile(path.join(cwd, 'src', 'feature.ts'), 'export {};\n');
        const harness = createHarness(cwd);
        const event = {
            toolName: 'read',
            input: { path: 'src/feature.ts' },
            content: [{ type: 'text', text: 'export {};' }],
        };

        const first = await harness.hooks.get('tool_result')!(event, harness.context);
        const second = await harness.hooks.get('tool_result')!(event, harness.context);
        harness.entries.push({ type: 'compaction' });
        const afterCompaction = await harness.hooks.get('tool_result')!(event, harness.context);

        expect(first.content.at(-1).text).toContain('PATH_SENTINEL');
        expect(second).toBeUndefined();
        expect(afterCompaction.content.at(-1).text).toContain('PATH_SENTINEL');
    });

    it('reapplies path-scoped instructions when their contents change', async () => {
        const cwd = createWorkspace();
        const instructions = path.join(cwd, 'src', 'CLAUDE.md');
        writeFile(instructions, 'FIRST_VERSION\n');
        writeFile(path.join(cwd, 'src', 'feature.ts'), 'export {};\n');
        const harness = createHarness(cwd);
        const event = {
            toolName: 'read',
            input: { path: 'src/feature.ts' },
            content: [{ type: 'text', text: 'export {};' }],
        };

        await harness.hooks.get('tool_result')!(event, harness.context);
        writeFile(instructions, 'SECOND_VERSION_WITH_NEW_SIZE\n');
        const changed = await harness.hooks.get('tool_result')!(event, harness.context);

        expect(changed.content.at(-1).text).toContain('SECOND_VERSION_WITH_NEW_SIZE');
    });

    it('injects project-wide rules directly into the system prompt', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, '.claude', 'rules', 'global.md'), 'GLOBAL_RULE_SENTINEL\n');
        const harness = createHarness(cwd);

        const result = await harness.hooks.get('before_agent_start')!(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } },
            harness.context,
        );
        const toolCall = await harness.hooks.get('tool_call')!(
            { toolName: 'read', toolCallId: 'call-1', input: { path: 'src/file.ts' } },
            harness.context,
        );

        expect(result.message.content).toContain('GLOBAL_RULE_SENTINEL');
        expect(toolCall).toBeUndefined();
    });

    it('blocks matching path tool calls, queues rules once per assistant turn, and permits retry', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, '.claude', 'rules', 'typescript.md'), [
            '---',
            'paths: ["src/**/*.ts"]',
            '---',
            'SCOPED_RULE_SENTINEL',
        ].join('\n'));
        const harness = createHarness(cwd);
        harness.entries.push({ type: 'message', id: 'assistant-1', message: { role: 'assistant' } });
        const event = { toolName: 'read', toolCallId: 'call-1', input: { path: 'src/feature.ts' } };

        const first = await harness.hooks.get('tool_call')!(event, harness.context);
        const sibling = await harness.hooks.get('tool_call')!(
            { ...event, toolCallId: 'call-2' },
            harness.context,
        );
        harness.entries.push({ type: 'message', id: 'assistant-2', message: { role: 'assistant' } });
        const retry = await harness.hooks.get('tool_call')!(
            { ...event, toolCallId: 'call-3' },
            harness.context,
        );

        expect(first.block).toBe(true);
        expect(first.reason).toContain('Retry');
        expect(sibling.block).toBe(true);
        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].message.content).toContain('# Claude resource compatibility boundary');
        expect(harness.sentMessages[0].message.content).toContain('SCOPED_RULE_SENTINEL');
        expect(harness.sentMessages[0].options.deliverAs).toBe('steer');
        expect(retry).toBeUndefined();
    });

    it('reapplies path rules after compaction or a rule content change', async () => {
        const cwd = createWorkspace();
        const rule = path.join(cwd, '.claude', 'rules', 'typescript.md');
        writeFile(rule, '---\npaths: ["src/**"]\n---\nFIRST_RULE_VERSION\n');
        const harness = createHarness(cwd);
        const event = { toolName: 'edit', toolCallId: 'call-1', input: { path: 'src/file.ts' } };
        harness.entries.push({ type: 'message', id: 'assistant-1', message: { role: 'assistant' } });
        await harness.hooks.get('tool_call')!(event, harness.context);
        harness.entries.push({ type: 'message', id: 'assistant-2', message: { role: 'assistant' } });
        expect(await harness.hooks.get('tool_call')!(event, harness.context)).toBeUndefined();

        harness.entries.push({ type: 'compaction', id: 'compact-1' });
        harness.entries.push({ type: 'message', id: 'assistant-3', message: { role: 'assistant' } });
        const afterCompaction = await harness.hooks.get('tool_call')!(event, harness.context);
        expect(afterCompaction.block).toBe(true);

        harness.entries.push({ type: 'message', id: 'assistant-4', message: { role: 'assistant' } });
        writeFile(rule, '---\npaths: ["src/**"]\n---\nSECOND_RULE_VERSION_WITH_NEW_SIZE\n');
        const afterChange = await harness.hooks.get('tool_call')!(event, harness.context);
        expect(afterChange.block).toBe(true);
        expect(harness.sentMessages.at(-1).message.content).toContain('SECOND_RULE_VERSION_WITH_NEW_SIZE');
    });

    it('injects matching rules discovered from bash output as a fallback', async () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, '.claude', 'rules', 'typescript.md'), [
            '---',
            'paths: ["src/**/*.ts"]',
            '---',
            'BASH_FALLBACK_RULE',
        ].join('\n'));
        writeFile(path.join(cwd, 'src', 'feature.ts'), 'export {};\n');
        const harness = createHarness(cwd);
        harness.entries.push({ type: 'message', id: 'assistant-1', message: { role: 'assistant' } });

        const result = await harness.hooks.get('tool_result')!(
            {
                toolName: 'bash',
                toolCallId: 'call-1',
                input: { command: 'inspect src/feature.ts' },
                content: [{ type: 'text', text: 'src/feature.ts' }],
            },
            harness.context,
        );

        expect(result.content.at(-1).text).toContain('BASH_FALLBACK_RULE');
    });

    it('registers Claude skills and legacy commands as bounded native Pi commands', async () => {
        const cwd = createWorkspace();
        const userClaudeDirectory = path.join(cwd, '.test-user-claude');
        writeFile(path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), [
            '---',
            'description: Deploy the project',
            'disable-model-invocation: true',
            '---',
            'Deploy $0.',
        ].join('\n'));
        writeFile(path.join(cwd, '.claude', 'commands', 'model.md'), 'Legacy model command $1.');
        const resources = indexClaudeResources(cwd, { userClaudeDirectory });
        const harness = createHarness(cwd, { contextEnabled: false, rulesEnabled: false, resources });

        expect(harness.commands.has('deploy')).toBe(true);
        expect(harness.commands.has('model')).toBe(false);
        expect(harness.commands.has('claude:model')).toBe(true);
        await harness.commands.get('deploy').handler('production', harness.context);
        expect(harness.sentUserMessages).toHaveLength(1);
        expect(harness.sentUserMessages[0].content).toContain('Remain the current Pi agent');
        expect(harness.sentUserMessages[0].content).toContain('Deploy production.');
    });

    it('advertises model-invocable Claude skills without exposing raw harness identity', async () => {
        const cwd = createWorkspace();
        const userClaudeDirectory = path.join(cwd, '.test-user-claude');
        writeFile(path.join(cwd, '.claude', 'skills', 'review', 'SKILL.md'), [
            '---',
            'description: Review project changes',
            '---',
            'You are Claude Code. Review changes.',
        ].join('\n'));
        const resources = indexClaudeResources(cwd, { userClaudeDirectory });
        const harness = createHarness(cwd, { contextEnabled: false, rulesEnabled: false, resources });

        const result = await harness.hooks.get('before_agent_start')!(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } },
            harness.context,
        );
        expect(result.message.content).toContain('Remain the current Pi agent');
        expect(result.message.content).toContain('Available adapted Claude skills');
        expect(result.message.content).toContain('review: Review project changes');
        expect(result.message.content).not.toContain('You are Claude Code');
    });

    it('activates directory-qualified nested skills before matching path tools and reapplies after compaction', async () => {
        const cwd = createWorkspace();
        const userClaudeDirectory = path.join(cwd, '.test-user-claude');
        const nestedSkill = path.join(cwd, 'apps', 'web', '.claude', 'skills', 'deploy', 'SKILL.md');
        writeFile(nestedSkill, '---\ndescription: Deploy web\n---\nNESTED_WEB_SKILL\n');
        writeFile(path.join(cwd, 'apps', 'web', 'src', 'file.ts'), 'export {};\n');
        const resources = indexClaudeResources(cwd, { userClaudeDirectory, projectSkillFiles: [nestedSkill] });
        const harness = createHarness(cwd, { contextEnabled: false, rulesEnabled: false, resources });
        const event = { toolName: 'edit', toolCallId: 'call-1', input: { path: 'apps/web/src/file.ts' } };

        const first = await harness.hooks.get('tool_call')!(event, harness.context);
        const retry = await harness.hooks.get('tool_call')!({ ...event, toolCallId: 'call-2' }, harness.context);
        const unrelated = await harness.hooks.get('tool_call')!(
            { toolName: 'edit', toolCallId: 'call-3', input: { path: 'apps/api/file.ts' } },
            harness.context,
        );
        harness.entries.push({ type: 'compaction', id: 'compact-1' });
        const afterCompaction = await harness.hooks.get('tool_call')!({ ...event, toolCallId: 'call-4' }, harness.context);

        expect(first.block).toBe(true);
        expect(harness.sentMessages[0].message.content).toContain('apps/web:deploy');
        expect(harness.sentMessages[0].message.content).toContain('Remain the current Pi agent');
        expect(retry).toBeUndefined();
        expect(unrelated).toBeUndefined();
        expect(afterCompaction.block).toBe(true);
        expect(harness.sentMessages).toHaveLength(2);
    });

    it('annotates Claude tool references from progressively disclosed skill files', async () => {
        const cwd = createWorkspace();
        const userClaudeDirectory = path.join(cwd, '.test-user-claude');
        const skillPath = path.join(cwd, '.claude', 'skills', 'verify', 'SKILL.md');
        writeFile(skillPath, [
            '---',
            'description: Verify through the build service',
            '---',
            'Use `Read`, mcp__build__compile, and `Agent`.',
        ].join('\n'));
        const resources = indexClaudeResources(cwd, { userClaudeDirectory });
        const harness = createHarness(cwd, {
            contextEnabled: false,
            rulesEnabled: false,
            resources,
            activeTools: ['read', 'build_compile', 'mcp'],
        });

        const result = await harness.hooks.get('tool_result')!(
            {
                toolName: 'read',
                input: { path: skillPath },
                content: [{ type: 'text', text: 'Use `Read`, mcp__build__compile, and `Agent`.' }],
            },
            harness.context,
        );
        const annotation = result.content.at(-1).text;
        expect(annotation).toContain('mcp__build__compile → build_compile [mapped]');
        expect(annotation).toContain('Read → read [mapped]');
        expect(annotation).toContain('Agent [deferred-agent]');
    });

    it('registers no context or rule hooks when those capabilities have no resources', () => {
        const harness = createHarness(createWorkspace(), { contextEnabled: false, rulesEnabled: false });

        expect(harness.hooks.has('before_agent_start')).toBe(false);
        expect(harness.hooks.has('tool_call')).toBe(false);
        expect(harness.hooks.has('tool_result')).toBe(false);
        expect(harness.commands.has('claude-compat')).toBe(true);
    });

    it('can mount rules without mounting CLAUDE context handling', () => {
        const cwd = createWorkspace();
        writeFile(path.join(cwd, '.claude', 'rules', 'global.md'), 'RULE_ONLY\n');
        const harness = createHarness(cwd, { contextEnabled: false, rulesEnabled: true });

        expect(harness.hooks.has('before_agent_start')).toBe(true);
        expect(harness.hooks.has('tool_call')).toBe(true);
        expect(harness.hooks.has('tool_result')).toBe(true);
    });

    it('registers the new status command and the legacy alias only when mounted', () => {
        const harness = createHarness(createWorkspace());

        expect(harness.commands.has('claude-compat')).toBe(true);
        expect(harness.commands.has('claude-md-injector')).toBe(true);
    });
});

// End-to-end diagnostic command for the Claude compatibility bridge.
// It runs the real workspace detector, checks whether the active Pi session
// mounted the conditional extension, and invokes /claude-compat without making
// a provider request.
//
// This command is intentionally not registered or contributed to the Command
// Palette. Keep the implementation available for future bridge diagnostics.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { retainNativePiContextFiles } from '../pi/claude-compat/boundary';
import { createClaudeContextExtension } from '../pi/claude-compat/context-extension';
import {
    buildPathInstructions,
    buildRootInstructions,
    getRootClaudeFiles,
    getUserClaudeDirectory,
    type RenderedInstructions,
} from '../pi/claude-compat/context';
import { detectClaudeInfrastructure } from '../pi/claude-compat/detect';
import {
    CLAUDE_NESTED_SEARCH_EXCLUDE,
    isExcludedClaudeDiscoveryPath,
} from '../pi/claude-compat/discovery';
import {
    CLAUDE_IMPORT_DEPTH_LIMIT,
    clearInstructionImportCache,
    expandInstructionFiles,
    type ImportDiagnostic,
} from '../pi/claude-compat/imports';
import { isCanonicalDescendant, normalizePathForCompare } from '../pi/claude-compat/path-scope';
import { resolveClaudeToolReferences } from '../pi/claude-compat/tool-compat';
import {
    indexClaudeResources,
    matchingNestedClaudeSkills,
    renderClaudeInvocableResource,
} from '../pi/claude-compat/resources';
import { loadClaudeMdExcludes } from '../pi/claude-compat/settings';
import {
    clearClaudeRuleCache,
    indexClaudeRules,
    matchingClaudeRules,
    renderClaudeRules,
    ruleMatchesPath,
} from '../pi/claude-compat/rules';
import type { PiSessionManager } from '../pi/session';

const COMMAND_ID = 'pi-code.claudeCompatSmoke';
const CHANNEL_NAME = 'Pi Code: Claude Compatibility Smoke';

export function registerClaudeCompatSmokeCommand(
    context: vscode.ExtensionContext,
    getActiveSession: () => PiSessionManager | undefined,
): vscode.Disposable {
    const channel = vscode.window.createOutputChannel(CHANNEL_NAME);
    context.subscriptions.push(channel);

    return vscode.commands.registerCommand(COMMAND_ID, async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) {
            vscode.window.showErrorMessage('Claude Compatibility Smoke: open a workspace first.');
            return;
        }

        const cwd = workspace.uri.fsPath;
        channel.clear();
        channel.show(true);
        channel.appendLine(`=== Claude Compatibility Smoke @ ${new Date().toISOString()} ===`);
        channel.appendLine(`Workspace: ${cwd}`);
        channel.appendLine('Scope: detector, conditional mount, provider-independent boundary, context/import pipeline, skills/commands, path scope, safety guards, and status command');
        channel.appendLine('');

        const infrastructure = await detectClaudeInfrastructure(cwd, {
            collectNestedClaudeFiles: true,
            collectNestedClaudeSkillFiles: true,
            findNestedClaudeFiles: async () => {
                const pattern = new vscode.RelativePattern(cwd, '**/{CLAUDE.md,CLAUDE.local.md}');
                const matches = await vscode.workspace.findFiles(pattern, CLAUDE_NESTED_SEARCH_EXCLUDE, 100);
                return matches.map((uri) => uri.fsPath);
            },
            findNestedClaudeSkillFiles: async () => {
                const pattern = new vscode.RelativePattern(cwd, '**/.claude/skills/**/SKILL.md');
                const matches = await vscode.workspace.findFiles(pattern, CLAUDE_NESTED_SEARCH_EXCLUDE, 500);
                return matches.map((uri) => uri.fsPath);
            },
        });

        const generatedResourcesExcluded = [...infrastructure.nestedContextFiles, ...infrastructure.nestedSkillFiles]
            .every((filePath) => !isExcludedClaudeDiscoveryPath(cwd, filePath));
        channel.appendLine('-- detector --');
        channel.appendLine(`${infrastructure.active ? 'PASS' : 'INFO'} active=${infrastructure.active}`);
        channel.appendLine(`${generatedResourcesExcluded ? 'PASS' : 'FAIL'} generated/dependency resources excluded=${generatedResourcesExcluded}`);
        channel.appendLine(`  reasons: ${infrastructure.activationReasons.join(', ') || '(none)'}`);
        logPaths(channel, 'root context', infrastructure.rootContextFiles, cwd);
        logPaths(channel, 'nested context', infrastructure.nestedContextFiles, cwd);
        logPaths(channel, 'nested skills', infrastructure.nestedSkillFiles, cwd);
        logPaths(channel, 'skill directories', infrastructure.skillDirectories, cwd);
        logPaths(channel, 'command directories', infrastructure.commandDirectories, cwd);
        logPaths(channel, 'agent directories', infrastructure.agentDirectories, cwd);
        logPaths(channel, 'rule directories', infrastructure.ruleDirectories, cwd);
        if (infrastructure.pluginInstalls.length === 0) {
            channel.appendLine('  project plugins: (none)');
        } else {
            channel.appendLine(`  project plugins (${infrastructure.pluginInstalls.length}):`);
            for (const plugin of infrastructure.pluginInstalls) {
                channel.appendLine(`    - ${plugin.key}: ${plugin.installPath}`);
            }
        }
        channel.appendLine('');

        const session = getActiveSession();
        channel.appendLine('-- active session --');
        if (!session?.isReady) {
            channel.appendLine('FAIL no ready Pi session; open a Pi Code chat and run the smoke test again.');
            finish(channel, false);
            return;
        }

        const commandNames = new Set(session.getCommands().map((command) => command.name));
        const hasCompatCommand = commandNames.has('claude-compat');
        const hasLegacyAlias = commandNames.has('claude-md-injector');
        channel.appendLine(`${hasCompatCommand === infrastructure.active ? 'PASS' : 'FAIL'} /claude-compat mounted=${hasCompatCommand}`);
        channel.appendLine(`${hasLegacyAlias === infrastructure.active ? 'PASS' : 'FAIL'} legacy alias mounted=${hasLegacyAlias}`);

        if (!infrastructure.active) {
            channel.appendLine('');
            channel.appendLine(hasCompatCommand
                ? 'FAIL inactive workspace still has Claude compatibility mounted.'
                : 'PASS inactive workspace has no Claude compatibility command or hooks mounted.');
            finish(channel, !hasCompatCommand && !hasLegacyAlias);
            return;
        }

        if (!hasCompatCommand) {
            channel.appendLine('');
            channel.appendLine('FAIL Claude infrastructure was found, but this session predates detection.');
            channel.appendLine('Open a new chat (or reload the VS Code window), then run the smoke test again.');
            finish(channel, false);
            return;
        }

        const unreadable = [...infrastructure.rootContextFiles, ...infrastructure.nestedContextFiles]
            .filter((file) => !isReadableFile(file));
        channel.appendLine(`${unreadable.length === 0 ? 'PASS' : 'FAIL'} detected context files readable=${unreadable.length === 0}`);
        for (const file of unreadable) {
            channel.appendLine(`  unreadable: ${file}`);
        }

        let passed = unreadable.length === 0 && generatedResourcesExcluded;
        const contextResult = runRealProjectContextChecks(channel, cwd, infrastructure.nestedContextFiles);
        passed = passed && contextResult.passed;
        const safetyPassed = runSyntheticSafetyChecks(channel);
        passed = passed && safetyPassed;
        const resourcesPassed = await runClaudeResourceChecks(
            channel,
            cwd,
            infrastructure,
            commandNames,
            session.getRegisteredToolNames(),
        );
        passed = passed && resourcesPassed;
        const rulesPassed = runClaudeRuleChecks(channel, cwd, contextResult.target);
        passed = passed && rulesPassed;
        const enforcementPassed = await runRuleEnforcementChecks(channel);
        passed = passed && enforcementPassed;

        const target = contextResult.target;
        const command = target ? `/claude-compat ${target}` : '/claude-compat';
        channel.appendLine('');
        channel.appendLine('-- status command --');
        channel.appendLine(`Running locally (no model/provider request): ${command}`);
        try {
            await session.executeSlashCommand(command);
            channel.appendLine('PASS command executed; inspect the new status card in the active chat.');
        } catch (error) {
            channel.appendLine(`FAIL command error: ${(error as Error).message ?? String(error)}`);
            finish(channel, false);
            return;
        }

        if (infrastructure.agentDirectories.length > 0 || infrastructure.pluginInstalls.length > 0) {
            channel.appendLine('');
            channel.appendLine('-- rollout notice --');
            channel.appendLine('INFO these resources activated detection but are scheduled for later implementation phases:');
            channel.appendLine('  .claude agents and installed plugin resources.');
            channel.appendLine('  Their presence is reported here; this smoke test does not claim they are bridged yet.');
        }

        finish(channel, passed);
    });
}

function runRealProjectContextChecks(
    channel: vscode.OutputChannel,
    cwd: string,
    detectedNestedFiles: string[],
): { passed: boolean; target?: string } {
    channel.appendLine('');
    channel.appendLine('-- direct context pipeline (real project) --');

    const roots = getRootClaudeFiles(cwd);
    const root = buildRootInstructions(cwd);
    const repeated = buildRootInstructions(cwd);
    const deterministic = expansionSignature(root) === expansionSignature(repeated);
    const canonicalPaths = root.files.map((file) => normalizePathForCompare(file.canonicalPath));
    const deduplicated = new Set(canonicalPaths).size === canonicalPaths.length;
    const bounded = root.files.every((file) => file.depth <= CLAUDE_IMPORT_DEPTH_LIMIT);
    const contentsPresent = contentsAreRendered(root);
    const rootOrder = root.files.filter((file) => file.depth === 0).map((file) => normalizePathForCompare(file.path));
    const expectedRootOrder = roots.map(normalizePathForCompare);
    const precedenceCorrect = JSON.stringify(rootOrder) === JSON.stringify(expectedRootOrder);
    const userDirectory = getUserClaudeDirectory();
    const excludes = loadClaudeMdExcludes(cwd, userDirectory);
    const settingsValid = excludes.diagnostics.length === 0;
    const contained = root.files.every((file) =>
        isCanonicalDescendant(cwd, file.path) || isCanonicalDescendant(userDirectory, file.path),
    );

    channel.appendLine(`${deterministic ? 'PASS' : 'FAIL'} deterministic expansion=${deterministic}`);
    channel.appendLine(`${precedenceCorrect ? 'PASS' : 'FAIL'} user/root/.claude precedence=${precedenceCorrect}`);
    channel.appendLine(`${deduplicated ? 'PASS' : 'FAIL'} canonical files deduplicated=${deduplicated}`);
    channel.appendLine(`${bounded ? 'PASS' : 'FAIL'} import depth <= ${CLAUDE_IMPORT_DEPTH_LIMIT}: ${bounded}`);
    channel.appendLine(`${contained ? 'PASS' : 'FAIL'} sources contained by workspace or activated user Claude directory=${contained}`);
    channel.appendLine(`${contentsPresent ? 'PASS' : 'FAIL'} expanded source contents rendered directly=${contentsPresent}`);
    channel.appendLine(`${settingsValid ? 'PASS' : 'FAIL'} claudeMdExcludes settings valid=${settingsValid} (${excludes.patterns.length} pattern(s))`);
    for (const diagnostic of excludes.diagnostics) channel.appendLine(`  settings error: ${diagnostic.path}: ${diagnostic.message}`);
    logExpandedFiles(channel, root, cwd);
    logImportDiagnostics(channel, root.diagnostics, cwd);

    const preloaded = buildRootInstructions(cwd, roots);
    const preloadedRootPaths = new Set(roots.map(normalizePathForCompare));
    const avoidsPreloadedDuplicates = preloaded.files.every(
        (file) => !preloadedRootPaths.has(normalizePathForCompare(file.canonicalPath)),
    );
    channel.appendLine(`${avoidsPreloadedDuplicates ? 'PASS' : 'FAIL'} Pi-preloaded root files are not duplicated=${avoidsPreloadedDuplicates}`);

    let target = getActiveWorkspaceTarget(cwd);
    let scoped = target
        ? buildPathInstructions(cwd, [target], new Set(canonicalPaths))
        : { content: '', files: [], diagnostics: [] };
    if (scoped.files.length === 0 && detectedNestedFiles.length > 0) {
        target = path.relative(cwd, detectedNestedFiles[0]).replace(/\\/g, '/');
        scoped = buildPathInstructions(cwd, [target], new Set(canonicalPaths));
    }

    channel.appendLine('');
    channel.appendLine(`Path sample: ${target ?? '(none available)'}`);
    const scopedContentsPresent = contentsAreRendered(scoped);
    const scopedBounded = scoped.files.every((file) => file.depth <= CLAUDE_IMPORT_DEPTH_LIMIT);
    const scopedDeduplicated = new Set(scoped.files.map((file) => normalizePathForCompare(file.canonicalPath))).size === scoped.files.length;
    const scopedRoots = scoped.files.filter((file) => file.depth === 0);
    const generalToSpecific = scopedRoots.every((file, index) =>
        index === 0 || isCanonicalDescendant(path.dirname(scopedRoots[index - 1].path), path.dirname(file.path)),
    );
    const hasExpectedNestedFile = detectedNestedFiles.length === 0 || scopedRoots.length > 0;
    channel.appendLine(`${hasExpectedNestedFile ? 'PASS' : 'FAIL'} nested path instructions discovered=${scopedRoots.length}`);
    channel.appendLine(`${generalToSpecific ? 'PASS' : 'FAIL'} nested instructions ordered general-to-specific=${generalToSpecific}`);
    channel.appendLine(`${scopedDeduplicated ? 'PASS' : 'FAIL'} path expansion deduplicated=${scopedDeduplicated}`);
    channel.appendLine(`${scopedBounded ? 'PASS' : 'FAIL'} path import depth bounded=${scopedBounded}`);
    channel.appendLine(`${scopedContentsPresent ? 'PASS' : 'FAIL'} path source contents rendered directly=${scopedContentsPresent}`);
    logExpandedFiles(channel, scoped, cwd);
    logImportDiagnostics(channel, scoped.diagnostics, cwd);

    return {
        passed:
            deterministic && precedenceCorrect && deduplicated && bounded && contained && contentsPresent && settingsValid &&
            avoidsPreloadedDuplicates && hasExpectedNestedFile && generalToSpecific && scopedDeduplicated &&
            scopedBounded && scopedContentsPresent,
        target,
    };
}

async function runClaudeResourceChecks(
    channel: vscode.OutputChannel,
    cwd: string,
    infrastructure: Awaited<ReturnType<typeof detectClaudeInfrastructure>>,
    mountedCommands: Set<string>,
    registeredTools: string[],
): Promise<boolean> {
    channel.appendLine('');
    channel.appendLine('-- adapted Claude skills and commands --');
    const resources = indexClaudeResources(cwd, {
        projectSkillDirectories: infrastructure.skillDirectories,
        projectSkillFiles: infrastructure.nestedSkillFiles,
        projectCommandDirectories: infrastructure.commandDirectories,
    });
    const expectedProjectSkills = infrastructure.skillDirectories.length === 0 ||
        resources.skills.some((skill) => skill.scope === 'project');
    const expectedProjectCommands = infrastructure.commandDirectories.length === 0 ||
        resources.commands.some((command) => command.scope === 'project');
    const invocableResources = [
        ...resources.skills.filter((skill) => skill.userInvocable),
        ...resources.commands,
    ];
    const commandsMounted = invocableResources.every((resource) =>
        mountedCommands.has(resource.name) || mountedCommands.has(`claude:${resource.name}`),
    );
    const skillsOverrideCommands = resources.commands.every((command) =>
        !resources.skills.some((skill) => skill.name.toLowerCase() === command.name.toLowerCase()),
    );
    const recoveredErrors = resources.diagnostics.filter((diagnostic) => diagnostic.kind === 'frontmatter-error');
    const toolReferences = [...resources.skills, ...resources.commands].flatMap((resource) => resource.toolReferences);
    const toolResolutions = resolveClaudeToolReferences(toolReferences, registeredTools);
    const unavailableTools = toolResolutions.filter((resolution) => resolution.status === 'unavailable');
    const deferredAgentTools = toolResolutions.filter((resolution) => resolution.status === 'deferred-agent');
    const runtimeOnlyTools = toolResolutions.filter((resolution) => resolution.status === 'runtime-only');
    const fatalDiagnostics = resources.diagnostics.filter((diagnostic) =>
        diagnostic.kind === 'read-error' || diagnostic.kind === 'invalid-resource',
    );

    channel.appendLine(`${expectedProjectSkills ? 'PASS' : 'FAIL'} detected project skill directories indexed=${expectedProjectSkills}`);
    channel.appendLine(`${expectedProjectCommands ? 'PASS' : 'FAIL'} detected project command directories indexed=${expectedProjectCommands}`);
    channel.appendLine(`${commandsMounted ? 'PASS' : 'FAIL'} user-invocable resources mounted as Pi slash commands=${commandsMounted}`);
    channel.appendLine(`${skillsOverrideCommands ? 'PASS' : 'FAIL'} same-named skills take precedence over legacy commands=${skillsOverrideCommands}`);
    channel.appendLine(`${fatalDiagnostics.length === 0 ? 'PASS' : 'FAIL'} no unreadable or unusable resources=${fatalDiagnostics.length === 0}`);
    channel.appendLine(`${unavailableTools.length === 0 ? 'PASS' : 'FAIL'} non-agent tool references resolve through Pi built-ins/direct MCP/proxy=${unavailableTools.length === 0}`);
    channel.appendLine(`  indexed: ${resources.skills.length} skill(s), ${resources.commands.length} legacy command(s)`);
    channel.appendLine(`  tool references: ${toolResolutions.length} total, ${deferredAgentTools.length} agent-deferred, ${runtimeOnlyTools.length} runtime-adapted, ${unavailableTools.length} unavailable`);
    for (const resolution of unavailableTools) channel.appendLine(`  FAIL unavailable ${resolution.reference}: ${resolution.message}`);
    for (const diagnostic of recoveredErrors) {
        channel.appendLine(`  INFO recovered malformed frontmatter: ${path.relative(cwd, diagnostic.path).replace(/\\/g, '/')}`);
    }
    for (const diagnostic of fatalDiagnostics) {
        channel.appendLine(`  FAIL ${diagnostic.kind}: ${diagnostic.path}: ${diagnostic.message}`);
    }

    channel.appendLine('  synthetic resource adapter (workspace is not modified):');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-resources-smoke-'));
    try {
        const userClaudeDirectory = path.join(fixtureRoot, '.test-user-claude');
        writeSmokeFile(path.join(fixtureRoot, '.claude', 'skills', 'migrate', 'SKILL.md'), [
            '---',
            'description: Use when: migrating components',
            'arguments: [component, source]',
            'allowed-tools: [Read, Bash]',
            '---',
            'Migrate $component from $source. First=$0 all=$ARGUMENTS.',
            'Skill=${CLAUDE_SKILL_DIR} Project=${CLAUDE_PROJECT_DIR}.',
        ].join('\n'));
        writeSmokeFile(path.join(fixtureRoot, '.claude', 'commands', 'issue', 'fix.md'),
            '---\ndescription: Fix issue\n---\nFix $1; all=$ARGUMENTS.\n');
        writeSmokeFile(path.join(userClaudeDirectory, 'skills', 'migrate', 'SKILL.md'),
            '---\ndescription: User migration\n---\nUSER_WINNER $0 via `Read` and mcp__docs__lookup\n');
        const nestedSkillPath = path.join(fixtureRoot, 'apps', 'web', '.claude', 'skills', 'deploy', 'SKILL.md');
        const generatedSkillPath = path.join(fixtureRoot, 'ExampleGame', 'Library', 'PackageCache', 'package', '.claude', 'skills', 'changelog', 'SKILL.md');
        writeSmokeFile(nestedSkillPath, '---\ndescription: Deploy web\n---\nNESTED_WEB_SKILL\n');
        writeSmokeFile(generatedSkillPath, '---\ndescription: Generated changelog\n---\nIGNORE\n');
        const fixture = indexClaudeResources(fixtureRoot, {
            userClaudeDirectory,
            projectSkillFiles: [nestedSkillPath, generatedSkillPath],
        });
        const skill = fixture.skills.find((resource) => resource.name === 'migrate');
        const command = fixture.commands.find((resource) => resource.name === 'issue:fix');
        const skillRendered = skill
            ? renderClaudeInvocableResource(skill, 'Widget React', fixtureRoot, 'smoke-session', 'high', ['read', 'bash', 'mcp'])
            : '';
        const commandRendered = command ? renderClaudeInvocableResource(command, '123 extra', fixtureRoot) : '';
        const precedence = skill?.scope === 'user' && skillRendered.includes('USER_WINNER Widget');
        const substitutions = commandRendered.includes('Fix 123; all=123 extra.');
        const bounded = skillRendered.includes('Remain the current Pi agent') &&
            commandRendered.includes('do not replace the current agent identity');
        const runtimeSafe = fixture.diagnostics.some((diagnostic) =>
            diagnostic.kind === 'unsupported-runtime-field' && diagnostic.message.includes('allowed-tools'),
        );
        const toolNamesAdapted = skillRendered.includes('Read → read [mapped]') &&
            skillRendered.includes('mcp__docs__lookup → mcp [proxy]');
        const nestedQualified = fixture.skills.some((resource) => resource.name === 'apps/web:deploy') &&
            matchingNestedClaudeSkills(fixture, ['apps/web/src/file.ts'], fixtureRoot)
                .some((resource) => resource.name === 'apps/web:deploy') &&
            matchingNestedClaudeSkills(fixture, ['apps/api/file.ts'], fixtureRoot).length === 0;
        const generatedResourcesExcluded = !fixture.skills.some((resource) => resource.canonicalPath === generatedSkillPath) &&
            fixture.diagnostics.some((diagnostic) => diagnostic.path === generatedSkillPath);
        channel.appendLine(`    ${precedence ? 'PASS' : 'FAIL'} user-before-project resource precedence=${precedence}`);
        channel.appendLine(`    ${substitutions ? 'PASS' : 'FAIL'} legacy command argument substitution=${substitutions}`);
        channel.appendLine(`    ${bounded ? 'PASS' : 'FAIL'} invoked resources retain Pi identity/runtime boundary=${bounded}`);
        channel.appendLine(`    ${runtimeSafe ? 'PASS' : 'FAIL'} Claude runtime/tool fields do not grant capabilities=${runtimeSafe}`);
        channel.appendLine(`    ${toolNamesAdapted ? 'PASS' : 'FAIL'} built-in and MCP source names map through the active Pi registry=${toolNamesAdapted}`);
        channel.appendLine(`    ${nestedQualified ? 'PASS' : 'FAIL'} nested skills use qualified names and directory scope=${nestedQualified}`);
        channel.appendLine(`    ${generatedResourcesExcluded ? 'PASS' : 'FAIL'} generated/dependency caches are excluded=${generatedResourcesExcluded}`);
        return expectedProjectSkills && expectedProjectCommands && commandsMounted && skillsOverrideCommands &&
            fatalDiagnostics.length === 0 && unavailableTools.length === 0 && precedence && substitutions && bounded &&
            runtimeSafe && toolNamesAdapted && nestedQualified && generatedResourcesExcluded;
    } catch (error) {
        channel.appendLine(`    FAIL synthetic resource checks error: ${(error as Error).message ?? String(error)}`);
        return false;
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

function runClaudeRuleChecks(channel: vscode.OutputChannel, cwd: string, target?: string): boolean {
    channel.appendLine('');
    channel.appendLine('-- Claude rules --');
    const indexed = indexClaudeRules(cwd);
    const repeated = indexClaudeRules(cwd);
    const deterministic = JSON.stringify(indexed.rules.map((rule) => [rule.canonicalPath, rule.fingerprint])) ===
        JSON.stringify(repeated.rules.map((rule) => [rule.canonicalPath, rule.fingerprint]));
    const contained = indexed.rules.every((rule) =>
        isCanonicalDescendant(path.join(cwd, '.claude', 'rules'), rule.path) ||
        isCanonicalDescendant(path.join(os.homedir(), '.claude', 'rules'), rule.path),
    );
    const projectWide = indexed.rules.filter((rule) => rule.projectWide);
    const projectWideRendered = projectWide.length === 0 || projectWide.every((rule) =>
        !rule.content || renderClaudeRules(projectWide, cwd).includes(rule.content),
    );
    const matching = target
        ? matchingClaudeRules(indexed.rules, [{ path: target, directoryScope: false }], cwd)
        : [];

    channel.appendLine(`${deterministic ? 'PASS' : 'FAIL'} deterministic rule index=${deterministic}`);
    channel.appendLine(`${contained ? 'PASS' : 'FAIL'} rule files originate from project or activated user rules=${contained}`);
    channel.appendLine(`${projectWideRendered ? 'PASS' : 'FAIL'} project-wide rule contents render directly=${projectWideRendered}`);
    channel.appendLine(`  indexed rules: ${indexed.rules.length} (${projectWide.length} project-wide, ${indexed.rules.length - projectWide.length} path-scoped)`);
    channel.appendLine(`  matching sample path: ${matching.length}${target ? ` for ${target}` : ''}`);
    for (const rule of indexed.rules) {
        const scope = rule.projectWide ? 'project-wide' : rule.patterns.join(', ');
        channel.appendLine(`    - ${rule.relativePath} (${scope})`);
    }
    for (const diagnostic of indexed.diagnostics) {
        channel.appendLine(`  FAIL ${diagnostic.kind}: ${path.relative(cwd, diagnostic.path).replace(/\\/g, '/')}: ${diagnostic.message}`);
    }

    channel.appendLine('  synthetic rule fixture (workspace is not modified):');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-rules-smoke-'));
    const fixtureLinks: string[] = [];
    try {
        const ruleDirectory = path.join(fixtureRoot, '.claude', 'rules');
        writeSmokeFile(path.join(ruleDirectory, 'global.md'), 'GLOBAL_RULE_SMOKE\n');
        writeSmokeFile(path.join(ruleDirectory, 'scoped.md'), [
            '---',
            'paths: ["src/**/*.{ts,tsx}", "docs/file?.md", "tests/file[0-9].ts", "exact/config.json", "broken[/path"]',
            '---',
            'SCOPED_RULE_SMOKE',
        ].join('\n'));
        writeSmokeFile(path.join(ruleDirectory, 'invalid.md'), '---\npaths:\n  nested: invalid\n---\nINVALID\n');
        const userClaudeDirectory = path.join(fixtureRoot, '.test-user-claude');
        writeSmokeFile(path.join(userClaudeDirectory, 'rules', 'user.md'), 'USER_RULE_SMOKE\n');
        const sharedRules = path.join(fixtureRoot, 'shared-rules');
        writeSmokeFile(path.join(sharedRules, 'linked.md'), 'LINKED_RULE_SMOKE\n');
        let symlinkCreated = false;
        try {
            const sharedLink = path.join(ruleDirectory, 'shared');
            fs.symlinkSync(
                sharedRules,
                sharedLink,
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            fixtureLinks.push(sharedLink);
            const cycleLink = path.join(sharedRules, 'cycle');
            fs.symlinkSync(
                ruleDirectory,
                cycleLink,
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            fixtureLinks.push(cycleLink);
            symlinkCreated = true;
        } catch {
            // Report unsupported environments without failing unrelated checks.
        }

        clearClaudeRuleCache();
        const fixture = indexClaudeRules(fixtureRoot, { userClaudeDirectory });
        const global = fixture.rules.find((rule) => rule.relativePath.endsWith('global.md'));
        const scoped = fixture.rules.find((rule) => rule.relativePath.endsWith('scoped.md'));
        const invalid = fixture.rules.find((rule) => rule.relativePath.endsWith('invalid.md'));
        const globalWorks = Boolean(global?.projectWide && ruleMatchesPath(global, 'anything/file.bin', fixtureRoot));
        const wildcardsWork = Boolean(
            scoped &&
            ruleMatchesPath(scoped, 'src/features/file.tsx', fixtureRoot) &&
            ruleMatchesPath(scoped, 'docs/file1.md', fixtureRoot) &&
            ruleMatchesPath(scoped, 'tests/file7.ts', fixtureRoot) &&
            ruleMatchesPath(scoped, 'exact/config.json', fixtureRoot) &&
            !ruleMatchesPath(scoped, 'docs/file10.md', fixtureRoot) &&
            ruleMatchesPath(scoped, 'src', fixtureRoot, true),
        );
        const malformedSafe = Boolean(
            invalid && !invalid.projectWide && invalid.patterns.length === 0 &&
            fixture.diagnostics.some((diagnostic) => diagnostic.kind === 'invalid-paths'),
        );
        const userPrecedence = fixture.rules[0]?.sourceScope === 'user';
        const invalidPatternIsolated = Boolean(scoped && !scoped.patterns.includes('broken[/path') &&
            fixture.diagnostics.some((diagnostic) => diagnostic.kind === 'invalid-pattern'));
        const symlinkRulesWork = !symlinkCreated || fixture.rules.some((rule) =>
            rule.relativePath === '.claude/rules/shared/linked.md' && rule.content === 'LINKED_RULE_SMOKE',
        );
        const directRender = Boolean(global && scoped &&
            renderClaudeRules([global, scoped], fixtureRoot).includes('GLOBAL_RULE_SMOKE') &&
            renderClaudeRules([global, scoped], fixtureRoot).includes('SCOPED_RULE_SMOKE'));

        channel.appendLine(`    ${globalWorks ? 'PASS' : 'FAIL'} rules without paths are project-wide=${globalWorks}`);
        channel.appendLine(`    ${wildcardsWork ? 'PASS' : 'FAIL'} exact/*/**/?/brace/bracket matching and directory scopes=${wildcardsWork}`);
        channel.appendLine(`    ${userPrecedence ? 'PASS' : 'FAIL'} activated user rules load before project rules=${userPrecedence}`);
        channel.appendLine(`    ${invalidPatternIsolated ? 'PASS' : 'FAIL'} invalid bracket patterns do not disable valid patterns=${invalidPatternIsolated}`);
        channel.appendLine(`    ${symlinkRulesWork ? (symlinkCreated ? 'PASS' : 'INFO') : 'FAIL'} symlinked rule directories and cycle protection=${symlinkRulesWork}`);
        channel.appendLine(`    ${malformedSafe ? 'PASS' : 'FAIL'} malformed scoped rules do not become global=${malformedSafe}`);
        channel.appendLine(`    ${directRender ? 'PASS' : 'FAIL'} rule bodies render directly=${directRender}`);
        return deterministic && contained && projectWideRendered && indexed.diagnostics.length === 0 &&
            globalWorks && wildcardsWork && userPrecedence && invalidPatternIsolated && symlinkRulesWork &&
            malformedSafe && directRender;
    } catch (error) {
        channel.appendLine(`    FAIL synthetic rule checks error: ${(error as Error).message ?? String(error)}`);
        return false;
    } finally {
        clearClaudeRuleCache();
        // Windows recursive deletion follows circular directory junctions far
        // enough to fail with ERROR_CANT_RESOLVE_FILENAME. Unlink every test
        // junction explicitly before deleting the temporary tree.
        for (const link of fixtureLinks.reverse()) {
            try { fs.unlinkSync(link); } catch { /* best-effort fixture cleanup */ }
        }
        try {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        } catch (error) {
            channel.appendLine(`    INFO temporary fixture cleanup warning: ${(error as Error).message ?? String(error)}`);
        }
    }
}

async function runRuleEnforcementChecks(channel: vscode.OutputChannel): Promise<boolean> {
    channel.appendLine('');
    channel.appendLine('-- rule enforcement hooks (actual extension, temporary fixture) --');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-rule-hooks-smoke-'));
    try {
        const scopedRule = path.join(cwd, '.claude', 'rules', 'scoped.md');
        writeSmokeFile(path.join(cwd, '.claude', 'rules', 'global.md'), 'GLOBAL_HOOK_RULE\n');
        writeSmokeFile(scopedRule, '---\npaths: ["src/**/*.ts"]\n---\nSCOPED_HOOK_RULE\n');
        writeSmokeFile(
            path.join(cwd, '.claude', 'rules', 'bash-fallback.md'),
            '---\npaths: ["scripts/**"]\n---\nBASH_FALLBACK_HOOK_RULE\n',
        );
        writeSmokeFile(path.join(cwd, 'src', 'feature.ts'), 'export {};\n');
        writeSmokeFile(path.join(cwd, 'scripts', 'build.ts'), 'export {};\n');
        const nestedSkillPath = path.join(cwd, 'apps', 'web', '.claude', 'skills', 'deploy', 'SKILL.md');
        writeSmokeFile(nestedSkillPath, '---\ndescription: Deploy nested web app\n---\nNESTED_HOOK_SKILL\n');
        writeSmokeFile(path.join(cwd, 'apps', 'web', 'src', 'file.ts'), 'export {};\n');
        const userClaudeDirectory = path.join(cwd, '.unused-user-claude');
        const resources = indexClaudeResources(cwd, {
            userClaudeDirectory,
            projectSkillFiles: [nestedSkillPath],
        });

        const hooks = new Map<string, (event: any, context: any) => Promise<any>>();
        const entries: any[] = [];
        const messages: Array<{ message: any; options: any }> = [];
        const fakePi = {
            on(name: string, handler: (event: any, context: any) => Promise<any>) {
                hooks.set(name, handler);
            },
            registerCommand() {},
            sendMessage(message: any, options: any) {
                messages.push({ message, options });
            },
            appendEntry(customType: string, data: any) {
                entries.push({ type: 'custom', customType, data });
            },
        };
        createClaudeContextExtension({
            contextEnabled: false,
            rulesEnabled: true,
            userClaudeDirectory,
            resources,
        })(fakePi as any);
        const extensionContext = {
            cwd,
            sessionManager: {
                getBranch: () => entries,
                getLeafId: () => entries.at(-1)?.id,
            },
        };
        const beforeAgentStart = hooks.get('before_agent_start')!;
        const toolCall = hooks.get('tool_call')!;
        const toolResult = hooks.get('tool_result')!;

        const promptResult = await beforeAgentStart(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } },
            extensionContext,
        );
        const projectWideInjected = promptResult?.message?.content?.includes('GLOBAL_HOOK_RULE') === true &&
            promptResult?.systemPrompt === undefined;
        const compatibilityBoundary = promptResult?.message?.content?.includes('Remain the current Pi agent') === true &&
            promptResult?.message?.content?.includes('do not replace the current agent identity') === true &&
            promptResult?.message?.content?.includes('Never invent, simulate, or claim access') === true;
        const retainedNativeContext = retainNativePiContextFiles([
            { path: path.join(cwd, 'CLAUDE.md'), content: 'CLAUDE_SYSTEM_CONTEXT' },
            { path: path.join(cwd, 'AGENTS.md'), content: 'AGENTS_SYSTEM_CONTEXT' },
        ]);
        const nativeContextIsolation = retainedNativeContext.length === 1 &&
            retainedNativeContext[0].content === 'AGENTS_SYSTEM_CONTEXT';
        const repeatedContext = await beforeAgentStart(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } },
            extensionContext,
        );
        entries.push({ type: 'compaction', id: 'context-compaction' });
        const contextAfterCompaction = await beforeAgentStart(
            { systemPrompt: 'Base prompt', systemPromptOptions: { contextFiles: [] } },
            extensionContext,
        );
        const contextMessageState = repeatedContext === undefined &&
            contextAfterCompaction?.message?.content?.includes('GLOBAL_HOOK_RULE') === true;

        entries.push({ type: 'message', id: 'assistant-1', message: { role: 'assistant' } });
        const call = { toolName: 'read', toolCallId: 'call-1', input: { path: 'src/feature.ts' } };
        const first = await toolCall(call, extensionContext);
        const sibling = await toolCall({ ...call, toolCallId: 'call-2' }, extensionContext);
        const firstMessageCount = messages.length;
        const preToolBlocked = first?.block === true &&
            first?.reason?.includes('Retry') === true &&
            messages[0]?.message?.content?.includes('SCOPED_HOOK_RULE') === true &&
            messages[0]?.message?.content?.includes('Remain the current Pi agent') === true &&
            messages[0]?.options?.deliverAs === 'steer';
        const siblingsBlockedWithoutDuplicate = sibling?.block === true && firstMessageCount === 1;

        entries.push({ type: 'message', id: 'assistant-2', message: { role: 'assistant' } });
        const retry = await toolCall({ ...call, toolCallId: 'call-3' }, extensionContext);
        const retryPermitted = retry === undefined;
        const nonMatchingPermitted = await toolCall(
            { toolName: 'read', toolCallId: 'call-4', input: { path: 'docs/readme.md' } },
            extensionContext,
        ) === undefined;

        entries.push({ type: 'compaction', id: 'compaction-1' });
        entries.push({ type: 'message', id: 'assistant-3', message: { role: 'assistant' } });
        const afterCompaction = await toolCall({ ...call, toolCallId: 'call-5' }, extensionContext);
        const compactionReapplied = afterCompaction?.block === true && messages.length === 2;

        entries.push({ type: 'message', id: 'assistant-4', message: { role: 'assistant' } });
        writeSmokeFile(scopedRule, '---\npaths: ["src/**/*.ts"]\n---\nUPDATED_SCOPED_HOOK_RULE_WITH_NEW_SIZE\n');
        const afterChange = await toolCall({ ...call, toolCallId: 'call-6' }, extensionContext);
        const contentChangeReapplied = afterChange?.block === true &&
            messages.at(-1)?.message?.content?.includes('UPDATED_SCOPED_HOOK_RULE_WITH_NEW_SIZE') === true;

        const bashFallback = await toolResult(
            {
                toolName: 'bash',
                toolCallId: 'call-7',
                input: { command: 'inspect scripts/build.ts' },
                content: [{ type: 'text', text: 'scripts/build.ts' }],
            },
            extensionContext,
        );
        const bashFallbackInjected = bashFallback?.content?.at(-1)?.text?.includes('BASH_FALLBACK_HOOK_RULE') === true &&
            bashFallback?.content?.at(-1)?.text?.includes('Remain the current Pi agent') === true;

        entries.push({ type: 'message', id: 'assistant-5', message: { role: 'assistant' } });
        const nestedCall = {
            toolName: 'read',
            toolCallId: 'nested-1',
            input: { path: 'apps/web/src/file.ts' },
        };
        const nestedBlocked = await toolCall(nestedCall, extensionContext);
        const nestedMessage = messages.at(-1)?.message?.content ?? '';
        const nestedRetry = await toolCall({ ...nestedCall, toolCallId: 'nested-2' }, extensionContext);
        const nestedSkillApplied = nestedBlocked?.block === true && nestedRetry === undefined &&
            nestedMessage.includes('apps/web:deploy') && nestedMessage.includes('Remain the current Pi agent');
        entries.push({ type: 'compaction', id: 'nested-compaction' });
        const nestedAfterCompaction = await toolCall({ ...nestedCall, toolCallId: 'nested-3' }, extensionContext);
        const nestedSkillReapplied = nestedAfterCompaction?.block === true;

        const disabledHooks = new Map<string, unknown>();
        createClaudeContextExtension({ contextEnabled: false, rulesEnabled: false })({
            on(name: string, handler: unknown) { disabledHooks.set(name, handler); },
            registerCommand() {},
        } as any);
        const capabilityGated = !disabledHooks.has('before_agent_start') &&
            !disabledHooks.has('tool_call') && !disabledHooks.has('tool_result');

        channel.appendLine(`${projectWideInjected ? 'PASS' : 'FAIL'} project-wide rules enter a context message, not the system prompt=${projectWideInjected}`);
        channel.appendLine(`${compatibilityBoundary ? 'PASS' : 'FAIL'} Claude resources retain the current Pi identity/runtime/tool contract=${compatibilityBoundary}`);
        channel.appendLine(`${nativeContextIsolation ? 'PASS' : 'FAIL'} raw CLAUDE.md is removed from Pi system context while AGENTS.md remains native=${nativeContextIsolation}`);
        channel.appendLine(`${contextMessageState ? 'PASS' : 'FAIL'} context messages deduplicate and reapply after compaction=${contextMessageState}`);
        channel.appendLine(`${preToolBlocked ? 'PASS' : 'FAIL'} matching tool call blocked with direct steer context=${preToolBlocked}`);
        channel.appendLine(`${siblingsBlockedWithoutDuplicate ? 'PASS' : 'FAIL'} matching sibling calls blocked without duplicate messages=${siblingsBlockedWithoutDuplicate}`);
        channel.appendLine(`${retryPermitted ? 'PASS' : 'FAIL'} retry permitted on the next assistant turn=${retryPermitted}`);
        channel.appendLine(`${nonMatchingPermitted ? 'PASS' : 'FAIL'} non-matching path permitted=${nonMatchingPermitted}`);
        channel.appendLine(`${compactionReapplied ? 'PASS' : 'FAIL'} rule reapplied after compaction=${compactionReapplied}`);
        channel.appendLine(`${contentChangeReapplied ? 'PASS' : 'FAIL'} changed rule reapplied=${contentChangeReapplied}`);
        channel.appendLine(`${bashFallbackInjected ? 'PASS' : 'FAIL'} bash-discovered path receives fallback rule context=${bashFallbackInjected}`);
        channel.appendLine(`${nestedSkillApplied ? 'PASS' : 'FAIL'} nested skill blocks matching path once and permits retry=${nestedSkillApplied}`);
        channel.appendLine(`${nestedSkillReapplied ? 'PASS' : 'FAIL'} nested skill reapplied after compaction=${nestedSkillReapplied}`);
        channel.appendLine(`${capabilityGated ? 'PASS' : 'FAIL'} absent rule/context resources register no hooks=${capabilityGated}`);

        return projectWideInjected && compatibilityBoundary && nativeContextIsolation && contextMessageState &&
            preToolBlocked && siblingsBlockedWithoutDuplicate && retryPermitted &&
            nonMatchingPermitted && compactionReapplied && contentChangeReapplied && bashFallbackInjected &&
            nestedSkillApplied && nestedSkillReapplied && capabilityGated;
    } catch (error) {
        channel.appendLine(`FAIL enforcement hook checks error: ${(error as Error).message ?? String(error)}`);
        return false;
    } finally {
        clearClaudeRuleCache();
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

function runSyntheticSafetyChecks(channel: vscode.OutputChannel): boolean {
    channel.appendLine('');
    channel.appendLine('-- import safety guards (temporary fixture; workspace is not modified) --');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-claude-smoke-'));
    const cwd = path.join(fixtureRoot, 'workspace');
    try {
        fs.mkdirSync(cwd, { recursive: true });
        const root = path.join(cwd, 'CLAUDE.md');
        writeSmokeFile(root, '@a.md\n@../outside.md\n');
        writeSmokeFile(path.join(cwd, 'a.md'), '@b.md\n');
        writeSmokeFile(path.join(cwd, 'b.md'), '@a.md\n');
        writeSmokeFile(path.join(fixtureRoot, 'outside.md'), 'must not load\n');

        clearInstructionImportCache();
        const guarded = expandInstructionFiles([root], { cwd });
        const cycleDetected = guarded.diagnostics.some((diagnostic) => diagnostic.kind === 'cycle');
        const escapeRejected = guarded.diagnostics.some((diagnostic) => diagnostic.kind === 'outside-root') &&
            guarded.files.every((file) => !file.content.includes('must not load'));

        const depthRoot = path.join(cwd, 'depth-root.md');
        writeSmokeFile(depthRoot, '@level-1.md\n');
        for (let level = 1; level <= CLAUDE_IMPORT_DEPTH_LIMIT + 1; level++) {
            writeSmokeFile(
                path.join(cwd, `level-${level}.md`),
                level <= CLAUDE_IMPORT_DEPTH_LIMIT ? `@level-${level + 1}.md\n` : 'end\n',
            );
        }
        const deep = expandInstructionFiles([depthRoot], { cwd });
        const depthStopped = deep.diagnostics.some((diagnostic) => diagnostic.kind === 'depth-limit') &&
            deep.files.every((file) => file.depth <= CLAUDE_IMPORT_DEPTH_LIMIT);

        const cacheRoot = path.join(cwd, 'cache-root.md');
        const dependency = path.join(cwd, 'dependency.md');
        writeSmokeFile(cacheRoot, '@dependency.md\n');
        writeSmokeFile(dependency, 'before\n');
        const before = expandInstructionFiles([cacheRoot], { cwd });
        writeSmokeFile(dependency, 'after with a different size\n');
        const after = expandInstructionFiles([cacheRoot], { cwd });
        const dependencyInvalidated = before.files.at(-1)?.fingerprint !== after.files.at(-1)?.fingerprint &&
            after.files.at(-1)?.content.includes('after with a different size') === true;

        const markdownRoot = path.join(cwd, 'markdown-root.md');
        writeSmokeFile(markdownRoot, '@real.md\n`@inline.md`\n```md\n@fenced.md\n```\n<!-- @comment.md -->\n');
        writeSmokeFile(path.join(cwd, 'real.md'), 'REAL\n');
        writeSmokeFile(path.join(cwd, 'inline.md'), 'INLINE\n');
        writeSmokeFile(path.join(cwd, 'fenced.md'), 'FENCED\n');
        writeSmokeFile(path.join(cwd, 'comment.md'), 'COMMENT\n');
        const markdownAware = expandInstructionFiles([markdownRoot], { cwd });
        const codeAware = markdownAware.files.length === 2 &&
            markdownAware.files.at(-1)?.content === 'REAL\n' &&
            !markdownAware.files[0].content.includes('<!--');

        const sourceRoot = path.join(cwd, 'source-root.md');
        writeSmokeFile(sourceRoot, '@nested/source.md\n');
        writeSmokeFile(path.join(cwd, 'nested', 'source.md'), '@target.md\n');
        writeSmokeFile(path.join(cwd, 'nested', 'target.md'), 'SOURCE_RELATIVE\n');
        writeSmokeFile(path.join(cwd, 'target.md'), 'WRONG_WORKSPACE_RELATIVE\n');
        const sourceRelative = expandInstructionFiles([sourceRoot], { cwd }).files.at(-1)?.content === 'SOURCE_RELATIVE\n';

        const userClaudeDirectory = path.join(cwd, '.test-user-claude');
        writeSmokeFile(path.join(fixtureRoot, 'CLAUDE.md'), 'ANCESTOR_CONTEXT\n');
        writeSmokeFile(path.join(cwd, 'CLAUDE.md'), 'EXCLUDED_ROOT\n');
        writeSmokeFile(path.join(cwd, '.claude', 'CLAUDE.md'), 'DOT_CONTEXT\n');
        writeSmokeFile(path.join(cwd, 'CLAUDE.local.md'), 'LOCAL_CONTEXT\n');
        writeSmokeFile(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({
            claudeMdExcludes: [path.join(cwd, 'CLAUDE.md')],
        }));
        writeSmokeFile(path.join(cwd, 'nested', 'CLAUDE.local.md'), 'NESTED_LOCAL_CONTEXT\n');
        writeSmokeFile(path.join(cwd, 'nested', 'file.ts'), '');
        const correctedRoot = buildRootInstructions(cwd, [], { userClaudeDirectory });
        const correctedNested = buildPathInstructions(cwd, ['nested/file.ts'], new Set(), { userClaudeDirectory });
        const localAndExcludes = !correctedRoot.content.includes('EXCLUDED_ROOT') &&
            correctedRoot.content.includes('ANCESTOR_CONTEXT') &&
            correctedRoot.content.indexOf('ANCESTOR_CONTEXT') < correctedRoot.content.indexOf('DOT_CONTEXT') &&
            correctedRoot.content.includes('DOT_CONTEXT') && correctedRoot.content.includes('LOCAL_CONTEXT') &&
            correctedNested.content.includes('NESTED_LOCAL_CONTEXT');

        channel.appendLine(`${cycleDetected ? 'PASS' : 'FAIL'} cycle detection=${cycleDetected}`);
        channel.appendLine(`${escapeRejected ? 'PASS' : 'FAIL'} workspace escape rejected=${escapeRejected}`);
        channel.appendLine(`${depthStopped ? 'PASS' : 'FAIL'} depth limit enforced=${depthStopped}`);
        channel.appendLine(`${dependencyInvalidated ? 'PASS' : 'FAIL'} dependency-aware cache invalidation=${dependencyInvalidated}`);
        channel.appendLine(`${codeAware ? 'PASS' : 'FAIL'} imports ignore code/comments and strip HTML comments=${codeAware}`);
        channel.appendLine(`${sourceRelative ? 'PASS' : 'FAIL'} relative imports resolve from their containing file=${sourceRelative}`);
        channel.appendLine(`${localAndExcludes ? 'PASS' : 'FAIL'} ancestor/CLAUDE.local.md/claudeMdExcludes semantics=${localAndExcludes}`);
        return cycleDetected && escapeRejected && depthStopped && dependencyInvalidated && codeAware &&
            sourceRelative && localAndExcludes;
    } catch (error) {
        channel.appendLine(`FAIL synthetic checks error: ${(error as Error).message ?? String(error)}`);
        return false;
    } finally {
        clearInstructionImportCache();
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

function expansionSignature(instructions: RenderedInstructions): string {
    return JSON.stringify(instructions.files.map((file) => ({
        path: normalizePathForCompare(file.canonicalPath),
        fingerprint: file.fingerprint,
        depth: file.depth,
        importedBy: file.importedBy ? normalizePathForCompare(file.importedBy) : undefined,
    })));
}

function contentsAreRendered(instructions: RenderedInstructions): boolean {
    if (instructions.files.length === 0) return instructions.content.length === 0;
    return instructions.files.every((file) => {
        const content = file.content.trim();
        return content.length === 0 || instructions.content.includes(content);
    });
}

function logExpandedFiles(channel: vscode.OutputChannel, instructions: RenderedInstructions, cwd: string): void {
    if (instructions.files.length === 0) {
        channel.appendLine('  expanded sources: (none)');
        return;
    }
    channel.appendLine(`  expanded sources (${instructions.files.length}, ${instructions.content.length} rendered chars):`);
    for (const file of instructions.files) {
        const relative = path.relative(cwd, file.path).replace(/\\/g, '/');
        const label = relative.startsWith('..') ? file.path.replace(/\\/g, '/') : relative;
        const imported = file.importedBy ? ` import depth=${file.depth}` : ' root';
        channel.appendLine(`    - ${label}${imported}`);
    }
}

function logImportDiagnostics(channel: vscode.OutputChannel, diagnostics: ImportDiagnostic[], cwd: string): void {
    if (diagnostics.length === 0) {
        channel.appendLine('  import diagnostics: (none)');
        return;
    }
    channel.appendLine(`  import diagnostics (${diagnostics.length}; informational, project files are not modified):`);
    for (const diagnostic of diagnostics) {
        const source = path.relative(cwd, diagnostic.source).replace(/\\/g, '/');
        channel.appendLine(`    - ${diagnostic.kind}: ${source}${diagnostic.reference ? ` @${diagnostic.reference}` : ''}`);
    }
}

function writeSmokeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function logPaths(channel: vscode.OutputChannel, label: string, paths: string[], cwd: string): void {
    if (paths.length === 0) {
        channel.appendLine(`  ${label}: (none)`);
        return;
    }
    channel.appendLine(`  ${label} (${paths.length}):`);
    for (const file of paths) {
        const relative = path.relative(cwd, file).replace(/\\/g, '/');
        channel.appendLine(`    - ${relative || path.basename(file)}`);
    }
}

function isReadableFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile() && fs.readFileSync(filePath, 'utf8').length >= 0;
    } catch {
        return false;
    }
}

function getActiveWorkspaceTarget(cwd: string): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const relative = path.relative(cwd, editor.document.uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return relative.replace(/\\/g, '/');
}

function finish(channel: vscode.OutputChannel, passed: boolean): void {
    channel.appendLine('');
    channel.appendLine(`=== ${passed ? 'PASS' : 'FAIL'} ===`);
    const message = passed
        ? 'Claude Compatibility Smoke passed. See the output channel and active chat status card.'
        : 'Claude Compatibility Smoke found a problem. See the output channel for details.';
    if (passed) {
        vscode.window.showInformationMessage(message);
    } else {
        vscode.window.showWarningMessage(message);
    }
}

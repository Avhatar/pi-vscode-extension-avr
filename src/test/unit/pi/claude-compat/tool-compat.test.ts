import { describe, expect, it } from 'vitest';
import {
    extractClaudeToolReferences,
    formatClaudeToolCompatibility,
    resolveClaudeToolReference,
} from '../../../../pi/claude-compat/tool-compat';

describe('Claude tool-reference compatibility', () => {
    it('maps Claude built-in capability names only to active Pi tools', () => {
        expect(resolveClaudeToolReference('Read', ['read', 'find'])).toMatchObject({ status: 'mapped', target: 'read' });
        expect(resolveClaudeToolReference('Glob', ['read', 'find'])).toMatchObject({ status: 'mapped', target: 'find' });
        expect(resolveClaudeToolReference('Bash', ['read'])).toMatchObject({ status: 'unavailable' });
    });

    it('maps Claude MCP names to direct tools and falls back to the existing mcp adapter', () => {
        expect(resolveClaudeToolReference('mcp__docs__lookup', ['docs_lookup', 'mcp'])).toMatchObject({
            status: 'mapped',
            target: 'docs_lookup',
        });
        expect(resolveClaudeToolReference('mcp__editor__document_*', ['editor_document_open', 'mcp'])).toMatchObject({
            status: 'mapped',
            target: 'editor_document_open',
        });
        expect(resolveClaudeToolReference('mcp__repo-mcp__search', ['repo_mcp_search', 'mcp'])).toMatchObject({
            status: 'mapped',
            target: 'repo_mcp_search',
        });
        expect(resolveClaudeToolReference('mcp__canvas__place_shape', ['mcp'])).toMatchObject({
            status: 'proxy',
            target: 'mcp',
        });
        expect(resolveClaudeToolReference('mcp__missing__tool', [])).toMatchObject({ status: 'unavailable' });
    });

    it('classifies subagent and Claude-runtime-only tools without emulating them', () => {
        expect(resolveClaudeToolReference('Agent', ['read'])).toMatchObject({ status: 'deferred-agent' });
        expect(resolveClaudeToolReference('Skill', ['read'])).toMatchObject({ status: 'runtime-only' });
        expect(resolveClaudeToolReference('AskUserQuestion', ['read'])).toMatchObject({ status: 'runtime-only' });
    });

    it('extracts explicit body and metadata references and renders an auditable map', () => {
        const references = extractClaudeToolReferences(
            'Use `Read`, `Agent`, and mcp__build__compile.',
            [['Bash', 'mcp__catalog__search']],
        );
        expect(references).toEqual(['mcp__build__compile', 'Read', 'Agent', 'Bash', 'mcp__catalog__search']);
        const rendered = formatClaudeToolCompatibility(references, ['read', 'bash', 'build_compile', 'mcp']);
        expect(rendered).toContain('mcp__build__compile → build_compile [mapped]');
        expect(rendered).toContain('Agent [deferred-agent]');
        expect(rendered).toContain('The mappings do not grant permissions or add tools.');
    });
});

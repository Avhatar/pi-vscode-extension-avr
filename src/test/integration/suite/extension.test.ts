import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {
    test('extension is present', () => {
        const ext = vscode.extensions.getExtension('Avhatar.pi-code')
            ?? vscode.extensions.getExtension('avhatar.pi-code');
        assert.ok(ext, 'Extension should be installed');
    });

    test('commands are registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('pi-code.newChat'), 'newChat command should exist');
        assert.ok(commands.includes('pi-code.abort'), 'abort command should exist');
        assert.ok(commands.includes('pi-code.selectModel'), 'selectModel command should exist');
        assert.ok(commands.includes('pi-code.focusChat'), 'focusChat command should exist');
        assert.ok(commands.includes('pi-code.runSubagentSmokeTest'), 'subagent smoke-test command should exist');
        assert.ok(!commands.includes('pi-code.claudeCompatSmoke'), 'disabled Claude compatibility smoke command should not exist');
        assert.ok(!commands.includes('pi-code.lspSmoke'), 'disabled LSP smoke command should not exist');
    });
});

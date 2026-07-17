import type { SettingsClientMessage, SettingsServerMessage, SettingsData, SkillInfo, OAuthFlowState } from '../shared/protocol';
import { API_KEY_PROVIDERS } from '../shared/providers';

declare function acquireVsCodeApi(): {
    postMessage(message: SettingsClientMessage): void;
    getState(): any;
    setState(state: any): void;
};

const vscode = acquireVsCodeApi();

let currentSettings: SettingsData | null = null;
let loadedSkills: SkillInfo[] = [];
const oauthFlowStates = new Map<string, OAuthFlowState>();

window.addEventListener('message', (event) => {
    const msg = event.data as SettingsServerMessage;
    switch (msg.type) {
        case 'settings':
            currentSettings = msg.data;
            render(msg.data);
            break;
        case 'settingChanged':
            if (currentSettings) {
                (currentSettings as any)[msg.key] = msg.value;
                render(currentSettings);
            }
            break;
        case 'skills':
            loadedSkills = msg.skills;
            renderSkillsSection();
            break;
        case 'oauthState':
            oauthFlowStates.set(msg.providerId, msg.state);
            renderOAuthSection();
            if (msg.state.kind === 'success') {
                showToast(`Signed in successfully.`, 'info');
            } else if (msg.state.kind === 'error') {
                showToast(msg.state.message, 'error');
            }
            break;
        case 'error':
            showToast(msg.message, 'error');
            break;
    }
});

function render(data: SettingsData): void {
    const app = document.getElementById('settings-app')!;
    app.innerHTML = '';

    const container = el('div', 'settings-container');

    const header = el('div', 'settings-header');
    header.innerHTML = `<h1>Pi Code Settings</h1>`;
    container.appendChild(header);

    const configuredSet = new Set(data.configuredProviders ?? []);
    const providerOptions = [
        { value: '', label: 'Auto-detect' },
        ...API_KEY_PROVIDERS.map((p) => ({
            value: p.id,
            label: configuredSet.has(p.id) ? `✓ ${p.label}` : p.label,
        })),
    ];

    container.appendChild(buildSection('API Keys', [
        buildSelect('apiProvider', 'Provider', data.apiProvider, providerOptions,
            'Selects which provider\'s API key the form below manages. The runtime provider is decided by the chosen model — this dropdown only changes which key slot you are editing. A leading ✓ means a key is already saved for that provider.'),
        buildConfiguredProvidersChips(data.configuredProviders ?? []),
        buildApiKeyField(data),
        buildAuthIndicator(data.authMethod),
    ]));

    const oauthSection = buildSection('Sign in with subscription accounts', [buildOAuthPlaceholder()]);
    oauthSection.id = 'oauth-section';
    container.appendChild(oauthSection);

    container.appendChild(buildSection('Default Model & Thinking', [
        buildTextInput('defaultModel', 'Default Model', data.defaultModel,
            'Model ID to use when starting new sessions (e.g. claude-sonnet-4-20250514). Leave empty for automatic.'),
        buildSelect('thinkingLevel', 'Default Thinking Level', data.thinkingLevel, [
            { value: 'off', label: 'Off' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'Extra High' },
            { value: 'max', label: 'Max (GPT-5.6 / adaptive Claude only)' },
        ], 'How verbose the agent\'s chain-of-thought should be by default. Max is only natively supported by GPT-5.6 and adaptive Claude models.'),
    ]));

    container.appendChild(buildSection('Tool Execution', [
        buildTextarea('allowedTools', 'Allowed Tools', data.allowedTools.join(', '),
            'Comma-separated list of tool names to allow (e.g. read, grep, bash). Leave empty to allow all.'),
        buildToggle('mcp.importClaudeCode', 'Import Claude Code MCP servers', data.mcpImportClaudeCode,
            'Expose user-level MCP servers from ~/.claude.json to Pi Code through the bundled MCP adapter. Server definitions and credentials stay in Claude Code\'s config; Pi stores only a managed compatibility import. Existing manual imports are never removed. Applies to new sessions or after Reload Window.'),
        buildToggle('lsp.enabled', 'Language Server tools', data.lspEnabled,
            'Expose Language Server tools (find_references, …) to the agent. Each tool delegates to the active VS Code language extension (C#, rust-analyzer, Pylance, TypeScript, etc.). Turn off to work without LSP — the tools disappear from the system prompt entirely. Applies on new sessions or window reload.'),
    ]));

    container.appendChild(buildSection('ToDo', [
        buildMultilineTextarea(
            'todo.promptGuidelines',
            'ToDo prompt guidelines',
            data.todoPromptGuidelines,
            'Instructions injected into the system prompt for the ToDo tool. One guideline per line. Changes apply to new chat sessions — open a new chat or reload the window for them to take effect. Clear the field (or click Reset) to restore the built-in default.',
            12,
        ),
    ]));

    container.appendChild(buildSection('Subagents', [
        buildToggle('subagents.defaultEnabled', 'Enable for new chats', data.subagentsDefaultEnabled,
            'Expose subagent delegation to new chats by default. Existing chats keep their own persisted opt-in state.'),
        buildTextInput('subagents.defaultModel', 'Default child model', data.subagentsDefaultModel,
            'Canonical provider/id model used after the selected agent definition and before inheriting the parent. Leave empty to inherit.'),
        buildTextarea('subagents.allowedModels', 'Allowed child models', data.subagentsAllowedModels.join(', '),
            'Comma-separated provider/id allowlist. Leave empty to permit every configured model.'),
        buildToggle('subagents.allowInvocationModelOverride', 'Allow per-call model override', data.subagentsAllowInvocationModelOverride,
            'Allow the parent orchestrator to choose an exact child provider/model for each delegation.'),
        buildNumberInput('subagents.defaultMaxTurns', 'Default maximum turns', data.subagentsDefaultMaxTurns, 1, 100,
            'Maximum child turns unless a stricter agent or invocation value is used.'),
        buildNumberInput('subagents.defaultTimeoutMinutes', 'Default timeout (minutes)', data.subagentsDefaultTimeoutMinutes, 1, 120,
            'Child execution timeout unless a stricter agent or invocation value is used.'),
        buildNumberInput('subagents.maxConcurrentGlobal', 'Global concurrent children', data.subagentsMaxConcurrentGlobal, 1, 16,
            'Maximum child agents running across all Pi Code chats. Applies after window reload.'),
        buildNumberInput('subagents.maxConcurrentPerChat', 'Concurrent children per chat', data.subagentsMaxConcurrentPerChat, 1, 8,
            'Maximum children from one parent chat occupying execution slots. Applies to new or reloaded sessions.'),
    ]));

    const skillsSection = buildSection('Skills', [buildSkillsPlaceholder()]);
    skillsSection.id = 'skills-section';
    container.appendChild(skillsSection);

    container.appendChild(buildSection('Chat Appearance', [
        buildColorInput('userMessageGlowColor', 'User Message Glow Color', data.userMessageGlowColor,
            'Color of the subtle glow outline around user messages in the chat.'),
        buildRange('userMessageGlowOpacity', 'User Message Glow Opacity', data.userMessageGlowOpacity, 0, 100,
            `Opacity of the glow around user messages.`),
    ]));

    container.appendChild(buildSection('Keyboard Shortcuts', [
        buildShortcutsInfo(),
    ]));

    app.appendChild(container);
    bindEvents();
    renderSkillsSection();
    renderOAuthSection();
}

function buildSection(title: string, children: HTMLElement[]): HTMLElement {
    const section = el('div', 'settings-section');
    const heading = el('h2', 'section-title');
    heading.textContent = title;
    section.appendChild(heading);
    for (const child of children) {
        section.appendChild(child);
    }
    return section;
}

function buildSelect(key: string, label: string, value: string, options: { value: string; label: string }[], description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <select id="setting-${key}" class="setting-select" data-key="${key}">
            ${options.map(o => `<option value="${escHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}
        </select>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildTextInput(key: string, label: string, value: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escHtml(value)}" placeholder="${escHtml(description.split('.')[0])}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildTextarea(key: string, label: string, value: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="text" id="setting-${key}" class="setting-input" data-key="${key}" value="${escHtml(value)}" placeholder="e.g. read, grep, bash">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildNumberInput(
    key: string,
    label: string,
    value: number,
    min: number,
    max: number,
    description: string,
): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <input type="number" id="setting-${key}" class="setting-input" data-key="${key}" value="${value}" min="${min}" max="${max}" step="1">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

/** Real multi-line textarea. Used for prompt-style settings that span
 *  many lines and need preserved newlines (e.g. ToDo guidelines). */
function buildMultilineTextarea(
    key: string,
    label: string,
    value: string,
    description: string,
    rows: number = 10,
): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
            <button type="button" class="setting-btn secondary" data-reset-key="${key}" title="Reset to the built-in default">Reset</button>
        </div>
        <textarea id="setting-${key}" class="setting-textarea" data-key="${key}" rows="${rows}" spellcheck="false">${escHtml(value)}</textarea>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildToggle(key: string, label: string, value: boolean, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-toggle-row">
            <label class="toggle-label" for="setting-${key}">
                <span class="toggle-switch">
                    <input type="checkbox" id="setting-${key}" data-key="${key}" ${value ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
                <span>${escHtml(label)}</span>
            </label>
        </div>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildRange(key: string, label: string, value: number, min: number, max: number, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
            <span class="range-value" id="range-val-${key}">${value}%</span>
        </div>
        <input type="range" id="setting-${key}" class="setting-range" data-key="${key}" min="${min}" max="${max}" value="${value}">
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildColorInput(key: string, label: string, value: string, description: string): HTMLElement {
    const row = el('div', 'setting-row');
    row.innerHTML = `
        <div class="setting-label-row">
            <label for="setting-${key}">${escHtml(label)}</label>
        </div>
        <div class="setting-color-row">
            <input type="color" id="setting-${key}" class="setting-color" data-key="${key}" value="${escHtml(value)}">
            <input type="text" id="setting-${key}-text" class="setting-input setting-color-text" data-key="${key}" value="${escHtml(value)}" placeholder="#00aaff">
        </div>
        <p class="setting-description">${escHtml(description)}</p>
    `;
    return row;
}

function buildApiKeyField(data: SettingsData): HTMLElement {
    const row = el('div', 'setting-row');
    const provider = data.apiProvider || 'provider';

    if (data.apiKeySet) {
        row.innerHTML = `
            <div class="setting-label-row">
                <label>API Key</label>
                <span class="key-status set">Key stored</span>
            </div>
            <div class="api-key-actions">
                <button class="setting-btn secondary" id="btn-change-key">Change</button>
                <button class="setting-btn danger" id="btn-clear-key">Remove</button>
            </div>
            <p class="setting-description">API key is securely stored and never written to settings files.</p>
        `;
    } else {
        row.innerHTML = `
            <div class="setting-label-row">
                <label for="api-key-input">API Key</label>
                <span class="key-status unset">No key stored</span>
            </div>
            <div class="api-key-input-row">
                <input type="password" id="api-key-input" class="setting-input" placeholder="Enter your API key">
                <button class="setting-btn primary" id="btn-save-key">Save</button>
            </div>
            <p class="setting-description">Securely stored via VS Code SecretStorage. Never written to settings files.</p>
        `;
    }
    return row;
}

function buildConfiguredProvidersChips(configured: string[]): HTMLElement {
    const row = el('div', 'setting-row configured-providers');
    if (configured.length === 0) {
        row.innerHTML = `<p class="setting-description">No API keys saved yet. Pick a provider above and add a key.</p>`;
        return row;
    }
    const labelById = new Map(API_KEY_PROVIDERS.map((p) => [p.id, p.label]));
    const chips = configured
        .map((id) => {
            const label = labelById.get(id) ?? id;
            return `<button type="button" class="provider-chip" data-provider-id="${escapeAttr(id)}" title="Switch to ${escapeAttr(label)}">✓ ${escapeHtml(label)}</button>`;
        })
        .join('');
    row.innerHTML = `
        <label>Saved API keys</label>
        <div class="provider-chips">${chips}</div>
        <p class="setting-description">Click a chip to switch the active provider to it.</p>
    `;
    return row;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function escapeAttr(s: string): string {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

function buildAuthIndicator(method: SettingsData['authMethod']): HTMLElement {
    const row = el('div', 'setting-row auth-indicator');
    const labels: Record<string, string> = {
        env: 'Authenticated via environment variable',
        'pi-login': 'Authenticated via Pi CLI login (~/.pi/agent/)',
        manual: 'Authenticated via stored API key',
        none: 'No credentials detected',
    };
    const icons: Record<string, string> = {
        env: '&#10003;',
        'pi-login': '&#10003;',
        manual: '&#10003;',
        none: '&#10007;',
    };
    const cls = method === 'none' ? 'auth-none' : 'auth-ok';
    row.innerHTML = `
        <div class="auth-status ${cls}">
            <span class="auth-icon">${icons[method]}</span>
            <span>${labels[method]}</span>
        </div>
    `;
    return row;
}

function buildShortcutsInfo(): HTMLElement {
    const row = el('div', 'setting-row shortcuts-info');
    row.innerHTML = `
        <div class="shortcuts-list">
            <div class="shortcut-item"><kbd>Ctrl+Shift+L</kbd><span>Focus chat</span></div>
            <div class="shortcut-item"><kbd>Ctrl+Shift+N</kbd><span>New session</span></div>
            <div class="shortcut-item"><kbd>Escape</kbd><span>Stop generation</span></div>
        </div>
        <p class="setting-description">
            <a href="#" id="btn-open-keybindings">Open Keyboard Shortcuts editor</a> to customize.
        </p>
    `;
    return row;
}

function buildSkillsPlaceholder(): HTMLElement {
    const row = el('div', 'setting-row');
    row.id = 'skills-list';
    row.innerHTML = `<p class="setting-description">Loading skills...</p>`;
    return row;
}

function buildOAuthPlaceholder(): HTMLElement {
    const row = el('div', 'setting-row');
    row.id = 'oauth-list';
    row.innerHTML = `<p class="setting-description">Loading sign-in providers...</p>`;
    return row;
}

const OAUTH_DESCRIPTIONS: Record<string, string> = {
    'openai-codex': 'Use your ChatGPT subscription. Unlocks the GPT-5.6 family and Codex models included with your plan.',
    'anthropic': 'Use your Claude Pro / Max subscription instead of an Anthropic API key.',
    'github-copilot': 'Use your GitHub Copilot subscription as a model provider.',
    'google-gemini-cli': 'Use Google Cloud Code Assist credentials (gemini CLI flow).',
    'google-antigravity': 'Use Antigravity (Gemini 3, Claude, GPT-OSS via Google Cloud).',
};

function renderOAuthSection(): void {
    const container = document.getElementById('oauth-list');
    if (!container) return;

    const providers = currentSettings?.oauthProviders ?? [];
    if (providers.length === 0) {
        container.innerHTML = `<p class="setting-description">No OAuth providers registered by the Pi SDK.</p>`;
        return;
    }

    container.innerHTML = '';
    for (const p of providers) {
        const flow = oauthFlowStates.get(p.id) ?? { kind: 'idle' };
        container.appendChild(buildOAuthCard(p, flow));
    }
    bindOAuthEvents();
}

function buildOAuthCard(p: { id: string; name: string; signedIn: boolean; usesCallbackServer: boolean }, flow: OAuthFlowState): HTMLElement {
    const card = el('div', 'oauth-card');
    const description = OAUTH_DESCRIPTIONS[p.id] ?? '';
    const inProgress = flow.kind === 'starting'
        || flow.kind === 'awaitingSelection'
        || flow.kind === 'awaitingPrompt'
        || flow.kind === 'awaitingBrowser'
        || flow.kind === 'awaitingDeviceCode'
        || flow.kind === 'progress';

    let statusBadge = '';
    if (p.signedIn) {
        statusBadge = `<span class="key-status set">Signed in</span>`;
    } else if (inProgress) {
        statusBadge = `<span class="key-status pending">Signing in...</span>`;
    } else {
        statusBadge = `<span class="key-status unset">Not signed in</span>`;
    }

    let actions = '';
    if (p.signedIn && !inProgress) {
        actions = `<button class="setting-btn danger" data-oauth-logout="${escAttr(p.id)}">Sign out</button>`;
    } else if (inProgress) {
        actions = `<button class="setting-btn secondary" data-oauth-cancel="${escAttr(p.id)}">Cancel</button>`;
    } else {
        actions = `<button class="setting-btn primary" data-oauth-login="${escAttr(p.id)}">Sign in</button>`;
    }

    let flowDetails = '';
    if (flow.kind === 'awaitingSelection') {
        const options = flow.options.map((option) => `
            <button class="setting-btn secondary" data-oauth-select="${escAttr(p.id)}" data-oauth-option="${escAttr(option.id)}">${escHtml(option.label)}</button>
        `).join('');
        flowDetails = `
            <div class="oauth-flow-block">
                <p class="setting-description"><strong>${escHtml(flow.message)}</strong></p>
                <div class="oauth-choice-list">${options}</div>
            </div>
        `;
    } else if (flow.kind === 'awaitingPrompt') {
        flowDetails = `
            <div class="oauth-flow-block">
                <p class="setting-description"><strong>${escHtml(flow.message)}</strong></p>
                <div class="api-key-input-row">
                    <input type="text" class="setting-input" data-oauth-input="${escAttr(p.id)}" data-oauth-allow-empty="${flow.allowEmpty ? 'true' : 'false'}" placeholder="${escAttr(flow.placeholder ?? '')}">
                    <button class="setting-btn primary" data-oauth-submit-input="${escAttr(p.id)}">Continue</button>
                </div>
            </div>
        `;
    } else if (flow.kind === 'awaitingBrowser') {
        const instr = flow.instructions ? `<p class="setting-description">${escHtml(flow.instructions)}</p>` : '';
        const promptMsg = flow.promptForCode?.message ?? '';
        const placeholder = flow.promptForCode?.placeholder ?? 'Paste authorization code';
        flowDetails = `
            <div class="oauth-flow-block">
                <p class="setting-description">A browser window should have opened. If not, <a href="#" data-oauth-open-url="${escAttr(flow.url)}">open this link manually</a>.</p>
                ${instr}
                <p class="setting-description"><strong>${escHtml(promptMsg)}</strong></p>
                <div class="api-key-input-row">
                    <input type="text" class="setting-input" data-oauth-input="${escAttr(p.id)}" data-oauth-allow-empty="false" placeholder="${escAttr(placeholder)}">
                    <button class="setting-btn primary" data-oauth-submit-input="${escAttr(p.id)}">Submit</button>
                </div>
            </div>
        `;
    } else if (flow.kind === 'awaitingDeviceCode') {
        const expiry = flow.expiresInSeconds
            ? `<p class="setting-description">This code expires in about ${Math.max(1, Math.ceil(flow.expiresInSeconds / 60))} minutes.</p>`
            : '';
        flowDetails = `
            <div class="oauth-flow-block">
                <p class="setting-description">Enter this code on the provider's verification page:</p>
                <div class="oauth-device-code">${escHtml(flow.userCode)}</div>
                <div class="oauth-choice-list">
                    <button class="setting-btn primary" data-oauth-open-url="${escAttr(flow.verificationUri)}">Open verification page</button>
                    <button class="setting-btn secondary" data-oauth-copy-code="${escAttr(flow.userCode)}">Copy code</button>
                </div>
                ${expiry}
                <p class="setting-description">Waiting for authentication to complete...</p>
            </div>
        `;
    } else if (flow.kind === 'progress') {
        flowDetails = `<p class="setting-description">${escHtml(flow.message)}</p>`;
    } else if (flow.kind === 'starting') {
        flowDetails = `<p class="setting-description">Starting authentication flow...</p>`;
    } else if (flow.kind === 'error') {
        flowDetails = `<p class="oauth-error-message">${escHtml(flow.message)}</p>`;
    }

    card.innerHTML = `
        <div class="oauth-card-header">
            <div class="oauth-card-name">${escHtml(p.name)}</div>
            ${statusBadge}
        </div>
        ${description ? `<p class="setting-description">${escHtml(description)}</p>` : ''}
        ${flowDetails}
        <div class="oauth-card-actions">${actions}</div>
    `;
    return card;
}

function bindOAuthEvents(): void {
    document.querySelectorAll('[data-oauth-login]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).getAttribute('data-oauth-login')!;
            oauthFlowStates.set(id, { kind: 'starting' });
            renderOAuthSection();
            vscode.postMessage({ type: 'oauthLogin', providerId: id });
        });
    });
    document.querySelectorAll('[data-oauth-logout]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).getAttribute('data-oauth-logout')!;
            vscode.postMessage({ type: 'oauthLogout', providerId: id });
        });
    });
    document.querySelectorAll('[data-oauth-cancel]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).getAttribute('data-oauth-cancel')!;
            vscode.postMessage({ type: 'oauthCancel', providerId: id });
        });
    });
    document.querySelectorAll('[data-oauth-select]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).getAttribute('data-oauth-select')!;
            const optionId = (btn as HTMLElement).getAttribute('data-oauth-option')!;
            vscode.postMessage({ type: 'oauthSelect', providerId: id, optionId });
        });
    });
    document.querySelectorAll('[data-oauth-submit-input]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).getAttribute('data-oauth-submit-input')!;
            submitOAuthInput(id);
        });
    });
    document.querySelectorAll('[data-oauth-input]').forEach((input) => {
        input.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') {
                e.preventDefault();
                const id = (input as HTMLElement).getAttribute('data-oauth-input')!;
                submitOAuthInput(id);
            }
        });
    });
    document.querySelectorAll('[data-oauth-open-url]').forEach((control) => {
        control.addEventListener('click', (e) => {
            e.preventDefault();
            const url = (control as HTMLElement).getAttribute('data-oauth-open-url') ?? '';
            vscode.postMessage({ type: 'oauthOpenUrl', url });
        });
    });
    document.querySelectorAll('[data-oauth-copy-code]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const code = (btn as HTMLElement).getAttribute('data-oauth-copy-code') ?? '';
            navigator.clipboard?.writeText(code).then(
                () => showToast('Device code copied to clipboard.', 'info'),
                () => showToast('Could not copy device code.', 'error'),
            );
        });
    });
}

function submitOAuthInput(providerId: string): void {
    const input = document.querySelector(`[data-oauth-input="${cssEscape(providerId)}"]`) as HTMLInputElement | null;
    if (!input) return;
    const allowEmpty = input.getAttribute('data-oauth-allow-empty') === 'true';
    if (!allowEmpty && !input.value.trim()) {
        showToast('Enter a value first.', 'error');
        return;
    }
    vscode.postMessage({ type: 'oauthSubmitInput', providerId, value: input.value });
}

function cssEscape(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function renderSkillsSection(): void {
    const container = document.getElementById('skills-list');
    if (!container) return;

    if (loadedSkills.length === 0) {
        container.innerHTML = `<p class="setting-description">No skills found. Place <code>SKILL.md</code> files in <code>~/.agents/skills/</code> or workspace <code>.agents/skills/</code>. Legacy Pi locations remain supported.</p>`;
        return;
    }

    container.innerHTML = loadedSkills.map(skill => {
        const invocation = skill.disableModelInvocation
            ? '<span class="skill-badge">manual only</span>'
            : '';
        return `<div class="skill-card">
            <div class="skill-card-header">
                <span class="skill-card-name">/skill:${escHtml(skill.name)}</span>
                ${invocation}
            </div>
            ${skill.description ? `<p class="skill-card-desc">${escHtml(skill.description)}</p>` : ''}
            <p class="skill-card-path">${escHtml(skill.filePath)}</p>
            ${skill.source ? `<span class="skill-card-source">${escHtml(skill.source)}</span>` : ''}
        </div>`;
    }).join('');
}

function bindEvents(): void {
    document.querySelectorAll('.setting-select').forEach((select) => {
        select.addEventListener('change', () => {
            const key = (select as HTMLSelectElement).dataset.key!;
            const value = (select as HTMLSelectElement).value;
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    document.querySelectorAll('.setting-input[data-key]').forEach((input) => {
        let debounce: ReturnType<typeof setTimeout>;
        input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                const key = (input as HTMLInputElement).dataset.key!;
                let value: any = (input as HTMLInputElement).value;
                if (key === 'allowedTools' || key === 'subagents.allowedModels') {
                    value = value.split(',').map((s: string) => s.trim()).filter(Boolean);
                } else if ((input as HTMLInputElement).type === 'number') {
                    value = Number(value);
                }
                vscode.postMessage({ type: 'updateSetting', key, value });
            }, 500);
        });
    });

    document.querySelectorAll('.setting-textarea[data-key]').forEach((textarea) => {
        let debounce: ReturnType<typeof setTimeout>;
        textarea.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                const key = (textarea as HTMLTextAreaElement).dataset.key!;
                const value = (textarea as HTMLTextAreaElement).value;
                vscode.postMessage({ type: 'updateSetting', key, value });
            }, 500);
        });
    });

    document.querySelectorAll('button[data-reset-key]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = (btn as HTMLButtonElement).dataset.resetKey!;
            // Setting value to undefined removes the user's override and
            // VS Code falls back to the package.json default.
            vscode.postMessage({ type: 'updateSetting', key, value: undefined });
        });
    });

    document.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const key = (cb as HTMLInputElement).dataset.key!;
            const value = (cb as HTMLInputElement).checked;
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    document.querySelectorAll('.setting-color').forEach((colorInput) => {
        colorInput.addEventListener('input', () => {
            const key = (colorInput as HTMLInputElement).dataset.key!;
            const value = (colorInput as HTMLInputElement).value;
            const textInput = document.getElementById(`setting-${key}-text`) as HTMLInputElement;
            if (textInput) textInput.value = value;
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    document.querySelectorAll('.setting-color-text').forEach((textInput) => {
        let debounce: ReturnType<typeof setTimeout>;
        textInput.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                const key = (textInput as HTMLInputElement).dataset.key!;
                let value = (textInput as HTMLInputElement).value.trim();
                if (!/^#[0-9a-fA-F]{3,6}$/.test(value)) return;
                const colorInput = document.getElementById(`setting-${key}`) as HTMLInputElement;
                if (colorInput) colorInput.value = value;
                vscode.postMessage({ type: 'updateSetting', key, value });
            }, 500);
        });
    });

    document.querySelectorAll('.setting-range').forEach((range) => {
        range.addEventListener('input', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            const label = document.getElementById(`range-val-${key}`);
            if (label) label.textContent = `${value}%`;
        });
        range.addEventListener('change', () => {
            const key = (range as HTMLInputElement).dataset.key!;
            const value = parseInt((range as HTMLInputElement).value, 10);
            vscode.postMessage({ type: 'updateSetting', key, value });
        });
    });

    const saveKeyBtn = document.getElementById('btn-save-key');
    saveKeyBtn?.addEventListener('click', () => {
        const input = document.getElementById('api-key-input') as HTMLInputElement;
        const key = input?.value?.trim();
        const provider = currentSettings?.apiProvider || '';
        if (!provider) {
            showToast('Select a provider first', 'error');
            return;
        }
        if (!key) {
            showToast('Enter an API key', 'error');
            return;
        }
        vscode.postMessage({ type: 'setApiKey', provider, key });
    });

    const changeKeyBtn = document.getElementById('btn-change-key');
    changeKeyBtn?.addEventListener('click', () => {
        if (currentSettings) {
            currentSettings.apiKeySet = false;
            render(currentSettings);
        }
    });

    const clearKeyBtn = document.getElementById('btn-clear-key');
    clearKeyBtn?.addEventListener('click', () => {
        const provider = currentSettings?.apiProvider || '';
        if (provider) {
            vscode.postMessage({ type: 'clearApiKey', provider });
        }
    });

    document.querySelectorAll<HTMLButtonElement>('.provider-chip[data-provider-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-provider-id') || '';
            if (!id) return;
            vscode.postMessage({ type: 'updateSetting', key: 'apiProvider', value: id });
        });
    });

    const keybindingsLink = document.getElementById('btn-open-keybindings');
    keybindingsLink?.addEventListener('click', (e) => {
        e.preventDefault();
    });
}

let toastTimeout: ReturnType<typeof setTimeout>;

function showToast(message: string, type: 'error' | 'info' = 'info'): void {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = el('div', 'toast');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.className = `toast toast-${type} visible`;
    toast.textContent = message;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast!.classList.remove('visible'), 3000);
}

function el(tag: string, className?: string): HTMLElement {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function escHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

vscode.postMessage({ type: 'getSettings' });
vscode.postMessage({ type: 'getSkills' });

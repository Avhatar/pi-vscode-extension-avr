import { beforeAll, afterAll } from 'vitest';
import type { AgentSession, ModelRegistry } from '@mariozechner/pi-coding-agent';

export const TEST_MODEL_PROVIDER = 'ollama';
export const TEST_MODEL_ID = 'local/Qwen3.6-27B-Coding';

export function getPreferredTestModel(registry: ModelRegistry) {
    return registry.find(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
}

export function getFallbackTestModel(registry: ModelRegistry) {
    const models = registry.getAvailable();
    if (models.length === 0) {
        throw new Error('No models available in test registry');
    }
    return models[0];
}

let _authStorage: any;
let _modelRegistry: ModelRegistry;
let _initialized = false;

export async function initTestInfra() {
    if (_initialized) { return { authStorage: _authStorage, modelRegistry: _modelRegistry }; }

    const { AuthStorage, ModelRegistry } = await import('@mariozechner/pi-coding-agent');
    _authStorage = AuthStorage.create();
    _modelRegistry = ModelRegistry.create(_authStorage);
    _initialized = true;
    return { authStorage: _authStorage, modelRegistry: _modelRegistry };
}

export async function createTestSession(cwd?: string): Promise<AgentSession> {
    const { createAgentSession, SessionManager } = await import('@mariozechner/pi-coding-agent');
    const { authStorage, modelRegistry } = await initTestInfra();

    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));

    const sessionManager = SessionManager.create(tmpDir);
    const { session } = await createAgentSession({
        cwd: tmpDir,
        authStorage,
        modelRegistry,
        sessionManager,
    });

    const model = getPreferredTestModel(modelRegistry);
    if (model) {
        await session.setModel(model);
    }

    return session;
}

export function getModelRegistry(): ModelRegistry {
    if (!_modelRegistry) { throw new Error('Call initTestInfra() first'); }
    return _modelRegistry;
}

beforeAll(async () => {
    await initTestInfra();
}, 30_000);

afterAll(() => {
    _initialized = false;
});

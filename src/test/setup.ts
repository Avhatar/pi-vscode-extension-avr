import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';

export const TEST_MODEL_PROVIDER = 'ollama';
export const TEST_MODEL_ID = 'local/Qwen3.6-27B-Coding';

export function getPreferredTestModel(runtime: ModelRuntime) {
    return runtime.getModel(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
}

export function getFallbackTestModel(runtime: ModelRuntime) {
    const models = runtime.getAvailableSnapshot();
    if (models.length === 0) {
        throw new Error('No models available in test runtime');
    }
    return models[0];
}

let _modelRuntime: ModelRuntime;

export async function initTestInfra() {
    if (_modelRuntime) return { modelRuntime: _modelRuntime };

    const { ModelRuntime: Runtime } = await import('@earendil-works/pi-coding-agent');
    _modelRuntime = await Runtime.create({ allowModelNetwork: false });
    return { modelRuntime: _modelRuntime };
}

export async function createTestSession(cwd?: string): Promise<AgentSession> {
    const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { modelRuntime } = await initTestInfra();

    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const tmpDir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-test-'));

    const sessionManager = SessionManager.create(tmpDir);
    const { session } = await createAgentSession({
        cwd: tmpDir,
        modelRuntime,
        sessionManager,
    });

    const model = getPreferredTestModel(modelRuntime);
    if (model) {
        await session.setModel(model);
    }

    return session;
}

export function getTestModelRuntime(): ModelRuntime {
    if (!_modelRuntime) throw new Error('Call initTestInfra() first');
    return _modelRuntime;
}

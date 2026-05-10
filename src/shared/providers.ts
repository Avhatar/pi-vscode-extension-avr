export interface ApiKeyProvider {
    id: string;
    label: string;
}

export const API_KEY_PROVIDERS: ApiKeyProvider[] = [
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'google', label: 'Google Gemini' },
    { id: 'google-vertex', label: 'Google Vertex AI' },
    { id: 'azure-openai-responses', label: 'Azure OpenAI' },
    { id: 'amazon-bedrock', label: 'Amazon Bedrock' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'qwen', label: 'Qwen (Alibaba DashScope International)' },
    { id: 'qwen-cn', label: 'Qwen (Alibaba DashScope China)' },
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'groq', label: 'Groq' },
    { id: 'cerebras', label: 'Cerebras' },
    { id: 'xai', label: 'xAI (Grok)' },
    { id: 'mistral', label: 'Mistral' },
    { id: 'fireworks', label: 'Fireworks' },
    { id: 'huggingface', label: 'Hugging Face' },
    { id: 'kimi-coding', label: 'Kimi (Moonshot)' },
    { id: 'minimax', label: 'MiniMax' },
    { id: 'minimax-cn', label: 'MiniMax (China)' },
    { id: 'zai', label: 'Z.ai (GLM)' },
    { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway' },
];

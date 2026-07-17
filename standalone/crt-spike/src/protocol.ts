export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'prompt'; text: string }
  | { type: 'abort' };

export type ServerMessage =
  | { type: 'authenticated' }
  | { type: 'ready'; cwd: string; model?: string; sessionId: string; isStreaming: boolean }
  | { type: 'prompt_accepted' }
  | { type: 'abort_accepted' }
  | { type: 'agent_start' }
  | { type: 'agent_settled' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; isError: boolean }
  | { type: 'error'; message: string };

export function parseClientMessage(raw: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || typeof value.type !== 'string') return undefined;

  switch (value.type) {
    case 'auth':
      return typeof value.token === 'string' ? { type: 'auth', token: value.token } : undefined;
    case 'prompt':
      return typeof value.text === 'string' ? { type: 'prompt', text: value.text } : undefined;
    case 'abort':
      return { type: 'abort' };
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

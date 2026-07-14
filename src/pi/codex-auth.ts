const CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';

/** Extract the ChatGPT account id carried by a Codex OAuth access token. */
export function extractCodexAccountId(accessToken: string): string {
    const parts = accessToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid Codex OAuth token');
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
        const auth = payload[CODEX_AUTH_CLAIM];
        const accountId = auth && typeof auth === 'object' && !Array.isArray(auth)
            ? (auth as Record<string, unknown>).chatgpt_account_id
            : undefined;
        if (typeof accountId !== 'string' || accountId.length === 0) {
            throw new Error('Codex OAuth token has no account id');
        }
        return accountId;
    } catch (error) {
        if (error instanceof Error && error.message === 'Codex OAuth token has no account id') throw error;
        throw new Error('Invalid Codex OAuth token payload');
    }
}

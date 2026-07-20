export interface ExternalUrlPort {
    openExternal(url: string): Promise<boolean>;
}

/** Portable URL validation and host-delegation for authentication flows. */
export class ExternalUrlService {
    constructor(private readonly _port: ExternalUrlPort) {}

    async openHttpUrl(url: string): Promise<void> {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error('Authentication links must use HTTP or HTTPS.');
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error('Authentication links must use HTTP or HTTPS.');
        }
        if (!await this._port.openExternal(url)) {
            throw new Error('The host could not open the authentication link.');
        }
    }
}

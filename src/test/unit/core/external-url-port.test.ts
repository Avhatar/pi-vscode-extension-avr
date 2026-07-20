import { describe, expect, it, vi } from 'vitest';
import { ExternalUrlService } from '../../../core/ports/external-url';

describe('portable external URL service', () => {
    it('opens only HTTP and HTTPS URLs through the injected host port', async () => {
        const openExternal = vi.fn(async () => true);
        const service = new ExternalUrlService({ openExternal });

        await service.openHttpUrl('https://example.com/oauth?code=1');
        await service.openHttpUrl('http://127.0.0.1:8080/callback');
        expect(openExternal).toHaveBeenNthCalledWith(1, 'https://example.com/oauth?code=1');
        expect(openExternal).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8080/callback');

        await expect(service.openHttpUrl('file:///secret')).rejects.toThrow(
            'Authentication links must use HTTP or HTTPS.',
        );
        await expect(service.openHttpUrl('not a url')).rejects.toThrow(
            'Authentication links must use HTTP or HTTPS.',
        );
        expect(openExternal).toHaveBeenCalledTimes(2);
    });

    it('reports a host refusal without depending on a host-specific API', async () => {
        const service = new ExternalUrlService({ openExternal: vi.fn(async () => false) });
        await expect(service.openHttpUrl('https://example.com')).rejects.toThrow(
            'The host could not open the authentication link.',
        );
    });
});

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { captureIssueScreenshots } from '../../src/analyzer/issue-screenshot-capture';
import type { TraceRecorder } from '../../src/tracer/trace-recorder';
import type { HostnameResolver } from '../../src/browser/network-safety';

vi.mock('node:fs', () => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn() }));

const publicResolver: HostnameResolver = vi.fn().mockResolvedValue(['104.20.30.40']);

const GITHUB_ATTACHMENT_UUID = 'bf6a7c1d-6d65-4641-9aa8-797e892123f4';

const GITHUB_ASSET_STORAGE_HOST = 'github-production-user-asset-6210df.s3.amazonaws.com';

const TRUSTED_CDN_SCREENSHOT = 'https://cdn.adguardcdn.com/sitereports/example.png';

/**
 * A recorder whose registrations the test inspects.
 *
 * @returns Recorder stand-in with a spied `addArtifact`.
 */
function spyRecorder(): TraceRecorder {
    return { addArtifact: vi.fn() } as unknown as TraceRecorder;
}

describe('captureIssueScreenshots', () => {
    it('captures trusted issue evidence', async () => {
        const fetcher = vi.fn().mockResolvedValue(
            new Response(Buffer.from('image'), {
                status: 200,
                headers: { 'content-type': 'image/png', 'content-length': '5' },
            }),
        );
        const recorder = spyRecorder();

        const matched = await captureIssueScreenshots([{ url: TRUSTED_CDN_SCREENSHOT }], {
            artifactsDir: '/tmp',
            recorder,
            fetcher: fetcher as unknown as typeof fetch,
            resolveHostname: publicResolver,
        });

        expect(matched).toEqual([
            expect.objectContaining({
                issueScreenshotUrl: TRUSTED_CDN_SCREENSHOT,
                liveArtifactId: expect.any(String),
            }),
        ]);
        expect(fetcher).toHaveBeenCalledWith(TRUSTED_CDN_SCREENSHOT, { redirect: 'manual' });
        expect(recorder.addArtifact).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'issue-screenshot', bytes: 5 }),
        );
        expect(writeFileSync).toHaveBeenCalled();
    });

    it('follows a GitHub attachment through its signed storage redirect', async () => {
        const attachmentUrl = `https://github.com/user-attachments/assets/${GITHUB_ATTACHMENT_UUID}`;
        const signedUrl = `https://${GITHUB_ASSET_STORAGE_HOST}/1/${GITHUB_ATTACHMENT_UUID}?X-Amz-Signature=abc`;
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, { status: 302, headers: { location: signedUrl } }),
            )
            .mockResolvedValueOnce(
                new Response(Buffer.from('image'), {
                    status: 200,
                    headers: { 'content-type': 'image/png', 'content-length': '5' },
                }),
            );
        const recorder = spyRecorder();

        const matched = await captureIssueScreenshots([{ url: attachmentUrl }], {
            artifactsDir: '/tmp',
            recorder,
            fetcher: fetcher as unknown as typeof fetch,
            resolveHostname: publicResolver,
        });

        expect(matched).toEqual([
            expect.objectContaining({
                issueScreenshotUrl: attachmentUrl,
                liveArtifactId: expect.any(String),
            }),
        ]);
        expect(recorder.addArtifact).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'issue-screenshot', bytes: 5 }),
        );
        expect(fetcher).toHaveBeenNthCalledWith(1, attachmentUrl, { redirect: 'manual' });
        expect(fetcher).toHaveBeenNthCalledWith(2, signedUrl, { redirect: 'manual' });
    });

    it('refuses a redirect whose target resolves to a private address', async () => {
        const fetcher = vi.fn().mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: 'https://internal.example/image.png' },
            }),
        );
        const recorder = spyRecorder();

        const matched = await captureIssueScreenshots(
            [{ url: `https://github.com/user-attachments/assets/${GITHUB_ATTACHMENT_UUID}` }],
            {
                artifactsDir: '/tmp',
                recorder,
                fetcher: fetcher as unknown as typeof fetch,
                resolveHostname: async (hostname) =>
                    hostname === 'internal.example' ? ['10.0.0.8'] : ['104.20.30.40'],
            },
        );

        expect(matched[0].liveArtifactId).toBeUndefined();
        expect(matched[0].description).toContain('non-public address');
        expect(recorder.addArtifact).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    // The first hop is the only one the reporter-namespace allowlist applies to, and an image
    // suffix does not buy a host into it: extraction's own `isLikelyImageDestination` accepts any
    // `.png` path, and the downloader must not, or a reporter could aim it at any host.
    it.each([
        'http://cdn.adguardcdn.com/sitereports/example.png',
        'https://untrusted.example/screenshot.png',
        'https://evil.example/x.png',
        'https://github.com/AdguardTeam/AdguardFilters/issues/1',
    ])('rejects an unsafe screenshot URL before fetch: %s', async (url) => {
        const fetcher = vi.fn();
        const resolveHostname = vi.fn(publicResolver);

        const matched = await captureIssueScreenshots([{ url }], {
            artifactsDir: '/tmp',
            recorder: spyRecorder(),
            fetcher: fetcher as unknown as typeof fetch,
            resolveHostname,
        });

        expect(matched[0].description).toContain('Download error');
        expect(fetcher).not.toHaveBeenCalled();
        // Refused before the hostname is resolved: the downloader never becomes a DNS probe.
        expect(resolveHostname).not.toHaveBeenCalled();
    });

    it('rejects the trusted hostname when DNS resolves it to a private address', async () => {
        const fetcher = vi.fn();

        const matched = await captureIssueScreenshots([{ url: TRUSTED_CDN_SCREENSHOT }], {
            artifactsDir: '/tmp',
            recorder: spyRecorder(),
            fetcher: fetcher as unknown as typeof fetch,
            resolveHostname: vi.fn().mockResolvedValue(['10.0.0.8']),
        });

        expect(matched[0].description).toContain('non-public address');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each(['text/html', 'image/svg+xml'])(
        'rejects an unsupported screenshot content type: %s',
        async (contentType) => {
            const fetcher = vi.fn().mockResolvedValue(
                new Response('<html>login</html>', {
                    status: 200,
                    headers: { 'content-type': contentType },
                }),
            );
            const recorder = spyRecorder();

            const matched = await captureIssueScreenshots([{ url: TRUSTED_CDN_SCREENSHOT }], {
                artifactsDir: '/tmp',
                recorder,
                fetcher: fetcher as unknown as typeof fetch,
                resolveHostname: publicResolver,
            });

            expect(matched[0].description).toContain('raster image content type');
            expect(recorder.addArtifact).not.toHaveBeenCalled();
        },
    );

    it('stops reading when the screenshot exceeds the byte cap', async () => {
        const fetcher = vi.fn().mockResolvedValue(
            new Response(Buffer.from('12345'), {
                status: 200,
                headers: { 'content-type': 'image/png' },
            }),
        );
        const recorder = spyRecorder();

        const matched = await captureIssueScreenshots([{ url: TRUSTED_CDN_SCREENSHOT }], {
            artifactsDir: '/tmp',
            recorder,
            fetcher: fetcher as unknown as typeof fetch,
            resolveHostname: publicResolver,
            maxBytes: 4,
        });

        expect(matched[0].description).toContain('byte limit');
        expect(recorder.addArtifact).not.toHaveBeenCalled();
    });

    it('refuses a plain-HTTP redirect target', async () => {
        const fetcher = vi.fn().mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: 'http://cdn.adguardcdn.com/sitereports/example.png' },
            }),
        );

        const matched = await captureIssueScreenshots([{ url: TRUSTED_CDN_SCREENSHOT }], {
            artifactsDir: '/tmp',
            recorder: spyRecorder(),
            fetcher: fetcher as unknown as typeof fetch,
            resolveHostname: publicResolver,
        });

        expect(matched[0].description).toContain('https');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

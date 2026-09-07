import { describe, expect, it } from 'vitest';
import { releaseAssets } from '../release-assets';

describe('release assets embedded in the site', () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://github.com/dohc-ai/dohc/releases/download/v1/${name}` });
  const fetchReleases = (releases: unknown) => (async () => Response.json(releases)) as typeof fetch;

  it('prefers a published stable build over drafts and newer prereleases', async () => {
    const stable = [asset('dohc-x64.exe')];
    expect(await releaseAssets(fetchReleases([
      { draft: true, prerelease: false, assets: [asset('draft.exe')] },
      { draft: false, prerelease: true, assets: [asset('beta.exe')] },
      { draft: false, prerelease: false, assets: [] },
      { draft: false, prerelease: false, assets: stable },
    ]))).toEqual(stable);
  });

  it('uses a prerelease when there is no stable build', async () => {
    const beta = [asset('dohc-arm64.dmg')];
    expect(await releaseAssets(fetchReleases([{ draft: false, prerelease: true, assets: beta }]))).toEqual(beta);
  });

  it('keeps releases-page links when no public release is available', async () => {
    expect(await releaseAssets((async () => new Response(null, { status: 404 })) as typeof fetch)).toEqual([]);
    expect(await releaseAssets(fetchReleases([]))).toEqual([]);
  });

  it('allows offline builds and tolerates malformed API responses', async () => {
    expect(await releaseAssets((async () => { throw new Error('offline'); }) as typeof fetch)).toEqual([]);
    expect(await releaseAssets(fetchReleases({ message: 'rate limited' }))).toEqual([]);
  });
});

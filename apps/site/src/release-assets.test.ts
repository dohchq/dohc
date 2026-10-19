import { describe, expect, it } from 'vitest';
import { matchesBuild, releaseAssets } from '../release-assets';

describe('installer matching', () => {
  // The names electron-builder writes for one nightly.
  const nightly = [
    'dohc-0.1.1-nightly.20261019.40.1-win-x64.exe',
    'dohc-0.1.1-nightly.20261019.40.1-win-x64.exe.blockmap',
    'dohc-0.1.1-nightly.20261019.40.1-mac-arm64.dmg',
    'dohc-0.1.1-nightly.20261019.40.1-mac-arm64.zip',
    'dohc-0.1.1-nightly.20261019.40.1-linux-x86_64.AppImage',
    'dohc-0.1.1-nightly.20261019.40.1-linux-amd64.deb',
    'nightly.yml',
    'nightly-linux.yml',
  ];

  it('finds exactly one installer for each download', () => {
    const find = (extension: string, architecture: string) => nightly.filter(matchesBuild(extension, architecture));
    expect(find('.exe', 'x64')).toEqual(['dohc-0.1.1-nightly.20261019.40.1-win-x64.exe']);
    expect(find('.dmg', 'arm64')).toEqual(['dohc-0.1.1-nightly.20261019.40.1-mac-arm64.dmg']);
    expect(find('.deb', 'amd64')).toEqual(['dohc-0.1.1-nightly.20261019.40.1-linux-amd64.deb']);
    expect(find('.appimage', 'x86_64')).toEqual(['dohc-0.1.1-nightly.20261019.40.1-linux-x86_64.AppImage']);
  });

  it('does not take another architecture that contains the name', () => {
    expect(matchesBuild('.dmg', 'arm64')('dohc-0.1.1-mac-x64.dmg')).toBe(false);
    expect(matchesBuild('.appimage', 'x86_64')('dohc-0.1.1-linux-arm64.AppImage')).toBe(false);
  });
});

describe('release asset selection', () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://github.com/dohchq/dohc/releases/download/v1/${name}` });
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

  it('keeps the releases fallback offline and tolerates malformed API responses', async () => {
    expect(await releaseAssets((async () => { throw new Error('offline'); }) as typeof fetch)).toEqual([]);
    expect(await releaseAssets(fetchReleases({ message: 'rate limited' }))).toEqual([]);
  });
});

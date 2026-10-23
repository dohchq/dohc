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

  it('lists stable builds before newer prereleases and skips drafts', async () => {
    expect(await releaseAssets(fetchReleases([
      { draft: true, prerelease: false, assets: [asset('draft.exe')] },
      { draft: false, prerelease: true, assets: [asset('beta.exe')] },
      { draft: false, prerelease: false, assets: [] },
      { draft: false, prerelease: false, assets: [asset('dohc-x64.exe')] },
    ]))).toEqual([asset('dohc-x64.exe'), asset('beta.exe')]);
  });

  it('finds a platform in an older nightly when the newest one lacks it', async () => {
    const assets = await releaseAssets(fetchReleases([
      { draft: false, prerelease: true, assets: [asset('dohc-0.1.1-nightly.2-win-x64.exe')] },
      { draft: false, prerelease: true, assets: [asset('dohc-0.1.1-nightly.1-win-x64.exe'), asset('dohc-0.1.1-nightly.1-mac-arm64.dmg')] },
    ]));
    expect(assets?.find(candidate => matchesBuild('.exe', 'x64')(candidate.name))?.name).toBe('dohc-0.1.1-nightly.2-win-x64.exe');
    expect(assets?.find(candidate => matchesBuild('.dmg', 'arm64')(candidate.name))?.name).toBe('dohc-0.1.1-nightly.1-mac-arm64.dmg');
  });

  it('reports no builds while the repository is private or has no releases', async () => {
    expect(await releaseAssets((async () => new Response(null, { status: 404 })) as typeof fetch)).toEqual([]);
    expect(await releaseAssets(fetchReleases([]))).toEqual([]);
  });

  it('reports no answer when GitHub is unreachable, limits the request, or answers malformed', async () => {
    expect(await releaseAssets((async () => { throw new Error('offline'); }) as typeof fetch)).toBeNull();
    expect(await releaseAssets((async () => new Response(null, { status: 403 })) as typeof fetch)).toBeNull();
    expect(await releaseAssets(fetchReleases({ message: 'rate limited' }))).toBeNull();
  });
});

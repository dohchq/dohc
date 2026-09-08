interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

export async function releaseAssets(fetchRelease: typeof fetch = fetch): Promise<ReleaseAsset[]> {
  try {
    const response = await fetchRelease('https://api.github.com/repos/dohc-ai/dohc/releases?per_page=10', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const releases: Release[] = await response.json();
    const available = releases.filter(release => !release.draft && release.assets?.length);
    return (available.find(release => !release.prerelease) ?? available[0])?.assets ?? [];
  } catch { return []; }
}

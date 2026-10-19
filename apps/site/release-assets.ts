interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

// Installers are named <product>-<version>-<os>-<architecture>.<extension>.
// Each package format spells the architecture its own way: x86_64 for the
// AppImage and amd64 for the .deb.
export function matchesBuild(extension: string, architecture: string): (name: string) => boolean {
  const architecturePattern = new RegExp(`(?:^|[-_])${architecture}(?:[-_.]|$)`, 'i');
  return (name) => name.toLowerCase().endsWith(extension) && architecturePattern.test(name);
}

export async function releaseAssets(fetchRelease: typeof fetch = fetch): Promise<ReleaseAsset[]> {
  try {
    const response = await fetchRelease('https://api.github.com/repos/dohchq/dohc/releases?per_page=10', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const releases: Release[] = await response.json();
    const available = releases.filter(release => !release.draft && release.assets?.length);
    return (available.find(release => !release.prerelease) ?? available[0])?.assets ?? [];
  } catch { return []; }
}

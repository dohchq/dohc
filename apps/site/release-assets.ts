interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

// Installers are named <product>-<version>-<os>-<architecture>.<extension>.
// Each package format spells the architecture its own way: x86_64 for the
// AppImage and amd64 for the .deb.
export function matchesBuild(extension: string, architecture: string): (name: string) => boolean {
  const architecturePattern = new RegExp(`(?:^|[-_])${architecture}(?:[-_.]|$)`, 'i');
  return (name) => name.toLowerCase().endsWith(extension) && architecturePattern.test(name);
}

// Every published installer, stable releases first, newest first within each
// channel, so the first match for a platform is the build to offer. A nightly
// can publish before its macOS files arrive, so an older release can still
// hold the newest build for one platform.
// [] means GitHub answered and has nothing to offer: the repository is not
// public yet, or nothing is published. null means GitHub did not answer, and
// the releases page is the best link left.
export async function releaseAssets(fetchRelease: typeof fetch = fetch): Promise<ReleaseAsset[] | null> {
  try {
    const response = await fetchRelease('https://api.github.com/repos/dohchq/dohc/releases?per_page=10', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 404) return [];
    if (!response.ok) return null;
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) return null;
    const published = (releases as Release[]).filter(release => !release.draft && Array.isArray(release.assets));
    return [
      ...published.filter(release => !release.prerelease),
      ...published.filter(release => release.prerelease),
    ].flatMap(release => release.assets);
  } catch { return null; }
}

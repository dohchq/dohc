// The build writes the star count into the header's GitHub link, so a
// visitor's browser never asks GitHub for it. null means GitHub did not
// answer, and the link shows no count.
export async function githubStars(fetchRepository: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchRepository('https://api.github.com/repos/dohchq/dohc', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const { stargazers_count: stars } = await response.json() as { stargazers_count?: unknown };
    if (typeof stars !== 'number') return null;
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(stars);
  } catch { return null; }
}

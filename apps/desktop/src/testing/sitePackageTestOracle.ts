import type { SitePackageInfo } from "../workspaces/sitePackage";

// Preserve the former listing-based selection as an equivalence oracle. The
// root app ranks below any nested one, as the catalog now does.
export function selectListedSitePackage(path: string, sites: readonly SitePackageInfo[]): SitePackageInfo | null {
  const depth = (root: string) => (root === "." ? 0 : root.length);
  return sites.filter(site => path === site.root || (site.root === "."
    ? !path.startsWith(".dohc/") : path.startsWith(site.root + "/")))
    .sort((a, b) => depth(b.root) - depth(a.root))[0] ?? null;
}

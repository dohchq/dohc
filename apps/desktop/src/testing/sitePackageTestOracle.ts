import type { SitePackageInfo } from "../workspaces/sitePackage";

// Preserve the former listing-based selection as an equivalence oracle.
export function selectListedSitePackage(path: string, sites: readonly SitePackageInfo[]): SitePackageInfo | null {
  return sites.filter(site => path === site.root || (site.root === "."
    ? !path.startsWith(".dohc/") : path.startsWith(site.root + "/")))
    .sort((a, b) => b.root.length - a.root.length)[0] ?? null;
}

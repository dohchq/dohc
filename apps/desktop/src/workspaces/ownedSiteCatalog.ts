import { BUILD_OUTPUT_DIRS, discoverSites, parseDohcSiteConfig, SITE_DISCOVERY_FILE_NAMES } from "@dohc/workspace-core";
import type { SitePreviewMode } from "../ipc/bridgeContract";
import {
  getDetectedSitePackage,
  listSitePackages,
  sourceForFile,
  type SitePackageInfo,
} from "./sitePackage";
import type { OwnedWorkspaceReadPort } from "./ownedWorkspaceReadPort";

export interface OwnedSiteCatalog<Workspace> {
  list(workspace: Workspace): Promise<SitePackageInfo[]>;
  get(
    workspace: Workspace,
    path: string,
    effectiveMode: SitePreviewMode | null | undefined,
  ): Promise<SitePackageInfo | null>;
}

export function createOwnedSiteCatalog<Workspace extends { rootPath: string }>(
  input: {
    reads(
      workspace: Workspace,
    ): OwnedWorkspaceReadPort;
  },
): OwnedSiteCatalog<Workspace> {
  const listOwnedPackages = async (workspace: Workspace) => {
    const reads = input.reads(workspace);
    const searchView = await reads.prepareSearch();
    const listed = searchView.listing ?? (await reads.listFiles());
    return listSitePackages(workspace.rootPath, listed);
  };

  return {
    list: listOwnedPackages,
    async get(workspace, path, effectiveMode) {
      const lookup = await input.reads(workspace).prepareLookup();
      const roots = new Set(["."]);
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
        roots.add(path.slice(0, i));
      }
      roots.add(path);
      const join = (root: string, name: string) => root === "." ? name : `${root}/${name}`;
      const signals = [...roots].flatMap(root => SITE_DISCOVERY_FILE_NAMES.map(name => join(root, name)));
      const found = await lookup.lookupFiles(signals);
      const sources = await Promise.all(found.files.map(file => sourceForFile(workspace.rootPath, file.path)));
      const outputs = [...roots].flatMap(root => BUILD_OUTPUT_DIRS.map(output => join(root, output + "/index.html")));
      for (const source of sources) {
        if (typeof source === "string" || !source.path.endsWith("dohc.json") || !source.body) continue;
        const output = parseDohcSiteConfig(source.body, source.path).config?.build?.output;
        if (output) outputs.push(source.path.slice(0, -"dohc.json".length) + output + "/index.html");
      }
      const artifacts = await lookup.lookupFiles([...new Set(outputs)]);
      const discovery = [...sources, ...artifacts.files.map(file => file.path)];
      discovery.sort((a, b) => (typeof a === "string" ? a : a.path).localeCompare(typeof b === "string" ? b : b.path));
      const candidates = discoverSites(discovery);
      const selected = candidates.filter(site => (site.root || ".") === "." || path === site.root || path.startsWith(site.root + "/"))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (!selected || (!selected.root && path.startsWith(".dohc/"))) return null;
      // The selected app's complete source inventory is part of its result.
      const inventory = await lookup.listFiles({ path: selected.root || "." });
      return getDetectedSitePackage(workspace.rootPath, selected, inventory.files, effectiveMode);
    },
  };
}

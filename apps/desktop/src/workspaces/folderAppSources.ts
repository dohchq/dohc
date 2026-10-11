import { parseDohcSiteConfig, type WorkspaceSiteSource } from "@dohc/workspace-core";
import { matchesFileListingScope, type WorkspaceFileListingScope } from "./workspaceFileListingScope";

export async function readFolderAppSources(folder: string, input: {
  list(scope: WorkspaceFileListingScope): Promise<readonly string[]>;
  source(path: string): Promise<string | WorkspaceSiteSource>;
}): Promise<readonly (string | WorkspaceSiteSource)[]> {
  const sources = new Map<string, string | WorkspaceSiteSource>();
  async function collect(scope: WorkspaceFileListingScope) {
    const paths = (await input.list(scope)).filter(path => matchesFileListingScope(path, scope) && !sources.has(path));
    for (const source of await Promise.all(paths.map(path => input.source(path)))) sources.set(typeof source === "string" ? source : source.path, source);
  }
  await collect({ path: folder, recursive: folder !== "." });
  if (folder === ".") {
    const configSource = sources.get("dohc.json");
    const config = typeof configSource === "object" && configSource.body ? parseDohcSiteConfig(configSource.body).config : null;
    for (const output of new Set(["dist", "build", "out", ...(config?.build?.output ? [config.build.output] : [])])) {
      await collect({ path: output, recursive: true });
    }
  }
  return [...sources.values()];
}

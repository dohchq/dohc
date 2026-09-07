import { basename, dirname, join } from "node:path";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import { startStaticDirectoryPreview } from "../security/staticDirectoryPreview";
import { pluginDataDir } from "./pluginLocalState";
import { pluginIdToSafePath } from "./pluginSourceSnapshot";

export interface PluginPanelPreview {
  url: string;
  stop(): Promise<void>;
  releaseOrigin(): void;
}

type ClearPluginPanelStorage = (options: {
  origin: string;
}) => Promise<void>;

export async function stopPluginPanelPreview(
  panel: PluginPanelPreview,
  clearStorageData: ClearPluginPanelStorage,
  onClearError: (error: unknown) => void,
): Promise<void> {
  try {
    await clearStorageData({ origin: new URL(panel.url).origin });
  } catch (error) {
    onClearError(error);
  }
  try {
    await panel.stop();
  } finally {
    panel.releaseOrigin();
  }
}

export function createPluginPanelPreviewStarter(stateDir: () => string) {
  // Panels serve from the approved, hash-verified snapshot — never from
  // plugin.pluginRoot (live, unverified workspace-folder source) — matching
  // ensurePluginStarted's own hash-verify-before-execute gate: a panel is
  // code from this plugin as much as its process is, and the userData-
  // residency rule applies the same way.
  function pluginSnapshotRoot(workspace: CreatedWorkspace, pluginId: string): string {
    return join(
      pluginDataDir(stateDir(), workspace.rootPath),
      "plugins",
      pluginIdToSafePath(pluginId),
      "snapshot",
    );
  }

  async function startPluginPanelPreview(input: {
    workspace: CreatedWorkspace;
    pluginId: string;
    panel: { entry: string };
  }) {
    const snapshotRoot = pluginSnapshotRoot(input.workspace, input.pluginId);
    const entryPath = join(snapshotRoot, input.panel.entry);
    const handle = await startStaticDirectoryPreview(dirname(entryPath), {
      containmentRoot: snapshotRoot,
      entry: basename(entryPath),
      entryLabel: "plugin panel entry",
    });
    return { url: handle.url, stop: () => handle.stop() };
  }

  return startPluginPanelPreview;
}

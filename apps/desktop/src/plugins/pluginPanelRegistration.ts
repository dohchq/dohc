import { stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { resolveWorkspaceFile } from "../workspaces/workspaceAssets";
import { readPluginManifestFile } from "./pluginManifest";
import type { DohcPluginManifest } from "./pluginManifestSchema";

export interface PluginPanelRegistration {
  pluginRoot: string;
  manifest: DohcPluginManifest;
  panel: NonNullable<DohcPluginManifest["panels"]>[number];
}

function workspaceRelativePluginRoot(
  workspaceRoot: string,
  pluginRoot: string,
): string {
  if (!isAbsolute(pluginRoot)) return pluginRoot;
  const resolved = relative(workspaceRoot, pluginRoot);
  if (resolved.length === 0) return ".";
  if (
    isAbsolute(resolved) ||
    resolved === ".." ||
    resolved.startsWith(`..${sep}`)
  ) {
    throw new Error(`Plugin root escapes the workspace: ${pluginRoot}.`);
  }
  return resolved.replaceAll("\\", "/");
}

export async function loadPluginPanelRegistration(input: {
  workspaceRoot: string;
  pluginRoot: string;
  pluginId: string;
  panelId: string;
}): Promise<PluginPanelRegistration> {
  const requestedRoot = workspaceRelativePluginRoot(
    input.workspaceRoot,
    input.pluginRoot,
  );
  const { realTarget: pluginRoot } = await resolveWorkspaceFile(
    input.workspaceRoot,
    requestedRoot,
    "write",
  );
  if (!(await stat(pluginRoot)).isDirectory()) {
    throw new Error(`Plugin root is not a directory: ${input.pluginRoot}.`);
  }

  const read = await readPluginManifestFile(pluginRoot);
  if (!read.ok) {
    throw new Error(`Plugin manifest is invalid. ${read.diagnostics.join("; ")}`);
  }
  if (read.manifest.name !== input.pluginId) {
    throw new Error(
      `Plugin id "${input.pluginId}" does not match manifest name "${read.manifest.name}".`,
    );
  }
  const panel = read.manifest.panels?.find(
    (candidate) => candidate.id === input.panelId,
  );
  if (!panel) {
    throw new Error(
      `Plugin "${input.pluginId}" does not declare panel "${input.panelId}".`,
    );
  }
  return { pluginRoot, manifest: read.manifest, panel };
}

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DohcPluginManifest } from "@dohc/workspace-contracts/plugin-manifest";
import { formatZodIssues } from "./zodDiagnostics";

export const MAX_PLUGIN_MANIFEST_FILE_BYTES = 256 * 1024;
export const PLUGIN_MANIFEST_FILE_NAME = "dohc-plugin.json";

export type PluginManifestReadResult =
  | { ok: true; manifest: DohcPluginManifest }
  | { ok: false; diagnostics: string[] };

function failure(diagnostic: string): PluginManifestReadResult {
  return { ok: false, diagnostics: [diagnostic] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readPluginManifestFile(
  pluginRoot: string,
): Promise<PluginManifestReadResult> {
  const path = resolve(pluginRoot, PLUGIN_MANIFEST_FILE_NAME);
  let fileStats;
  try {
    fileStats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return failure(`${PLUGIN_MANIFEST_FILE_NAME} was not found at ${path}`);
    }
    return failure(
      `${PLUGIN_MANIFEST_FILE_NAME} at ${path} could not be inspected: ${errorMessage(error)}`,
    );
  }

  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    return failure(
      `${PLUGIN_MANIFEST_FILE_NAME} at ${path} is not a readable file (symlink or directory)`,
    );
  }
  if (fileStats.size > MAX_PLUGIN_MANIFEST_FILE_BYTES) {
    return failure(
      `${PLUGIN_MANIFEST_FILE_NAME} must be 256 KiB (${MAX_PLUGIN_MANIFEST_FILE_BYTES} bytes) or smaller; found ${fileStats.size} bytes.`,
    );
  }

  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    return failure(
      `${PLUGIN_MANIFEST_FILE_NAME} at ${path} could not be read: ${errorMessage(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return failure(
      `${PLUGIN_MANIFEST_FILE_NAME} is not valid JSON: ${errorMessage(error)}`,
    );
  }

  const parsed = DohcPluginManifest.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: formatZodIssues(parsed.error),
    };
  }
  return { ok: true, manifest: parsed.data };
}

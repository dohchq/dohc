import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { formatZodIssues } from "./zodDiagnostics";

/**
 * The one bound on this file, enforced on both sides: a read refuses a file
 * larger than this before parsing it, and a write refuses to produce one.
 *
 * A 500-record count cap used to sit in the schema as well. It rejected
 * otherwise valid work — 501 ordinary plugins serialize to about 222 KB, well
 * inside this limit — on size arithmetic rather than measurement, and it did
 * not bound what it claimed to: a few records with long, heavily escaped
 * plugin ids pass the count and still exceed the byte limit, which then made
 * the file unreadable and took every plugin's state with it. Bounding the
 * bytes directly bounds the thing that actually matters and rejects nothing
 * that fits (#779 round 9 B4).
 */
export const MAX_PLUGIN_LOCAL_STATE_FILE_BYTES = 256 * 1024;

const PluginSourceHash = z.string().regex(
  /^[0-9a-f]{64}$/,
  "must be a 64-character lowercase hex sha256 digest",
);

export const PluginRecord = z.object({
  disabled: z.boolean().optional(),
  approvedHash: PluginSourceHash.optional(),
  installedBaselineHash: PluginSourceHash.optional(),
  // SHA-256 of bundle.mjs at the moment it was last (re)built from approved
  // source — the EXECUTING artifact's own hash, re-checked before every
  // start alongside approvedHash (CERT779: approvedHash alone verified a
  // source tree that never runs; a tampered bundle.mjs with an unchanged
  // source tree previously loaded without detection).
  approvedBundleHash: PluginSourceHash.optional(),
  // The plugins/ directory this record was installed from. Discovery names a
  // plugin from its manifest, so a plugin whose manifest breaks falls back to
  // its directory name and no longer matches the key this record is stored
  // under — "foo" against a record keyed "@scope/bar". That lost the
  // installation, and with it the Uninstall action. The directory is the one
  // identity a broken manifest cannot take away (#779 round 9 B3).
  directoryName: z.string().min(1).max(255).optional(),
}).strict();
export type PluginRecordShape = z.infer<typeof PluginRecord>;

export const PluginLocalState = z.object({
  version: z.literal(1),
  plugins: z.record(
    // Plugin ids are manifest names, whose schema allows at most 214 characters.
    z.string().min(1).max(214, "plugin id must be 214 characters or fewer"),
    PluginRecord,
  ),
}).strict();
export type PluginLocalState = z.infer<typeof PluginLocalState>;

export const DEFAULT_PLUGIN_LOCAL_STATE: PluginLocalState = {
  version: 1,
  plugins: {},
};

export type PluginLocalStateResult =
  | { ok: true; state: PluginLocalState }
  | { ok: false; warning: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadableState(path: string, problem: string): PluginLocalStateResult {
  return {
    ok: false,
    warning: `Plugin local state file at ${path} ${problem}`,
  };
}

// Shared with pluginSourceSnapshot.ts/PluginPipeline.ts: this same hash is
// the per-workspace directory name under userData where every derived
// plugin artifact (snapshot, node_modules, bundle) lives — one canonical
// workspace identity, one place it's computed.
export function workspaceStateKey(workspaceRoot: string): string {
  const resolvedRoot = resolve(workspaceRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch {
    canonicalRoot = resolvedRoot;
  }
  if (process.platform === "win32") canonicalRoot = canonicalRoot.toLowerCase();
  return createHash("sha256").update(canonicalRoot).digest("hex");
}

export function pluginStateFileName(workspaceRoot: string): string {
  return `${workspaceStateKey(workspaceRoot)}.json`;
}

// The single computation for where every derived plugin artifact
// (snapshot, installed node_modules, pnpm store/cache/state, built bundle)
// lives: under the app's own userData, keyed by workspace, never inside the
// workspace folder itself (CERT779 — a workspace-folder-resident bundle is
// sync/mirror-writable and bypasses source hashing entirely).
export function pluginDataDir(stateDir: string, workspaceRoot: string): string {
  return join(resolve(stateDir), "plugin-data", workspaceStateKey(workspaceRoot));
}

function pluginLocalStatePath(stateDir: string, workspaceRoot: string): string {
  return join(stateDir, "plugin-state", pluginStateFileName(workspaceRoot));
}

export async function readPluginLocalState(
  stateDir: string,
  workspaceRoot: string,
): Promise<PluginLocalStateResult> {
  const path = pluginLocalStatePath(stateDir, workspaceRoot);

  let fileStats: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, state: DEFAULT_PLUGIN_LOCAL_STATE };
    }
    return unreadableState(path, `could not be inspected: ${errorMessage(error)}`);
  }

  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    return unreadableState(path, "is not a readable file (symlink or directory).");
  }
  if (fileStats.size > MAX_PLUGIN_LOCAL_STATE_FILE_BYTES) {
    return unreadableState(
      path,
      `must be 256 KiB (${MAX_PLUGIN_LOCAL_STATE_FILE_BYTES} bytes) or smaller; found ${fileStats.size} bytes.`,
    );
  }

  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    return unreadableState(path, `could not be read: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    return unreadableState(path, `is not valid JSON: ${errorMessage(error)}`);
  }

  const parsed = PluginLocalState.safeParse(value);
  if (!parsed.success) {
    const problems = formatZodIssues(parsed.error);
    return unreadableState(path, `does not match its schema: ${problems.join("; ")}`);
  }
  return { ok: true, state: parsed.data };
}

async function writePluginLocalState(
  stateDir: string,
  workspaceRoot: string,
  state: PluginLocalState,
): Promise<void> {
  const path = pluginLocalStatePath(stateDir, workspaceRoot);
  const body = `${JSON.stringify(PluginLocalState.parse(state), null, 2)}\n`;
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_PLUGIN_LOCAL_STATE_FILE_BYTES) {
    throw new Error(
      `Plugin local state for ${path} is ${bytes} bytes with ` +
        `${Object.keys(state.plugins).length} plugin records; the plugin ` +
        `local-state size limit is ${MAX_PLUGIN_LOCAL_STATE_FILE_BYTES} ` +
        "bytes. Uninstall plugins in this workspace to get back under it.",
    );
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, body);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

const stateWriteQueues = new Map<string, Promise<unknown>>();

function queuePluginLocalStateWrite<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const queue = stateWriteQueues.get(path) ?? Promise.resolve();
  const result = queue.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  stateWriteQueues.set(path, settled);
  void settled.then(() => {
    if (stateWriteQueues.get(path) === settled) {
      stateWriteQueues.delete(path);
    }
  });
  return result;
}

export function mutatePluginRecord(
  stateDir: string,
  workspaceRoot: string,
  pluginId: string,
  updater: (
    record: PluginRecordShape | undefined,
  ) => PluginRecordShape | undefined,
): Promise<void> {
  const path = pluginLocalStatePath(stateDir, workspaceRoot);
  return queuePluginLocalStateWrite(path, async () => {
    const result = await readPluginLocalState(stateDir, workspaceRoot);
    if (!result.ok) {
      throw new Error(result.warning);
    }
    const { state } = result;
    const plugins = { ...state.plugins };
    const updatedRecord = updater(plugins[pluginId]);
    if (updatedRecord === undefined) {
      delete plugins[pluginId];
    } else {
      plugins[pluginId] = updatedRecord;
    }
    await writePluginLocalState(stateDir, workspaceRoot, {
      ...state,
      plugins,
    });
  });
}

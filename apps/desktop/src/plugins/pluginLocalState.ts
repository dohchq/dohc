import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";

export const PLUGIN_LOCAL_STATE_FILE = "plugins.local.json";
export const MAX_PLUGIN_LOCAL_STATE_FILE_BYTES = 256 * 1024;

export const PluginLocalState = z.object({
  version: z.literal(1),
  plugins: z.record(
    z.string(),
    z.object({
      disabled: z.boolean().optional(),
      approvedHash: z.string().optional(),
    }).strict(),
  ),
}).strict();
export type PluginLocalState = z.infer<typeof PluginLocalState>;

export const DEFAULT_PLUGIN_LOCAL_STATE: PluginLocalState = {
  version: 1,
  plugins: {},
};

export interface PluginLocalStateResult {
  state: PluginLocalState;
  warning?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadableState(path: string, problem: string): PluginLocalStateResult {
  return {
    state: DEFAULT_PLUGIN_LOCAL_STATE,
    warning: `${PLUGIN_LOCAL_STATE_FILE} at ${path} ${problem}`,
  };
}

async function pluginLocalStatePath(workspaceRoot: string): Promise<string> {
  return join(
    await resolveWorkspaceMetadataDir(workspaceRoot),
    PLUGIN_LOCAL_STATE_FILE,
  );
}

export async function readPluginLocalState(
  workspaceRoot: string,
): Promise<PluginLocalStateResult> {
  let path: string;
  try {
    path = await pluginLocalStatePath(workspaceRoot);
  } catch (error) {
    return unreadableState(
      join(workspaceRoot, ".dohc", PLUGIN_LOCAL_STATE_FILE),
      `could not be resolved: ${errorMessage(error)}`,
    );
  }

  let fileStats: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: DEFAULT_PLUGIN_LOCAL_STATE };
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
    const problems = parsed.error.issues.map((issue) => {
      const issuePath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `${issuePath}: ${issue.message}`;
    });
    return unreadableState(path, `does not match its schema: ${problems.join("; ")}`);
  }
  return { state: parsed.data };
}

async function writePluginLocalState(
  workspaceRoot: string,
  state: PluginLocalState,
): Promise<void> {
  const path = await pluginLocalStatePath(workspaceRoot);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(PluginLocalState.parse(state), null, 2)}\n`,
    );
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

const stateWriteQueues = new Map<string, Promise<unknown>>();

function queuePluginLocalStateWrite<T>(
  workspaceRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  const queue = stateWriteQueues.get(workspaceRoot) ?? Promise.resolve();
  const result = queue.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  stateWriteQueues.set(workspaceRoot, settled);
  void settled.then(() => {
    if (stateWriteQueues.get(workspaceRoot) === settled) {
      stateWriteQueues.delete(workspaceRoot);
    }
  });
  return result;
}

export function setPluginDisabled(
  workspaceRoot: string,
  pluginId: string,
  disabled: boolean,
): Promise<void> {
  return queuePluginLocalStateWrite(workspaceRoot, async () => {
    const { state } = await readPluginLocalState(workspaceRoot);
    await writePluginLocalState(workspaceRoot, {
      ...state,
      plugins: {
        ...state.plugins,
        [pluginId]: {
          ...state.plugins[pluginId],
          disabled,
        },
      },
    });
  });
}

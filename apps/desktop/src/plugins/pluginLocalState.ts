import { createHash, randomUUID } from "node:crypto";
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

export function pluginStateFileName(workspaceRoot: string): string {
  const key = createHash("sha256").update(resolve(workspaceRoot)).digest("hex");
  return `${key}.json`;
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
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
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

export function setPluginDisabled(
  stateDir: string,
  workspaceRoot: string,
  pluginId: string,
  disabled: boolean,
): Promise<void> {
  const path = pluginLocalStatePath(stateDir, workspaceRoot);
  return queuePluginLocalStateWrite(path, async () => {
    const result = await readPluginLocalState(stateDir, workspaceRoot);
    if (!result.ok) {
      throw new Error(result.warning);
    }
    const { state } = result;
    await writePluginLocalState(stateDir, workspaceRoot, {
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

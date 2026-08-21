import { join } from "node:path";
import type { MomentAuthor } from "@dohc/workspace-contracts/engine";
import { recoverOnDiskSegments } from "./pluginCaseRecovery";

async function recoverOnDiskCasing(
  root: string,
  relativePath: string,
  signal: AbortSignal | undefined,
): Promise<{ path: string; fullyRecovered: boolean }> {
  const { segments, fullyRecovered } = await recoverOnDiskSegments(
    root,
    relativePath,
    signal,
  );
  return { path: join(root, ...segments), fullyRecovered };
}

/** The one slice of a workspace engine capture an authored plugin write uses. */
export interface PluginAuthoredWriteCapture {
  writeAuthoredTextFile(
    absolutePath: string,
    text: string,
    author: MomentAuthor,
    options?: { createOnly?: boolean; signal?: AbortSignal },
  ): Promise<void>;
}

/** The slice of PluginPipeline a door-attributed write notifies. */
export interface PluginDoorWritePipeline {
  pluginIdForPath(absolutePath: string): string | null;
  handleDoorWrittenSourceChange(
    pluginId: string,
    write: { absolutePath: string; text: string },
  ): void;
  rekeyDoorWrittenSourceChange(
    pluginId: string,
    from: { absolutePath: string },
    to: { absolutePath: string },
  ): void;
}

export interface PluginAuthoredTextWriterInput {
  platform?: NodeJS.Platform;
  /**
   * Aborts when the calling panel authority goes stale or the plugin's spawn
   * ends. The write must not start after it fires, and the capture receives
   * it so an abort landing mid-flight still cancels the queued write
   * (CERT779L D1: this is the production write path's abort contract, pinned
   * here rather than in a test's stand-in closure).
   */
  signal: AbortSignal | undefined;
  /**
   * Resolves the workspace's engine capture, throwing when the workspace is
   * not writable or its capture is not running.
   */
  requireWritableCapture(): Promise<{
    workspaceRoot: string;
    capture: PluginAuthoredWriteCapture;
  }>;
  /** The workspace's live plugin pipeline, if one is running. */
  pipeline(): PluginDoorWritePipeline | undefined;
}

/**
 * The production writeAuthoredText the plugin SDK host calls (main.ts wires
 * it into invokeWorkspacePluginSdk). After the write lands, a path owned by a
 * plugin is reported to that plugin's pipeline as door-written, carrying the
 * path and the exact text that landed — the plan doc's auto-approve
 * predicate is attribution through the door, not topology, and these bytes
 * are the only ones this write attributes — rather than waiting for the
 * watcher to observe the same write as an unattributed disk change.
 */
export function createPluginAuthoredTextWriter(
  input: PluginAuthoredTextWriterInput,
): (
  path: string,
  text: string,
  options: { overwrite: boolean; author: MomentAuthor },
) => Promise<{ path: string }> {
  return async (path, text, { overwrite, author }) => {
    const platform = input.platform ?? process.platform;
    const { workspaceRoot, capture } = await input.requireWritableCapture();
    if (input.signal?.aborted) {
      throw new Error("Plugin panel is no longer active.");
    }
    const absolutePath = join(workspaceRoot, path);
    await capture.writeAuthoredTextFile(absolutePath, text, author, {
      createOnly: !overwrite,
      signal: input.signal,
    });
    const pipeline = input.pipeline();
    const ownerId = pipeline?.pluginIdForPath(absolutePath);
    if (ownerId && pipeline) {
      pipeline.handleDoorWrittenSourceChange(ownerId, { absolutePath, text });
    }

    let recoveredPath = absolutePath;
    let recoveryComplete = true;
    if (ownerId && (platform === "win32" || platform === "darwin")) {
      const result = await recoverOnDiskCasing(
        workspaceRoot,
        path,
        input.signal,
      );
      recoveredPath = result.path;
      recoveryComplete = result.fullyRecovered;
      if (input.signal?.aborted) {
        throw new Error("Plugin panel is no longer active.");
      }
    }
    if (ownerId && pipeline && recoveryComplete) {
      pipeline.rekeyDoorWrittenSourceChange(
        ownerId,
        { absolutePath },
        { absolutePath: recoveredPath },
      );
    }
    return { path };
  };
}

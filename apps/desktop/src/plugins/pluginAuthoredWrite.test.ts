import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MomentAuthor } from "@dohc/workspace-contracts/engine";
import {
  createPluginAuthoredTextWriter,
  type PluginAuthoredWriteCapture,
} from "./pluginAuthoredWrite";

const author: MomentAuthor = {
  kind: "agent",
  agentId: "plugin:example-plugin",
  onBehalfOf: "local",
  agentRunId: "spawn-1",
};

interface RecordedWrite {
  absolutePath: string;
  text: string;
  options: { createOnly?: boolean; signal?: AbortSignal } | undefined;
}

/**
 * Records what reaches the capture and, like the real engine capture, honors
 * an abort that arrives while the write is queued. It deliberately does NOT
 * re-check `aborted` on entry — the real capture does, but modelling that
 * here would hide the writer's own precheck from the tests below (the
 * production contract is that the writer refuses before the capture is ever
 * asked; CERT779L D1).
 */
function recordingCapture(behavior?: {
  blockUntil?: Promise<void>;
  onEnter?: () => void;
}): {
  capture: PluginAuthoredWriteCapture;
  writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  return {
    writes,
    capture: {
      async writeAuthoredTextFile(absolutePath, text, writeAuthor, options) {
        expect(writeAuthor).toEqual(author);
        behavior?.onEnter?.();
        if (behavior?.blockUntil) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void =>
              reject(new Error("Plugin panel is no longer active."));
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            void behavior.blockUntil?.then(() => {
              options?.signal?.removeEventListener("abort", onAbort);
              resolve();
            });
          });
        }
        writes.push({ absolutePath, text, options });
      },
    },
  };
}

function writerInput(overrides: {
  signal?: AbortSignal;
  workspaceRoot?: string;
  capture: PluginAuthoredWriteCapture;
  pipeline?: {
    pluginIdForPath(absolutePath: string): string | null;
    handleDoorWrittenSourceChange(
      pluginId: string,
      write: { absolutePath: string; text: string },
    ): void;
  };
}) {
  return {
    signal: overrides.signal,
    requireWritableCapture: async () => ({
      workspaceRoot: overrides.workspaceRoot ?? join("C:", "ws"),
      capture: overrides.capture,
    }),
    pipeline: () => overrides.pipeline,
  };
}

describe("createPluginAuthoredTextWriter", () => {
  it("refuses a write whose signal already aborted, before the capture is asked (CERT779L D1)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { capture, writes } = recordingCapture();
    const write = createPluginAuthoredTextWriter(
      writerInput({ signal: controller.signal, capture }),
    );

    await expect(write("note.txt", "must not land\n", { overwrite: true, author }))
      .rejects.toThrow("Plugin panel is no longer active.");
    expect(writes).toEqual([]);
  });

  it("hands the capture its own signal, so an abort in flight still cancels the write (CERT779L D1)", async () => {
    const controller = new AbortController();
    let releaseWrite: () => void = () => undefined;
    let enterWrite: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enterWrite = resolve;
    });
    const { capture, writes } = recordingCapture({
      onEnter: () => enterWrite(),
      blockUntil: new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    });
    const write = createPluginAuthoredTextWriter(
      writerInput({ signal: controller.signal, capture }),
    );

    const pending = write("note.txt", "must not land\n", {
      overwrite: true,
      author,
    });
    // Abort only once the write is already inside the capture — past the
    // writer's own precheck, so ONLY the signal handed to the capture can
    // cancel it from here.
    await entered;
    controller.abort();
    releaseWrite();
    await expect(pending).rejects.toThrow("Plugin panel is no longer active.");
    expect(writes).toEqual([]);
  });

  it("writes under the workspace root and reports an owned path as door-written with its path and bytes (#779 A5, round 14 A1)", async () => {
    const { capture, writes } = recordingCapture();
    const doorWrites: {
      pluginId: string;
      write: { absolutePath: string; text: string };
    }[] = [];
    const workspaceRoot = join("C:", "ws");
    const write = createPluginAuthoredTextWriter(writerInput({
      capture,
      workspaceRoot,
      pipeline: {
        pluginIdForPath: (absolutePath) =>
          absolutePath.startsWith(join(workspaceRoot, "plugins", "owned"))
            ? "owned-plugin"
            : null,
        handleDoorWrittenSourceChange: (pluginId, doorWrite) => {
          // The write must already have landed: the notification carries
          // the path and the exact bytes the pipeline may attribute to
          // this door write — and nothing else.
          expect(writes).toHaveLength(doorWrites.length + 1);
          doorWrites.push({ pluginId, write: doorWrite });
        },
      },
    }));

    const owned = await write(
      join("plugins", "owned", "src", "index.ts"),
      "export {};\n",
      { overwrite: true, author },
    );
    expect(owned).toEqual({ path: join("plugins", "owned", "src", "index.ts") });
    expect(doorWrites).toEqual([{
      pluginId: "owned-plugin",
      write: {
        absolutePath: join(workspaceRoot, "plugins", "owned", "src", "index.ts"),
        text: "export {};\n",
      },
    }]);
    expect(writes[0]).toMatchObject({
      absolutePath: join(workspaceRoot, "plugins", "owned", "src", "index.ts"),
      options: { createOnly: false },
    });

    await write("note.txt", "not plugin source\n", { overwrite: false, author });
    expect(doorWrites).toHaveLength(1);
    expect(writes[1]).toMatchObject({
      absolutePath: join(workspaceRoot, "note.txt"),
      options: { createOnly: true },
    });
  });

  it("does not report a door write when the capture refused the write", async () => {
    const doorWrites: string[] = [];
    const write = createPluginAuthoredTextWriter(writerInput({
      capture: {
        writeAuthoredTextFile: async () => {
          throw new Error("File already exists: note.txt");
        },
      },
      pipeline: {
        pluginIdForPath: () => "owned-plugin",
        handleDoorWrittenSourceChange: (pluginId) => {
          doorWrites.push(pluginId);
        },
      },
    }));

    await expect(write("note.txt", "text\n", { overwrite: false, author }))
      .rejects.toThrow("File already exists");
    expect(doorWrites).toEqual([]);
  });
});

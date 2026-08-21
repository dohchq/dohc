import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MomentAuthor } from "@dohc/workspace-contracts/engine";
import {
  createPluginAuthoredTextWriter,
  type PluginAuthoredWriteCapture,
  type PluginDoorWritePipeline,
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
  landWrite?: boolean;
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
        if (behavior?.landWrite) {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, text);
        }
        writes.push({ absolutePath, text, options });
      },
    },
  };
}

function writerInput(overrides: {
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  workspaceRoot?: string;
  capture: PluginAuthoredWriteCapture;
  pipeline?: PluginDoorWritePipeline;
}) {
  return {
    signal: overrides.signal,
    platform: overrides.platform,
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
    const { capture, writes } = recordingCapture({ landWrite: true });
    const doorWrites: {
      pluginId: string;
      write: { absolutePath: string; text: string };
    }[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-authored-write-"));
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

    try {
      const owned = await write(
        join("plugins", "owned", "src", "index.ts"),
        "export {};\n",
        { overwrite: true, author },
      );
      expect(owned).toEqual({
        path: join("plugins", "owned", "src", "index.ts"),
      });
      expect(doorWrites).toEqual([{
        pluginId: "owned-plugin",
        write: {
          absolutePath: join(
            workspaceRoot,
            "plugins",
            "owned",
            "src",
            "index.ts",
          ),
          text: "export {};\n",
        },
      }]);
      expect(writes[0]).toMatchObject({
        absolutePath: join(
          workspaceRoot,
          "plugins",
          "owned",
          "src",
          "index.ts",
        ),
        options: { createOnly: false },
      });

      await write("note.txt", "not plugin source\n", {
        overwrite: false,
        author,
      });
      expect(doorWrites).toHaveLength(1);
      expect(writes[1]).toMatchObject({
        absolutePath: join(workspaceRoot, "note.txt"),
        options: { createOnly: true },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "keeps a junction workspace root lexical while recovering casing below it",
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "dohc-authored-junction-"));
      const targetRoot = join(tempRoot, "physical-target");
      const workspaceDirectory = join(tempRoot, "registered-workspaces");
      const workspaceRoot = join(workspaceDirectory, "LinkedWorkspace");
      const canonicalPluginRoot = join(workspaceRoot, "plugins", "owned");
      const canonicalPath = join(canonicalPluginRoot, "src", "index.ts");
      const doorWrites: {
        pluginId: string;
        write: { absolutePath: string; text: string };
      }[] = [];

      try {
        await mkdir(join(targetRoot, "plugins", "owned", "src"), {
          recursive: true,
        });
        await mkdir(workspaceDirectory, { recursive: true });
        symlinkSync(targetRoot, workspaceRoot, "junction");
        const { capture } = recordingCapture({ landWrite: true });
        const write = createPluginAuthoredTextWriter(writerInput({
          capture,
          platform: "win32",
          workspaceRoot,
          pipeline: {
            pluginIdForPath: (absolutePath) =>
              absolutePath.startsWith(canonicalPluginRoot)
                ? "owned-plugin"
                : null,
            handleDoorWrittenSourceChange: (pluginId, doorWrite) => {
              doorWrites.push({ pluginId, write: doorWrite });
            },
          },
        }));

        await write(join("PLUGINS", "owned", "SRC", "index.ts"), "text\n", {
          overwrite: true,
          author,
        });

        expect(doorWrites).toEqual([{
          pluginId: "owned-plugin",
          write: { absolutePath: canonicalPath, text: "text\n" },
        }]);
        expect(doorWrites[0]?.write.absolutePath.startsWith(workspaceRoot))
          .toBe(true);
        expect(doorWrites[0]?.write.absolutePath.startsWith(targetRoot))
          .toBe(false);
      } finally {
        await rm(workspaceRoot, { force: true });
        await rm(targetRoot, { recursive: true, force: true });
        await rm(workspaceDirectory, { recursive: true, force: true });
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

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

  it("canonicalizes the reported path when darwin is injected", async () => {
    const { capture } = recordingCapture();
    const reportedPaths: string[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-authored-darwin-"));
    const canonicalPath = join(
      workspaceRoot,
      "plugins",
      "owned",
      "src",
      "newdir",
      "a.ts",
    );

    try {
      await mkdir(dirname(canonicalPath), { recursive: true });
      await writeFile(canonicalPath, "before\n");
      const write = createPluginAuthoredTextWriter(writerInput({
        capture,
        platform: "darwin",
        workspaceRoot,
        pipeline: {
          pluginIdForPath: () => "owned-plugin",
          handleDoorWrittenSourceChange: (_pluginId, doorWrite) => {
            reportedPaths.push(doorWrite.absolutePath);
          },
        },
      }));

      await write(join("plugins", "owned", "SRC", "NewDir", "a.ts"), "text\n", {
        overwrite: true,
        author,
      });

      expect(reportedPaths).toEqual([canonicalPath]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("recovers an NFD on-disk segment from an NFC caller path", async () => {
    const { capture } = recordingCapture();
    const reportedPaths: string[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-authored-unicode-"));
    const decomposedDirectory = "cafe\u0301";
    const composedDirectory = "caf\u00e9";
    const canonicalPath = join(
      workspaceRoot,
      "plugins",
      "owned",
      decomposedDirectory,
      "src",
      "a.ts",
    );

    try {
      await mkdir(dirname(canonicalPath), { recursive: true });
      await writeFile(canonicalPath, "before\n");
      const write = createPluginAuthoredTextWriter(writerInput({
        capture,
        platform: "darwin",
        workspaceRoot,
        pipeline: {
          pluginIdForPath: () => "owned-plugin",
          handleDoorWrittenSourceChange: (_pluginId, doorWrite) => {
            reportedPaths.push(doorWrite.absolutePath);
          },
        },
      }));

      await write(
        join("PLUGINS", "OWNED", composedDirectory, "SRC", "a.ts"),
        "text\n",
        { overwrite: true, author },
      );

      expect(reportedPaths).toEqual([canonicalPath]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("stops case recovery when the panel aborts after the capture lands", async () => {
    const controller = new AbortController();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-authored-abort-"));
    const canonicalPath = join(workspaceRoot, "plugins", "owned", "src", "a.ts");
    const doorWrites: string[] = [];

    try {
      await mkdir(dirname(canonicalPath), { recursive: true });
      const write = createPluginAuthoredTextWriter(writerInput({
        signal: controller.signal,
        platform: "darwin",
        workspaceRoot,
        capture: {
          writeAuthoredTextFile: async (_absolutePath, text) => {
            await writeFile(canonicalPath, text);
            controller.abort();
          },
        },
        pipeline: {
          pluginIdForPath: () => "owned-plugin",
          handleDoorWrittenSourceChange: (_pluginId, doorWrite) => {
            doorWrites.push(doorWrite.absolutePath);
          },
        },
      }));

      await expect(
        write(join("PLUGINS", "OWNED", "SRC", "a.ts"), "text\n", {
          overwrite: true,
          author,
        }),
      ).rejects.toThrow("Plugin panel is no longer active.");
      expect(doorWrites).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("stops after an abort during the final case-recovery read", async () => {
    const controller = new AbortController();
    let enterRead: () => void = () => undefined;
    let releaseRead: (entries: string[]) => void = () => undefined;
    const readEntered = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    const readResult = new Promise<string[]>((resolve) => {
      releaseRead = resolve;
    });
    const readdirMock = vi.fn(async () => {
      enterRead();
      return readResult;
    });
    const handleDoorWrittenSourceChange = vi.fn();
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ readdir: readdirMock }));

    try {
      const { createPluginAuthoredTextWriter: createWriterWithMockedReaddir } =
        await import("./pluginAuthoredWrite");
      const write = createWriterWithMockedReaddir(writerInput({
        signal: controller.signal,
        platform: "darwin",
        capture: recordingCapture().capture,
        pipeline: {
          pluginIdForPath: () => "owned-plugin",
          handleDoorWrittenSourceChange,
        },
      }));

      const pending = write("note.txt", "text\n", {
        overwrite: true,
        author,
      });
      await readEntered;
      controller.abort();
      releaseRead(["note.txt"]);

      await expect(pending).rejects.toThrow(
        "Plugin panel is no longer active.",
      );
      expect(handleDoorWrittenSourceChange).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("reports overlapping writes in their landing order after case recovery", async () => {
    let releaseFirstRead: (entries: string[]) => void = () => undefined;
    const firstReadResult = new Promise<string[]>((resolve) => {
      releaseFirstRead = resolve;
    });
    let readCount = 0;
    const readdirMock = vi.fn(async () => {
      readCount += 1;
      return readCount === 1 ? firstReadResult : ["note.txt"];
    });
    let writeCount = 0;
    let landSecondWrite: () => void = () => undefined;
    const secondWriteLanded = new Promise<void>((resolve) => {
      landSecondWrite = resolve;
    });
    const reportedTexts: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ readdir: readdirMock }));

    try {
      const { createPluginAuthoredTextWriter: createWriterWithMockedReaddir } =
        await import("./pluginAuthoredWrite");
      const write = createWriterWithMockedReaddir(writerInput({
        platform: "darwin",
        capture: {
          writeAuthoredTextFile: async () => {
            writeCount += 1;
            if (writeCount === 2) landSecondWrite();
          },
        },
        pipeline: {
          pluginIdForPath: () => "owned-plugin",
          handleDoorWrittenSourceChange: (_pluginId, doorWrite) => {
            reportedTexts.push(doorWrite.text);
          },
        },
      }));

      const first = write("note.txt", "first\n", {
        overwrite: true,
        author,
      });
      await vi.waitFor(() => expect(readdirMock).toHaveBeenCalledOnce());
      const second = write("note.txt", "second\n", {
        overwrite: true,
        author,
      });
      await secondWriteLanded;
      await Promise.resolve();
      await Promise.resolve();
      releaseFirstRead(["note.txt"]);
      await Promise.all([first, second]);

      expect(readdirMock).toHaveBeenCalledTimes(2);
      expect(reportedTexts).toEqual(["first\n", "second\n"]);
      expect(reportedTexts.at(-1)).toBe("second\n");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("canonicalizes before resolving ownership when darwin is injected", async () => {
    const { capture } = recordingCapture();
    const ownerPaths: string[] = [];
    const doorWrites: {
      pluginId: string;
      write: { absolutePath: string; text: string };
    }[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-authored-owner-"));
    const canonicalPluginRoot = join(workspaceRoot, "plugins", "owned");
    const canonicalPath = join(canonicalPluginRoot, "src", "a.ts");

    try {
      await mkdir(dirname(canonicalPath), { recursive: true });
      await writeFile(canonicalPath, "before\n");
      const write = createPluginAuthoredTextWriter(writerInput({
        capture,
        platform: "darwin",
        workspaceRoot,
        pipeline: {
          pluginIdForPath: (absolutePath) => {
            ownerPaths.push(absolutePath);
            return absolutePath.startsWith(canonicalPluginRoot)
              ? "owned-plugin"
              : null;
          },
          handleDoorWrittenSourceChange: (pluginId, doorWrite) => {
            doorWrites.push({ pluginId, write: doorWrite });
          },
        },
      }));

      await write(join("PLUGINS", "OWNED", "src", "a.ts"), "text\n", {
        overwrite: true,
        author,
      });

      expect(doorWrites).toEqual([{
        pluginId: "owned-plugin",
        write: { absolutePath: canonicalPath, text: "text\n" },
      }]);
      expect(ownerPaths).toEqual([canonicalPath]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps recovered parent casing when a landed path vanishes before reporting", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-authored-vanished-"));
    const canonicalPluginRoot = join(workspaceRoot, "plugins", "owned");
    const vanishedDirectory = join(canonicalPluginRoot, "src", "Vanished");
    const callerPath = join(
      workspaceRoot,
      "PLUGINS",
      "OWNED",
      "SRC",
      "Vanished",
      "a.ts",
    );
    const recoveredPath = join(
      canonicalPluginRoot,
      "src",
      "Vanished",
      "a.ts",
    );
    const doorWrites: {
      pluginId: string;
      write: { absolutePath: string; text: string };
    }[] = [];

    try {
      await mkdir(vanishedDirectory, { recursive: true });
      const write = createPluginAuthoredTextWriter(writerInput({
        platform: "darwin",
        workspaceRoot,
        capture: {
          writeAuthoredTextFile: async (absolutePath, text, writeAuthor) => {
            expect(absolutePath).toBe(callerPath);
            expect(writeAuthor).toEqual(author);
            await writeFile(join(vanishedDirectory, "a.ts"), text);
            await rm(vanishedDirectory, { recursive: true });
          },
        },
        pipeline: {
          pluginIdForPath: (absolutePath) =>
            absolutePath.startsWith(canonicalPluginRoot)
              ? "owned-plugin"
              : null,
          handleDoorWrittenSourceChange: (pluginId, doorWrite) => {
            doorWrites.push({ pluginId, write: doorWrite });
          },
        },
      }));

      await write(join("PLUGINS", "OWNED", "SRC", "Vanished", "a.ts"), "text\n", {
        overwrite: true,
        author,
      });

      expect(doorWrites).toEqual([{
        pluginId: "owned-plugin",
        write: { absolutePath: recoveredPath, text: "text\n" },
      }]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves the caller-spelled path when linux is injected", async () => {
    const { capture } = recordingCapture();
    const reportedPaths: string[] = [];
    const workspaceRoot = join("/tmp", "workspace");
    const write = createPluginAuthoredTextWriter(writerInput({
      capture,
      platform: "linux",
      workspaceRoot,
      pipeline: {
        pluginIdForPath: () => "owned-plugin",
        handleDoorWrittenSourceChange: (_pluginId, doorWrite) => {
          reportedPaths.push(doorWrite.absolutePath);
        },
      },
    }));

    await write(join("plugins", "owned", "SRC", "NewDir", "a.ts"), "text\n", {
      overwrite: true,
      author,
    });

    expect(reportedPaths).toEqual([
      join(workspaceRoot, "plugins", "owned", "SRC", "NewDir", "a.ts"),
    ]);
  });
});

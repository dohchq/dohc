import {
  mkdir,
  readFile,
  readdir,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAtomicTextWriter,
  createOrderedWorkspaceTextWriter,
  mediaTypeForExtension,
  readWorkspaceAsset,
  readWorkspaceText,
  resolveWorkspaceFile,
  restoreWorkspaceText,
  writeWorkspaceAsset,
  writeWorkspaceText,
} from "./workspaceAssets";
import { createTestScratch } from "./testTemp";

// The asset/text serving path is the renderer's ONLY window into workspace
// bytes, so its negative paths are security boundaries: traversal and symlink
// escapes must be refused, and the size caps must hold (one oversized file
// must never freeze the main process or stream unbounded bytes over IPC).

async function makeWorkspace(): Promise<string> {
  const root = join(await createTestScratch("dohc-assets-"), "ws");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "a.md"), "# A\n");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWorkspaceFile containment", () => {
  it("resolves an in-workspace path and refuses traversal/absolute/reserved", async () => {
    const root = await makeWorkspace();
    const ok = await resolveWorkspaceFile(root, "notes/a.md");
    expect(ok.normalized).toBe("notes/a.md");
    for (const evil of ["../outside.md", "/etc/passwd", ".dohc/manifest.json", "%2e%2e/x"]) {
      await expect(resolveWorkspaceFile(root, evil)).rejects.toThrow(/Invalid asset path/);
    }
  });

  it("refuses a symlink that points outside the workspace (real-path containment)", async () => {
    const root = await makeWorkspace();
    const outside = await createTestScratch("dohc-assets-outside-");
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(root, "notes", "link.txt"));
    await expect(resolveWorkspaceFile(root, "notes/link.txt")).rejects.toThrow(
      /escapes the workspace/,
    );
    // And the read paths built on it refuse too — nothing leaks via media/text.
    await expect(readWorkspaceAsset(root, "notes/link.txt")).rejects.toThrow(/escapes the workspace/);
    await expect(readWorkspaceText(root, "notes/link.txt")).rejects.toThrow(/escapes the workspace/);
  });
});

describe("size caps", () => {
  it("refuses to serve an asset above the 64MB cap (sparse file, no real bytes written)", async () => {
    const root = await makeWorkspace();
    const big = join(root, "notes", "huge.png");
    await writeFile(big, "");
    await truncate(big, 64 * 1024 * 1024 + 1);
    await expect(readWorkspaceAsset(root, "notes/huge.png")).rejects.toThrow(/too large to serve/);
  });

  it("refuses an editor write above the 2MB text cap before touching the file", async () => {
    const root = await makeWorkspace();
    await expect(
      writeWorkspaceText(root, "notes/a.md", "x".repeat(2 * 1024 * 1024 + 1)),
    ).rejects.toThrow(/editor limit/);
    // The file is untouched by the refused write.
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("# A\n");
  });

  it("bounded text read truncates instead of buffering an oversized file", async () => {
    const root = await makeWorkspace();
    const big = join(root, "notes", "big.md");
    await writeFile(big, "");
    await truncate(big, 2 * 1024 * 1024 + 10);
    const result = await readWorkspaceText(root, "notes/big.md");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(2 * 1024 * 1024);
  });
});

describe("writeWorkspaceText atomicity + round trip", () => {
  it("writes atomically and reads back exactly what was written", async () => {
    const root = await makeWorkspace();
    await writeWorkspaceText(root, "notes/a.md", "# Edited\n");
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("# Edited\n");
    const back = await readWorkspaceText(root, "notes/a.md");
    expect(back).toEqual({ text: "# Edited\n", truncated: false });
  });

  it("gives same-millisecond atomic writes distinct temp paths", async () => {
    const staged: Array<{ temp: string; text: string }> = [];
    const committed: string[] = [];
    let id = 0;
    const writer = createAtomicTextWriter({
      now: () => 1_000,
      uniqueId: () => String(++id),
      writeFile: async (temp, text) => {
        staged.push({ temp, text });
      },
      rename: async (temp) => {
        committed.push(temp);
      },
      remove: async () => undefined,
    });

    await writer("C:/workspace/notes/a.md", "older");
    await writer("C:/workspace/notes/a.md", "newer");

    expect(staged.map((entry) => entry.text)).toEqual(["older", "newer"]);
    expect(new Set(staged.map((entry) => entry.temp)).size).toBe(2);
    expect(committed).toEqual(staged.map((entry) => entry.temp));
  });

  it("removes the temp file and preserves an atomic write failure", async () => {
    const writes: string[] = [];
    const commits: string[] = [];
    const removed: string[] = [];
    const writeError = new Error("write rejected");
    const writer = createAtomicTextWriter({
      now: () => 1_000,
      uniqueId: () => "fixed-id",
      writeFile: async (_temp, text) => {
        writes.push(text);
        throw writeError;
      },
      rename: async (temp) => {
        commits.push(temp);
      },
      remove: async (temp) => {
        removed.push(temp);
      },
    });

    await expect(writer("C:/workspace/notes/a.md", "rejected")).rejects.toBe(
      writeError,
    );
    expect(writes).toEqual(["rejected"]);
    expect(commits).toHaveLength(0);
    expect(removed).toHaveLength(1);
  });

  it("uses a short sibling temp name for a maximum-length target component", async () => {
    const target = join("C:/workspace/notes", `${"a".repeat(252)}.md`);
    let staged = "";
    const writer = createAtomicTextWriter({
      now: () => 1_000,
      uniqueId: () => "fixed-id",
      writeFile: async (temp) => {
        staged = temp;
      },
      rename: async () => undefined,
      remove: async () => undefined,
    });

    await writer(target, "text");

    expect(dirname(staged)).toBe(dirname(target));
    expect(basename(staged)).not.toContain(basename(target));
    expect(Buffer.byteLength(basename(staged), "utf8")).toBeLessThanOrEqual(255);
  });

  it("preserves invocation order when aliases resolve to the same target", async () => {
    let releaseOlder!: () => void;
    const olderHeld = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    let resolutions = 0;
    const writes: string[] = [];
    const writer = createOrderedWorkspaceTextWriter({
      resolveTarget: async (_rootPath, relativePath) => {
        resolutions += 1;
        if (relativePath === "notes/alias.md") await olderHeld;
        return "C:/workspace/notes/a.md";
      },
      writeTarget: async (_target, text) => {
        writes.push(text);
      },
    });

    const older = writer("C:/workspace", "notes/alias.md", "older");
    await vi.waitFor(() => expect(resolutions).toBe(1));
    const newer = writer("C:/workspace", "notes/a.md", "newer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolutions).toBe(1);

    releaseOlder();
    await Promise.all([older, newer]);

    expect(writes).toEqual(["older", "newer"]);
  });

  it("recovers the same-target alias queue after a rejected write", async () => {
    let releaseOlder!: () => void;
    const olderHeld = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const writes: string[] = [];
    const writer = createOrderedWorkspaceTextWriter({
      resolveTarget: async () => "C:/workspace/notes/a.md",
      writeTarget: async (_target, text) => {
        writes.push(text);
        if (text === "older") {
          await olderHeld;
          throw new Error("write rejected");
        }
      },
    });

    const older = writer("C:/workspace", "notes/alias.md", "older");
    const olderResult = older.catch((error: unknown) => error);
    await vi.waitFor(() => expect(writes).toEqual(["older"]));

    const newer = writer("C:/workspace", "notes/a.md", "newer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toEqual(["older"]);

    releaseOlder();
    await expect(olderResult).resolves.toEqual(new Error("write rejected"));
    await expect(newer).resolves.toBeUndefined();
    expect(writes).toEqual(["older", "newer"]);
  });

  it("keeps distinct targets in one workspace concurrent", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const resolutions: string[] = [];
    const writes: string[] = [];
    const writer = createOrderedWorkspaceTextWriter({
      resolveTarget: async (rootPath, relativePath) => {
        resolutions.push(relativePath);
        return join(rootPath, relativePath);
      },
      writeTarget: async (target) => {
        writes.push(target);
        if (target.endsWith("a.md")) await firstHeld;
      },
    });

    const first = writer("C:/workspace", "notes/a.md", "a");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const second = writer("C:/workspace", "notes/b.md", "b");

    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(resolutions).toEqual(["notes/a.md", "notes/b.md"]);

    releaseFirst();
    await Promise.all([first, second]);
  });

  it("keeps different workspace roots concurrent", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const writer = createOrderedWorkspaceTextWriter({
      resolveTarget: async (rootPath, relativePath) => join(rootPath, relativePath),
      writeTarget: async (target) => {
        started.push(target);
        await held;
      },
    });

    const first = writer("C:/workspace-a", "notes/a.md", "a");
    const second = writer("C:/workspace-b", "notes/b.md", "b");
    await vi.waitFor(() => expect(started).toHaveLength(2));

    release();
    await Promise.all([first, second]);
  });
});

describe("restoreWorkspaceText", () => {
  it("recreates a missing nested file from a history snapshot", async () => {
    const root = await makeWorkspace();

    await restoreWorkspaceText(root, "archive/2026/note.md", "# Restored\n");

    expect(await readFile(join(root, "archive", "2026", "note.md"), "utf8")).toBe(
      "# Restored\n",
    );
  });

  it("overwrites an existing file with the exact snapshot text", async () => {
    const root = await makeWorkspace();

    await restoreWorkspaceText(root, "notes/a.md", "# Before\n");

    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("# Before\n");
  });

  it("keeps same-millisecond contained writes to one target independent", async () => {
    const root = await makeWorkspace();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const asset = writeWorkspaceAsset(
      root,
      "notes/a.md",
      new Uint8Array(20 * 1024 * 1024),
    );
    const restored = restoreWorkspaceText(root, "notes/a.md", "restored");

    await expect(Promise.all([restored, asset])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(["restored".length, 20 * 1024 * 1024]).toContain(
      (await readFile(join(root, "notes", "a.md"))).byteLength,
    );
    expect(await readdir(join(root, "notes"))).toEqual(["a.md"]);
  });

  it("restores a valid long filename without extending its basename for staging", async () => {
    const root = await makeWorkspace();
    const filename = `${"a".repeat(240)}.md`;

    await restoreWorkspaceText(root, `notes/${filename}`, "restored");

    expect(await readFile(join(root, "notes", filename), "utf8")).toBe("restored");
    expect((await readdir(join(root, "notes"))).sort()).toEqual(
      ["a.md", filename].sort(),
    );
  });

  it("preserves primary contained-write errors when cleanup also fails", async () => {
    const renameError = new Error("rename failed");
    const writeError = new Error("exclusive write failed");
    vi.doMock("node:fs/promises", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs/promises")>()),
      open: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => {
          throw writeError;
        }),
      })),
      rename: vi.fn(async () => {
        throw renameError;
      }),
      rm: vi.fn(async () => {
        throw new Error("cleanup busy");
      }),
    }));
    vi.resetModules();
    try {
      const failingWrites = await import("./workspaceAssets");
      const root = await makeWorkspace();

      await expect(
        failingWrites.restoreWorkspaceText(root, "notes/a.md", "restored"),
      ).rejects.toBe(renameError);
      await expect(
        failingWrites.createWorkspaceTextExclusive(root, "notes/new.md", "created"),
      ).rejects.toBe(writeError);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("refuses to restore through a symlinked ancestor outside the workspace", async () => {
    const root = await makeWorkspace();
    const outside = await createTestScratch("dohc-assets-outside-");
    await symlink(outside, join(root, "notes", "outside"));

    await expect(
      restoreWorkspaceText(root, "notes/outside/secret.md", "nope"),
    ).rejects.toThrow(/escapes the workspace/);
  });
});

describe("mediaTypeForExtension", () => {
  it("maps known media types and falls back to octet-stream (never executable)", () => {
    expect(mediaTypeForExtension("a/b.png")).toBe("image/png");
    expect(mediaTypeForExtension("x.PDF")).toBe("application/pdf");
    expect(mediaTypeForExtension("voice.m4a")).toBe("audio/mp4");
    expect(mediaTypeForExtension("app.html")).toBe("application/octet-stream");
    expect(mediaTypeForExtension("script.js")).toBe("application/octet-stream");
  });
});

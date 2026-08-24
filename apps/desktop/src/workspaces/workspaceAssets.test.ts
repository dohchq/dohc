import { rmSync, symlinkSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAtomicTextWriter,
  createOrderedWorkspaceTextAccess,
  createWorkspaceOperationScheduler,
  createWorkspaceTextExclusive,
  mediaTypeForExtension,
  prepareWorkspaceFileRead,
  readWorkspaceText,
  resolveWorkspaceFile,
  restoreWorkspaceText,
  withExclusiveWorkspaceOperation,
  type WorkspaceOperationLease,
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

function contentHash(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const INITIAL_CONTENT_HASH = contentHash("# A\n");

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
    await expect(
      prepareWorkspaceFileRead(root, "notes/link.txt").then((read) =>
        read.readAsset(),
      ),
    ).rejects.toThrow(/escapes the workspace/);
    await expect(readWorkspaceText(root, "notes/link.txt")).rejects.toThrow(/escapes the workspace/);
  });

  it("returns the resolved source path with bytes read through an in-workspace alias", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "notes", "data.csv"), "id,value\n1,canonical\n");
    await symlink(
      join(root, "notes", "data.csv"),
      join(root, "notes", "notes.json"),
    );

    const source = await (
      await prepareWorkspaceFileRead(root, "notes/notes.json")
    ).readAsset();

    expect(source.path).toBe("notes/data.csv");
    expect(source.bytes.toString("utf8")).toBe("id,value\n1,canonical\n");
  });

  it("keeps an asset alias media type from the requested path", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "notes", "blob"), "image bytes");
    await symlink(join(root, "notes", "blob"), join(root, "notes", "cover.png"));

    const source = await (
      await prepareWorkspaceFileRead(root, "notes/cover.png")
    ).readAsset();

    expect(source.path).toBe("notes/blob");
    expect(source.mediaType).toBe("image/png");
  });

  it("keeps verified native-path operations synchronous", async () => {
    const root = await makeWorkspace();
    const prepared = await prepareWorkspaceFileRead(root, "notes/a.md");
    if (false) {
      // @ts-expect-error A verified path must not escape into async work.
      prepared.withVerifiedPathSync(async () => "not allowed");
    }

    const thenable = { then: vi.fn() };
    await expect(
      (prepared.withVerifiedPathSync as unknown as (
        run: () => unknown,
      ) => Promise<unknown>)(() => thenable),
    ).rejects.toThrow(/finish synchronously/i);
    expect(thenable.then).not.toHaveBeenCalled();

    const replacement = join(root, "notes", "replacement.md");
    await writeFile(replacement, "replacement");
    await expect(
      (prepared.withVerifiedPathSync as unknown as (
        run: () => unknown,
      ) => Promise<unknown>)(() => {
        rmSync(join(root, "notes", "a.md"));
        symlinkSync(replacement, join(root, "notes", "a.md"));
        return thenable;
      }),
    ).rejects.toThrow(/file changed/i);
  });
});

describe("size caps", () => {
  it("refuses to serve an asset above the 64MB cap (sparse file, no real bytes written)", async () => {
    const root = await makeWorkspace();
    const big = join(root, "notes", "huge.png");
    await writeFile(big, "");
    await truncate(big, 64 * 1024 * 1024 + 1);
    await expect(
      prepareWorkspaceFileRead(root, "notes/huge.png").then((read) =>
        read.readAsset(),
      ),
    ).rejects.toThrow(/too large to serve/);
  });

  it("refuses an editor write above the 2MB text cap before touching the file", async () => {
    const root = await makeWorkspace();
    await expect(
      writeWorkspaceText(
        root,
        "notes/a.md",
        "x".repeat(2 * 1024 * 1024 + 1),
        INITIAL_CONTENT_HASH,
      ),
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
    expect(result.contentHash).toBeNull();
  });

  it("omits a partial trailing UTF-8 character from a truncated text read", async () => {
    const root = await makeWorkspace();
    const prefix = "x".repeat(2 * 1024 * 1024 - 1);
    await writeFile(join(root, "notes", "big.md"), `${prefix}😀tail`, "utf8");

    const result = await readWorkspaceText(root, "notes/big.md");

    expect(result.truncated).toBe(true);
    expect(result.contentHash).toBeNull();
    expect(result.text.length).toBe(prefix.length);
    expect(result.text.at(-1)).toBe("x");
    expect(result.text).not.toContain("\uFFFD");
  });
});

describe("writeWorkspaceText atomic replacement + optimistic conflicts", () => {
  it("writes atomically and returns the raw UTF-8 hash needed by the next write", async () => {
    const root = await makeWorkspace();
    const before = await readWorkspaceText(root, "notes/a.md");
    expect(before).toEqual({
      text: "# A\n",
      truncated: false,
      contentHash: INITIAL_CONTENT_HASH,
    });
    if (before.truncated) throw new Error("test fixture must be a complete read");

    const edited = "# Café 😀\n";
    const result = await writeWorkspaceText(
      root,
      "notes/a.md",
      edited,
      before.contentHash,
    );

    expect(result).toEqual({ status: "written", contentHash: contentHash(edited) });
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe(edited);
    const back = await readWorkspaceText(root, "notes/a.md");
    expect(back).toEqual({
      text: edited,
      truncated: false,
      contentHash: contentHash(edited),
    });
  });

  it("returns conflict without renaming when the target changed externally", async () => {
    const root = await makeWorkspace();
    const before = await readWorkspaceText(root, "notes/a.md");
    if (before.truncated) throw new Error("test fixture must be a complete read");
    await writeFile(join(root, "notes", "a.md"), "external\n", "utf8");

    const result = await writeWorkspaceText(
      root,
      "notes/a.md",
      "local\n",
      before.contentHash,
    );

    expect(result).toEqual({
      status: "conflict",
      currentContentHash: contentHash("external\n"),
    });
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("external\n");
    expect(await readdir(join(root, "notes"))).toEqual(["a.md"]);
  });

  it("returns a typed missing-target conflict and removes its staged temp", async () => {
    const root = await makeWorkspace();
    const before = await readWorkspaceText(root, "notes/a.md");
    if (before.truncated) throw new Error("test fixture must be a complete read");
    await rm(join(root, "notes", "a.md"));

    await expect(
      writeWorkspaceText(root, "notes/a.md", "local\n", before.contentHash),
    ).resolves.toEqual({ status: "conflict", currentContentHash: null });
    expect(await readdir(join(root, "notes"))).toEqual([]);
  });

  it("rejects a stale token after a successful write without changing the file", async () => {
    const root = await makeWorkspace();
    const first = await writeWorkspaceText(
      root,
      "notes/a.md",
      "first\n",
      INITIAL_CONTENT_HASH,
    );
    expect(first).toEqual({
      status: "written",
      contentHash: contentHash("first\n"),
    });

    await expect(
      writeWorkspaceText(root, "notes/a.md", "stale\n", INITIAL_CONTENT_HASH),
    ).resolves.toEqual({
      status: "conflict",
      currentContentHash: contentHash("first\n"),
    });
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("first\n");
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
      readCurrentContentHash: async () => INITIAL_CONTENT_HASH,
    });

    await writer("C:/workspace/notes/a.md", "older", INITIAL_CONTENT_HASH);
    await writer("C:/workspace/notes/a.md", "newer", INITIAL_CONTENT_HASH);

    expect(staged.map((entry) => entry.text)).toEqual(["older", "newer"]);
    expect(new Set(staged.map((entry) => entry.temp)).size).toBe(2);
    expect(committed).toEqual(staged.map((entry) => entry.temp));
  });

  it("cleans the staged temp without renaming when the content hash changed", async () => {
    const staged: string[] = [];
    const committed: string[] = [];
    const removed: string[] = [];
    const writer = createAtomicTextWriter({
      now: () => 1_000,
      uniqueId: () => "fixed-id",
      writeFile: async (temp) => {
        staged.push(temp);
      },
      rename: async (temp) => {
        committed.push(temp);
      },
      remove: async (temp) => {
        removed.push(temp);
      },
      readCurrentContentHash: async () => contentHash("external"),
    });

    await expect(
      writer("C:/workspace/notes/a.md", "local", INITIAL_CONTENT_HASH),
    ).resolves.toEqual({
      status: "conflict",
      currentContentHash: contentHash("external"),
    });
    expect(staged).toHaveLength(1);
    expect(committed).toHaveLength(0);
    expect(removed).toEqual(staged);
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
      readCurrentContentHash: async () => INITIAL_CONTENT_HASH,
    });

    await expect(
      writer("C:/workspace/notes/a.md", "rejected", INITIAL_CONTENT_HASH),
    ).rejects.toBe(writeError);
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
      readCurrentContentHash: async () => INITIAL_CONTENT_HASH,
    });

    await writer(target, "text", INITIAL_CONTENT_HASH);

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
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async (_rootPath, relativePath) => {
        resolutions += 1;
        if (relativePath === "notes/alias.md") await olderHeld;
        return "C:/workspace/notes/a.md";
      },
      readTarget: async () => ({
        text: "",
        truncated: false,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      writeTarget: async (_target, text) => {
        writes.push(text);
        return { status: "written" as const, contentHash: contentHash(text) };
      },
    });

    const older = access.write(
      "C:/workspace",
      "notes/alias.md",
      "older",
      INITIAL_CONTENT_HASH,
    );
    await vi.waitFor(() => expect(resolutions).toBe(1));
    const newer = access.write(
      "C:/workspace",
      "notes/a.md",
      "newer",
      INITIAL_CONTENT_HASH,
    );
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
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async () => "C:/workspace/notes/a.md",
      readTarget: async () => ({
        text: "",
        truncated: false,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      writeTarget: async (_target, text) => {
        writes.push(text);
        if (text === "older") {
          await olderHeld;
          throw new Error("write rejected");
        }
        return { status: "written" as const, contentHash: contentHash(text) };
      },
    });

    const older = access.write(
      "C:/workspace",
      "notes/alias.md",
      "older",
      INITIAL_CONTENT_HASH,
    );
    const olderResult = older.catch((error: unknown) => error);
    await vi.waitFor(() => expect(writes).toEqual(["older"]));

    const newer = access.write(
      "C:/workspace",
      "notes/a.md",
      "newer",
      INITIAL_CONTENT_HASH,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toEqual(["older"]);

    releaseOlder();
    await expect(olderResult).resolves.toEqual(new Error("write rejected"));
    await expect(newer).resolves.toEqual({
      status: "written",
      contentHash: contentHash("newer"),
    });
    expect(writes).toEqual(["older", "newer"]);
  });

  it("keeps distinct targets in one workspace concurrent", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const resolutions: string[] = [];
    const writes: string[] = [];
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async (rootPath, relativePath) => {
        resolutions.push(relativePath);
        return join(rootPath, relativePath);
      },
      readTarget: async () => ({
        text: "",
        truncated: false,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      writeTarget: async (target) => {
        writes.push(target);
        if (target.endsWith("a.md")) await firstHeld;
        return { status: "written" as const, contentHash: INITIAL_CONTENT_HASH };
      },
    });

    const first = access.write(
      "C:/workspace",
      "notes/a.md",
      "a",
      INITIAL_CONTENT_HASH,
    );
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const second = access.write(
      "C:/workspace",
      "notes/b.md",
      "b",
      INITIAL_CONTENT_HASH,
    );

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
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async (rootPath, relativePath) => join(rootPath, relativePath),
      readTarget: async () => ({
        text: "",
        truncated: false,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      writeTarget: async (target) => {
        started.push(target);
        await held;
        return { status: "written" as const, contentHash: INITIAL_CONTENT_HASH };
      },
    });

    const first = access.write(
      "C:/workspace-a",
      "notes/a.md",
      "a",
      INITIAL_CONTENT_HASH,
    );
    const second = access.write(
      "C:/workspace-b",
      "notes/b.md",
      "b",
      INITIAL_CONTENT_HASH,
    );
    await vi.waitFor(() => expect(started).toHaveLength(2));

    release();
    await Promise.all([first, second]);
  });

  it("orders a read behind an already-admitted write to the same target", async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let disk = "before";
    let reads = 0;
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async () => "C:/workspace/notes/a.md",
      readTarget: async () => {
        reads += 1;
        return {
          text: disk,
          truncated: false as const,
          contentHash: contentHash(disk),
        };
      },
      writeTarget: async (_target, text) => {
        markWriteStarted();
        await writeHeld;
        disk = text;
        return { status: "written" as const, contentHash: contentHash(text) };
      },
    });

    const writing = access.write(
      "C:/workspace",
      "notes/a.md",
      "after",
      contentHash("before"),
    );
    await writeStarted;
    const reading = access.read("C:/workspace", "notes/a.md");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(0);

    releaseWrite();
    await expect(writing).resolves.toEqual({
      status: "written",
      contentHash: contentHash("after"),
    });
    await expect(reading).resolves.toEqual({
      text: "after",
      truncated: false,
      contentHash: contentHash("after"),
    });
  });

  it("orders an alias write behind an already-admitted read of the same target", async () => {
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const operations: string[] = [];
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async () => "C:/workspace/notes/a.md",
      readTarget: async () => {
        operations.push("read");
        markReadStarted();
        await readHeld;
        return {
          text: "before",
          truncated: false as const,
          contentHash: contentHash("before"),
        };
      },
      writeTarget: async (_target, text) => {
        operations.push(`write:${text}`);
        return { status: "written" as const, contentHash: contentHash(text) };
      },
    });

    const reading = access.read("C:/workspace", "notes/alias.md");
    await readStarted;
    const writing = access.write(
      "C:/workspace",
      "notes/a.md",
      "after",
      contentHash("before"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(operations).toEqual(["read"]);

    releaseRead();
    await expect(reading).resolves.toEqual({
      text: "before",
      truncated: false,
      contentHash: contentHash("before"),
    });
    await expect(writing).resolves.toEqual({
      status: "written",
      contentHash: contentHash("after"),
    });
    expect(operations).toEqual(["read", "write:after"]);
  });

  it("recovers the target queue after a rejected read", async () => {
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const writes: string[] = [];
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async () => "C:/workspace/notes/a.md",
      readTarget: async () => {
        markReadStarted();
        await readHeld;
        throw new Error("read rejected");
      },
      writeTarget: async (_target, text) => {
        writes.push(text);
        return { status: "written" as const, contentHash: contentHash(text) };
      },
    });

    const reading = access.read("C:/workspace", "notes/a.md");
    const readResult = reading.catch((error: unknown) => error);
    await readStarted;
    const writing = access.write(
      "C:/workspace",
      "notes/alias.md",
      "after",
      contentHash("before"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toEqual([]);

    releaseRead();
    await expect(readResult).resolves.toEqual(new Error("read rejected"));
    await expect(writing).resolves.toEqual({
      status: "written",
      contentHash: contentHash("after"),
    });
    expect(writes).toEqual(["after"]);
  });

  it("does not let later shared work pass a queued exclusive workspace operation", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const operations: string[] = [];
    const scheduler = createWorkspaceOperationScheduler();

    const first = scheduler.shared("C:/workspace", async () => {
      operations.push("shared:first:start");
      await firstHeld;
      operations.push("shared:first:end");
    });
    await vi.waitFor(() => expect(operations).toEqual(["shared:first:start"]));
    const exclusive = scheduler.exclusive("C:/workspace", async () => {
      operations.push("exclusive");
    });
    const later = scheduler.shared("C:/workspace", async () => {
      operations.push("shared:later");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(operations).toEqual(["shared:first:start"]);

    releaseFirst();
    await Promise.all([first, exclusive, later]);
    expect(operations).toEqual([
      "shared:first:start",
      "shared:first:end",
      "exclusive",
      "shared:later",
    ]);
  });

  it("rejects a leased target order for the wrong root or after admission ends", async () => {
    const scheduler = createWorkspaceOperationScheduler();
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async (rootPath, relativePath) => join(rootPath, relativePath),
      readTarget: async () => ({
        text: "",
        truncated: false,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      writeTarget: async () => ({
        status: "written" as const,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      scheduler,
    });
    let escapedLease!: WorkspaceOperationLease;

    await scheduler.exclusive("C:/workspace", async (_markChanged, lease) => {
      escapedLease = lease;
      await expect(
        access.orderedOnResolvedTargetInLease(
          "C:/other-workspace",
          lease,
          "C:/other-workspace/notes/a.md",
          async () => "wrong-root",
        ),
      ).rejects.toThrow(
        "Workspace operation lease is inactive or belongs to another root.",
      );
      await expect(
        access.orderedOnResolvedTargetInLease(
          "C:/workspace",
          lease,
          "C:/workspace/notes/a.md",
          async () => "ordered",
        ),
      ).resolves.toBe("ordered");
    });

    await expect(
      access.orderedOnResolvedTargetInLease(
        "C:/workspace",
        escapedLease,
        "C:/workspace/notes/a.md",
        async () => "late",
      ),
    ).rejects.toThrow(
      "Workspace operation lease is inactive or belongs to another root.",
    );
  });

  it("keeps leased target work behind an ordinary order on the same target", async () => {
    const rootPath = "C:/workspace";
    const resolvedTarget = "C:/workspace/notes/a.md";
    const scheduler = createWorkspaceOperationScheduler();
    const access = createOrderedWorkspaceTextAccess({
      resolveTarget: async (root, relativePath) => join(root, relativePath),
      readTarget: async () => ({
        text: "",
        truncated: false,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      writeTarget: async () => ({
        status: "written" as const,
        contentHash: INITIAL_CONTENT_HASH,
      }),
      scheduler,
    });
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    let markLeasedAdmitted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const leasedAdmitted = new Promise<void>((resolve) => {
      markLeasedAdmitted = resolve;
    });
    const order: string[] = [];

    const first = access.orderedOnResolvedTarget(
      rootPath,
      resolvedTarget,
      async () => {
        order.push("first:start");
        markFirstStarted();
        await firstHeld;
        order.push("first:end");
      },
    );
    await firstStarted;
    const leased = scheduler.staleSensitiveShared(rootPath, async (lease) => {
      markLeasedAdmitted();
      return access.orderedOnResolvedTargetInLease(
        rootPath,
        lease,
        resolvedTarget,
        async () => {
          order.push("leased");
        },
      );
    });
    await leasedAdmitted;

    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, leased]);
    expect(order).toEqual(["first:start", "first:end", "leased"]);
  });

  it("holds later direct-text reads and writes behind an exclusive workspace operation", async () => {
    const root = await makeWorkspace();
    let releaseExclusive!: () => void;
    let markExclusiveStarted!: () => void;
    const exclusiveHeld = new Promise<void>((resolve) => {
      releaseExclusive = resolve;
    });
    const exclusiveStarted = new Promise<void>((resolve) => {
      markExclusiveStarted = resolve;
    });
    const exclusive = withExclusiveWorkspaceOperation(root, async () => {
      markExclusiveStarted();
      await exclusiveHeld;
    });
    await exclusiveStarted;

    let writeSettled = false;
    let readSettled = false;
    const writing = writeWorkspaceText(
      root,
      "notes/a.md",
      "after\n",
      INITIAL_CONTENT_HASH,
    ).finally(() => {
      writeSettled = true;
    });
    const reading = readWorkspaceText(root, "notes/a.md").finally(() => {
      readSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect({ writeSettled, readSettled }).toEqual({
      writeSettled: false,
      readSettled: false,
    });

    releaseExclusive();
    await exclusive;
    await expect(writing).resolves.toEqual({
      status: "written",
      contentHash: contentHash("after\n"),
    });
    await expect(reading).resolves.toEqual({
      text: "after\n",
      truncated: false,
      contentHash: contentHash("after\n"),
    });
  });

  it("resumes restore and exclusive-create text writes after a failed exclusive operation", async () => {
    const root = await makeWorkspace();
    const mutationError = new Error("move rejected");
    let releaseExclusive!: () => void;
    let markExclusiveStarted!: () => void;
    const exclusiveHeld = new Promise<void>((resolve) => {
      releaseExclusive = resolve;
    });
    const exclusiveStarted = new Promise<void>((resolve) => {
      markExclusiveStarted = resolve;
    });
    const exclusiveResult = withExclusiveWorkspaceOperation(root, async () => {
      markExclusiveStarted();
      await exclusiveHeld;
      throw mutationError;
    }).catch((error: unknown) => error);
    await exclusiveStarted;

    const restoring = restoreWorkspaceText(root, "notes/a.md", "restored\n");
    const creating = createWorkspaceTextExclusive(root, "notes/new.md", "created\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("# A\n");
    await expect(readFile(join(root, "notes", "new.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    releaseExclusive();
    await expect(exclusiveResult).resolves.toBe(mutationError);
    await Promise.all([restoring, creating]);
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("restored\n");
    expect(await readFile(join(root, "notes", "new.md"), "utf8")).toBe("created\n");
  });

  it("rejects late restore and exclusive-create writes after a successful folder move", async () => {
    const root = await makeWorkspace();
    let releaseMove!: () => void;
    let markMoveStarted!: () => void;
    const moveHeld = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moving = withExclusiveWorkspaceOperation(root, async () => {
      markMoveStarted();
      await moveHeld;
      await rename(join(root, "notes"), join(root, "moved-notes"));
    });
    await moveStarted;

    const restoreResult = restoreWorkspaceText(
      root,
      "notes/a.md",
      "restored\n",
    ).catch((error: unknown) => error);
    const createResult = createWorkspaceTextExclusive(
      root,
      "notes/new.md",
      "created\n",
    ).catch((error: unknown) => error);
    releaseMove();
    await moving;

    await expect(restoreResult).resolves.toMatchObject({
      name: "WorkspaceOperationSupersededError",
      message: "A file or folder changed before this write started. Try the action again.",
    });
    await expect(createResult).resolves.toMatchObject({
      name: "WorkspaceOperationSupersededError",
      message: "A file or folder changed before this write started. Try the action again.",
    });
    await expect(readdir(join(root, "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, "moved-notes"))).toEqual(["a.md"]);
  });

  it("rejects a late asset write after a successful folder move without recreating the source", async () => {
    const root = await makeWorkspace();
    let releaseMove!: () => void;
    let markMoveStarted!: () => void;
    const moveHeld = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moving = withExclusiveWorkspaceOperation(root, async () => {
      markMoveStarted();
      await moveHeld;
      await rename(join(root, "notes"), join(root, "moved-notes"));
    });
    await moveStarted;

    let assetSettled = false;
    const assetResult = writeWorkspaceAsset(
      root,
      "notes/image.png",
      new Uint8Array([1, 2, 3]),
    )
      .catch((error: unknown) => error)
      .finally(() => {
        assetSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(assetSettled).toBe(false);

    releaseMove();
    await moving;
    await expect(assetResult).resolves.toMatchObject({
      name: "WorkspaceOperationSupersededError",
      message: "A file or folder changed before this write started. Try the action again.",
    });
    await expect(readdir(join(root, "notes"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, "moved-notes"))).toEqual(["a.md"]);
  });

  it("resumes a late asset write after a failed exclusive operation", async () => {
    const root = await makeWorkspace();
    const mutationError = new Error("move rejected");
    let releaseMove!: () => void;
    let markMoveStarted!: () => void;
    const moveHeld = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moveResult = withExclusiveWorkspaceOperation(root, async () => {
      markMoveStarted();
      await moveHeld;
      throw mutationError;
    }).catch((error: unknown) => error);
    await moveStarted;

    let assetSettled = false;
    const asset = writeWorkspaceAsset(
      root,
      "notes/image.png",
      new Uint8Array([1, 2, 3]),
    ).finally(() => {
      assetSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(assetSettled).toBe(false);

    releaseMove();
    await expect(moveResult).resolves.toBe(mutationError);
    await asset;
    expect(await readFile(join(root, "notes", "image.png"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("releases a failed exclusive operation so a late draft reaches the unchanged path", async () => {
    const root = await makeWorkspace();
    const mutationError = new Error("move rejected");
    let releaseExclusive!: () => void;
    let markExclusiveStarted!: () => void;
    const exclusiveHeld = new Promise<void>((resolve) => {
      releaseExclusive = resolve;
    });
    const exclusiveStarted = new Promise<void>((resolve) => {
      markExclusiveStarted = resolve;
    });
    const mutationResult = withExclusiveWorkspaceOperation(root, async () => {
      markExclusiveStarted();
      await exclusiveHeld;
      throw mutationError;
    }).catch((error: unknown) => error);
    await exclusiveStarted;

    let writeSettled = false;
    const lateWrite = writeWorkspaceText(
      root,
      "notes/a.md",
      "late draft\n",
      INITIAL_CONTENT_HASH,
    ).finally(() => {
      writeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeSettled).toBe(false);
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("# A\n");

    releaseExclusive();
    await expect(mutationResult).resolves.toBe(mutationError);
    await expect(lateWrite).resolves.toEqual({
      status: "written",
      contentHash: contentHash("late draft\n"),
    });
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("late draft\n");
  });

  it("makes a late old-path write conflict after an exclusive move without recreating the source", async () => {
    const root = await makeWorkspace();
    let releaseMove!: () => void;
    let markMoveStarted!: () => void;
    const moveHeld = new Promise<void>((resolve) => {
      releaseMove = resolve;
    });
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve;
    });
    const moving = withExclusiveWorkspaceOperation(root, async () => {
      markMoveStarted();
      await moveHeld;
      await rename(join(root, "notes", "a.md"), join(root, "notes", "renamed.md"));
    });
    await moveStarted;

    let writeSettled = false;
    const lateWrite = writeWorkspaceText(
      root,
      "notes/a.md",
      "late draft\n",
      INITIAL_CONTENT_HASH,
    ).finally(() => {
      writeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeSettled).toBe(false);

    releaseMove();
    await moving;
    await expect(lateWrite).resolves.toEqual({
      status: "conflict",
      currentContentHash: null,
    });
    await expect(readFile(join(root, "notes", "a.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, "notes", "renamed.md"), "utf8")).toBe("# A\n");
    expect(await readdir(join(root, "notes"))).toEqual(["renamed.md"]);
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

describe("containment of '..'-prefixed names", () => {
  it("writes an asset into a directory whose NAME starts with '..'", async () => {
    // MUTATION (..-segment): a bare "..-prefix" isInside refuses this real contained name.
    const root = await makeWorkspace();
    await writeWorkspaceAsset(root, "..cache/pixel.png", new Uint8Array([1, 2, 3]));
    expect(
      new Uint8Array(await readFile(join(root, "..cache", "pixel.png"))),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
});

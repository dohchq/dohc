import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addBoundaryCrossing,
  addFileChanges,
  createChangeSet,
  createLocalChangeAuthor,
  type ChangeSet,
} from "@dohc/workspace-core";
import {
  createChangeSetStore,
  humanSummary,
  type HistoryRecord,
} from "./changeSetStore";

const userAuthor = { kind: "user" as const, userId: "user-1" };
const localAuthor = createLocalChangeAuthor("Local file edit");
const agentAuthor = {
  kind: "agent" as const,
  agentId: "codex-local",
  onBehalfOf: "Maya",
};

let root: string;
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
const hasAnchoredHistoryMutation = process.platform === "linux";
const describeAnchoredHistory = hasAnchoredHistoryMutation ? describe : describe.skip;
const itLinux = process.platform === "linux" ? it : it.skip;

function historyLockPaths(token: string) {
  const historyDir = join(root, ".dohc", "history");
  const lockDir = join(historyDir, "index.json.lock");
  const ownerDir = join(lockDir, token);
  const ownerPath = join(ownerDir, "owner.json");
  return { historyDir, lockDir, ownerDir, ownerPath };
}

async function writeHistoryLockOwner(input: {
  token: string;
  pid: number;
  createdAtMs: number;
  heartbeatAtMs: number;
}) {
  const paths = historyLockPaths(input.token);
  await mkdir(paths.ownerDir, { recursive: true });
  await writeFile(
    paths.ownerPath,
    `${JSON.stringify({
      token: input.token,
      pid: input.pid,
      createdAtMs: input.createdAtMs,
      heartbeatAtMs: input.heartbeatAtMs,
    })}\n`,
    "utf8",
  );
  return paths;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-history-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function userEdit(): ChangeSet {
  return addFileChanges(
    createChangeSet({
      kind: "user-edit",
      author: userAuthor,
      summary: "Edited today's notes",
      provenance: { source: "user-edit" },
    }),
    [{ path: "notes/today.md", operation: "write" }],
  );
}

function agentImport(): ChangeSet {
  const files = Array.from({ length: 18 }, (_, i) => ({
    path: `finance/import/file-${i}.csv`,
    operation: "write" as const,
  }));
  return addFileChanges(
    createChangeSet({
      kind: "import",
      author: agentAuthor,
      summary: "Imported transactions",
      provenance: { source: "import", importPath: "/tmp/transactions" },
    }),
    files,
  );
}

function historyRecord(id: string, set: ChangeSet, recordedAtMs = 1000): HistoryRecord {
  return {
    id,
    recordedAtMs,
    kind: set.kind,
    author: set.author,
    summary: set.summary,
    files: set.files,
    boundaryCrossings: set.boundaryCrossings,
    ...(set.provenance ? { provenance: set.provenance } : {}),
  };
}

describeAnchoredHistory("changeSetStore persistence", () => {
  it("writes an inspectable JSON file under .dohc/history and round-trips via get", async () => {
    const store = createChangeSetStore(root);
    const recorded = await store.record(userEdit(), {
      id: "abc",
      recordedAtMs: 1000,
    });

    // The per-record file is plain, pretty JSON anyone can open and read.
    const historyDir = join(root, ".dohc", "history");
    const entries = await readdir(historyDir);
    const recordFile = entries.find((name) => name === "1000-abc.json");
    expect(recordFile).toBeDefined();

    const raw = await readFile(join(historyDir, recordFile!), "utf8");
    // Pretty-printed (indented), inspectable JSON — not a packed blob.
    expect(raw).toContain("\n  ");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe("abc");
    expect(parsed.kind).toBe("user-edit");

    const got = await store.get("abc");
    expect(got).not.toBeNull();
    expect(got).toEqual(recorded);
    expect(got!.files).toHaveLength(1);
    expect(got!.author).toEqual(userAuthor);
    expect(got!.provenance).toEqual({ source: "user-edit" });
  });

  it("returns null from get for an unknown id", async () => {
    const store = createChangeSetStore(root);
    expect(await store.get("nope")).toBeNull();
  });

  it("rejects unsafe history ids before they can become filenames", async () => {
    const store = createChangeSetStore(root);
    await expect(
      store.record(userEdit(), { id: "../escape", recordedAtMs: 1000 }),
    ).rejects.toThrow(/invalid history record id/i);
    await expect(store.get("../escape")).rejects.toThrow(/invalid history record id/i);
  });

  it("rejects unsafe record timestamps before they can become filenames", async () => {
    const store = createChangeSetStore(root);
    for (const [index, recordedAtMs] of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ].entries()) {
      await expect(
        store.record(userEdit(), { id: `bad-time-${index}`, recordedAtMs }),
      ).rejects.toThrow(/invalid history record timestamp/i);
    }
    await expect(store.list()).resolves.toEqual([]);
  });

  it("rejects reserved history namespace path segments", async () => {
    expect(() => createChangeSetStore(root, { namespace: "" })).toThrow(
      /invalid history namespace/i,
    );
    expect(() => createChangeSetStore(root, { namespace: "." })).toThrow(
      /invalid history namespace/i,
    );
    expect(() => createChangeSetStore(root, { namespace: ".." })).toThrow(
      /invalid history namespace/i,
    );
  });

  it("isolates namespaced history from default history lock basenames", async () => {
    const namespaced = createChangeSetStore(root, { namespace: "index.json.lock" });
    await namespaced.record(userEdit(), { id: "namespaced", recordedAtMs: 1000 });

    await expect(
      readdir(join(root, ".dohc", "history", "namespaces", "index.json.lock")),
    ).resolves.toContain("1000-namespaced.json");

    const defaultStore = createChangeSetStore(root);
    await defaultStore.record(userEdit(), { id: "default", recordedAtMs: 2000 });
    await expect(defaultStore.list()).resolves.toHaveLength(1);
  });

  it("rejects history storage that links outside the workspace", async () => {
    const outsideDohc = await mkdtemp(join(tmpdir(), "dohc-history-outside-dohc-"));
    const outsideHistory = await mkdtemp(join(tmpdir(), "dohc-history-outside-history-"));
    const outsideLock = await mkdtemp(join(tmpdir(), "dohc-history-outside-lock-"));
    const outsideNamespace = await mkdtemp(join(tmpdir(), "dohc-history-outside-namespace-"));
    try {
      await symlink(outsideDohc, join(root, ".dohc"), directoryLinkType);
      await expect(
        createChangeSetStore(root).record(userEdit(), { id: "escaped-dohc", recordedAtMs: 1000 }),
      ).rejects.toThrow(/outside the workspace root/i);
      await expect(readdir(outsideDohc)).resolves.toEqual([]);

      await rm(join(root, ".dohc"), { recursive: true, force: true });
      await mkdir(join(root, ".dohc"), { recursive: true });
      await symlink(outsideHistory, join(root, ".dohc", "history"), directoryLinkType);
      await expect(
        createChangeSetStore(root).record(userEdit(), {
          id: "escaped-history",
          recordedAtMs: 2000,
        }),
      ).rejects.toThrow(/outside the workspace root/i);
      await expect(readdir(outsideHistory)).resolves.toEqual([]);

      await rm(join(root, ".dohc"), { recursive: true, force: true });
      await mkdir(join(root, ".dohc", "history"), { recursive: true });
      await symlink(
        outsideLock,
        join(root, ".dohc", "history", "index.json.lock"),
        directoryLinkType,
      );
      await expect(
        createChangeSetStore(root).record(userEdit(), {
          id: "escaped-lock",
          recordedAtMs: 3000,
        }),
      ).rejects.toThrow(/outside the workspace root/i);
      await expect(readdir(outsideLock)).resolves.toEqual([]);

      await rm(join(root, ".dohc"), { recursive: true, force: true });
      await mkdir(join(root, ".dohc", "history", "namespaces"), { recursive: true });
      await symlink(
        outsideNamespace,
        join(root, ".dohc", "history", "namespaces", "team"),
        directoryLinkType,
      );
      await expect(
        createChangeSetStore(root, { namespace: "team" }).record(userEdit(), {
          id: "escaped-namespace",
          recordedAtMs: 4000,
        }),
      ).rejects.toThrow(/outside the workspace root/i);
      await expect(readdir(outsideNamespace)).resolves.toEqual([]);
    } finally {
      await rm(outsideDohc, { recursive: true, force: true });
      await rm(outsideHistory, { recursive: true, force: true });
      await rm(outsideLock, { recursive: true, force: true });
      await rm(outsideNamespace, { recursive: true, force: true });
    }
  });

  it("lists the timeline newest first", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });
    await store.record(userEdit(), { id: "third", recordedAtMs: 3000 });

    const timeline = await store.list();
    expect(timeline.map((r) => r.id)).toEqual(["third", "second", "first"]);
    // Each listed record is the full record read back from its own file.
    expect(timeline[1].files).toHaveLength(18);
    expect(timeline[1].kind).toBe("import");
  });

  it("lists display-ordered records with their durable append index", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });
    await store.record(userEdit(), { id: "third", recordedAtMs: 3000 });

    const indexed = await store.listIndexed();
    expect(indexed.map((entry) => entry.record.id)).toEqual(["third", "second", "first"]);
    expect(indexed.map((entry) => entry.index)).toEqual([2, 1, 0]);
  });

  it("reports the max recorded timestamp from the durable index", async () => {
    const store = createChangeSetStore(root);
    await expect(store.maxRecordedAtMs()).resolves.toBe(0);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });
    await store.record(userEdit(), { id: "third", recordedAtMs: 3000 });

    await expect(store.maxRecordedAtMs()).resolves.toBe(3000);
  });

  it("rejects stale or equal recorded timestamps after the durable index advances", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });

    await expect(
      store.record(agentImport(), { id: "same-timestamp", recordedAtMs: 1000 }),
    ).rejects.toThrow(/not newer than the latest committed timestamp/i);
    await expect(
      store.record(userEdit(), { id: "clock-skewed", recordedAtMs: 999 }),
    ).rejects.toThrow(/not newer than the latest committed timestamp/i);

    await expect(store.list()).resolves.toMatchObject([{ id: "first" }]);
    await expect(store.maxRecordedAtMs()).resolves.toBe(1000);
  });

  it("appends to an ordered index.json carrying lightweight summaries", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "first", recordedAtMs: 1000 });
    await store.record(agentImport(), { id: "second", recordedAtMs: 2000 });

    const indexPath = join(root, ".dohc", "history", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    expect(Array.isArray(index)).toBe(true);
    expect(index).toHaveLength(2);
    const entry = index.find((e: { id: string }) => e.id === "second");
    expect(entry).toMatchObject({
      id: "second",
      recordedAtMs: 2000,
      kind: "import",
      summary: "Imported transactions",
      fileCount: 18,
    });
    expect(entry.author).toEqual(agentAuthor);
  });

  it("records carry kind, author, provenance, and boundary crossings", async () => {
    const store = createChangeSetStore(root);
    const set = addBoundaryCrossing(agentImport(), "external-export");
    const recorded = await store.record(set, { id: "x", recordedAtMs: 5000 });
    expect(recorded.kind).toBe("import");
    expect(recorded.author).toEqual(agentAuthor);
    expect(recorded.provenance).toEqual({
      source: "import",
      importPath: "/tmp/transactions",
    });
    expect(recorded.boundaryCrossings).toContain("external-export");

    const got = await store.get("x");
    expect(got!.boundaryCrossings).toContain("external-export");
  });

  it("snapshots caller-owned change sets before recording", async () => {
    const store = createChangeSetStore(root);
    const set = userEdit();
    const record = store.record(set, { id: "snapshotted", recordedAtMs: 1000 });
    set.summary = "Mutated after record call";
    set.files[0]!.path = "notes/mutated-in-place.md";
    set.files[0] = { path: "notes/mutated.md", operation: "delete" };
    set.boundaryCrossings.push("public-share");

    await expect(record).resolves.toMatchObject({
      summary: "Edited today's notes",
      files: [{ path: "notes/today.md", operation: "write" }],
      boundaryCrossings: [],
    });
    await expect(store.get("snapshotted")).resolves.toMatchObject({
      summary: "Edited today's notes",
      files: [{ path: "notes/today.md", operation: "write" }],
      boundaryCrossings: [],
    });
  });

  it("rejects duplicate history ids without appending a second record", async () => {
    const store = createChangeSetStore(root);
    await store.record(userEdit(), { id: "duplicate", recordedAtMs: 1000 });

    await expect(
      store.record(agentImport(), { id: "duplicate", recordedAtMs: 2000 }),
    ).rejects.toThrow(/already exists/);
    await expect(store.list()).resolves.toHaveLength(1);
    await expect(store.get("duplicate")).resolves.toMatchObject({
      summary: "Edited today's notes",
    });
  });

  it("uses an ephemeral fallback when unsupported platforms disable recording", async () => {
    await createChangeSetStore(root).record(userEdit(), {
      id: "persisted-before-unsupported",
      recordedAtMs: 1000,
    });

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    try {
      const durableReadStore = createChangeSetStore(root);
      await expect(durableReadStore.list()).resolves.toMatchObject([
        { id: "persisted-before-unsupported" },
      ]);
      await expect(durableReadStore.get("persisted-before-unsupported")).resolves.toMatchObject({
        summary: "Edited today's notes",
      });
      await expect(
        durableReadStore.record(userEdit(), { id: "unsupported-record", recordedAtMs: 2000 }),
      ).rejects.toThrow(/not supported/);

      const store = createChangeSetStore(root, { ephemeralIfUnsupported: true });

      await expect(store.list()).resolves.toEqual([]);
      await expect(store.get("persisted-before-unsupported")).resolves.toBeNull();
      await expect(
        store.record(userEdit(), { id: "ephemeral-record", recordedAtMs: 2000 }),
      ).resolves.toMatchObject({ id: "ephemeral-record" });
      await expect(
        store.record(userEdit(), { id: "stale-ephemeral", recordedAtMs: 2000 }),
      ).rejects.toThrow(/not newer than the latest committed timestamp/i);
      await expect(store.list()).resolves.toMatchObject([{ id: "ephemeral-record" }]);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("migrates legacy persisted site history values while reading records", async () => {
    const legacyBuildKind = ["app", "build"].join("-");
    const legacyTrustBoundary = ["app", "trust"].join("-");
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "legacy-site",
            recordedAtMs: 1000,
            kind: legacyBuildKind,
            author: agentAuthor,
            summary: "Legacy site build",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-legacy-site.json"),
      `${JSON.stringify(
        {
          id: "legacy-site",
          recordedAtMs: 1000,
          kind: legacyBuildKind,
          author: agentAuthor,
          summary: "Legacy site build",
          files: [{ path: "sites/client/dist/index.html", operation: "write" }],
          provenance: { source: legacyBuildKind },
          boundaryCrossings: [legacyTrustBoundary],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    await expect(store.get("legacy-site")).resolves.toMatchObject({
      id: "legacy-site",
      kind: "site-build",
      provenance: { source: "site-build" },
      boundaryCrossings: ["site-publish"],
    });
    await expect(store.list()).resolves.toMatchObject([
      {
        id: "legacy-site",
        kind: "site-build",
        provenance: { source: "site-build" },
        boundaryCrossings: ["site-publish"],
      },
    ]);
    await expect(store.listIndexed()).resolves.toMatchObject([
      {
        record: {
          id: "legacy-site",
          kind: "site-build",
          provenance: { source: "site-build" },
          boundaryCrossings: ["site-publish"],
        },
      },
    ]);
  });

  it("rejects unknown persisted history enum values instead of type-casting them", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "corrupt",
            recordedAtMs: 1000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Corrupt record",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-corrupt.json"),
      `${JSON.stringify(
        {
          id: "corrupt",
          recordedAtMs: 1000,
          kind: "made-up-kind",
          author: userAuthor,
          summary: "Corrupt record",
          files: [{ path: "notes/today.md", operation: "write" }],
          boundaryCrossings: ["also-made-up"],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("corrupt")).resolves.toBeNull();
      await expect(store.list()).resolves.toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[workspace-history] skipping unreadable record corrupt:"),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("skips corrupt index entries with unknown kinds", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "corrupt-index",
            recordedAtMs: 1000,
            kind: "made-up-kind",
            author: userAuthor,
            summary: "Corrupt index",
            fileCount: 1,
          },
          {
            id: "valid",
            recordedAtMs: 2000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Valid record",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "2000-valid.json"),
      `${JSON.stringify(
        {
          id: "valid",
          recordedAtMs: 2000,
          kind: "user-edit",
          author: userAuthor,
          summary: "Valid record",
          files: [{ path: "notes/today.md", operation: "write" }],
          boundaryCrossings: [],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("corrupt-index")).resolves.toBeNull();
      await expect(store.list()).resolves.toMatchObject([{ id: "valid", kind: "user-edit" }]);
      await expect(store.listSince(0)).resolves.toMatchObject([
        { id: "valid", kind: "user-edit" },
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "[workspace-history] skipping unreadable index entry corrupt-index:",
        ),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("skips corrupt index entries with unsafe timestamps before reading records", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "corrupt-time",
            recordedAtMs: Number.MAX_SAFE_INTEGER,
            kind: "user-edit",
            author: userAuthor,
            summary: "Corrupt timestamp",
            fileCount: 1,
          },
          {
            id: "valid",
            recordedAtMs: 2000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Valid record",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "2000-valid.json"),
      `${JSON.stringify(
        {
          id: "valid",
          recordedAtMs: 2000,
          kind: "user-edit",
          author: userAuthor,
          summary: "Valid record",
          files: [{ path: "notes/today.md", operation: "write" }],
          boundaryCrossings: [],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("corrupt-time")).resolves.toBeNull();
      await expect(store.list()).resolves.toMatchObject([{ id: "valid", kind: "user-edit" }]);
      await expect(store.listSince(0)).resolves.toMatchObject([
        { id: "valid", kind: "user-edit" },
      ]);
      await expect(store.maxRecordedAtMs()).resolves.toBe(2000);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "[workspace-history] skipping unreadable index entry corrupt-time:",
        ),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects unknown persisted boundary crossings even when the kind is valid", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "bad-boundary",
            recordedAtMs: 1000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Corrupt boundary",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-bad-boundary.json"),
      `${JSON.stringify(
        {
          id: "bad-boundary",
          recordedAtMs: 1000,
          kind: "user-edit",
          author: userAuthor,
          summary: "Corrupt boundary",
          files: [{ path: "notes/today.md", operation: "write" }],
          boundaryCrossings: ["also-made-up"],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("bad-boundary")).resolves.toBeNull();
      await expect(store.list()).resolves.toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[workspace-history] skipping unreadable record bad-boundary:"),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects unknown persisted provenance source values", async () => {
    const historyDir = join(root, ".dohc", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "index.json"),
      `${JSON.stringify(
        [
          {
            id: "bad-provenance",
            recordedAtMs: 1000,
            kind: "user-edit",
            author: userAuthor,
            summary: "Corrupt provenance",
            fileCount: 1,
          },
        ],
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(historyDir, "1000-bad-provenance.json"),
      `${JSON.stringify(
        {
          id: "bad-provenance",
          recordedAtMs: 1000,
          kind: "user-edit",
          author: userAuthor,
          summary: "Corrupt provenance",
          files: [{ path: "notes/today.md", operation: "write" }],
          provenance: { source: "made-up-source" },
          boundaryCrossings: [],
        },
        null,
        2,
      )}\n`,
    );

    const store = createChangeSetStore(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(store.get("bad-provenance")).resolves.toBeNull();
      await expect(store.list()).resolves.toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[workspace-history] skipping unreadable record bad-provenance:"),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("humanSummary", () => {
  it("summarizes neutral local file edits without claiming a user or agent", async () => {
    const set = addFileChanges(
      createChangeSet({
        kind: "user-edit",
        author: localAuthor,
        summary: "External edit",
      }),
      [{ path: "notes/local.md", operation: "write" }],
    );

    const recorded = historyRecord("local", set, 1000);
    expect(recorded.author).toEqual(localAuthor);
    expect(humanSummary(recorded)).toBe("Local file edit edited notes/local.md");
  });

  it("attributes an agent run to the person it acted on behalf of", async () => {
    const recorded = historyRecord("agent", agentImport());
    const line = humanSummary(recorded);
    expect(line).toContain("Maya");
    expect(line).toContain("agent");
    expect(line).toContain("18");
  });

  it("attributes a user edit to the user, not an agent", async () => {
    const recorded = historyRecord("user", userEdit());
    const line = humanSummary(recorded);
    expect(line.toLowerCase()).toContain("you");
    expect(line).not.toContain("agent");
  });

  it("summarizes history restore provenance as restore or undo", async () => {
    const restored = addFileChanges(
      createChangeSet({
        kind: "history-restore",
        author: userAuthor,
        summary: "Restored notes/today.md from history",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-1",
          restoreOfPath: "notes/today.md",
          restoreDirection: "restore",
        },
      }),
      [{ path: "notes/today.md", operation: "write" }],
    );
    const undone = addFileChanges(
      createChangeSet({
        kind: "history-restore",
        author: userAuthor,
        summary: "Undid restore for notes/today.md",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-1",
          restoreOfPath: "notes/today.md",
          restoreDirection: "undo",
        },
      }),
      [{ path: "notes/today.md", operation: "write" }],
    );

    const restoredRecord = historyRecord("restore", restored, 1000);
    const undoneRecord = historyRecord("undo", undone, 2000);

    expect(humanSummary(restoredRecord)).toBe("You restored notes/today.md");
    expect(humanSummary(undoneRecord)).toBe(
      "You undid restore for notes/today.md",
    );
  });

  it("does not attribute workspace-authored restores to the user", async () => {
    const restored = addFileChanges(
      createChangeSet({
        kind: "history-restore",
        author: localAuthor,
        summary: "Restored notes/today.md",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-1",
          restoreOfPath: "notes/today.md",
          restoreDirection: "restore",
        },
      }),
      [{ path: "notes/today.md", operation: "write" }],
    );
    const redone = addFileChanges(
      createChangeSet({
        kind: "history-restore",
        author: localAuthor,
        summary: "Redid restore notes/today.md",
        provenance: {
          source: "history-restore",
          restoreOfChangeSetId: "change-1",
          restoreOfPath: "notes/today.md",
          restoreDirection: "redo",
        },
      }),
      [{ path: "notes/today.md", operation: "write" }],
    );

    const restoredRecord = historyRecord("workspace-restore", restored, 1000);
    const redoneRecord = historyRecord("workspace-redo", redone, 2000);

    expect(humanSummary(restoredRecord)).toBe("Local file edit restored notes/today.md");
    expect(humanSummary(redoneRecord)).toBe(
      "Local file edit redid restore for notes/today.md",
    );
  });

  it("produces different attributed summaries for a user edit vs an agent run", async () => {
    const userRec = historyRecord("u", userEdit(), 1000);
    const agentRec = historyRecord("a", agentImport(), 2000);
    expect(humanSummary(userRec)).not.toBe(humanSummary(agentRec));
  });

  it("never contains git conflict markers", async () => {
    const userRec = historyRecord("u", userEdit(), 1000);
    const agentRec = historyRecord("a", agentImport(), 2000);
    const localRec = historyRecord(
      "local",
      addFileChanges(
        createChangeSet({
          kind: "user-edit",
          author: localAuthor,
          summary: "Edited notes/today.md",
          provenance: { source: "user-edit" },
        }),
        [{ path: "notes/today.md", operation: "write" }],
      ),
      3000,
    );
    const restoredRec = historyRecord(
      "restore",
      addFileChanges(
        createChangeSet({
          kind: "history-restore",
          author: localAuthor,
          summary: "Restored notes/today.md",
          provenance: {
            source: "history-restore",
            restoreOfChangeSetId: "change-1",
            restoreOfPath: "notes/today.md",
            restoreDirection: "restore",
          },
        }),
        [{ path: "notes/today.md", operation: "write" }],
      ),
      4000,
    );
    const redoneRec = historyRecord(
      "redo",
      addFileChanges(
        createChangeSet({
          kind: "history-restore",
          author: localAuthor,
          summary: "Redid restore notes/today.md",
          provenance: {
            source: "history-restore",
            restoreOfChangeSetId: "change-1",
            restoreOfPath: "notes/today.md",
            restoreDirection: "redo",
          },
        }),
        [{ path: "notes/today.md", operation: "write" }],
      ),
      5000,
    );
    for (const record of [userRec, agentRec, localRec, restoredRec, redoneRec]) {
      expect(humanSummary(record)).not.toMatch(/(?:<{7}|>{7}|={7}|\|{7})/);
    }
  });
});

describeAnchoredHistory("changeSetStore concurrency and locks", () => {
  it("does not drop entries when records are fired concurrently", async () => {
    // The live watcher fires record() fire-and-forget; without serialization
    // two close-together records race on index.json and the second clobbers
    // the first's entry, silently dropping it from the timeline.
    const store = createChangeSetStore(root);
    const writes = Array.from({ length: 25 }, (_, i) =>
      store.record(userEdit(), { id: `c${i}`, recordedAtMs: 1000 + i }),
    );
    await Promise.all(writes);
    const listed = await store.list();
    expect(listed).toHaveLength(25);
    expect(new Set(listed.map((r) => r.id)).size).toBe(25);
  });

  it("does not drop entries when separate store instances record concurrently", async () => {
    const firstStore = createChangeSetStore(root);
    const secondStore = createChangeSetStore(root);
    const writes = Array.from({ length: 25 }, (_, i) =>
      (i % 2 === 0 ? firstStore : secondStore).record(userEdit(), {
        id: `s${i}`,
        recordedAtMs: 2000 + i,
      }),
    );

    await Promise.all(writes);

    const listed = await firstStore.list();
    expect(listed).toHaveLength(25);
    expect(new Set(listed.map((r) => r.id)).size).toBe(25);
  });

  it("waits for the filesystem history lock before recording", async () => {
    const token = "active-history-lock";
    const lockedAtMs = Date.now();
    const { lockDir } = await writeHistoryLockOwner({
      token,
      pid: process.pid,
      createdAtMs: lockedAtMs,
      heartbeatAtMs: lockedAtMs,
    });
    const store = createChangeSetStore(root);
    let settled = false;
    let pending: Promise<void> | undefined;
    try {
      pending = store
        .record(userEdit(), { id: "locked", recordedAtMs: 3000 })
        .then(() => {
          settled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 75));
      await expect(readdir(lockDir)).resolves.toContain(token);
      expect(settled).toBe(false);
      await rm(lockDir, { recursive: true, force: true });
      await pending;
    } finally {
      await rm(lockDir, { recursive: true, force: true });
      await pending?.catch(() => undefined);
    }

    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("reclaims a stale filesystem history lock before recording", async () => {
    const token = "stale-history-lock";
    const staleAtMs = Date.now() - 60_000;
    await writeHistoryLockOwner({
      token,
      pid: -1,
      createdAtMs: staleAtMs,
      heartbeatAtMs: staleAtMs,
    });
    const store = createChangeSetStore(root);

    await store.record(userEdit(), { id: "stale-lock", recordedAtMs: 3000 });

    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("reclaims an impossible future-dated filesystem history lock before recording", async () => {
    const token = "future-history-lock";
    const futureAtMs = Date.now() + 60_000;
    const { lockDir } = await writeHistoryLockOwner({
      token,
      pid: -1,
      createdAtMs: futureAtMs,
      heartbeatAtMs: futureAtMs,
    });
    const store = createChangeSetStore(root);

    await store.record(userEdit(), { id: "future-lock", recordedAtMs: 3000 });

    await expect(store.list()).resolves.toHaveLength(1);
    await expect(readdir(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reclaim a stale filesystem history lock while the owner pid is live", async () => {
    const token = "stale-live-pid-history-lock";
    const staleAtMs = Date.now() - 60_000;
    const { lockDir } = await writeHistoryLockOwner({
      token,
      pid: process.pid,
      createdAtMs: staleAtMs,
      heartbeatAtMs: staleAtMs,
    });
    const store = createChangeSetStore(root);
    let settled = false;
    let pending: Promise<void> | undefined;
    try {
      pending = store
        .record(userEdit(), { id: "stale-live-pid-lock", recordedAtMs: 3000 })
        .then(() => {
          settled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 75));
      await expect(readdir(lockDir)).resolves.toContain(token);
      expect(settled).toBe(false);
      await rm(lockDir, { recursive: true, force: true });
      await pending;
    } finally {
      await rm(lockDir, { recursive: true, force: true });
      await pending?.catch(() => undefined);
    }

    await expect(store.list()).resolves.toHaveLength(1);
  });

  itLinux("ignores symlinked history lock owners before reclaiming stale locks", async () => {
    const token = "symlink-owner-lock";
    const { lockDir, ownerDir, ownerPath } = historyLockPaths(token);
    const symlinkedOwnerTargetPath = join(root, "fresh-owner.json");
    const freshAtMs = Date.now();
    const staleDate = new Date(freshAtMs - 60_000);
    await mkdir(ownerDir, { recursive: true });
    await writeFile(
      symlinkedOwnerTargetPath,
      `${JSON.stringify({
        token,
        pid: process.pid,
        createdAtMs: freshAtMs,
        heartbeatAtMs: freshAtMs,
      })}\n`,
      "utf8",
    );
    await symlink(symlinkedOwnerTargetPath, ownerPath);
    await utimes(ownerDir, staleDate, staleDate);
    await utimes(lockDir, staleDate, staleDate);
    const store = createChangeSetStore(root);
    const reclaimShouldNotWaitForSymlinkedOwnerMs = 5_000;
    const record = store
      .record(userEdit(), { id: "symlink-owner-ignored", recordedAtMs: 3000 })
      .then(() => "recorded" as const);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await expect(
        Promise.race([
          record,
          new Promise<"blocked">((resolve) => {
            timeout = setTimeout(
              () => resolve("blocked"),
              reclaimShouldNotWaitForSymlinkedOwnerMs,
            );
          }),
        ]),
      ).resolves.toBe("recorded");
    } finally {
      if (timeout) clearTimeout(timeout);
      await rm(lockDir, { recursive: true, force: true });
      await record.catch(() => undefined);
    }

    await expect(store.list()).resolves.toHaveLength(1);
  });
});

describeAnchoredHistory("listSince (cloud sync cursor)", () => {
  it("returns only records strictly newer than the cursor, oldest first", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "dohc-hist-"));
    try {
      const store = createChangeSetStore(root);
      const set = (summary: string) => ({
        kind: "user-edit" as const,
        author: { kind: "user" as const, userId: "u1" },
        summary,
        files: [{ path: "a.md", operation: "write" as const }],
        boundaryCrossings: [],
      });
      await store.record(set("first"), { id: "a", recordedAtMs: 100 });
      await store.record(set("second"), { id: "b", recordedAtMs: 200 });
      await store.record(set("third"), { id: "c", recordedAtMs: 300 });

      const since = await store.listSince(100);
      expect(since.map((r) => r.id)).toEqual(["b", "c"]);
      expect(await store.listSince(300)).toEqual([]);
      expect((await store.listSince(0)).map((r) => r.id)).toEqual(["a", "b", "c"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

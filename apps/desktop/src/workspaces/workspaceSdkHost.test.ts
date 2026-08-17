import { databaseOpLogPath } from "@dohc/workspace-core";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokeWorkspaceSdkHost,
  sdkWorkspacePath,
  type SdkSearchStarter,
} from "./workspaceSdkHost";
import { createTestScratch } from "./testTemp";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";

// A plugin surface acts for the user driving it.
const USER_AUTHOR: ChangeAuthor = { kind: "user", userId: "local" };

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await createTestScratch("dohc-workspace-sdk-");
  roots.push(root);
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "today.md"), "hello from dohc\n");
  return root;
}

function seedDatabase(path: string, marker: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE sentinel (id TEXT PRIMARY KEY, marker TEXT); INSERT INTO sentinel VALUES ('1', '${marker}');`,
    );
  } finally {
    database.close();
  }
}

describe("workspace SDK host authority", () => {
  it("reads, lists, and writes through owned workspace authority", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, writable: true, author: USER_AUTHOR };
    await expect(invokeWorkspaceSdkHost(context, "files.read", { path: "notes/today.md" })).resolves.toMatchObject({
      text: "hello from dohc\n",
    });
    await expect(invokeWorkspaceSdkHost(context, "files.list", { path: "notes" })).resolves.toContainEqual(
      expect.objectContaining({ path: "notes/today.md", name: "today.md" }),
    );
    await expect(invokeWorkspaceSdkHost(context, "files.list", { path: "." })).resolves.toContainEqual(
      expect.objectContaining({ path: "notes/today.md", name: "today.md" }),
    );
    await invokeWorkspaceSdkHost(context, "files.write", {
      path: "notes/from-plugin.txt",
      text: "written by a plugin\n",
    });
    await expect(readFile(join(root, "notes", "from-plugin.txt"), "utf8")).resolves.toBe(
      "written by a plugin\n",
    );
  });

  it("atomically honors overwrite false under concurrent writes", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, writable: true, author: USER_AUTHOR };
    const attempts = await Promise.allSettled([
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "notes/exclusive.txt",
        text: "first",
        overwrite: false,
      }),
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "notes/exclusive.txt",
        text: "second",
        overwrite: false,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(String(attempts.find((attempt) => attempt.status === "rejected")?.reason)).toMatch(
      /already exists/i,
    );
    await expect(readFile(join(root, "notes", "exclusive.txt"), "utf8")).resolves.toMatch(
      /^(?:first|second)$/,
    );
  });

  it("rejects raw live-document writes without changing the document", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, writable: true, author: USER_AUTHOR };

    await expect(
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "notes/today.md",
        text: "replacement that bypasses Y.Doc\n",
      }),
    ).rejects.toThrow(/cannot overwrite live documents.*locks, history, and collaboration/i);
    await expect(readFile(join(root, "notes", "today.md"), "utf8")).resolves.toBe(
      "hello from dohc\n",
    );

    await expect(
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "notes/also-canonical.MARKDOWN",
        text: "not written\n",
      }),
    ).rejects.toThrow(/live documents/i);

    await expect(
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "notes/not-live.mdx",
        text: "ordinary source\n",
      }),
    ).resolves.toEqual({ path: "notes/not-live.mdx" });
    await expect(readFile(join(root, "notes", "not-live.mdx"), "utf8")).resolves.toBe(
      "ordinary source\n",
    );
  });

  it("rejects writes under the workspace-root plugins tree", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, writable: true, author: USER_AUTHOR };

    await expect(
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "plugins/example/index.txt",
        text: "full-trust source\n",
      }),
    ).rejects.toThrow(/cannot write plugin source.*plugins\/.*full-trust/i);

    await expect(
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "notes/todo.txt",
        text: "ordinary text\n",
      }),
    ).resolves.toEqual({ path: "notes/todo.txt" });
    await expect(readFile(join(root, "notes", "todo.txt"), "utf8")).resolves.toBe(
      "ordinary text\n",
    );

    await expect(
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "src/plugins/readme.txt",
        text: "nested folder\n",
      }),
    ).resolves.toEqual({ path: "src/plugins/readme.txt" });
    await expect(readFile(join(root, "src", "plugins", "readme.txt"), "utf8")).resolves.toBe(
      "nested folder\n",
    );
  });

  it("rejects writes through a real directory alias into the plugin tree", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, writable: true, author: USER_AUTHOR };
    await mkdir(join(root, "plugins", "example"), { recursive: true });
    await symlink(
      join(root, "plugins"),
      join(root, "plugin-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      invokeWorkspaceSdkHost(context, "files.write", {
        path: "plugin-alias/example/index.txt",
        text: "full-trust source\n",
      }),
    ).rejects.toThrow(/cannot write plugin source.*plugins\//i);
    await expect(
      readFile(join(root, "plugins", "example", "index.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")(
    "rejects a Windows case alias for the workspace plugin tree",
    async () => {
      const root = await workspace();
      const context = { workspaceRoot: root, writable: true, author: USER_AUTHOR };
      await mkdir(join(root, "plugins", "example"), { recursive: true });

      await expect(
        invokeWorkspaceSdkHost(context, "files.write", {
          path: "Plugins/example/index.txt",
          text: "full-trust source\n",
        }),
      ).rejects.toThrow(/cannot write plugin source.*plugins\//i);
    },
  );

  it("rejects raw database writes and requires structured databases.edit", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, writable: true, author: USER_AUTHOR };

    for (const path of [
      "data/app.db",
      "data/app.sqlite",
      "data/app.SQLITE3",
      "data/app.db-wal",
      "data/app.db-shm",
      "data/app.db-journal",
      "data/app.sqlite-wal",
      "data/app.sqlite-shm",
      "data/app.sqlite-journal",
      "data/app.sqlite3-wal",
      "data/app.sqlite3-shm",
      "data/app.sqlite3-journal",
    ]) {
      await expect(
        invokeWorkspaceSdkHost(context, "files.write", {
          path,
          text: "not sqlite bytes",
        }),
      ).rejects.toThrow(/cannot overwrite database files.*databases\.edit/i);
      await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("threads the injected clock/id seams into a database edit's op log", async () => {
    const root = await workspace();
    await mkdir(join(root, "data"), { recursive: true });
    seedDatabase(join(root, "data", "app.sqlite"), "start");
    const context = {
      workspaceRoot: root,
      writable: true,
      author: USER_AUTHOR,
      now: () => 1_700_000_000_000,
      createId: () => "op_sdk_0001",
    };
    await invokeWorkspaceSdkHost(context, "databases.edit", {
      path: "data/app.sqlite",
      edit: { table: "sentinel", op: "update", pkColumn: "id", rowId: "1", payload: { marker: "edited" } },
    });
    const log = await readFile(join(root, databaseOpLogPath("data/app.sqlite")), "utf8");
    const ops = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(ops[0]).toMatchObject({
      operationId: "op_sdk_0001",
      appliedAt: 1_700_000_000_000,
      author: { kind: "user", userId: "local" },
    });
  });

  it("refuses every write when the context has no write authority", async () => {
    const root = await workspace();
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "today.md"), "today\n");
    seedDatabase(join(root, "tasks.sqlite"), "task-sentinel");
    const context = {
      workspaceRoot: root,
      writable: false,
      author: USER_AUTHOR,
    };
    // Reads stay available; only the write half is withheld.
    await expect(invokeWorkspaceSdkHost(context, "capabilities")).resolves.toMatchObject({
      files: { read: true, list: true, write: false },
      workspace: { search: true },
      databases: { read: true, edit: false },
    });
    await expect(
      invokeWorkspaceSdkHost(context, "files.read", { path: "notes/today.md" }),
    ).resolves.toBeDefined();
    // MUTATION (write authority): drop either gate and a read-only surface
    // writes the workspace.
    await expect(
      invokeWorkspaceSdkHost(context, "files.write", { path: "notes/no.md", text: "no" }),
    ).rejects.toThrow(/read-only workspace authority/);
    await expect(
      invokeWorkspaceSdkHost(context, "databases.edit", {
        path: "tasks.sqlite",
        edits: [{ kind: "insert", table: "items", values: { title: "no" } }],
      }),
    ).rejects.toThrow(/read-only workspace authority/);
  });

  it("cancels search when its surface authority is already gone", async () => {
    const root = await workspace();
    const controller = new AbortController();
    controller.abort();
    await expect(
      invokeWorkspaceSdkHost(
        { workspaceRoot: root, writable: true, author: USER_AUTHOR, signal: controller.signal },
        "workspace.search",
        { query: "hello" },
      ),
    ).rejects.toThrow(/surface that owns this SDK request is no longer active/i);
  });

  it("cancels an in-flight file write when preview authority is revoked", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const write = invokeWorkspaceSdkHost(
      { workspaceRoot: root, writable: true, author: USER_AUTHOR, signal: controller.signal },
      "files.write",
      { path: "notes/stale.txt", text: "must not be written" },
    );
    controller.abort();

    await expect(write).rejects.toThrow(/cancelled/i);
    await expect(readFile(join(root, "notes", "stale.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("searches an exact requested file with literal glob metacharacters", async () => {
    const root = await workspace();
    await writeFile(join(root, "notes", "[draft].txt"), "literal glob sentinel\n");

    await expect(
      invokeWorkspaceSdkHost(
        { workspaceRoot: root, writable: true, author: USER_AUTHOR },
        "workspace.search",
        { query: "literal glob sentinel", path: "notes/[draft].txt" },
      ),
    ).resolves.toContainEqual(expect.objectContaining({ path: "notes/[draft].txt" }));
  });

  it("kills an in-flight search when surface authority is revoked", async () => {
    const root = await workspace();
    const controller = new AbortController();
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let killCount = 0;
    const searchStarter: SdkSearchStarter = ({ searchId }) => {
      signalStarted?.();
      return {
        searchId,
        kill() {
          killCount += 1;
        },
      };
    };
    const search = invokeWorkspaceSdkHost(
      {
        workspaceRoot: root,
          writable: true,
        author: USER_AUTHOR,
        signal: controller.signal,
        searchStarter,
      },
      "workspace.search",
      { query: "hello" },
    );

    await started;
    controller.abort();
    await expect(search).rejects.toThrow(/surface that owns this SDK request is no longer active/i);
    expect(killCount).toBe(1);
  });

  it("rejects multi-operation database edits until they can be transactional", async () => {
    const root = await workspace();
    await expect(
      invokeWorkspaceSdkHost(
        { workspaceRoot: root, writable: true, author: USER_AUTHOR },
        "databases.edit",
        {
          path: "missing.sqlite",
          operations: [
            { table: "items", op: "insert", pkColumn: "id", rowId: "1", payload: {} },
            { table: "items", op: "insert", pkColumn: "id", rowId: "2", payload: {} },
          ],
        },
      ),
    ).rejects.toThrow(/exactly one structured operation.*transactions/i);
  });
});

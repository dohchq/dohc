import { databaseOpLogPath } from "@dohc/workspace-core";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokeSiteSdkHost,
  siteSdkWorkspacePath,
  type SiteSdkSearchStarter,
} from "./siteSdkHost";
import { createTestScratch } from "./testTemp";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";

// A site preview acts for the user driving it.
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
  const root = await createTestScratch("dohc-site-sdk-");
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

describe("site SDK host authority", () => {
  it("maps shared site paths into the derived mount", () => {
    expect(siteSdkWorkspacePath("shared-with-me/Plan", "notes/today.md")).toBe(
      "shared-with-me/Plan/notes/today.md",
    );
    expect(() => siteSdkWorkspacePath("shared-with-me/Plan", "../secret.txt")).toThrow(
      /Invalid read path/,
    );
  });

  // Theme tokens are a plugin panel surface. A site asking gets told that,
  // not a generic "unsupported method".
  it("refuses ui.theme by name", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };
    await expect(invokeSiteSdkHost(context, "ui.theme", undefined)).rejects.toThrow(
      /ui.theme is unavailable to a site/,
    );
  });

  it("reads, lists, and writes through owned workspace authority", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };
    await expect(invokeSiteSdkHost(context, "files.read", { path: "notes/today.md" })).resolves.toMatchObject({
      text: "hello from dohc\n",
    });
    await expect(invokeSiteSdkHost(context, "files.list", { path: "notes" })).resolves.toContainEqual(
      expect.objectContaining({ path: "notes/today.md", name: "today.md" }),
    );
    await expect(invokeSiteSdkHost(context, "files.list", { path: "." })).resolves.toContainEqual(
      expect.objectContaining({ path: "notes/today.md", name: "today.md" }),
    );
    await invokeSiteSdkHost(context, "files.write", {
      path: "notes/from-site.txt",
      text: "written by site\n",
    });
    await expect(readFile(join(root, "notes", "from-site.txt"), "utf8")).resolves.toBe(
      "written by site\n",
    );
  });

  it("atomically honors overwrite false under concurrent writes", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };
    const attempts = await Promise.allSettled([
      invokeSiteSdkHost(context, "files.write", {
        path: "notes/exclusive.txt",
        text: "first",
        overwrite: false,
      }),
      invokeSiteSdkHost(context, "files.write", {
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
    const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "notes/today.md",
        text: "replacement that bypasses Y.Doc\n",
      }),
    ).rejects.toThrow(/cannot overwrite live documents.*locks, history, and collaboration/i);
    await expect(readFile(join(root, "notes", "today.md"), "utf8")).resolves.toBe(
      "hello from dohc\n",
    );

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "notes/also-canonical.MARKDOWN",
        text: "not written\n",
      }),
    ).rejects.toThrow(/live documents/i);

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "notes/not-live.mdx",
        text: "ordinary source\n",
      }),
    ).resolves.toEqual({ path: "notes/not-live.mdx" });
    await expect(readFile(join(root, "notes", "not-live.mdx"), "utf8")).resolves.toBe(
      "ordinary source\n",
    );
  });

  it("rejects site writes under the workspace-root plugins tree", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "plugins/example/index.txt",
        text: "full-trust source\n",
      }),
    ).rejects.toThrow(/cannot write plugin source.*plugins\/.*full-trust/i);

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "notes/todo.txt",
        text: "ordinary text\n",
      }),
    ).resolves.toEqual({ path: "notes/todo.txt" });
    await expect(readFile(join(root, "notes", "todo.txt"), "utf8")).resolves.toBe(
      "ordinary text\n",
    );

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "src/plugins/readme.txt",
        text: "nested folder\n",
      }),
    ).resolves.toEqual({ path: "src/plugins/readme.txt" });
    await expect(readFile(join(root, "src", "plugins", "readme.txt"), "utf8")).resolves.toBe(
      "nested folder\n",
    );
  });

  it("rejects site writes through a real directory alias into the plugin tree", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };
    await mkdir(join(root, "plugins", "example"), { recursive: true });
    await symlink(
      join(root, "plugins"),
      join(root, "plugin-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      invokeSiteSdkHost(context, "files.write", {
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
      const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };
      await mkdir(join(root, "plugins", "example"), { recursive: true });

      await expect(
        invokeSiteSdkHost(context, "files.write", {
          path: "Plugins/example/index.txt",
          text: "full-trust source\n",
        }),
      ).rejects.toThrow(/cannot write plugin source.*plugins\//i);
    },
  );

  it("rejects raw database writes and requires structured databases.edit", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR };

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
        invokeSiteSdkHost(context, "files.write", {
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
      scopeRoot: null,
      writable: true,
      author: USER_AUTHOR,
      now: () => 1_700_000_000_000,
      createId: () => "op_site_0001",
    };
    await invokeSiteSdkHost(context, "databases.edit", {
      path: "data/app.sqlite",
      edit: { table: "sentinel", op: "update", pkColumn: "id", rowId: "1", payload: { marker: "edited" } },
    });
    const log = await readFile(join(root, databaseOpLogPath("data/app.sqlite")), "utf8");
    const ops = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(ops[0]).toMatchObject({
      operationId: "op_site_0001",
      appliedAt: 1_700_000_000_000,
      author: { kind: "user", userId: "local" },
    });
  });

  it("keeps a mounted shared site read-only and hides paths outside its mount", async () => {
    const root = await workspace();
    const outsideToken = "outside-mount-search-sentinel-7f32";
    await writeFile(join(root, "outside-secret.txt"), outsideToken);
    seedDatabase(join(root, "outside-secret.sqlite"), "outside-database-sentinel");
    await mkdir(join(root, "shared-with-me", "Plan", "notes"), { recursive: true });
    await writeFile(join(root, "shared-with-me", "Plan", "notes", "shared.md"), "shared\n");
    const context = {
      workspaceRoot: root,
      scopeRoot: "shared-with-me/Plan",
      writable: false,
      author: USER_AUTHOR,
    };
    await expect(invokeSiteSdkHost(context, "capabilities")).resolves.toMatchObject({
      files: { read: true, list: true, write: false },
      workspace: { search: true },
      databases: { read: true, edit: false },
    });
    await expect(invokeSiteSdkHost(context, "files.list")).resolves.toEqual([
      expect.objectContaining({ path: "notes/shared.md" }),
    ]);
    await expect(
      invokeSiteSdkHost(context, "files.read", { path: "outside-secret.txt" }),
    ).rejects.toThrow();
    await expect(
      invokeSiteSdkHost(context, "workspace.search", { query: outsideToken }),
    ).resolves.toEqual([]);
    await expect(
      invokeSiteSdkHost(context, "databases.read", { path: "outside-secret.sqlite" }),
    ).rejects.toThrow();
    await expect(
      invokeSiteSdkHost(context, "files.write", { path: "notes/no.md", text: "no" }),
    ).rejects.toThrow(/read-only collaboration authority/);
  });

  it("cancels search when its preview authority is already gone", async () => {
    const root = await workspace();
    const controller = new AbortController();
    controller.abort();
    await expect(
      invokeSiteSdkHost(
        { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR, signal: controller.signal },
        "workspace.search",
        { query: "hello" },
      ),
    ).rejects.toThrow(/preview is no longer active/i);
  });

  it("cancels an in-flight file write when preview authority is revoked", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const write = invokeSiteSdkHost(
      { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR, signal: controller.signal },
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
      invokeSiteSdkHost(
        { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR },
        "workspace.search",
        { query: "literal glob sentinel", path: "notes/[draft].txt" },
      ),
    ).resolves.toContainEqual(expect.objectContaining({ path: "notes/[draft].txt" }));
  });

  it("kills an in-flight search when preview authority is revoked", async () => {
    const root = await workspace();
    const controller = new AbortController();
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let killCount = 0;
    const searchStarter: SiteSdkSearchStarter = ({ searchId }) => {
      signalStarted?.();
      return {
        searchId,
        kill() {
          killCount += 1;
        },
      };
    };
    const search = invokeSiteSdkHost(
      {
        workspaceRoot: root,
        scopeRoot: null,
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
    await expect(search).rejects.toThrow(/preview is no longer active/i);
    expect(killCount).toBe(1);
  });

  it("rejects multi-operation database edits until they can be transactional", async () => {
    const root = await workspace();
    await expect(
      invokeSiteSdkHost(
        { workspaceRoot: root, scopeRoot: null, writable: true, author: USER_AUTHOR },
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

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeSiteSdkHost, siteSdkWorkspacePath } from "./siteSdkHost";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "dohc-site-sdk-"));
  roots.push(root);
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "today.md"), "hello from dohc\n");
  return root;
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

  it("reads, lists, and writes through owned workspace authority", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true };
    await expect(invokeSiteSdkHost(context, "files.read", { path: "notes/today.md" })).resolves.toMatchObject({
      text: "hello from dohc\n",
    });
    await expect(invokeSiteSdkHost(context, "files.list", { path: "notes" })).resolves.toContainEqual(
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

  it("rejects raw canonical Markdown writes without changing the document", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true };

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "notes/today.md",
        text: "replacement that bypasses Y.Doc\n",
      }),
    ).rejects.toThrow(/cannot overwrite canonical Markdown.*locks, history, and collaboration/i);
    await expect(readFile(join(root, "notes", "today.md"), "utf8")).resolves.toBe(
      "hello from dohc\n",
    );

    await expect(
      invokeSiteSdkHost(context, "files.write", {
        path: "notes/also-canonical.MARKDOWN",
        text: "not written\n",
      }),
    ).rejects.toThrow(/canonical Markdown/i);
  });

  it("rejects raw database writes and requires structured databases.edit", async () => {
    const root = await workspace();
    const context = { workspaceRoot: root, scopeRoot: null, writable: true };

    for (const path of ["data/app.db", "data/app.sqlite", "data/app.SQLITE3"]) {
      await expect(
        invokeSiteSdkHost(context, "files.write", {
          path,
          text: "not sqlite bytes",
        }),
      ).rejects.toThrow(/cannot overwrite database files.*databases\.edit/i);
      await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("keeps a mounted shared site read-only and hides paths outside its mount", async () => {
    const root = await workspace();
    await mkdir(join(root, "shared-with-me", "Plan", "notes"), { recursive: true });
    await writeFile(join(root, "shared-with-me", "Plan", "notes", "shared.md"), "shared\n");
    const context = {
      workspaceRoot: root,
      scopeRoot: "shared-with-me/Plan",
      writable: false,
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
      invokeSiteSdkHost(context, "files.write", { path: "notes/no.md", text: "no" }),
    ).rejects.toThrow(/read-only collaboration authority/);
  });
});

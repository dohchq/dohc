import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceFolder, resetFailedJoinFolder } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";

let base: string;

beforeEach(async () => {
  base = await createTestScratch("dohc-create-");
});

describe("createWorkspaceFolder", () => {
  it("creates a fresh workspace with manifest and context", async () => {
    const root = join(base, "personal");
    const created = await createWorkspaceFolder({ rootPath: root, kind: "personal" });
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      version: 1,
      kind: "personal",
      mode: "local-first",
      workspaceId: created.workspaceId,
    });
    expect(await readFile(join(root, ".context", "me.md"), "utf8")).toContain(
      "About me",
    );
    const sharedWithMe = await stat(join(root, "shared-with-me"));
    expect(sharedWithMe.isDirectory()).toBe(true);
  });

  it("adopts an existing workspace instead of overwriting its identity", async () => {
    const root = join(base, "existing");
    await mkdir(join(root, ".dohc"), { recursive: true });
    const existing = {
      version: 1,
      workspaceId: "ws-existing-identity",
      kind: "personal",
      mode: "local-first",
    };
    await writeFile(
      join(root, ".dohc", "manifest.json"),
      JSON.stringify(existing),
    );

    const adopted = await createWorkspaceFolder({ rootPath: root, kind: "personal" });

    expect(adopted.workspaceId).toBe("ws-existing-identity");
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest.workspaceId).toBe("ws-existing-identity");
    const sharedWithMe = await stat(join(root, "shared-with-me"));
    expect(sharedWithMe.isDirectory()).toBe(true);
  });

  it("adopts a requested identity for a fresh folder (join flow)", async () => {
    const root = join(base, "joined");
    const created = await createWorkspaceFolder({
      rootPath: root,
      kind: "personal",
      workspaceId: "ws-synced-elsewhere",
    });
    expect(created.workspaceId).toBe("ws-synced-elsewhere");
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest.workspaceId).toBe("ws-synced-elsewhere");
  });

  // 0P-C gate fix (High): a JOIN creates identity/metadata only. Seeding
  // .context/me.md into a folder that is about to receive the synced
  // workspace's real files would let reconciliation capture boilerplate that
  // then pushes into the remote (or conflicts with the remote's own me.md).
  it("join bootstrap seeds no user files — identity and metadata only", async () => {
    const root = join(base, "join-bootstrap");
    const created = await createWorkspaceFolder({
      rootPath: root,
      kind: "personal",
      workspaceId: "ws-synced-elsewhere",
      bootstrap: "join",
    });
    expect(created.workspaceId).toBe("ws-synced-elsewhere");
    const manifest = JSON.parse(
      await readFile(join(root, ".dohc", "manifest.json"), "utf8"),
    );
    expect(manifest.workspaceId).toBe("ws-synced-elsewhere");
    const sharedWithMe = await stat(join(root, "shared-with-me"));
    expect(sharedWithMe.isDirectory()).toBe(true);
    // No seeded me.md — the first pull owns every user file.
    await expect(stat(join(root, ".context", "me.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, ".context"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // Failed-first-pull contract (0P-C gate fix): a join that could not
  // complete its first pull rolls the folder back to EMPTY, so nothing
  // half-joined is left behind and a retry passes the empty-folder check.
  it("resetFailedJoinFolder returns a failed join's folder to empty", async () => {
    const root = join(base, "failed-join");
    await createWorkspaceFolder({
      rootPath: root,
      kind: "personal",
      workspaceId: "ws-failed-join",
      bootstrap: "join",
    });
    // Simulate partially materialized pull output alongside the scaffolding.
    await mkdir(join(root, ".dohc", "engine"), { recursive: true });
    await writeFile(join(root, ".dohc", "engine", "engine.db"), "stub");
    await writeFile(join(root, "partial.md"), "half-pulled\n");

    await resetFailedJoinFolder(root);
    expect(await readdir(root)).toEqual([]);
    // Idempotent (and tolerant of an already-gone folder).
    await resetFailedJoinFolder(root);
    await resetFailedJoinFolder(join(base, "never-existed"));
  });

  it("never rebinds an existing manifest to a requested identity", async () => {
    const root = join(base, "existing-vs-requested");
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(
      join(root, ".dohc", "manifest.json"),
      JSON.stringify({
        version: 1,
        workspaceId: "ws-already-here",
        kind: "personal",
        mode: "local-first",
      }),
    );
    const created = await createWorkspaceFolder({
      rootPath: root,
      kind: "personal",
      workspaceId: "ws-somewhere-else",
    });
    expect(created.workspaceId).toBe("ws-already-here");
  });

  it("rejects a blocking shared-with-me file", async () => {
    const root = join(base, "blocked-shared");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "shared-with-me"), "not a directory");

    await expect(
      createWorkspaceFolder({ rootPath: root, kind: "personal" }),
    ).rejects.toThrow(/shared-with-me exists but is not a folder/);
  });

  it("rejects a shared-with-me symlink before adopting a workspace", async () => {
    const root = join(base, "symlink-shared");
    const outside = join(base, "outside-shared-target");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, "shared-with-me"), "dir");

    await expect(
      createWorkspaceFolder({ rootPath: root, kind: "personal" }),
    ).rejects.toThrow(/shared-with-me must not be a symlink/);
  });

  it("rejects relative workspace roots", async () => {
    await expect(
      createWorkspaceFolder({ rootPath: "relative/place", kind: "personal" }),
    ).rejects.toThrow(/absolute/i);
  });
});

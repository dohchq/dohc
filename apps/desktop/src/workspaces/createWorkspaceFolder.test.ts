import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceFolder, resetFailedJoinFolder } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";

let base: string;

beforeEach(async () => {
  base = await createTestScratch("dohc-create-");
});

describe("createWorkspaceFolder", () => {
  it.each([false, true])("refuses linked metadata before creating or adopting a manifest (manifest present: %s)", async (hasManifest) => {
    const root = join(base, "linked-workspace");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    const manifestPath = join(outside, "manifest.json");
    const manifest = JSON.stringify({
      version: 1,
      workspaceId: "outside-workspace",
      kind: "personal",
      mode: "local-first",
    });
    if (hasManifest) await writeFile(manifestPath, manifest);
    await symlink(outside, join(root, ".dohc"), process.platform === "win32" ? "junction" : "dir");

    await expect(createWorkspaceFolder({ rootPath: root, kind: "personal" })).rejects.toThrow();

    expect(await readdir(outside)).toEqual(hasManifest ? ["manifest.json"] : []);
    if (hasManifest) expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  });

  it("creates a fresh workspace with only its manifest", async () => {
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
    expect(await readdir(root)).toEqual([".dohc"]);
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

  // Failed-first-pull contract (0P-C gate fix): a join that could not
  // complete its first pull rolls the folder back to empty, so nothing
  // half-joined is left behind and a retry passes the empty-folder check.
  it("resetFailedJoinFolder returns a failed join's folder to empty", async () => {
    const root = join(base, "failed-join");
    await createWorkspaceFolder({
      rootPath: root,
      kind: "personal",
      workspaceId: "ws-failed-join",
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

  it("rejects relative workspace roots", async () => {
    await expect(
      createWorkspaceFolder({ rootPath: "relative/place", kind: "personal" }),
    ).rejects.toThrow(/absolute/i);
  });
});

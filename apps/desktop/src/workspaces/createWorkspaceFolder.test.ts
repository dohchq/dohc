import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceFolder } from "./createWorkspaceFolder";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "dohc-create-"));
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

  it("rejects relative workspace roots", async () => {
    await expect(
      createWorkspaceFolder({ rootPath: "relative/place", kind: "personal" }),
    ).rejects.toThrow(/absolute/i);
  });
});

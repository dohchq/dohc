import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createRegistryStore } from "./registryStore";

let store: ReturnType<typeof createRegistryStore>;
let registryPath: string;

const personal = {
  workspaceId: "ws-1",
  rootPath: "/home/ice/dohc/personal",
  kind: "personal" as const,
  mode: "local-first" as const,
};

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dohc-registry-"));
  registryPath = join(dir, "workspaces.json");
  store = createRegistryStore(registryPath);
});

describe("registry store", () => {
  it("supports multiple attached folders", () => {
    store.register(personal);
    store.register({
      workspaceId: "ws-2",
      rootPath: "/mnt/data/research",
      kind: "personal",
      mode: "local-first",
    });
    expect(store.list()).toHaveLength(2);
  });

  it("rejects duplicate folder attachment", () => {
    store.register(personal);
    expect(() =>
      store.register({ ...personal, workspaceId: "ws-other" }),
    ).toThrow(/already attached/i);
  });

  it("rejects a second root carrying an already-registered workspace identity", () => {
    store.register(personal);
    expect(() =>
      store.register({ ...personal, rootPath: "/home/ice/dohc/personal-copy" }),
    ).toThrow(/identity .* already attached|already attached .* identity/i);
  });

  it("persists across store instances", () => {
    store.register(personal);
    const reopened = createRegistryStore(store.registryFile);
    expect(reopened.find("ws-1")?.rootPath).toBe(personal.rootPath);
  });

  it("local-only workspaces carry no account or remote identity", () => {
    store.register(personal);
    const entry = store.find("ws-1");
    expect(entry).toBeTruthy();
    expect(entry && "remote" in entry && entry.remote).toBeFalsy();
  });

  it("records remote identity only when sync is explicitly enabled", () => {
    store.register({ ...personal, kind: "shared", mode: "cloud-first-local-copy" });
    expect(store.find("ws-1")?.remote).toBeUndefined();

    store.setRemote("ws-1", {
      serverUrl: "https://cloud.dohc.example",
      remoteWorkspaceId: "rw-99",
    });
    expect(store.find("ws-1")?.remote).toEqual({
      serverUrl: "https://cloud.dohc.example",
      remoteWorkspaceId: "rw-99",
    });
  });

  it("refuses to wipe a future-version registry", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 2, workspaces: [personal] }),
    );
    const future = createRegistryStore(registryPath);
    expect(() => future.list()).toThrow(/newer than supported|refusing to overwrite/i);
  });

  it("records, marks ended, and clears joined shared channels (MU-C4)", () => {
    store.register(personal);
    const joined = {
      shareId: "share-1",
      channelWireId: "wire-team",
      access: "read-write" as const,
      granterEmail: "owner@example.com",
      relayUrl: "http://relay.test",
    };
    store.setSharedChannels("ws-1", [joined]);
    expect(store.find("ws-1")?.sharedChannels).toEqual([joined]);

    // Revocation stamps ended (replace-the-set write) and persists across
    // store instances.
    store.setSharedChannels("ws-1", [{ ...joined, ended: true }]);
    const reopened = createRegistryStore(registryPath);
    expect(reopened.find("ws-1")?.sharedChannels).toEqual([{ ...joined, ended: true }]);

    // Leaving the last shared channel removes the key entirely.
    store.setSharedChannels("ws-1", []);
    expect(store.find("ws-1")?.sharedChannels).toBeUndefined();
  });

  it("remove unregisters a workspace and tolerates unknown ids (failed-join rollback)", () => {
    store.register(personal);
    store.remove("ws-1");
    expect(store.find("ws-1")).toBeNull();
    expect(store.list()).toHaveLength(0);
    // Unknown/already-removed ids are a no-op, never a throw.
    store.remove("ws-1");
    store.remove("ws-never-registered");
    // The same root can be re-attached after removal (join retry).
    store.register(personal);
    expect(store.find("ws-1")?.rootPath).toBe(personal.rootPath);
  });

  it("persists a shared-view identity and its ended state (PR 18)", () => {
    store.register(personal);
    store.setShareView("ws-1", { shareId: "share-1", granterEmail: "granter@dohc.test" });
    expect(store.find("ws-1")?.shareView).toEqual({
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
    });
    // Marking ended survives a fresh read of the same file.
    store.setShareView("ws-1", {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      ended: true,
    });
    const reread = createRegistryStore(registryPath);
    expect(reread.find("ws-1")?.shareView?.ended).toBe(true);
    expect(() =>
      store.setShareView("ws-unknown", { shareId: "s", granterEmail: null }),
    ).toThrow(/Unknown workspace/);
  });

  it("persists the share's origin relay so refresh can reject a foreign relay (PR 18 gate fix)", () => {
    store.register(personal);
    store.setShareView("ws-1", {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      relayUrl: "https://relay.origin.example",
    });
    const reread = createRegistryStore(registryPath);
    expect(reread.find("ws-1")?.shareView?.relayUrl).toBe("https://relay.origin.example");
  });

  it("refuses to overwrite a corrupt registry instead of collapsing it to empty", async () => {
    await writeFile(registryPath, "{ this is not json");
    const corrupt = createRegistryStore(registryPath);
    expect(() => corrupt.list()).toThrow(/corrupt|refusing to overwrite/i);
  });

  it("writes atomically and leaves no temp file behind", async () => {
    store.register(personal);
    const onDisk = JSON.parse(await readFile(registryPath, "utf8"));
    expect(onDisk.workspaces).toHaveLength(1);
    // The temp file used during the atomic rename must not survive.
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(join(registryPath, "..")).filter((f) =>
      f.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });
});

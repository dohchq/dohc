import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openedLocalState } from "../testing/preparedLocalState";
import { signedOutServer } from "./collectionsHome";
import { createOwnerDatasetCopyRegistry, datasetCopyOwnerKey } from "./ownerDatasetCopyRegistry";

// The registry with real copies: each holds its replica.sqlite open, which
// Windows will not delete while it is open.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("removes a copy open for a signed-out read when a different account signs in", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-copy-files-")),
    state = await mkdtemp(join(tmpdir(), "dohc-copy-files-state-"));
  await openedLocalState({ workspaceId: "w", rootPath });
  const registry = createOwnerDatasetCopyRegistry({
    record: join(state, "dataset-copy-removals.json"),
    workspaces: () => [rootPath],
  });
  cleanups.push(async () => {
    await registry.closeAll();
    await rm(rootPath, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  const owner = datasetCopyOwnerKey({ serverUrl: "https://account", userId: "owner" }),
    other = datasetCopyOwnerKey({ serverUrl: "https://account", userId: "other" });
  const input = (lifetime: AbortSignal) => ({
    rootPath,
    workspaceId: "w",
    datasetId: "00000000-0000-4000-8000-000000000001",
    origin: "https://relay",
    ownerKey: owner,
    lifetime,
    assertOwner() {},
  });
  const copies = join(rootPath, ".dohc", "local", "dataset-copies");
  await registry.credentialsChanged(owner, "https://relay");
  await registry.get(input(new AbortController().signal));
  const [folder] = await readdir(copies);
  expect(await readdir(join(copies, folder!))).toContain("replica.sqlite");

  await registry.credentialsChanged(null);
  expect(await registry.signedOutOrigin(owner)).toBe("https://relay");
  const kept = await registry.get(input(new AbortController().signal));
  const server = signedOutServer(),
    data = kept.data(server, server, new AbortController().signal);
  // A read of the open copy, which has nothing kept here, so it asks for a sign-in.
  await expect(data.list({})).rejects.toThrow("Sign in to your server first.");

  // The signed-out copy's replica.sqlite is still open as the other account
  // signs in: on Windows, deleting it now fails.
  if (process.platform === "win32")
    await expect(rm(join(copies, folder!, "replica.sqlite"))).rejects.toThrow(/EBUSY|EPERM/);
  await registry.credentialsChanged(other, "https://relay");
  expect(await readdir(copies)).toEqual([]);
  expect(registry.leftover()).toMatchObject({ workspaces: [], sweepPending: false });
});

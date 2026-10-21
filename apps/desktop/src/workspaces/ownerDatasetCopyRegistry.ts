import { createHash } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ownedFileRefusal } from "@dohc/workspace-core/owned-file";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import type { CloudCredentials } from "./cloudCredentialStore";
import { localDatasetFolder } from "./localDatasetFolders";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const datasetCopyOwnerKey = (credentials: Pick<CloudCredentials, "serverUrl" | "userId">) =>
  hash([new URL(credentials.serverUrl).href.replace(/\/+$/, ""), credentials.userId]);
type Copy = Awaited<ReturnType<typeof createOwnerDatasetCopy>>;
type Entry = { lifetime: AbortSignal; stop: AbortController; closed: boolean; directory?: string; opening: Promise<Copy>; closing?: Promise<void>; detach(): void };

// A copy's database decides what the copy holds, so dohc opens only one that
// is a file this user owns, that no other user can write, with one name. The
// copy's folder is one only this user can change, so a check by name holds.
async function assertOwnCopyFiles(directory: string, key: string): Promise<void> {
  for (const name of ["replica.sqlite", "replica.sqlite-wal", "replica.sqlite-shm", "replica.sqlite-journal"]) {
    const stats = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stats && ownedFileRefusal(stats) !== null) {
      throw new Error(`dohc did not open this Collection's offline copy because it can't trust a file in .dohc/local/dataset-copies/${key}. Remove that folder, then try again.`);
    }
  }
}

/** Owns replica locks across workspace lifetimes and removes known copies when the account changes. */
export function createOwnerDatasetCopyRegistry() {
  // Copies that did not open but made their folder: an account change removes those too.
  const entries = new Map<string, Entry>(), failed = new Set<Entry>();
  let ownerKey: string | null = null, stopped = false, barrier: Promise<void> = Promise.resolve();
  function close(entry: Entry): Promise<void> {
    entry.closed = true; entry.stop.abort(); entry.detach();
    return entry.closing ??= entry.opening.then(copy => copy.close(), () => undefined);
  }
  async function remove(entry: Entry) {
    await close(entry);
    if (!entry.directory) return;
    const info = await lstat(entry.directory).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(entry.directory)) !== resolve(entry.directory)) throw Error("Collection copy storage changed. Its files were not removed.");
    await rm(entry.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
  return {
    credentialsChanged(nextOwner: string | null): Promise<void> {
      if (ownerKey === nextOwner) return barrier;
      ownerKey = nextOwner;
      const prior = [...entries.values(), ...failed];
      for (const entry of prior) { entry.closed = true; entry.stop.abort(); entry.detach(); }
      entries.clear(); failed.clear();
      barrier = barrier.then(async () => { await Promise.all(prior.map(remove)); });
      return barrier;
    },
    async get(input: {
      workspaceId: string; rootPath: string; attachmentId?: symbol; lifetime: AbortSignal; datasetId: string; origin: string; ownerKey: string;
      assertOwner(): void; runtime?: Parameters<typeof createOwnerDatasetCopy>[0]["runtime"];
    }): Promise<Copy> {
      z.string().uuid().parse(input.datasetId);
      const origin = new URL(input.origin);
      if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw Error("Invalid Collection sharing server.");
      const current = () => {
        input.lifetime.throwIfAborted(); input.assertOwner();
        if (stopped || ownerKey !== input.ownerKey) throw Error("The Collection owner changed. Reopen the workspace.");
      };
      current(); await barrier; current();
      const key = hash([resolve(input.rootPath), input.workspaceId, input.datasetId, origin.origin, input.ownerKey]);
      let entry = entries.get(key);
      if (entry && (entry.closed || entry.lifetime !== input.lifetime)) { await close(entry); current(); if (entries.get(key) === entry) entries.delete(key); entry = entries.get(key); }
      if (!entry) {
        const authorize = () => { current(); if (next.closed) throw Error("This Collection copy is closed. Reopen the workspace."); };
        const abort = () => { void close(next).catch(() => undefined); };
        const opening = Promise.resolve().then(async () => {
          authorize();
          // This computer's copy, in `.dohc/local`, which only the engine's open prepares.
          const directory = resolve(await realpath(await localDatasetFolder(
            { workspaceId: input.workspaceId, rootPath: input.rootPath, attachmentId: input.attachmentId }, "copies", key)));
          next.directory = directory; authorize();
          await assertOwnCopyFiles(directory, key);
          const copy = await createOwnerDatasetCopy({ directory, scope: { workspaceId: input.workspaceId, datasetId: input.datasetId }, ownerKey: input.ownerKey,
            origin: origin.origin, assertOwner: authorize, runtime: input.runtime });
          const scoped: Copy = { ...copy, data: (remote, source, signal) => copy.data(remote, source, AbortSignal.any([signal, next.stop.signal])) };
          return scoped;
        });
        const next: Entry = { lifetime: input.lifetime, stop: new AbortController(), closed: false, opening,
          detach: () => input.lifetime.removeEventListener("abort", abort) };
        entries.set(key, next);
        input.lifetime.addEventListener("abort", abort, { once: true });
        // A copy that did not open, such as before the workspace's open
        // prepared `.dohc/local`, opens again on the next request.
        void opening.catch(() => {
          if (entries.get(key) !== next) return;
          entries.delete(key); next.detach();
          if (next.directory) failed.add(next);
        });
        entry = next;
      }
      const copy = await entry.opening; current();
      if (entry.closed) throw Error("This Collection copy is closed. Reopen the workspace.");
      return copy;
    },
    async closeAll() {
      stopped = true;
      await barrier;
      await Promise.all([...entries.values()].map(close));
      entries.clear();
    },
  };
}

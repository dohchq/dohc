import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import type { CloudCredentials } from "./cloudCredentialStore";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const datasetCopyOwnerKey = (credentials: Pick<CloudCredentials, "serverUrl" | "userId">) =>
  hash([new URL(credentials.serverUrl).href.replace(/\/+$/, ""), credentials.userId]);
type Copy = Awaited<ReturnType<typeof createOwnerDatasetCopy>>;
type Entry = { lifetime: AbortSignal; stop: AbortController; closed: boolean; directory?: string; opening: Promise<Copy>; closing?: Promise<void>; detach(): void };

/** Owns replica locks across workspace lifetimes and removes known copies when the account changes. */
export function createOwnerDatasetCopyRegistry() {
  const entries = new Map<string, Entry>();
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
      const prior = [...entries.values()];
      for (const entry of prior) { entry.closed = true; entry.stop.abort(); entry.detach(); }
      entries.clear();
      barrier = barrier.then(async () => { await Promise.all(prior.map(remove)); });
      return barrier;
    },
    async get(input: {
      workspaceId: string; rootPath: string; lifetime: AbortSignal; datasetId: string; origin: string; ownerKey: string;
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
          let directory = resolve(await realpath(input.rootPath));
          for (const part of [".dohc", "dataset-copies", key]) {
            directory = join(directory, part);
            await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(directory)) !== directory) throw Error("Collection copies must remain inside this workspace.");
          }
          next.directory = directory; authorize();
          const copy = await createOwnerDatasetCopy({ directory, scope: { workspaceId: input.workspaceId, datasetId: input.datasetId }, ownerKey: input.ownerKey,
            origin: origin.origin, assertOwner: authorize, runtime: input.runtime });
          const scoped: Copy = { ...copy, data: (remote, source, signal) => copy.data(remote, source, AbortSignal.any([signal, next.stop.signal])) };
          return scoped;
        });
        const next: Entry = { lifetime: input.lifetime, stop: new AbortController(), closed: false, opening,
          detach: () => input.lifetime.removeEventListener("abort", abort) };
        entries.set(key, next);
        input.lifetime.addEventListener("abort", abort, { once: true });
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

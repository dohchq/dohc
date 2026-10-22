import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomicReplaceFile";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import type { CloudCredentials } from "./cloudCredentialStore";
import { localDatasetFolder } from "./localDatasetFolders";
import { ownedSqliteFiles } from "./workspaceLocalState";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const datasetCopyOwnerKey = (credentials: Pick<CloudCredentials, "serverUrl" | "userId">) =>
  hash([new URL(credentials.serverUrl).href.replace(/\/+$/, ""), credentials.userId]);
type Copy = Awaited<ReturnType<typeof createOwnerDatasetCopy>>;
type Entry = { lifetime: AbortSignal; stop: AbortController; closed: boolean; directory?: string; opening: Promise<Copy>; closing?: Promise<void>; detach(): void };

// A copy's database decides what the copy holds, so dohc opens only one it
// can trust, in the copy's folder, which only this user can change.
async function assertOwnCopyFiles(directory: string, key: string): Promise<void> {
  if (!(await ownedSqliteFiles(directory, "replica.sqlite"))) {
    throw new Error(`dohc did not open this Collection's offline copy because it can't trust a file in .dohc/local/dataset-copies/${key}. Remove that folder, then try again.`);
  }
}

const orMissing = <T>(work: Promise<T>): Promise<T | null> => work.catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
});

// The folders an account change removes: one copy's own in `.dohc/local`, and
// `.dohc/dataset-copies`, where copies lived before `.dohc/local`. That old
// folder syncs and holds the account's Collection data, so it goes too.
// Remove it from here once no workspace has it (#2474).
const COPIES = [".dohc", "local", "dataset-copies"], OLD_COPIES = [".dohc", "dataset-copies"];
function placeOf(path: string): { root: string; inside: string[] } | null {
  if (!isAbsolute(path)) return null;
  const parts = resolve(path).split(sep), name = parts.at(-1)!;
  const inside = /^[0-9a-f]{64}$/.test(name) ? [...COPIES, name] : OLD_COPIES, tail = parts.slice(-inside.length);
  return parts.length > inside.length && inside.every((part, index) => tail[index] === part)
    ? { root: resolve(path, ...inside.map(() => "..")), inside } : null;
}

// Removes a real folder in its workspace, never through a link. dohc never
// wrote an old copy through a link, so it leaves one there alone. "missing"
// when the workspace's folder is not on this computer now.
async function removeFolder(path: string): Promise<"done" | "missing"> {
  const { root, inside } = placeOf(path)!;
  const real = await orMissing(realpath(root));
  if (real === null) return "missing";
  const folder = join(resolve(real), ...inside);
  const info = await orMissing(lstat(folder));
  if (!info) return "done";
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(folder)) !== folder) {
    if (inside === OLD_COPIES) return "done";
    throw Error("Collection copy storage changed. Its files were not removed.");
  }
  await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  return "done";
}

const Saved = z.object({ folders: z.array(z.string()) });
const rejected = (result: PromiseSettledResult<unknown> | undefined): result is PromiseRejectedResult => result?.status === "rejected";

/** Owns replica locks across workspace lifetimes and removes known copies when the account changes. */
export function createOwnerDatasetCopyRegistry(options: {
  // This installation's record of the folders an account change could not
  // remove, outside every workspace. The next start removes them first.
  record: string;
  // Hears that the workspaces `leftover` names changed.
  onLeftover?(): void;
}) {
  // Copies that did not open but made their folder: an account change removes those too.
  const entries = new Map<string, Entry>(), failed = new Set<Entry>();
  // Every workspace a copy was asked for since the last account change, opened or not.
  const requested = new Set<string>();
  // A copy an account change could not close. That change dropped it, so quit raises it again.
  let unclosed: { reason: unknown } | null = null;
  // Folders not removed yet: true when removing one failed, false when its
  // workspace was not here. The record holds the same paths, and keeps one
  // until it is removed, however long its workspace is away.
  let left = new Map<string, boolean>(), recorded: string | null = null;
  // Folders of copies that did not close. They go when dohc next starts.
  const held = new Set<string>();
  let ownerKey: string | null = null, stopped = false;
  function close(entry: Entry): Promise<void> {
    entry.closed = true; entry.stop.abort(); entry.detach();
    return entry.closing ??= entry.opening.then(copy => copy.close(), () => undefined);
  }
  function leftover(): string[] {
    return [...new Set([...left].flatMap(([path, failure]) => failure ? [placeOf(path)!.root] : []))];
  }
  async function load() {
    recorded = await orMissing(readFile(options.record, "utf8"));
    let folders: string[] = [];
    // A record dohc cannot read names nothing. The next change replaces it.
    try { folders = recorded === null ? [] : Saved.parse(JSON.parse(recorded)).folders; } catch { /* names nothing */ }
    for (const path of folders) if (placeOf(path)) left.set(path, true);
  }
  async function save() {
    const folders = [...left.keys()].sort(), text = folders.length ? JSON.stringify({ folders }) : null;
    if (text === recorded) return;
    if (text === null) await rm(options.record, { force: true });
    else { await mkdir(dirname(options.record), { recursive: true }); await atomicWriteFile(options.record, text); }
    recorded = text;
  }
  // Every copy closes before any folder goes: a copy that opened on a retry
  // uses the folder of the attempt that failed. A copy that did not close
  // keeps its folder. A folder the signed-in account uses again is its own,
  // and goes at its next account change. Each removal runs whatever another
  // one did.
  async function sweep(prior: Entry[], roots: string[]) {
    const closed = await Promise.allSettled(prior.map(close));
    const closeFailure = closed.find(rejected);
    if (closeFailure && !unclosed) unclosed = { reason: closeFailure.reason };
    prior.forEach((entry, index) => { if (entry.directory && rejected(closed[index])) held.add(entry.directory); });
    const own = new Set([...entries.keys(), ...[...failed].map(entry => basename(entry.directory!))]);
    const folders = [...new Set([...left.keys(), ...prior.flatMap(entry => entry.directory ? [entry.directory] : []),
      ...roots.map(root => join(resolve(root), ...OLD_COPIES))])].filter(path => !held.has(path) && !own.has(basename(path)));
    const removed = await Promise.allSettled(folders.map(removeFolder));
    const before = leftover().join("\0");
    left = new Map([...held].map(path => [path, true]));
    folders.forEach((path, index) => {
      const result = removed[index]!;
      if (rejected(result) || result.value === "missing") left.set(path, rejected(result));
    });
    const saved = await save().then(() => undefined, (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }));
    if (leftover().join("\0") !== before) options.onLeftover?.();
    const failure = [...closed, ...removed, saved].find(rejected);
    if (failure) throw failure.reason;
  }
  // The folders the last run could not remove go before any copy opens.
  let barrier: Promise<void> = load().then(() => sweep([], []));
  return {
    credentialsChanged(nextOwner: string | null): Promise<void> {
      if (ownerKey === nextOwner) return barrier;
      ownerKey = nextOwner;
      const prior = [...entries.values(), ...failed], roots = [...requested];
      for (const entry of prior) { entry.closed = true; entry.stop.abort(); entry.detach(); }
      entries.clear(); failed.clear(); requested.clear();
      // A cleanup that failed does not stop this one, which tries its folders again.
      barrier = barrier.catch(() => undefined).then(() => sweep(prior, roots));
      return barrier;
    },
    // Tries again to remove the folders an account change left, as Try again asks.
    removeLeftover(): Promise<void> {
      barrier = barrier.catch(() => undefined).then(() => sweep([], []));
      return barrier;
    },
    // The workspaces where dohc could not remove a folder.
    leftover,
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
      // A copy's folder is named for its account, so a folder a failed
      // cleanup left for another account never holds it. It waits only for a
      // cleanup still running.
      current(); await barrier.catch(() => undefined); current();
      // Its old copies go at the next account change, even if this one never opens.
      requested.add(input.rootPath);
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
      // An account change reported its own failures. A folder it could not
      // remove stays recorded; a copy it could not close is raised below.
      await barrier.catch(() => undefined);
      const closed = await Promise.allSettled([...entries.values()].map(close));
      entries.clear();
      const failure = closed.find((result): result is PromiseRejectedResult => result.status === "rejected");
      const earlier = unclosed;
      unclosed = null;
      if (failure) throw failure.reason;
      if (earlier) throw earlier.reason;
    },
  };
}

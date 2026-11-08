import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
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

// The folders an account change removes: every copy in a workspace's
// `.dohc/local/dataset-copies`, and `.dohc/dataset-copies`, where copies
// lived before `.dohc/local`. That old folder syncs and holds the account's
// Collection data, so it goes too. Remove it from here once no workspace has
// it (#2474). A record names a copies folder, one copy in it, or an old folder.
// A copy's folder name is its account's tag and a short hash, so a cleanup
// removes only the copies of accounts that left. Two older names count as an
// account that left: a long hash with no tag, from before tags, and a tag
// with a long hash, which made Windows paths too long (#2652).
const KEY = /^(?:[0-9a-f]{16}-)?[0-9a-f]{64}$|^[0-9a-f]{16}-[0-9a-f]{16}$/, COPIES = [".dohc", "local", "dataset-copies"], OLD_COPIES = [".dohc", "dataset-copies"];
function placeOf(path: string): { root: string; inside: string[] } | null {
  if (!isAbsolute(path)) return null;
  const parts = resolve(path).split(sep), name = parts.at(-1)!;
  for (const inside of KEY.test(name) ? [[...COPIES, name]] : [COPIES, OLD_COPIES]) {
    const tail = parts.slice(-inside.length);
    if (parts.length > inside.length && inside.every((part, index) => tail[index] === part)) {
      return { root: resolve(path, ...inside.map(() => "..")), inside };
    }
  }
  return null;
}

// A real folder in its workspace, reached through no link, or null when there
// is none. "missing" when the workspace's folder is not on this computer now.
async function realFolder(path: string): Promise<{ folder: string; real: boolean } | null | "missing"> {
  const { root, inside } = placeOf(path)!;
  const real = await orMissing(realpath(root));
  if (real === null) return "missing";
  const folder = join(resolve(real), ...inside);
  const info = await orMissing(lstat(folder));
  if (!info) return null;
  return { folder, real: info.isDirectory() && !info.isSymbolicLink() && resolve(await realpath(folder)) === folder };
}

const ownerTag = (ownerKey: string) => hash(["dataset-copy-owner", ownerKey]).slice(0, 16);
const tagOf = (name: string) => name.length === 33 ? name.slice(0, 16) : null;

// What a recorded path stands for now: a copies folder stands for each copy
// in it of an account that left. dohc never wrote a copy through a link, so a
// link there stands for nothing.
async function foldersOf(path: string, departed: ReadonlySet<string>): Promise<string[] | "missing"> {
  if (placeOf(path)!.inside !== COPIES) return [path];
  const found = await realFolder(path);
  if (found === "missing") return found;
  if (!found?.real) return [];
  return (await readdir(found.folder)).filter(name => KEY.test(name) && (tagOf(name) === null || departed.has(tagOf(name)!)))
    .map(name => join(found.folder, name));
}

// Removes one copy, or the old folder, never through a link. A link at the
// old folder is left alone, as above.
async function removeFolder(path: string): Promise<"done" | "missing"> {
  const found = await realFolder(path);
  if (found === "missing") return found;
  if (found === null) return "done";
  if (!found.real) {
    if (placeOf(path)!.inside === OLD_COPIES) return "done";
    throw Error("Collection copy storage changed. Its files were not removed.");
  }
  await rm(found.folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  return "done";
}

const Saved = z.object({ folders: z.array(z.string()), sweepPending: z.literal(true).optional(), departed: z.array(z.string().regex(/^[0-9a-f]{16}$/)).optional() });
const rejected = (result: PromiseSettledResult<unknown> | undefined): result is PromiseRejectedResult => result?.status === "rejected";
const settled = (work: Promise<unknown>) => work.then((): undefined => undefined, (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }));

/** Owns replica locks across workspace lifetimes and removes copies when the account changes. */
export function createOwnerDatasetCopyRegistry(options: {
  // This installation's record of the folders an account change has not
  // removed yet, and of the accounts that left, outside every workspace. The
  // next start removes those folders first.
  record: string;
  // The registered workspaces. Leaving an account removes the copies in each.
  workspaces(): string[];
  // Hears that what `leftover` answers changed.
  onLeftover?(): void;
}) {
  // Copies that did not open but made their folder: an account change removes those too.
  const entries = new Map<string, Entry>(), failed = new Set<Entry>();
  // Every workspace a copy was asked for since the last account change, opened or not.
  const requested = new Set<string>();
  // A copy an account change could not close. That change dropped it, so quit raises it again.
  let unclosed: { reason: unknown } | null = null;
  // Folders not removed yet: true once removing one failed. False before a
  // try, or while its workspace is not here: the record keeps it until it is
  // removed, however long its workspace is away.
  let left = new Map<string, boolean>();
  // The record as last read or written. Until dohc reads it, nothing writes
  // it, and every try reads it again.
  let loaded = false, recorded: string | null = null, unreadable: { reason: unknown } | null = null;
  // Leaving an account owes a look in every registered workspace. When dohc
  // cannot list them, the look stays owed, in the record too, until one
  // lists them.
  let owed = false;
  // The tags of accounts that left, kept so any later look in a workspace
  // removes their copies. One short tag per account that signed out here. An
  // account that signs in again is no longer one.
  const departed = new Set<string>();
  // Folders of copies that did not close. They go when dohc next starts.
  const held = new Set<string>();
  let ownerKey: string | null = null, stopped = false;
  function close(entry: Entry): Promise<void> {
    entry.closed = true; entry.stop.abort(); entry.detach();
    return entry.closing ??= entry.opening.then(copy => copy.close(), () => undefined);
  }
  function leftover() {
    return { workspaces: [...new Set([...left].flatMap(([path, failure]) => failure ? [placeOf(path)!.root] : []))],
      recordUnreadable: unreadable !== null, sweepPending: owed };
  }
  async function load() {
    try { recorded = await orMissing(readFile(options.record, "utf8")); } catch (reason) { unreadable = { reason }; return; }
    loaded = true; unreadable = null;
    let saved: z.infer<typeof Saved> = { folders: [] };
    // A record dohc can read but not parse names nothing. The next change replaces it.
    try { if (recorded !== null) saved = Saved.parse(JSON.parse(recorded)); } catch { /* names nothing */ }
    for (const path of saved.folders) if (placeOf(path) && !left.has(path)) left.set(path, false);
    owed ||= saved.sweepPending === true;
    for (const tag of saved.departed ?? []) departed.add(tag);
    // A record read late can name the signed-in account, whose copies are open.
    if (ownerKey !== null) signedIn(ownerTag(ownerKey));
  }
  // An account signed in has not left, and the folders it left are its own
  // again. Every copy it opens carries its tag.
  function signedIn(tag: string) {
    departed.delete(tag);
    for (const path of [...left.keys()]) if (tagOf(basename(path)) === tag) left.delete(path);
  }
  async function save() {
    if (!loaded) return;
    const folders = [...left.keys()].sort();
    const text = folders.length || owed || departed.size ? JSON.stringify({ folders, ...(owed ? { sweepPending: true } : {}),
      ...(departed.size ? { departed: [...departed].sort() } : {}) }) : null;
    if (text === recorded) return;
    if (text === null) await rm(options.record, { force: true });
    else { await mkdir(dirname(options.record), { recursive: true }); await atomicWriteFile(options.record, text); }
    recorded = text;
  }
  // Records every folder it will remove before any copy closes, so a stop
  // part way leaves them for the next start. Every copy closes before any
  // folder goes: a copy that opened on a retry uses the folder of the attempt
  // that failed. A copy that did not close keeps its folder. Each removal runs
  // whatever another one did.
  async function sweep(prior: Entry[], roots: string[], leaving: string | null = null, arriving: string | null = null) {
    if (!loaded) await load();
    if (leaving) departed.add(leaving);
    if (arriving) signedIn(arriving);
    // Leaving an account removes its copies in every registered workspace,
    // including ones from earlier runs.
    let listing: PromiseRejectedResult | undefined;
    if (leaving || owed) {
      try { roots = [...new Set([...roots, ...options.workspaces()])]; owed = false; }
      catch (reason) { owed = true; listing = { status: "rejected", reason }; }
    }
    for (const root of roots) for (const path of [join(resolve(root), ...COPIES), join(resolve(root), ...OLD_COPIES)]) if (!left.has(path)) left.set(path, false);
    const intent = await settled(save());
    const closed = await Promise.allSettled(prior.map(close));
    const closeFailure = closed.find(rejected);
    if (closeFailure && !unclosed) unclosed = { reason: closeFailure.reason };
    prior.forEach((entry, index) => { if (entry.directory && rejected(closed[index])) held.add(entry.directory); });
    const paths = [...left.keys()], found = await Promise.allSettled(paths.map(path => foldersOf(path, departed)));
    const next = new Map<string, boolean>([...held].map(path => [path, true])), folders = new Set<string>();
    paths.forEach((path, index) => {
      const result = found[index]!;
      if (rejected(result) || result.value === "missing") next.set(path, rejected(result));
      else for (const folder of result.value) folders.add(folder);
    });
    const tried = [...folders].filter(path => !held.has(path));
    const removed = await Promise.allSettled(tried.map(removeFolder));
    tried.forEach((path, index) => {
      const result = removed[index]!;
      if (rejected(result) || result.value === "missing") next.set(path, rejected(result));
    });
    left = next;
    const saving = await settled(save());
    const now = JSON.stringify(leftover());
    if (now !== told) { told = now; options.onLeftover?.(); }
    const failure = [listing, ...closed, ...found, ...removed, intent, saving].find(rejected) ?? unreadable;
    if (failure) throw failure.reason;
  }
  // What the windows heard last. A folder no try has failed yet stays out of
  // it, so each try tells them what changed, even if they read before it.
  let told = JSON.stringify(leftover());
  // The folders the last run did not remove go before any copy opens.
  let barrier: Promise<void> = sweep([], []);
  return {
    credentialsChanged(nextOwner: string | null): Promise<void> {
      if (ownerKey === nextOwner) return barrier;
      // Signing in after no account removes nothing, so copies last across a restart.
      const leaving = ownerKey === null ? null : ownerTag(ownerKey), arriving = nextOwner === null ? null : ownerTag(nextOwner);
      ownerKey = nextOwner;
      const prior = [...entries.values(), ...failed], roots = [...requested];
      for (const entry of prior) { entry.closed = true; entry.stop.abort(); entry.detach(); }
      entries.clear(); failed.clear(); requested.clear();
      // A cleanup that failed does not stop this one, which tries its folders again.
      barrier = barrier.catch(() => undefined).then(() => sweep(prior, roots, leaving, arriving));
      return barrier;
    },
    // Tries again to remove the folders an account change left, as Try again asks.
    removeLeftover(): Promise<void> {
      barrier = barrier.catch(() => undefined).then(() => sweep([], []));
      return barrier;
    },
    // The workspaces where dohc could not remove a folder, and whether it
    // could not read its record of them.
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
      const key = `${ownerTag(input.ownerKey)}-${hash([resolve(input.rootPath), input.workspaceId, input.datasetId, origin.origin, input.ownerKey]).slice(0, 16)}`;
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

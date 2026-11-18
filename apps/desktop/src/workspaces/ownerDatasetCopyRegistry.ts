import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomicReplaceFile";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import type { CloudCredentials } from "./cloudCredentialStore";
import { localDatasetFolder } from "./localDatasetFolders";
import type { SavedCollectionsList } from "./collectionsHome";
import { ownedSqliteFiles } from "./workspaceLocalState";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const datasetCopyOwnerKey = (credentials: Pick<CloudCredentials, "serverUrl" | "userId">) =>
  hash([new URL(credentials.serverUrl).href.replace(/\/+$/, ""), credentials.userId]);
type Copy = Awaited<ReturnType<typeof createOwnerDatasetCopy>>;
type Entry = {
  lifetime: AbortSignal;
  stop: AbortController;
  closed: boolean;
  directory?: string;
  opening: Promise<Copy>;
  closing?: Promise<void>;
  detach(): void;
};

// A copy's database decides what the copy holds, so dohc opens only one it
// can trust, in the copy's folder, which only this user can change.
async function assertOwnCopyFiles(directory: string, key: string): Promise<void> {
  if (!(await ownedSqliteFiles(directory, "replica.sqlite"))) {
    throw new Error(
      `dohc did not open this Collection's offline copy because it can't trust a file in .dohc/local/dataset-copies/${key}. Remove that folder, then try again.`,
    );
  }
}

const orMissing = <T>(work: Promise<T>): Promise<T | null> =>
  work.catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });

// The folders an account change removes: every copy in a workspace's
// `.dohc/local/dataset-copies`, and `.dohc/dataset-copies`, where copies
// lived before `.dohc/local`. That old folder syncs and holds the account's
// Collection data, so it goes too. Remove it from here once no workspace has
// it. A record names a copies folder, one copy in it, or an old folder.
// A copy's folder name is its account's tag and a short hash, so a cleanup
// removes only the copies of accounts that left. Two older names count as an
// account that left: a long hash with no tag, from before tags, and a tag
// with a long hash, which made Windows paths too long.
const KEY = /^(?:[0-9a-f]{16}-)?[0-9a-f]{64}$|^[0-9a-f]{16}-[0-9a-f]{16}$/,
  COPIES = [".dohc", "local", "dataset-copies"],
  OLD_COPIES = [".dohc", "dataset-copies"];
function placeOf(path: string): { root: string; inside: string[] } | null {
  if (!isAbsolute(path)) return null;
  const parts = resolve(path).split(sep),
    name = parts.at(-1)!;
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
async function realFolder(
  path: string,
): Promise<{ folder: string; real: boolean } | null | "missing"> {
  const { root, inside } = placeOf(path)!;
  const real = await orMissing(realpath(root));
  if (real === null) return "missing";
  const folder = join(resolve(real), ...inside);
  const info = await orMissing(lstat(folder));
  if (!info) return null;
  return {
    folder,
    real:
      info.isDirectory() && !info.isSymbolicLink() && resolve(await realpath(folder)) === folder,
  };
}

const ownerTag = (ownerKey: string) => hash(["dataset-copy-owner", ownerKey]).slice(0, 16);
const tagOf = (name: string) => (name.length === 33 ? name.slice(0, 16) : null);

// What a recorded path stands for now: a copies folder stands for each copy
// in it of an account that left. dohc never wrote a copy through a link, so a
// link there stands for nothing.
async function foldersOf(
  path: string,
  departed: ReadonlySet<string>,
  keep: string | null,
): Promise<string[] | "missing"> {
  if (placeOf(path)!.inside !== COPIES) return [path];
  const found = await realFolder(path);
  if (found === "missing") return found;
  if (!found?.real) return [];
  return (await readdir(found.folder))
    .filter(
      (name) =>
        KEY.test(name) &&
        (tagOf(name) === null ||
          departed.has(tagOf(name)!) ||
          (keep !== null && tagOf(name) !== keep)),
    )
    .map((name) => join(found.folder, name));
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

const Saved = z.object({
  folders: z.array(z.string()),
  sweepPending: z.literal(true).optional(),
  departed: z.array(z.string().regex(/^[0-9a-f]{16}$/)).optional(),
  account: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  // The server origin of that account's copies, which a signed-out read opens.
  origin: z.string().url().optional(),
});
const rejected = (
  result: PromiseSettledResult<unknown> | undefined,
): result is PromiseRejectedResult => result?.status === "rejected";
const settled = (work: Promise<unknown>) =>
  work.then(
    (): undefined => undefined,
    (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
  );

/**
 * Owns replica locks across workspace lifetimes. An account's copies stay
 * through a sign-out, read-only, and go when a different account signs in.
 */
export function createOwnerDatasetCopyRegistry(options: {
  // This installation's record of the folders an account change has not
  // removed yet, of the accounts that left, and of the account signed in
  // last, outside every workspace. The next start removes those folders first.
  record: string;
  // The registered workspaces. An account that leaves has its copies removed from each.
  workspaces(): string[];
  // Hears that what `leftover` answers changed.
  onLeftover?(): void;
}) {
  // Copies that did not open but made their folder: an account change removes those too.
  const entries = new Map<string, Entry>(),
    failed = new Set<Entry>();
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
  let loaded = false,
    recorded: string | null = null,
    unreadable: { reason: unknown } | null = null;
  // Leaving an account owes a look in every registered workspace. When dohc
  // cannot list them, the look stays owed, in the record too, until one
  // lists them.
  let owed = false;
  // The tags of accounts that left, kept so any later look in a workspace
  // removes their copies. One short tag per account a different one replaced
  // here. An account that signs in again is no longer one.
  const departed = new Set<string>();
  // The tag of the account signed in here last, and its copies' server
  // origin, kept across a sign-out and a restart. Signed out, its copies read
  // here. The next different account to sign in removes them. Undefined until
  // the record or an account change says.
  let account: string | null | undefined,
    accountOrigin: string | null = null;
  // Folders of copies that did not close. They go when dohc next starts.
  const held = new Set<string>();
  let ownerKey: string | null = null,
    stopped = false,
    // Sessions starting: main has cleared the credentials but not yet
    // told this registry whose they are, so no copy opens signed out.
    changing = 0;
  // Signed in, the account's copies open. Signed out, only those of the
  // account signed in here last, read-only.
  const owns = (key: string) =>
    !stopped &&
    (ownerKey === null ? changing === 0 && account === ownerTag(key) : ownerKey === key);
  function close(entry: Entry): Promise<void> {
    entry.closed = true;
    entry.stop.abort();
    entry.detach();
    return (entry.closing ??= entry.opening.then(
      (copy) => copy.close(),
      () => undefined,
    ));
  }
  function leftover() {
    return {
      workspaces: [
        ...new Set([...left].flatMap(([path, failure]) => (failure ? [placeOf(path)!.root] : []))),
      ],
      recordUnreadable: unreadable !== null,
      sweepPending: owed,
    };
  }
  async function load() {
    try {
      recorded = await orMissing(readFile(options.record, "utf8"));
    } catch (reason) {
      unreadable = { reason };
      return;
    }
    loaded = true;
    unreadable = null;
    let saved: z.infer<typeof Saved> = { folders: [] };
    // A record dohc can read but not parse names nothing. The next change replaces it.
    try {
      if (recorded !== null) saved = Saved.parse(JSON.parse(recorded));
    } catch {
      /* names nothing */
    }
    for (const path of saved.folders) if (placeOf(path) && !left.has(path)) left.set(path, false);
    owed ||= saved.sweepPending === true;
    for (const tag of saved.departed ?? []) departed.add(tag);
    // A record read after an account signed in can name the account before it.
    const last = saved.account ?? null;
    if (account === undefined) {
      account = last;
      accountOrigin = saved.origin ?? null;
    } else if (last !== null && last !== account) {
      departed.add(last);
      owed = true;
    }
    // A record read late can name the signed-in account, whose copies are
    // open, or, signed out, the account signed in last, whose copies stay.
    if (ownerKey !== null) signedIn(ownerTag(ownerKey));
    else if (account) signedIn(account);
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
    const text =
      folders.length || owed || departed.size || account
        ? JSON.stringify({
            folders,
            ...(owed ? { sweepPending: true } : {}),
            ...(departed.size ? { departed: [...departed].sort() } : {}),
            ...(account ? { account } : {}),
            ...(account && accountOrigin ? { origin: accountOrigin } : {}),
          })
        : null;
    if (text === recorded) return;
    if (text === null) await rm(options.record, { force: true });
    else {
      await mkdir(dirname(options.record), { recursive: true });
      await atomicWriteFile(options.record, text);
    }
    recorded = text;
  }
  // Records every folder it will remove before any copy closes, so a stop
  // part way leaves them for the next start. Every copy closes before any
  // folder goes: a copy that opened on a retry uses the folder of the attempt
  // that failed. A copy that did not close keeps its folder. Each removal runs
  // whatever another one did.
  async function sweep(
    prior: Entry[],
    roots: string[],
    arriving: { tag: string; origin: string | null } | null = null,
  ) {
    if (!loaded) await load();
    const leaving = arriving && account && account !== arriving.tag ? account : null;
    if (leaving) departed.add(leaving);
    // A sign-in while the record cannot be read: the account before is
    // unknown, so the copies of every other account go.
    const keep = arriving && account === undefined ? arriving.tag : null;
    if (arriving) {
      signedIn(arriving.tag);
      account = arriving.tag;
      accountOrigin = arriving.origin;
    }
    // Leaving an account removes its copies in every registered workspace,
    // including ones from earlier runs.
    let listing: PromiseRejectedResult | undefined;
    if (leaving || keep || owed) {
      try {
        roots = [...new Set([...roots, ...options.workspaces()])];
        owed = false;
      } catch (reason) {
        owed = true;
        listing = { status: "rejected", reason };
      }
    }
    for (const root of roots)
      for (const path of [join(resolve(root), ...COPIES), join(resolve(root), ...OLD_COPIES)])
        if (!left.has(path)) left.set(path, false);
    const intent = await settled(save());
    const closed = await Promise.allSettled(prior.map(close));
    const closeFailure = closed.find(rejected);
    if (closeFailure && !unclosed) unclosed = { reason: closeFailure.reason };
    prior.forEach((entry, index) => {
      if (entry.directory && rejected(closed[index])) held.add(entry.directory);
    });
    const paths = [...left.keys()],
      found = await Promise.allSettled(paths.map((path) => foldersOf(path, departed, keep)));
    const next = new Map<string, boolean>([...held].map((path) => [path, true])),
      folders = new Set<string>();
    paths.forEach((path, index) => {
      const result = found[index]!;
      if (rejected(result) || result.value === "missing") next.set(path, rejected(result));
      else for (const folder of result.value) folders.add(folder);
    });
    const tried = [...folders].filter((path) => !held.has(path));
    const removed = await Promise.allSettled(tried.map(removeFolder));
    tried.forEach((path, index) => {
      const result = removed[index]!;
      if (rejected(result) || result.value === "missing") next.set(path, rejected(result));
    });
    left = next;
    const saving = await settled(save());
    const now = JSON.stringify(leftover());
    if (now !== told) {
      told = now;
      options.onLeftover?.();
    }
    const failure =
      [listing, ...closed, ...found, ...removed, intent, saving].find(rejected) ?? unreadable;
    if (failure) throw failure.reason;
  }
  // What the windows heard last. A folder no try has failed yet stays out of
  // it, so each try tells them what changed, even if they read before it.
  let told = JSON.stringify(leftover());
  // The folders the last run did not remove go before any copy opens.
  let barrier: Promise<void> = sweep([], []);
  return {
    // `origin` is the server origin the signed-in account's copies use.
    credentialsChanged(nextOwner: string | null, origin: string | null = null): Promise<void> {
      if (ownerKey === nextOwner) return barrier;
      // Signing out removes nothing. Signing in removes the copies of the
      // account signed in here before, if it differs.
      const arriving = nextOwner === null ? null : { tag: ownerTag(nextOwner), origin };
      ownerKey = nextOwner;
      const prior = [...entries.values(), ...failed],
        roots = [...requested];
      for (const entry of prior) {
        entry.closed = true;
        entry.stop.abort();
        entry.detach();
      }
      entries.clear();
      failed.clear();
      requested.clear();
      // A cleanup that failed does not stop this one, which tries its folders again.
      barrier = barrier.catch(() => undefined).then(() => sweep(prior, roots, arriving));
      return barrier;
    },
    // Signed out, the server origin of `key`'s copies when that account
    // signed in here last, or null. Only those copies open signed out.
    async signedOutOrigin(key: string): Promise<string | null> {
      await barrier.catch(() => undefined);
      if (changing > 0 && !stopped && ownerKey === null)
        throw Error("Your server session is changing. Try again.");
      return !stopped && ownerKey === null && account === ownerTag(key) ? accountOrigin : null;
    },
    // A session change started. Call what it returns once that change ends,
    // whether it worked or not. Another change ending first lifts nothing.
    sessionChange(): () => void {
      changing++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        changing--;
      };
    },
    removeLeftover(): Promise<void> {
      barrier = barrier.catch(() => undefined).then(() => sweep([], []));
      return barrier;
    },
    // The workspaces where dohc could not remove a folder, and whether it
    // could not read its record of them.
    leftover,
    // The last Collections list this computer read from a syncing workspace's
    // server, kept with its copies under the same account rules.
    savedList(input: {
      workspaceId: string;
      rootPath: string;
      attachmentId?: symbol;
      origin: string;
      ownerKey: string;
    }): SavedCollectionsList {
      const key = `${ownerTag(input.ownerKey)}-${hash([resolve(input.rootPath), input.workspaceId, "list", new URL(input.origin).origin, input.ownerKey]).slice(0, 16)}`;
      const mine = () => {
        if (!owns(input.ownerKey))
          throw Error("The Collection owner changed. Reopen the workspace.");
      };
      const file = async () => {
        await barrier.catch(() => undefined);
        mine();
        requested.add(input.rootPath);
        const folder = await localDatasetFolder(
          {
            workspaceId: input.workspaceId,
            rootPath: input.rootPath,
            attachmentId: input.attachmentId,
          },
          "copies",
          key,
        );
        return join(resolve(await realpath(folder)), "list.json");
      };
      return {
        read: async () => {
          const text = await readFile(await file(), "utf8");
          mine();
          return JSON.parse(text) as unknown;
        },
        write: async (value) => atomicWriteFile(await file(), JSON.stringify(value)),
      };
    },
    async get(input: {
      workspaceId: string;
      rootPath: string;
      attachmentId?: symbol;
      lifetime: AbortSignal;
      datasetId: string;
      origin: string;
      ownerKey: string;
      assertOwner(): void;
      runtime?: Parameters<typeof createOwnerDatasetCopy>[0]["runtime"];
      /** Hears that what the copy shows changed. The request that opens the copy names it. */
      onChanged?(): void;
    }): Promise<Copy> {
      z.string().uuid().parse(input.datasetId);
      const origin = new URL(input.origin);
      if (
        !["https:", "http:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw Error("Invalid Collection sharing server.");
      const current = () => {
        input.lifetime.throwIfAborted();
        input.assertOwner();
        if (!owns(input.ownerKey))
          throw Error("The Collection owner changed. Reopen the workspace.");
      };
      // A copy's folder is named for its account, so a folder a failed
      // cleanup left for another account never holds it. It waits only for a
      // cleanup still running.
      current();
      await barrier.catch(() => undefined);
      current();
      // Its old copies go at the next account change, even if this one never opens.
      requested.add(input.rootPath);
      const key = `${ownerTag(input.ownerKey)}-${hash([resolve(input.rootPath), input.workspaceId, input.datasetId, origin.origin, input.ownerKey]).slice(0, 16)}`;
      let entry = entries.get(key);
      if (entry && (entry.closed || entry.lifetime !== input.lifetime)) {
        await close(entry);
        current();
        if (entries.get(key) === entry) entries.delete(key);
        entry = entries.get(key);
      }
      if (!entry) {
        const authorize = () => {
          current();
          if (next.closed) throw Error("This Collection copy is closed. Reopen the workspace.");
        };
        const abort = () => {
          void close(next).catch(() => undefined);
        };
        // An account change closes every copy, so this one stays signed in or out.
        const signedOut = ownerKey === null;
        const opening = Promise.resolve().then(async () => {
          authorize();
          const workspace = {
            workspaceId: input.workspaceId,
            rootPath: input.rootPath,
            attachmentId: input.attachmentId,
          };
          // Signed out, only a copy already kept here opens.
          if (
            signedOut &&
            !(await orMissing(lstat(join(await localDatasetFolder(workspace, "copies"), key))))
          )
            throw Error("Sign in to your server first.");
          // This computer's copy, in `.dohc/local`, which only the engine's open prepares.
          const directory = resolve(
            await realpath(await localDatasetFolder(workspace, "copies", key)),
          );
          next.directory = directory;
          authorize();
          await assertOwnCopyFiles(directory, key);
          const copy = await createOwnerDatasetCopy({
            directory,
            scope: { workspaceId: input.workspaceId, datasetId: input.datasetId },
            ownerKey: input.ownerKey,
            origin: origin.origin,
            assertOwner: authorize,
            signedOut,
            runtime: input.runtime,
            ...(input.onChanged ? { onChanged: input.onChanged } : {}),
          });
          const scoped: Copy = {
            ...copy,
            data: (remote, source, signal) =>
              copy.data(remote, source, AbortSignal.any([signal, next.stop.signal])),
          };
          return scoped;
        });
        const next: Entry = {
          lifetime: input.lifetime,
          stop: new AbortController(),
          closed: false,
          opening,
          detach: () => input.lifetime.removeEventListener("abort", abort),
        };
        entries.set(key, next);
        input.lifetime.addEventListener("abort", abort, { once: true });
        // A copy that did not open, such as before the workspace's open
        // prepared `.dohc/local`, opens again on the next request.
        void opening.catch(() => {
          if (entries.get(key) !== next) return;
          entries.delete(key);
          next.detach();
          if (next.directory) failed.add(next);
        });
        entry = next;
      }
      const copy = await entry.opening;
      current();
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
      const failure = closed.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      const earlier = unclosed;
      unclosed = null;
      if (failure) throw failure.reason;
      if (earlier) throw earlier.reason;
    },
  };
}

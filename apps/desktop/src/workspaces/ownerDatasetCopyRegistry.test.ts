import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { openedLocalState } from "../testing/preparedLocalState";
import { createOwnerDatasetCopyRegistry, datasetCopyOwnerKey } from "./ownerDatasetCopyRegistry";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./ownerDatasetCopy", () => ({ createOwnerDatasetCopy: mocks.open }));
const files = vi.hoisted(() => ({ removed: [] as string[], busy: new Set<string>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (files.busy.has(String(args[0]))) {
        throw Object.assign(
          new Error(`EBUSY: resource busy or locked, rmdir '${String(args[0])}'`),
          { code: "EBUSY" },
        );
      }
      await actual.rm(...args);
      files.removed.push(String(args[0]));
    },
  };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  files.busy.clear();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.clearAllMocks();
});
function restart(record: string, workspaces: string[] = [], onLeftover = vi.fn()) {
  const registry = createOwnerDatasetCopyRegistry({
    record,
    workspaces: () => workspaces,
    onLeftover,
  });
  cleanups.push(() => registry.closeAll());
  return registry;
}
async function fixture({ opened = true, workspaces = (rootPath: string) => [rootPath] } = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-copy-registry-")),
    lifetime = new AbortController();
  if (opened) await openedLocalState({ workspaceId: "w", rootPath });
  const state = await mkdtemp(join(tmpdir(), "dohc-copy-registry-state-")),
    record = join(state, "dataset-copy-removals.json"),
    onLeftover = vi.fn();
  const ownerKey = datasetCopyOwnerKey({ serverUrl: "https://account", userId: "owner" });
  const registry = createOwnerDatasetCopyRegistry({
    record,
    workspaces: () => workspaces(rootPath),
    onLeftover,
  });
  cleanups.push(async () => {
    await registry.closeAll();
    await rm(rootPath, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });
  await registry.credentialsChanged(ownerKey);
  mocks.open.mockImplementation(async (options) => {
    await writeFile(join(options.directory, "owned.sqlite"), "copy");
    return {
      close: vi.fn(async () => {}),
      assertOwner: options.assertOwner,
      data: vi.fn((_remote, _source, signal) => ({ signal })),
    };
  });
  const input = {
    rootPath,
    lifetime: lifetime.signal,
    workspaceId: "w",
    datasetId: "00000000-0000-4000-8000-000000000001",
    origin: "https://relay",
    ownerKey,
    assertOwner() {},
  };
  return { registry, input, lifetime, record, onLeftover };
}
it("invalidates access before logout cleanup and removes copies from closed workspaces", async () => {
  const f = await fixture();
  const copy = await f.registry.get(f.input);
  const options = mocks.open.mock.calls[0]![0];
  f.lifetime.abort();
  await copy.close();
  const removal = f.registry.credentialsChanged(null);
  expect(() => options.assertOwner()).toThrow();
  await removal;
  expect(await readdir(join(f.input.rootPath, ".dohc", "local", "dataset-copies"))).toEqual([]);
  await expect(
    f.registry.get({ ...f.input, lifetime: new AbortController().signal }),
  ).rejects.toThrow(/owner changed/);
});
it("waits for an opening copy to close before the previous account can reopen it", async () => {
  const f = await fixture(),
    opening = deferred<{ close: () => Promise<void> }>(),
    entered = deferred<void>(),
    close = vi.fn(async () => {});
  mocks.open.mockImplementationOnce(async () => {
    entered.resolve();
    return opening.promise;
  });
  const first = f.registry.get(f.input),
    refused = expect(first).rejects.toThrow(/owner changed|closed/);
  await entered.promise;
  const switching = f.registry.credentialsChanged("other");
  const back = f.registry.credentialsChanged(f.input.ownerKey);
  const reopened = f.registry.get(f.input);
  expect(mocks.open).toHaveBeenCalledOnce();
  opening.resolve({ close });
  await refused;
  await switching;
  await back;
  await reopened;
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenCalledTimes(2);
});

it("keeps each copy in .dohc/local/dataset-copies, private, and ignores the old folder", async () => {
  const f = await fixture();
  const old = join(f.input.rootPath, ".dohc", "dataset-copies");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "replica.sqlite"), "old");
  await f.registry.get(f.input);
  const { directory } = mocks.open.mock.calls[0]![0];
  expect(dirname(directory)).toBe(join(f.input.rootPath, ".dohc", "local", "dataset-copies"));
  // Windows keeps no POSIX mode bits, so Node reports 0o666 there.
  if (process.platform !== "win32")
    for (const folder of [dirname(directory), directory])
      expect((await lstat(folder)).mode & 0o777).toBe(0o700);
  expect(await readdir(old)).toEqual(["replica.sqlite"]);
  expect(await readFile(join(old, "replica.sqlite"), "utf8")).toBe("old");
  const store = join(f.input.rootPath, ".dohc", "local", "datasets");
  await mkdir(store);
  await writeFile(join(store, "state.sqlite"), "the Collections");
  const removedBefore = files.removed.length;
  await f.registry.credentialsChanged(null);
  expect(await readdir(dirname(directory))).toEqual([]);
  expect(await readdir(join(f.input.rootPath, ".dohc"))).toEqual(["local"]);
  expect(await readFile(join(store, "state.sqlite"), "utf8")).toBe("the Collections");
  expect(
    files.removed
      .slice(removedBefore)
      .filter((path) => !path.startsWith(dirname(directory)) && !path.startsWith(old)),
  ).toEqual([]);
});
it.skipIf(process.platform === "win32").each(["writable by others", "hard-linked"])(
  "does not open a replica database that is %s",
  async (kind) => {
    const f = await fixture(),
      first = new AbortController();
    const copy = await f.registry.get({ ...f.input, lifetime: first.signal });
    const { directory } = mocks.open.mock.calls[0]![0];
    first.abort();
    await copy.close();
    const planted = join(directory, "replica.sqlite");
    await writeFile(planted, "planted");
    if (kind === "writable by others") await chmod(planted, 0o666);
    else await link(planted, join(f.input.rootPath, "elsewhere.sqlite"));
    await expect(f.registry.get(f.input)).rejects.toThrow(
      `dohc did not open this Collection's offline copy because it can't trust a file in .dohc/local/dataset-copies/${basename(directory)}. Remove that folder, then try again.`,
    );
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(await readFile(planted, "utf8")).toBe("planted");
    await rm(directory, { recursive: true });
    await f.registry.get(f.input);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  },
);

async function failedSignOut() {
  const f = await fixture();
  await f.registry.get(f.input);
  const { directory } = mocks.open.mock.calls[0]![0] as { directory: string };
  files.busy.add(directory);
  await expect(f.registry.credentialsChanged(null)).rejects.toThrow("EBUSY");
  return { ...f, directory, root: await realpath(f.input.rootPath) };
}
const nothing = { workspaces: [], recordUnreadable: false, sweepPending: false },
  tag = expect.stringMatching(/^[0-9a-f]{16}$/);
it("records a folder it could not remove, and the next start removes it before another account's copy opens", async () => {
  const f = await failedSignOut();
  expect(JSON.parse(await readFile(f.record, "utf8"))).toEqual({
    folders: [f.directory],
    departed: [tag],
  });
  files.busy.clear();
  const next = restart(f.record),
    other = {
      ...f.input,
      lifetime: new AbortController().signal,
      ownerKey: datasetCopyOwnerKey({ serverUrl: "https://account", userId: "other" }),
    };
  let leftAtOpen: boolean | undefined;
  mocks.open.mockImplementationOnce(async (options) => {
    leftAtOpen = await lstat(f.directory).then(
      () => true,
      () => false,
    );
    return { close: vi.fn(async () => {}), assertOwner: options.assertOwner, data: vi.fn() };
  });
  void next.credentialsChanged(other.ownerKey);
  await next.get(other);
  expect(leftAtOpen).toBe(false);
  expect(next.leftover()).toEqual(nothing);
  expect(JSON.parse(await readFile(f.record, "utf8"))).toEqual({
    folders: [],
    departed: [tag],
    account: tag,
  });
});
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "says when it cannot read its record, writes nothing over it, and reads it again on Try again",
  async () => {
    const f = await failedSignOut();
    files.busy.clear();
    const text = await readFile(f.record, "utf8"),
      elsewhere = await mkdtemp(join(tmpdir(), "dohc-copy-registry-elsewhere-"));
    cleanups.push(() => rm(elsewhere, { recursive: true, force: true }));
    await chmod(f.record, 0o000);
    cleanups.push(() => chmod(f.record, 0o600).catch(() => undefined));
    const onLeftover = vi.fn(),
      next = restart(f.record, [elsewhere], onLeftover);
    await expect(next.credentialsChanged(null)).rejects.toThrow("EACCES");
    expect(next.leftover()).toEqual({ ...nothing, recordUnreadable: true });
    expect(onLeftover).toHaveBeenCalledOnce();
    await next.credentialsChanged(f.input.ownerKey).catch(() => undefined);
    await expect(next.credentialsChanged(null)).rejects.toThrow("EACCES");
    await chmod(f.record, 0o600);
    expect(await readFile(f.record, "utf8")).toBe(text);
    await next.removeLeftover();
    expect(await readdir(dirname(f.directory))).toEqual([]);
    expect(next.leftover()).toEqual(nothing);
    expect(onLeftover).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(f.record, "utf8"))).toEqual({ folders: [], departed: [tag] });
  },
);
it("records what a sign-out will remove before any copy closes, so a stop part way leaves it for the next start", async () => {
  const f = await fixture(),
    copy = await f.registry.get(f.input),
    { directory } = mocks.open.mock.calls[0]![0] as { directory: string };
  const closing = deferred<void>(),
    closeCalled = deferred<void>();
  vi.mocked(copy.close).mockImplementationOnce(() => {
    closeCalled.resolve();
    return closing.promise;
  });
  const removal = f.registry.credentialsChanged(null);
  try {
    await closeCalled.promise;
    await restart(f.record).credentialsChanged(null);
    expect(await readdir(dirname(directory))).toEqual([]);
  } finally {
    closing.resolve();
  }
  await removal;
});
it.skipIf(process.platform === "win32")(
  "follows no link swapped in for a recorded folder, and removes nothing a record names outside a workspace's copies",
  async () => {
    const f = await failedSignOut();
    files.busy.clear();
    const outside = await mkdtemp(join(tmpdir(), "dohc-copy-registry-outside-")),
      stray = await mkdtemp(join(tmpdir(), "dohc-copy-registry-stray-"));
    cleanups.push(
      () => rm(outside, { recursive: true, force: true }),
      () => rm(stray, { recursive: true, force: true }),
    );
    await writeFile(join(outside, "keep.txt"), "not dohc's");
    await writeFile(join(stray, "keep.txt"), "not dohc's");
    await rm(f.directory, { recursive: true });
    await symlink(outside, f.directory, "dir");
    await writeFile(f.record, JSON.stringify({ folders: [f.directory, stray] }));
    const next = restart(f.record);
    await expect(next.credentialsChanged(null)).rejects.toThrow(
      "Collection copy storage changed. Its files were not removed.",
    );
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("not dohc's");
    expect((await lstat(f.directory)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(stray, "keep.txt"), "utf8")).toBe("not dohc's");
    expect(next.leftover()).toEqual({ ...nothing, workspaces: [f.root] });
    expect(JSON.parse(await readFile(f.record, "utf8"))).toEqual({ folders: [f.directory] });
  },
);
it("removes only the copies of accounts that left in a look still owed, never the signed-in account's, after a restart", async () => {
  const earlier = await mkdtemp(join(tmpdir(), "dohc-copy-registry-earlier-"));
  cleanups.push(() => rm(earlier, { recursive: true, force: true }));
  let listing = false;
  const f = await fixture({
    workspaces: (rootPath) => {
      if (!listing) throw new Error("dohc could not read its workspace list.");
      return [rootPath, earlier];
    },
  });
  await f.registry.get(f.input);
  const { directory: first } = mocks.open.mock.calls[0]![0] as { directory: string };
  expect(basename(first)).toMatch(/^[0-9a-f]{16}-[0-9a-f]{16}$/);
  // Account A's copies from an earlier run in another workspace: one with its tag, and one from before tags.
  const copies = join(earlier, ".dohc", "local", "dataset-copies"),
    tagged = join(copies, `${basename(first).slice(0, 16)}-${"1".repeat(16)}`),
    untagged = join(copies, "2".repeat(64));
  for (const copy of [tagged, untagged]) {
    await mkdir(copy, { recursive: true });
    await writeFile(join(copy, "replica.sqlite"), "A's data");
  }
  await expect(f.registry.credentialsChanged(null)).rejects.toThrow("workspace list");
  const b = datasetCopyOwnerKey({ serverUrl: "https://account", userId: "b" });
  await expect(f.registry.credentialsChanged(b)).rejects.toThrow("workspace list");
  await openedLocalState({ workspaceId: "e", rootPath: earlier });
  for (const input of [
    { ...f.input, ownerKey: b, lifetime: new AbortController().signal },
    {
      ...f.input,
      workspaceId: "e",
      rootPath: earlier,
      ownerKey: b,
      lifetime: new AbortController().signal,
    },
  ])
    await f.registry.get(input);
  const mine = mocks.open.mock.calls
    .slice(1)
    .map(([options]) => (options as { directory: string }).directory);
  // B's copy under the older long name counts as an account that left.
  const long = join(copies, `${basename(mine[0]!).slice(0, 16)}-${"3".repeat(64)}`);
  await mkdir(long);
  await writeFile(join(long, "replica.sqlite"), "B's data");
  listing = true;
  await restart(f.record, [f.input.rootPath, earlier]).credentialsChanged(null);
  for (const copy of mine) expect(await readdir(copy)).toEqual(["owned.sqlite"]);
  for (const copy of [first, tagged, untagged, long])
    await expect(lstat(copy)).rejects.toThrow("ENOENT");
  expect(JSON.parse(await readFile(f.record, "utf8"))).toEqual({
    folders: [],
    departed: [tag],
    account: tag,
  });
});
it("removes the copies of an account cleared outside dohc once another account signs in, and no other account's", async () => {
  const f = await fixture();
  await f.registry.get(f.input);
  const { directory } = mocks.open.mock.calls[0]![0] as { directory: string };
  // Another installation on this computer keeps its own account's copy in the same workspace.
  const theirs = join(dirname(directory), `${"c".repeat(16)}-${"1".repeat(16)}`);
  await mkdir(theirs);
  await writeFile(join(theirs, "replica.sqlite"), "their data");
  // A's sign-in is cleared outside dohc, so the next start has no account and keeps A's copy.
  const next = restart(f.record, [f.input.rootPath]);
  await next.credentialsChanged(null);
  expect(await readdir(directory)).toEqual(["owned.sqlite"]);
  const b = datasetCopyOwnerKey({ serverUrl: "https://account", userId: "b" });
  await next.credentialsChanged(b);
  await expect(lstat(directory)).rejects.toThrow("ENOENT");
  expect(await readdir(theirs)).toEqual(["replica.sqlite"]);
  await next.get({ ...f.input, ownerKey: b, lifetime: new AbortController().signal });
  const { directory: mine } = mocks.open.mock.calls[1]![0] as { directory: string };
  expect(await readdir(mine)).toEqual(["owned.sqlite"]);
  expect(next.leftover()).toEqual(nothing);
  // B's sign-in is cleared too: a start that signs B in again removes nothing.
  const third = restart(f.record, [f.input.rootPath]);
  await third.credentialsChanged(b);
  expect(await readdir(mine)).toEqual(["owned.sqlite"]);
  expect(await readdir(theirs)).toEqual(["replica.sqlite"]);
});

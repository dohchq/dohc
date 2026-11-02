import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createMoveAcceptedEditsGuard, type LiveDocumentPath } from "./moveAcceptedEditsGuard";
import { createTestScratch } from "./testTemp";
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";
import { moveWorkspacePathByHand, prepareMoveWorkspacePathAs } from "./workspaceFileMoves";

// #3089: every route that renames or moves a live page waits for the move
// guard first, before it takes the workspace lock or calls the capture.

// Counts every node:fs/promises call, to price a move's disk work.
const fsCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name, name !== "default" && typeof value === "function"
    ? (...args: unknown[]) => { fsCalls.count += 1; return (value as (...args: unknown[]) => unknown)(...args); } : value]));
});

const person = { kind: "human" as const, humanId: "local:installation" };

async function workspace(files: string[]) {
  const rootPath = await createTestScratch("move-guard");
  for (const file of files) {
    await mkdir(dirname(join(rootPath, file)), { recursive: true });
    await writeFile(join(rootPath, file), "body\n");
  }
  const order: string[] = [];
  const gate = deferred();
  const beforeMove = vi.fn(async (storedSpelling: () => Promise<string>) => {
    order.push(`before ${await storedSpelling()}`); await gate.promise; order.push("released");
  });
  // The capture stops each move as it starts: these tests only check what ran first.
  const capture = {
    changePathsAs: vi.fn(async () => { order.push("capture"); throw new Error("stopped at capture"); }),
    beginFileRename: vi.fn(async () => { order.push("capture"); throw new Error("stopped at capture"); }),
  };
  const operation = { workspace: { workspaceId: "workspace", rootPath, attachmentId: Symbol("attachment") }, state: undefined,
    signal: new AbortController().signal, assertCurrent() {} };
  // While the guard waits, nothing holds the workspace lock.
  const lockIsFree = () => withExclusiveWorkspaceOperation(rootPath, async () => { order.push("lock free"); });
  return { rootPath, order, gate, beforeMove, capture, operation, lockIsFree };
}

it.each([
  { route: "app rename of a page", from: "Notes/Page.md", to: "Notes/Renamed.md", expected: "Notes/Page.md" },
  { route: "app drag of a page into a folder", from: "Notes/Page.md", to: "Plans/Page.md", expected: "Notes/Page.md" },
  { route: "app move of a folder", from: "Notes", to: "Archive", expected: "Notes" },
])("the $route waits for the guard before the lock and the capture", async ({ from, to, expected }) => {
  const f = await workspace(["Notes/Page.md", "Plans/Other.md"]);
  const moving = moveWorkspacePathByHand(f.operation, { fromPath: from, toPath: to }, person,
    { capture: f.capture, requestId: "request", trashItem: async () => undefined, markDeleted: () => undefined, beforeMove: f.beforeMove }).catch(() => undefined);
  await vi.waitFor(() => expect(f.order).toContain(`before ${expected}`));
  await f.lockIsFree();
  f.gate.resolve();
  await moving;
  expect(f.order).toEqual([`before ${expected}`, "lock free", "released", "capture"]);
});

it.skipIf(process.platform === "linux")("the guard sees the stored spelling when the app names a case alias", async () => {
  const f = await workspace(["Notes/Page.md"]);
  f.gate.resolve();
  await moveWorkspacePathByHand(f.operation, { fromPath: "notes/page.md", toPath: "notes/renamed.md" }, person,
    { capture: f.capture, requestId: "request", trashItem: async () => undefined, markDeleted: () => undefined, beforeMove: f.beforeMove }).catch(() => undefined);
  expect(f.order).toContain("before Notes/Page.md");
});

it("the app's move without a capture still waits for the guard before the disk changes", async () => {
  const f = await workspace(["Notes/Page.md"]);
  const moving = moveWorkspacePathByHand(f.operation, { fromPath: "Notes/Page.md", toPath: "Notes/Renamed.md" }, person,
    { capture: null, requestId: "request", trashItem: async () => undefined, markDeleted: () => undefined, beforeMove: f.beforeMove });
  await vi.waitFor(() => expect(f.order).toContain("before Notes/Page.md"));
  await f.lockIsFree();
  expect(existsSync(join(f.rootPath, "Notes/Page.md"))).toBe(true);
  f.gate.resolve();
  await moving;
  expect(existsSync(join(f.rootPath, "Notes/Renamed.md"))).toBe(true);
});

it.each([
  { route: "a page", from: "Notes/Page.md", to: "Plans/Page.md" },
  { route: "a folder", from: "Notes", to: "Archive" },
])("an agent's move of $route waits for the guard before the lock and the capture", async ({ from, to }) => {
  const f = await workspace(["Notes/Page.md", "Plans/Other.md"]);
  const preparing = prepareMoveWorkspacePathAs(f.operation, { fromPath: from, toPath: to },
    { kind: "agent", agentId: "dohc-mcp", onBehalfOf: person.humanId },
    { capture: f.capture, requestId: "request", trashItem: async () => undefined, markDeleted: () => undefined, beforeMove: f.beforeMove });
  await vi.waitFor(() => expect(f.order).toContain(`before ${from}`));
  await f.lockIsFree();
  f.gate.resolve();
  const finish = await preparing;
  expect(f.order.slice(0, 3)).toEqual([`before ${from}`, "lock free", "released"]);
  expect(await finish()).toMatchObject({ ok: false });
  expect(f.order.at(-1)).toBe("capture");
});

// The timeout path: the guard gives up, reports nothing, and the move lands.
it.each([
  { name: "the owner sync never answers", owner: () => new Promise<boolean>(() => {}), relay: async () => undefined },
  { name: "the guard's pull hangs, then rejects", owner: async () => true,
    relay: (_id: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => setImmediate(() => reject(new Error("relay unavailable"))), { once: true })) },
])("a move goes ahead when $name", async ({ owner, relay }) => {
  const f = await workspace(["Notes/Page.md"]);
  const relayCatchUp = vi.fn(relay);
  const guard = createMoveAcceptedEditsGuard({ liveDocuments: () => [{ path: "Notes/Page.md", objectId: "page" }], offline: () => false,
    ownerCatchUp: owner, relayCatchUp, waitMs: 50 });
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const moved = await moveWorkspacePathByHand(f.operation, { fromPath: "Notes/Page.md", toPath: "Notes/Renamed.md" }, person,
      { capture: null, requestId: "request", trashItem: async () => undefined, markDeleted: () => undefined,
        beforeMove: storedSpelling => guard.beforeMove("workspace", storedSpelling) });
    expect(moved.path).toBe("Notes/Renamed.md");
    expect(existsSync(join(f.rootPath, "Notes/Renamed.md"))).toBe(true);
    expect(existsSync(join(f.rootPath, "Notes/Page.md"))).toBe(false);
    if (relayCatchUp.mock.calls.length) await vi.waitFor(() => expect(relayCatchUp.mock.results[0]!.value).rejects.toThrow("relay unavailable"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off("unhandledRejection", unhandled); }
});

type MoveFixture = Awaited<ReturnType<typeof workspace>>;
type Guarded = { beforeMove?(storedSpelling: () => Promise<string>): Promise<void> };
const base = (f: MoveFixture) => ({ capture: f.capture, requestId: "request", trashItem: async () => undefined, markDeleted: () => undefined });
it.each([
  { route: "app", move: (f: MoveFixture, guarded: Guarded) => moveWorkspacePathByHand(f.operation,
    { fromPath: "Notes/Page.md", toPath: "Notes/Renamed.md" }, person, { ...base(f), ...guarded }).catch(() => undefined) },
  { route: "agent", move: async (f: MoveFixture, guarded: Guarded) => (await prepareMoveWorkspacePathAs(f.operation,
    { fromPath: "Notes/Page.md", toPath: "Notes/Renamed.md" }, { kind: "agent", agentId: "dohc-mcp", onBehalfOf: person.humanId },
    { ...base(f), ...guarded }))().catch(() => undefined) },
])("an $route rename in a workspace with no live page does no more disk work than with no guard", async ({ move }) => {
  const guarded = (live: LiveDocumentPath[]): Guarded => {
    const guard = createMoveAcceptedEditsGuard({ liveDocuments: () => live, offline: () => false,
      ownerCatchUp: async () => true, relayCatchUp: async () => undefined });
    return { beforeMove: storedSpelling => guard.beforeMove("workspace", storedSpelling) };
  };
  const calls: number[] = [];
  for (const options of [{}, guarded([]), guarded([{ path: "Plans/Trip.md", objectId: "trip" }])]) {
    const f = await workspace(["Notes/Page.md"]);
    fsCalls.count = 0;
    await move(f, options);
    calls.push(fsCalls.count);
  }
  expect(calls[1]).toBe(calls[0]);
  // With a live page elsewhere, the guard reads the source's spelling.
  expect(calls[2]).toBeGreaterThan(calls[0]!);
});

// A folder move refused for a page live on this computer is refused before
// the guard catches anything up. A folder whose listed page is live only
// elsewhere, and a single page, still wait for it.
it.each([
  { route: "app", move: (f: MoveFixture, options: Guarded, from: string, to: string) =>
    moveWorkspacePathByHand(f.operation, { fromPath: from, toPath: to }, person, { ...base(f), ...options }) },
  { route: "agent", move: async (f: MoveFixture, options: Guarded, from: string, to: string) => (await prepareMoveWorkspacePathAs(f.operation,
    { fromPath: from, toPath: to }, { kind: "agent", agentId: "dohc-mcp", onBehalfOf: person.humanId }, { ...base(f), ...options }))() },
])("an $route folder move over a page live here catches nothing up; other moves still do", async ({ move }) => {
  for (const { from, to, liveHere, checked } of [
    { from: "Notes", to: "Archive", liveHere: true, checked: true },
    { from: "Notes", to: "Archive", liveHere: false, checked: true },
    { from: "Notes/Page.md", to: "Notes/Renamed.md", liveHere: true, checked: false },
  ]) {
    const f = await workspace(["Notes/Page.md"]);
    const checkFolderMove = vi.fn(async () => { if (liveHere) throw new Error("refused for a page live here"); });
    const ownerCatchUp = vi.fn(async () => true);
    const guard = createMoveAcceptedEditsGuard({ liveDocuments: () => [{ path: "Notes/Page.md", objectId: "page" }], offline: () => false,
      ownerCatchUp, relayCatchUp: async () => undefined });
    Object.assign(f.capture, { checkFolderMove });
    await move(f, { beforeMove: storedSpelling => guard.beforeMove("workspace", storedSpelling) }, from, to)
      .catch(() => undefined);
    expect(checkFolderMove.mock.calls).toEqual(checked ? [[from]] : []);
    const caughtUp = !(checked && liveHere);
    expect(ownerCatchUp.mock.calls).toEqual(caughtUp ? [["workspace", ["page"], expect.any(AbortSignal)]] : []);
    // The move still reaches the capture, whose own check refuses it there.
    expect(f.order).toEqual(["capture"]);
    const captured = [...f.capture.changePathsAs.mock.invocationCallOrder, ...f.capture.beginFileRename.mock.invocationCallOrder];
    if (caughtUp) expect(ownerCatchUp.mock.invocationCallOrder[0]).toBeLessThan(captured[0]!);
    expect(existsSync(join(f.rootPath, "Notes/Page.md"))).toBe(true);
  }
});

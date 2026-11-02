import {afterEach, expect, it, vi} from "vitest";
import {deferred, type Deferred} from "../testing/deferred";
import {createMoveAcceptedEditsGuard, MOVE_ACCEPTED_EDITS_WAIT_MS, type LiveDocumentPath} from "./moveAcceptedEditsGuard";

afterEach(() => vi.useRealTimers());

const pages: LiveDocumentPath[] = [
  {path: "Notes/Page.md", objectId: "page"},
  {path: "Notes/Other.md", objectId: "other"},
  {path: "Plans/Trip.md", objectId: "trip"},
];

// Each owner and relay call waits until the test settles it.
function harness(options: {live?: readonly LiveDocumentPath[]; offline?: boolean} = {}) {
  vi.useFakeTimers();
  const owner: Array<{workspaceId: string; objectIds: readonly string[]; signal: AbortSignal; reply: Deferred<boolean>}> = [];
  const relay: Array<{workspaceId: string; signal: AbortSignal; reply: Deferred<void>}> = [];
  const live = options.live === undefined ? pages : options.live;
  const offline = vi.fn(() => options.offline ?? false);
  // Moves the guard's clock without running any timer.
  let skew = 0;
  const guard = createMoveAcceptedEditsGuard({
    now: () => Date.now() + skew,
    liveDocuments: id => id === "workspace" ? live : undefined,
    offline,
    ownerCatchUp(workspaceId, objectIds, signal) {
      const reply = deferred<boolean>();
      owner.push({workspaceId, objectIds, signal, reply});
      return reply.promise;
    },
    relayCatchUp(workspaceId, signal) {
      const reply = deferred();
      relay.push({workspaceId, signal, reply});
      return reply.promise;
    },
  });
  // A move's wait, with whether it has gone ahead yet.
  const move = (path: string, workspaceId = "workspace") => {
    const state = {done: false};
    const wait = guard.beforeMove(workspaceId, path).then(() => {state.done = true;});
    return Object.assign(state, {wait});
  };
  return {owner, relay, offline, move, settle: () => vi.advanceTimersByTimeAsync(0), at: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    jump: (ms: number) => {skew += ms;}};
}

it("runs nothing for a path that is not live, or before the first live list", async () => {
  const h = harness();
  const plain = h.move("Notes/Plain.md");
  const unknown = h.move("Notes/Page.md", "elsewhere");
  await h.settle();
  expect(plain.done && unknown.done).toBe(true);
  expect(h.owner).toEqual([]);
  expect(h.relay).toEqual([]);
  expect(h.offline).not.toHaveBeenCalled();
});

it("matches the stored spelling at or under the path, never a partial name or another spelling", async () => {
  const h = harness();
  for (const path of ["Notes/Pa", "notes/page.md", "notes", "Note"]) {
    const other = h.move(path);
    await h.settle();
    expect(other.done, path).toBe(true);
  }
  expect(h.owner).toEqual([]);
  const file = h.move("Notes/Page.md");
  await h.settle();
  expect(h.owner.map(call => call.objectIds)).toEqual([["page"]]);
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  h.relay[0]!.reply.resolve();
  await file.wait;
  const folder = h.move("Notes");
  await h.settle();
  expect(h.owner[1]!.objectIds).toEqual(["page", "other"]);
  h.owner[1]!.reply.resolve(true);
  await h.settle();
  h.relay[1]!.reply.resolve();
  await folder.wait;
});

it("skips the catch-up when sync already reports a failure", async () => {
  const h = harness({offline: true});
  const moved = h.move("Notes/Page.md");
  await h.settle();
  expect(moved.done).toBe(true);
  expect(h.owner).toEqual([]);
  expect(h.relay).toEqual([]);
});

it("runs the owner sync, then the pull, before the move goes ahead", async () => {
  const h = harness();
  const moved = h.move("Notes/Page.md");
  await h.settle();
  expect(h.owner).toHaveLength(1);
  expect(h.relay).toEqual([]);
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  expect(h.relay).toHaveLength(1);
  expect(h.relay[0]!.signal).toBe(h.owner[0]!.signal);
  expect(moved.done).toBe(false);
  h.relay[0]!.reply.resolve();
  await h.settle();
  expect(moved.done).toBe(true);
});

it("goes ahead without a pull when an owner sync did not answer", async () => {
  const h = harness();
  const moved = h.move("Notes/Page.md");
  await h.settle();
  h.owner[0]!.reply.resolve(false);
  await h.settle();
  expect(moved.done).toBe(true);
  expect(h.relay).toEqual([]);
});

it("goes ahead at the deadline, aborts the attempt, and starts no pull for a late answer", async () => {
  const h = harness();
  const moved = h.move("Notes/Page.md");
  await h.at(MOVE_ACCEPTED_EDITS_WAIT_MS - 1);
  expect(moved.done).toBe(false);
  expect(h.owner[0]!.signal.aborted).toBe(false);
  await h.at(1);
  expect(moved.done).toBe(true);
  expect(h.owner[0]!.signal.aborted).toBe(true);
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  expect(h.relay).toEqual([]);
});

it("swallows a late owner rejection and a failed pull", async () => {
  const h = harness();
  const late = h.move("Notes/Page.md");
  await h.at(MOVE_ACCEPTED_EDITS_WAIT_MS);
  expect(late.done).toBe(true);
  h.owner[0]!.reply.reject(new Error("socket closed"));
  await h.settle();
  const failed = h.move("Notes/Page.md");
  await h.settle();
  h.owner[1]!.reply.resolve(true);
  await h.settle();
  h.relay[0]!.reply.reject(new Error("relay unavailable"));
  await h.settle();
  expect(failed.done).toBe(true);
});

it.each([
  {phase: "owner sync", during: async (h: ReturnType<typeof harness>) => {await h.settle();}},
  {phase: "ordinary pull", during: async (h: ReturnType<typeof harness>) => {h.owner[0]!.reply.resolve(true); await h.settle();}},
])("a move for another page that arrives during the $phase gets its own owner sync and pull", async ({during}) => {
  const h = harness();
  const first = h.move("Notes/Page.md");
  await h.settle();
  await during(h);
  const second = h.move("Plans/Trip.md");
  await h.settle();
  expect(h.owner).toHaveLength(1);
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  h.relay[0]!.reply.resolve();
  await h.settle();
  expect(first.done).toBe(true);
  // The second move is not released by the first attempt.
  expect(second.done).toBe(false);
  expect(h.owner).toHaveLength(2);
  expect(h.owner[1]!.objectIds).toEqual(["trip"]);
  h.owner[1]!.reply.resolve(true);
  await h.settle();
  expect(second.done).toBe(false);
  h.relay[1]!.reply.resolve();
  await h.settle();
  expect(second.done).toBe(true);
  expect(h.owner).toHaveLength(2);
});

it("a move whose pages the active attempt covers joins it", async () => {
  const h = harness();
  const folder = h.move("Notes");
  await h.settle();
  const page = h.move("Notes/Other.md");
  await h.settle();
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  h.relay[0]!.reply.resolve();
  await h.settle();
  expect(folder.done && page.done).toBe(true);
  expect(h.owner).toHaveLength(1);
  expect(h.relay).toHaveLength(1);
});

it("a pending move keeps its own deadline behind a held attempt, and its expired attempt never starts", async () => {
  const h = harness();
  const first = h.move("Notes/Page.md");
  await h.at(1000);
  const second = h.move("Plans/Trip.md");
  // The first attempt's native cleanup is held past both deadlines.
  await h.at(MOVE_ACCEPTED_EDITS_WAIT_MS - 1000);
  expect(first.done).toBe(true);
  expect(second.done).toBe(false);
  await h.at(999);
  expect(second.done).toBe(false);
  await h.at(1);
  expect(second.done).toBe(true);
  h.owner[0]!.reply.resolve(true);
  await h.at(10_000);
  expect(h.owner).toHaveLength(1);
  expect(h.relay).toEqual([]);
});

it("a later move that joins a pending attempt keeps it alive only for itself", async () => {
  const h = harness();
  h.move("Notes/Page.md");
  await h.at(1000);
  const second = h.move("Plans/Trip.md");
  await h.at(1500);
  const third = h.move("Notes/Other.md");
  await h.at(1500);
  // The second move still goes ahead 3 s after it arrived.
  expect(second.done).toBe(true);
  expect(third.done).toBe(false);
  // Released before the third move's deadline, the pending attempt starts with both pages.
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  expect(h.owner.map(call => call.objectIds)).toEqual([["page"], ["trip", "other"]]);
  expect(h.relay).toEqual([]);
  expect(h.owner[1]!.signal.aborted).toBe(false);
  await h.at(1499);
  expect(third.done).toBe(false);
  await h.at(1);
  expect(third.done).toBe(true);
  expect(h.owner[1]!.signal.aborted).toBe(true);
});

// The event loop can be busy past a deadline, so promises settle before the
// timer that aborts the attempt runs.
it("starts no pull for an owner answer that arrives after the deadline, before its timer runs", async () => {
  const h = harness();
  const moved = h.move("Notes/Page.md");
  await h.settle();
  h.jump(MOVE_ACCEPTED_EDITS_WAIT_MS);
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  expect(h.relay).toEqual([]);
  expect(moved.done).toBe(true);
});

it("never starts a pending attempt whose deadline passed before the held one finished, and releases its move", async () => {
  const h = harness();
  h.move("Notes/Page.md");
  await h.at(1000);
  const second = h.move("Plans/Trip.md");
  await h.settle();
  h.jump(MOVE_ACCEPTED_EDITS_WAIT_MS);
  h.owner[0]!.reply.resolve(false);
  await h.settle();
  expect(h.owner).toHaveLength(1);
  expect(second.done).toBe(true);
});

it("keeps an attempt open until the deadline of the last move that joined it", async () => {
  const h = harness();
  const first = h.move("Notes/Page.md");
  await h.at(2000);
  const second = h.move("Notes/Page.md");
  await h.settle();
  // Past the first move's deadline, before the second's.
  h.jump(1500);
  h.owner[0]!.reply.resolve(true);
  await h.settle();
  expect(h.relay).toHaveLength(1);
  h.relay[0]!.reply.resolve();
  await h.settle();
  expect(first.done && second.done).toBe(true);
});

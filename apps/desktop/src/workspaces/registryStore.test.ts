import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RETAINED_SKIPPED_OPS,
  MAX_TRACKED_BATCH_COORDINATES,
  MAX_TRACKED_SKIP_COORDINATES,
  acknowledgeShareSkips,
  createRegistryStore,
  mergeShareSkippedOps,
} from "./registryStore";
// The predicate the RENDERER acts on, asserted here against the records this
// store produces: one rule, and the surfaces that show the warning read it
// from the same place.
import { hasUnacknowledgedShareSkips } from "../renderer/shareSkipNotice";
import { createTestScratch } from "./testTemp";

let store: ReturnType<typeof createRegistryStore>;
let registryPath: string;

const personal = {
  workspaceId: "ws-1",
  rootPath: "/home/ice/dohc/personal",
  kind: "personal" as const,
  mode: "local-first" as const,
};

beforeEach(async () => {
  const dir = await createTestScratch("dohc-registry-");
  registryPath = join(dir, "workspaces.json");
  store = createRegistryStore(registryPath);
});

describe("share skip records", () => {
  const op = (originSeq: number) => ({
    originId: "origin-granter",
    originSeq,
    opKind: "moment.append",
    code: "share-boundary-violation",
    detail: `refused ${originSeq}`,
    atMs: 1000 + originSeq,
  });

  // A page is re-fetched whenever a refresh crashes before its cursor commit,
  // or a later page fails and the pull is retried. The same skipped op must
  // not stack up in the record, or the count the banner shows drifts away
  // from what actually happened.
  it("merges the same skipped op once, however often its page is refetched", () => {
    const first = mergeShareSkippedOps(undefined, [op(4), op(9)]);
    const again = mergeShareSkippedOps(first, [op(4), op(9), op(11)]);
    expect(
      again.ops.map((entry) => entry.originSeq),
      "MUTATION: appending blindly makes one retried page look like several failures",
    ).toEqual([4, 9, 11]);
    expect(again.more).toBe(0);
  });

  // The engine files an op with no usable coordinate under its page position,
  // in a namespace no relay origin id can enter (`relay.rs`,
  // `PAGE_POSITION_NAMESPACE`). This is the layer that would swallow a
  // collision: two refusals sharing a coordinate merge into one, and the
  // second never raises the generation, so acknowledging the first hides a
  // later, different refusal whose cursor has already committed.
  it("keeps a relay origin named like a page position apart from the real one", () => {
    const relayOrigin = { ...op(1), originId: "share-page:0", detail: "relay" };
    const pagePosition = {
      ...op(1),
      originId: "\u001fshare-page:0",
      detail: "page position",
    };

    const afterAcknowledgingTheRelayOrigin = (
      second: typeof relayOrigin,
    ): ReturnType<typeof mergeShareSkippedOps> => {
      const first = mergeShareSkippedOps(undefined, [relayOrigin]);
      return mergeShareSkippedOps(
        acknowledgeShareSkips(first, first.generation),
        [second],
      );
    };

    const namespaced = afterAcknowledgingTheRelayOrigin(pagePosition);
    expect(
      hasUnacknowledgedShareSkips(namespaced),
      "MUTATION: a page position shares a relay origin's coordinate, so acknowledging one hides the other",
    ).toBe(true);
    expect(namespaced.ops.map((entry) => entry.detail)).toEqual([
      "relay",
      "page position",
    ]);

    // What the collision costs, stated as its own case: with one coordinate
    // the merge is RIGHT to read the second as a retry, and the warning stays
    // hidden. The separation has to come from the engine, which is where it
    // is proved — `a_relay_origin_named_like_a_page_position_stays_a_separate_refusal`.
    const colliding = afterAcknowledgingTheRelayOrigin({
      ...pagePosition,
      originId: relayOrigin.originId,
    });
    expect(hasUnacknowledgedShareSkips(colliding)).toBe(false);
    expect(colliding.ops).toHaveLength(1);
  });

  // Idempotence has to survive the CAP. Beyond the retained list an op is
  // dropped, so the list alone can no longer answer "have I counted this
  // one?" — and a refetched page would re-count it on every retry, inflating
  // the number the banner shows.
  it("counts an overflowed op once, however often its page is refetched", () => {
    const many = Array.from({ length: MAX_RETAINED_SKIPPED_OPS + 5 }, (_, index) =>
      op(index),
    );
    const first = mergeShareSkippedOps(undefined, many);
    expect(first.more).toBe(5);
    const retried = mergeShareSkippedOps(first, many);
    expect(
      retried.more,
      "MUTATION: without a per-origin watermark every retry re-counts the ops the cap dropped",
    ).toBe(5);
    expect(retried.ops).toHaveLength(MAX_RETAINED_SKIPPED_OPS);
    // A genuinely new op past the cap still counts.
    expect(mergeShareSkippedOps(retried, [op(9999)]).more).toBe(6);
  });

  // The relay chooses how many ops it serves; this registry is a local file
  // the app rewrites on every workspace change. So the list is retained up to
  // the cap and the rest are counted.
  it("retains up to the cap and counts the rest", () => {
    const many = Array.from({ length: MAX_RETAINED_SKIPPED_OPS + 5 }, (_, index) =>
      op(index),
    );
    const merged = mergeShareSkippedOps(undefined, many);
    expect(merged.ops).toHaveLength(MAX_RETAINED_SKIPPED_OPS);
    expect(
      merged.more,
      "MUTATION: an unbounded list lets a misbehaving relay grow the registry file without limit",
    ).toBe(5);
    // And a later batch keeps counting rather than dropping the fact.
    expect(mergeShareSkippedOps(merged, [op(999)]).more).toBe(6);
  });

  // A dismissal names the generation the user saw. So a write that ADDS
  // something must move it — otherwise a refusal recorded between the render
  // and the click is cleared unseen, and the cursor has already committed
  // past that op.
  it("moves the generation only when a merge adds something", () => {
    const first = mergeShareSkippedOps(undefined, [op(4)]);
    expect(first.generation).toBe(1);
    expect(
      mergeShareSkippedOps(first, [op(4)]).generation,
      "MUTATION: bumping on every write invalidates a dismissal a refetched page did not change",
    ).toBe(1);
    expect(
      mergeShareSkippedOps(first, [op(5)]).generation,
      "MUTATION: a generation that never moves lets a stale click clear an unseen refusal",
    ).toBe(2);
  });

  // Dismissing must not DESTROY the record. The cursor has already committed
  // past those ops, so this is the only evidence of what is missing — a
  // one-click delete would be an irreversible change with no reverse path.
  // Acknowledging hides the warning and keeps the coordinates.
  it("hides an acknowledged warning without deleting its evidence", () => {
    const seen = mergeShareSkippedOps(undefined, [op(4)]);
    expect(hasUnacknowledgedShareSkips(seen)).toBe(true);

    const acknowledged = acknowledgeShareSkips(seen, seen.generation);

    expect(hasUnacknowledgedShareSkips(acknowledged)).toBe(false);
    expect(
      acknowledged.ops.map((entry) => entry.originSeq),
      "MUTATION: deleting the record destroys the only evidence of content the cursor has already passed",
    ).toEqual([4]);
  });

  // The race a destructive clear had to guard against does not exist here: a
  // refusal recorded after the render has a HIGHER generation, so the click
  // cannot acknowledge it and the warning comes back on its own.
  it("leaves a refusal recorded after the render unacknowledged", () => {
    const seen = mergeShareSkippedOps(undefined, [op(4)]);
    const afterRefresh = mergeShareSkippedOps(seen, [op(9)]);

    const acknowledged = acknowledgeShareSkips(afterRefresh, seen.generation);

    expect(
      hasUnacknowledgedShareSkips(acknowledged),
      "MUTATION: acknowledging the whole record hides a refusal the user never saw",
    ).toBe(true);
    // Seeing it and clicking again settles it, and still keeps both ops.
    const settled = acknowledgeShareSkips(acknowledged, afterRefresh.generation);
    expect(hasUnacknowledgedShareSkips(settled)).toBe(false);
    expect(settled.ops).toHaveLength(2);
  });

  // An acknowledgement never moves backwards, so a click on a stale render
  // cannot un-see a newer one.
  it("never lowers an acknowledgement", () => {
    const record = mergeShareSkippedOps(
      mergeShareSkippedOps(undefined, [op(4)]),
      [op(9)],
    );
    const settled = acknowledgeShareSkips(record, record.generation);
    expect(acknowledgeShareSkips(settled, 1).acknowledgedGeneration).toBe(
      record.generation,
    );
  });

  // Retries stay exact far past the retained list: the record remembers the
  // coordinates it counted, not just the ops it kept.
  it("keeps counting exact for far more ops than it retains", () => {
    const many = Array.from({ length: MAX_RETAINED_SKIPPED_OPS + 40 }, (_, index) =>
      op(index),
    );
    const first = mergeShareSkippedOps(undefined, many);
    const retried = mergeShareSkippedOps(first, many);
    expect(
      retried.more,
      "MUTATION: forgetting a counted coordinate re-counts it on every retry",
    ).toBe(first.more);
    expect(retried.inexact).toBeUndefined();
    expect(retried.generation).toBe(first.generation);
  });

  // A per-origin high-water mark reads "everything below this is counted",
  // which is only true while ops arrive in sequence order — and nothing
  // checks that. A relay serving seq 100 and then a genuinely new seq 99
  // would have had 99 dismissed as a retry, leaving newly missing content
  // silent behind an acknowledged warning.
  it("does not read a lower sequence as a duplicate of a higher one", () => {
    const first = mergeShareSkippedOps(undefined, [op(100)]);
    const outOfOrder = mergeShareSkippedOps(first, [op(99)]);

    expect(
      outOfOrder.ops.map((entry) => entry.originSeq),
      "MUTATION: a high-water mark swallows an out-of-order coordinate it never counted",
    ).toEqual([100, 99]);
    expect(
      outOfOrder.generation,
      "...and leaves an acknowledged warning silent while content goes missing",
    ).toBe(first.generation + 1);
  });

  // Past the coordinate bound there is nowhere left to remember an op, so a
  // duplicate is indistinguishable from a new one. Counting it would make the
  // total drift UPWARD while the copy claims a lower bound, so the count
  // stops and says it is incomplete.
  it("stops counting where it can no longer tell a duplicate from a new op", () => {
    const many = Array.from({ length: MAX_TRACKED_SKIP_COORDINATES + 5 }, (_, index) =>
      op(index),
    );
    const first = mergeShareSkippedOps(undefined, many);
    expect(first.inexact).toBe(true);
    expect(first.more + first.ops.length).toBe(MAX_TRACKED_SKIP_COORDINATES);

    const retried = mergeShareSkippedOps(first, many);

    expect(
      retried.more,
      "MUTATION: counting an op it cannot dedupe makes the total drift UP while the copy says 'more than'",
    ).toBe(first.more);
    expect(
      retried.generation,
      "MUTATION: a moving generation resurrects an acknowledged warning with no new refusal behind it",
    ).toBe(first.generation);
  });

  // The exact -> inexact transition is itself news: content is missing that
  // the total does not name, and the cursor has committed past it.
  it("moves the generation once when the count stops being complete", () => {
    const upToCap = Array.from({ length: MAX_TRACKED_SKIP_COORDINATES }, (_, index) =>
      op(index),
    );
    const exact = mergeShareSkippedOps(undefined, upToCap);
    expect(exact.inexact).toBeUndefined();

    const beyond = mergeShareSkippedOps(exact, [op(9000)]);

    expect(beyond.inexact).toBe(true);
    expect(
      beyond.generation,
      "MUTATION: a silent transition leaves an acknowledged warning hidden while content goes missing",
    ).toBe(exact.generation + 1);
    // The SAME batch again is the retry, and stays quiet. A different one is
    // more content skipped, and speaks up — see the two tests below.
    expect(mergeShareSkippedOps(beyond, [op(9000)]).generation).toBe(
      beyond.generation,
    );
  });

  // Exactness and VISIBILITY are different questions. `inexact` flips once,
  // but every later batch the record cannot place is more content skipped
  // past a committed cursor — and after the user acknowledges the first one,
  // silence would hide all of it forever.
  it("re-raises an acknowledged warning when more unplaceable ops arrive", () => {
    const upToCap = Array.from({ length: MAX_TRACKED_SKIP_COORDINATES }, (_, index) =>
      op(index),
    );
    const atCap = mergeShareSkippedOps(undefined, upToCap);
    const firstBeyond = mergeShareSkippedOps(atCap, [op(9000)]);
    // The user sees it and dismisses it.
    const acknowledged = acknowledgeShareSkips(
      firstBeyond,
      firstBeyond.generation,
    );
    expect(hasUnacknowledgedShareSkips(acknowledged)).toBe(false);

    // A later pull skips more, and its cursor commits past them.
    const later = mergeShareSkippedOps(acknowledged, [op(9001)]);

    expect(
      hasUnacknowledgedShareSkips(later),
      "MUTATION: once inexact, later skipped content stays hidden behind the acknowledgement forever",
    ).toBe(true);
  });

  // The retry of the same page is the one batch that is NOT news: the record
  // cannot dedupe its ops, but it can tell that it just saw this exact set.
  it("stays quiet when the same unplaceable batch arrives again", () => {
    const upToCap = Array.from({ length: MAX_TRACKED_SKIP_COORDINATES }, (_, index) =>
      op(index),
    );
    const page = [op(9000), op(9001)];
    const first = mergeShareSkippedOps(
      mergeShareSkippedOps(undefined, upToCap),
      page,
    );
    const acknowledged = acknowledgeShareSkips(first, first.generation);

    const retried = mergeShareSkippedOps(acknowledged, page);

    expect(
      hasUnacknowledgedShareSkips(retried),
      "MUTATION: treating a refetched page as news resurrects a warning the user dismissed",
    ).toBe(false);
    expect(retried.generation).toBe(acknowledged.generation);
  });

  // The batch identity is the coordinates themselves, not a hash of them. A
  // 32-bit digest is forgeable: these two one-op batches collide under
  // FNV-1a, so acknowledging the first would have silenced the second — more
  // content skipped past a committed cursor, hidden by a name collision.
  it("does not confuse two different batches that a short digest collides", () => {
    const upToCap = Array.from({ length: MAX_TRACKED_SKIP_COORDINATES }, (_, index) =>
      op(index),
    );
    const atCap = mergeShareSkippedOps(undefined, upToCap);
    const first = mergeShareSkippedOps(atCap, [
      { ...op(9000), originId: "Q2LtvxVflmCTdWhH" },
    ]);
    const acknowledged = acknowledgeShareSkips(first, first.generation);
    expect(hasUnacknowledgedShareSkips(acknowledged)).toBe(false);

    const collidingOther = mergeShareSkippedOps(acknowledged, [
      { ...op(9000), originId: "4bYy7MO7gBJ0Es94" },
    ]);

    expect(
      hasUnacknowledgedShareSkips(collidingOther),
      "MUTATION: a 32-bit digest names two different batches the same, and the second commits silently",
    ).toBe(true);
  });

  // A batch too large to keep the identity of records none, so the next one
  // reads as news. Visible rather than silent is the safe side of a bound.
  it("treats the next batch as news when it could not keep the last one", () => {
    const upToCap = Array.from({ length: MAX_TRACKED_SKIP_COORDINATES }, (_, index) =>
      op(index),
    );
    const huge = Array.from({ length: MAX_TRACKED_BATCH_COORDINATES + 1 }, (_, index) =>
      op(9000 + index),
    );
    const first = mergeShareSkippedOps(
      mergeShareSkippedOps(undefined, upToCap),
      huge,
    );
    const acknowledged = acknowledgeShareSkips(first, first.generation);

    expect(
      hasUnacknowledgedShareSkips(mergeShareSkippedOps(acknowledged, huge)),
      "MUTATION: keeping a truncated identity would call a different batch a repeat",
    ).toBe(true);
  });

  // Origin ids come from the relay, and a coordinate keyed on one lands in a
  // Set — never a plain object, where `__proto__` would read the inherited
  // prototype instead of an entry and recount on every retry.
  it("tracks an origin named __proto__ like any other", () => {
    const hostile = [
      { ...op(1), originId: "__proto__" },
      { ...op(2), originId: "constructor" },
      { ...op(3), originId: "toString" },
    ];
    const filler = Array.from({ length: MAX_RETAINED_SKIPPED_OPS }, (_, index) =>
      op(1000 + index),
    );
    const first = mergeShareSkippedOps(undefined, [...filler, ...hostile]);
    expect(first.more).toBe(hostile.length);

    const retried = mergeShareSkippedOps(first, [...filler, ...hostile]);

    expect(
      retried.more,
      "MUTATION: a prototype-inherited lookup recounts these coordinates on every retry",
    ).toBe(first.more);
    expect(
      retried.inexact,
      "MUTATION: ...and reports the inflated total as exact",
    ).toBeUndefined();
  });

  // Two shares can serve ops from different origins at the same sequence.
  it("keys a skipped op by origin AND sequence", () => {
    const merged = mergeShareSkippedOps(undefined, [
      op(4),
      { ...op(4), originId: "origin-other" },
    ]);
    expect(merged.ops).toHaveLength(2);
  });
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
      ownerUserId: "user-99",
    });
    expect(store.find("ws-1")?.remote).toEqual({
      serverUrl: "https://cloud.dohc.example",
      remoteWorkspaceId: "rw-99",
      ownerUserId: "user-99",
    });
  });

  it("persists and clears the first-pull join maintenance gate", () => {
    store.register({ ...personal, joinBootstrapPending: true });
    const reopened = createRegistryStore(registryPath);
    expect(reopened.find("ws-1")?.joinBootstrapPending).toBe(true);

    reopened.completeJoinBootstrap("ws-1");
    expect(createRegistryStore(registryPath).find("ws-1")?.joinBootstrapPending).toBeUndefined();
    expect(() => reopened.completeJoinBootstrap("missing")).toThrow(/Unknown workspace/);
  });

  // The cache may only show a warning hidden once the same change reached
  // disk. Mutating first and writing after leaves this process quiet while
  // the file still holds the record — and the warning comes back at the next
  // restart, which is the opposite of what the click said.
  it("leaves the acknowledgement unapplied when the registry write fails", async () => {
    store.register(personal);
    store.setShareView(personal.workspaceId, {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      grantedSelector: { paths: ["docs"], versionId: null },
      skippedOps: mergeShareSkippedOps(undefined, [
        {
          originId: "origin-granter",
          originSeq: 4,
          opKind: "moment.append",
          code: "share-boundary-violation",
          detail: "refused 4",
          atMs: 1000,
        },
      ]),
    });
    const before = store.list()[0]?.shareView?.skippedOps;
    expect(hasUnacknowledgedShareSkips(before)).toBe(true);

    // A full disk, modelled: the rename onto the registry path cannot
    // succeed. Reads keep working from the cache, exactly as they would.
    await rm(registryPath);
    await mkdir(registryPath);

    expect(() =>
      store.acknowledgeShareSkips(
        personal.workspaceId,
        undefined,
        before?.generation ?? 0,
      ),
    ).toThrow();

    expect(
      hasUnacknowledgedShareSkips(store.list()[0]?.shareView?.skippedOps),
      "MUTATION: mutating the cache before the write hides the warning in this process while disk still holds it",
    ).toBe(true);
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
      recipientUserId: "member-1",
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

  it("records, marks ended, and clears share mounts", () => {
    store.register(personal);
    const mount = {
      shareId: "share-9",
      label: "alex",
      granterEmail: "alex@example.com",
      relayUrl: "http://relay.test",
      grantedSelector: { paths: ["docs"], versionId: null },
    };
    store.setShareMounts("ws-1", [mount]);
    expect(store.find("ws-1")?.shareMounts).toEqual([mount]);

    store.setShareMounts("ws-1", [{ ...mount, ended: true }]);
    const reopened = createRegistryStore(registryPath);
    expect(reopened.find("ws-1")?.shareMounts).toEqual([{ ...mount, ended: true }]);

    store.setShareMounts("ws-1", []);
    expect(store.find("ws-1")?.shareMounts).toBeUndefined();
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
    store.setShareView("ws-1", {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      grantedSelector: { paths: ["docs"], versionId: null },
    });
    expect(store.find("ws-1")?.shareView).toEqual({
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      grantedSelector: { paths: ["docs"], versionId: null },
    });
    // Marking ended survives a fresh read of the same file.
    store.setShareView("ws-1", {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      grantedSelector: { paths: ["docs"], versionId: null },
      ended: true,
    });
    const reread = createRegistryStore(registryPath);
    expect(reread.find("ws-1")?.shareView?.ended).toBe(true);
    expect(() =>
      store.setShareView("ws-unknown", {
        shareId: "s",
        granterEmail: null,
        grantedSelector: { paths: ["docs"], versionId: null },
      }),
    ).toThrow(/Unknown workspace/);
  });

  it("persists the share's origin relay so refresh can reject a foreign relay (PR 18 gate fix)", () => {
    store.register(personal);
    store.setShareView("ws-1", {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      grantedSelector: { paths: ["docs"], versionId: null },
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

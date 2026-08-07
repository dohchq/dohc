// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  atRiskOrphanedDraftIds,
  captureOrphanedDraft,
  dismissOrphanedDraft,
  remapOrphanedDraftPaths,
  resetOrphanedDrafts,
  useOrphanedDrafts,
  type OrphanedDraft,
} from "./orphanedDrafts";
import {
  ORPHANED_DRAFT_RETENTION_MS,
  ORPHANED_DRAFT_STORAGE_KEY,
} from "./orphanedDraftStorage";

type DraftStore = typeof import("./orphanedDrafts");
type UseDrafts = (
  workspaceId: string,
  path: string,
) => readonly OrphanedDraft[];

function draftsFor(
  useDrafts: UseDrafts,
  workspaceId: string,
  path: string,
): readonly OrphanedDraft[] {
  const { result, unmount } = renderHook(() => useDrafts(workspaceId, path));
  const current = result.current;
  unmount();
  return current;
}

// A real restart: the module's state dies, storage does not. Nothing in
// production exists for this — a relaunched app gets a fresh module the same
// way.
async function relaunch(nowMs?: number): Promise<DraftStore> {
  vi.resetModules();
  const next: DraftStore = await import("./orphanedDrafts");
  next.restoreOrphanedDrafts(nowMs);
  return next;
}

function storedText(): string {
  return localStorage.getItem(ORPHANED_DRAFT_STORAGE_KEY) ?? "";
}

describe("orphanedDrafts remap (#579 review, P1)", () => {
  afterEach(() => {
    resetOrphanedDrafts();
  });

  it("follows a file rename, keyed to the workspace", () => {
    captureOrphanedDraft("ws-1", "a.md", "kept");
    captureOrphanedDraft("ws-2", "a.md", "other workspace");
    remapOrphanedDraftPaths("ws-1", (path) =>
      path === "a.md" ? "renamed.md" : path,
    );
    expect(draftsFor(useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
    expect(
      draftsFor(useOrphanedDrafts, "ws-1", "renamed.md").map((d) => d.text),
    ).toEqual(["kept"]);
    // The other workspace's identical path is untouched.
    expect(
      draftsFor(useOrphanedDrafts, "ws-2", "a.md").map((d) => d.text),
    ).toEqual(["other workspace"]);
  });

  it("merges into the target's existing drafts instead of overwriting", () => {
    captureOrphanedDraft("ws-1", "target.md", "already there");
    captureOrphanedDraft("ws-1", "a.md", "moving in");
    remapOrphanedDraftPaths("ws-1", (path) =>
      path === "a.md" ? "target.md" : path,
    );
    expect(
      draftsFor(useOrphanedDrafts, "ws-1", "target.md").map((d) => d.text),
    ).toEqual(["already there", "moving in"]);
  });

  it("keeps drafts whose path a delete projects to null", () => {
    captureOrphanedDraft("ws-1", "notes/a.md", "survives");
    remapOrphanedDraftPaths("ws-1", () => null);
    // Destroying recovery text is never the store's call: a recreated or
    // restored file shows the notice again. A move dohc did not perform lands
    // on this same rule — the renderer cannot tell one from a delete, so it
    // treats it as one rather than guess away the user's only copy.
    expect(
      draftsFor(useOrphanedDrafts, "ws-1", "notes/a.md").map((d) => d.text),
    ).toEqual(["survives"]);
  });

  it("dismisses by id after a remap", () => {
    captureOrphanedDraft("ws-1", "a.md", "kept");
    remapOrphanedDraftPaths("ws-1", () => "b.md");
    const [draft] = draftsFor(useOrphanedDrafts, "ws-1", "b.md");
    dismissOrphanedDraft("ws-1", "b.md", draft.id);
    expect(draftsFor(useOrphanedDrafts, "ws-1", "b.md")).toHaveLength(0);
  });
});

// #600: the recovery must outlive the app run that made it. Before this, the
// only copy of a set-aside edit was a renderer-memory map, so "Close anyway",
// a crash, or a forced restart destroyed it.
describe("orphanedDrafts persistence (#600)", () => {
  afterEach(() => {
    resetOrphanedDrafts();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("brings every notice back on the same file, with the same text, oldest first", async () => {
    captureOrphanedDraft("ws-1", "notes/plan.md", "# Plan\n\nTyped, unsaved.");
    captureOrphanedDraft("ws-1", "notes/plan.md", "# Plan\n\nTyped again.");
    // MUTATION (capture): stop calling storeDraft. Nothing reaches storage
    // and the relaunched app has no notice at all.
    const next = await relaunch();
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "notes/plan.md").map(
        (draft) => draft.text,
      ),
    ).toEqual(["# Plan\n\nTyped, unsaved.", "# Plan\n\nTyped again."]);
    // A restored draft is durable, so nothing stays behind the close warning.
    expect(next.atRiskOrphanedDraftIds()).toEqual([]);
  });

  it("never writes a secret-classified path to plaintext storage", async () => {
    // MUTATION (secret floor): route these through the plaintext path — make
    // isPersistableDraftPath return true, or classify with something that
    // answers "tracked" for `.env`. Every assertion below fails.
    captureOrphanedDraft("ws-1", ".env", "API_KEY=shh");
    captureOrphanedDraft("ws-1", "config/.env", "DB_URL=shh");
    captureOrphanedDraft("ws-1", ".env.local", "TOKEN=shh");
    captureOrphanedDraft("ws-1", "Shared with me/Team/.env", "SHARED=shh");
    expect(storedText()).not.toContain("shh");
    expect(storedText()).not.toContain(".env");

    // The text is still recoverable in THIS run, and the close warning is
    // what stands behind it.
    expect(
      draftsFor(useOrphanedDrafts, "ws-1", ".env").map((d) => d.text),
    ).toEqual(["API_KEY=shh"]);
    expect(atRiskOrphanedDraftIds()).toHaveLength(4);

    // And it is gone after the restart, rather than restored from plaintext.
    const next = await relaunch();
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", ".env")).toHaveLength(0);
  });

  it("takes the stored copy with a dismissal", async () => {
    captureOrphanedDraft("ws-1", "a.md", "Dismissed");
    captureOrphanedDraft("ws-1", "b.md", "Kept");
    const [draft] = draftsFor(useOrphanedDrafts, "ws-1", "a.md");
    dismissOrphanedDraft("ws-1", "a.md", draft.id);
    // MUTATION (dismiss): drop forgetStoredDraft. The dismissed edit comes
    // back on the next launch, with a Dismiss the user already answered.
    expect(storedText()).not.toContain("Dismissed");
    const next = await relaunch();
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "b.md").map((d) => d.text),
    ).toEqual(["Kept"]);
  });

  it("moves the stored copy with a rename", async () => {
    captureOrphanedDraft("ws-1", "a.md", "renamed with the file");
    remapOrphanedDraftPaths("ws-1", (path) =>
      path === "a.md" ? "notes/b.md" : path,
    );
    // MUTATION (remap): drop remapStoredDraftPaths. The notice comes back on
    // a path the workspace no longer has.
    const next = await relaunch();
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "notes/b.md").map((d) => d.text),
    ).toEqual(["renamed with the file"]);
  });

  it("drops the stored copy when a rename lands on a secret path", () => {
    captureOrphanedDraft("ws-1", "a.md", "SECRET_BODY");
    expect(storedText()).toContain("SECRET_BODY");
    remapOrphanedDraftPaths("ws-1", (path) => (path === "a.md" ? ".env" : path));
    // The floor holds after the fact too: plaintext for a now-secret path is
    // removed, and the draft goes back behind the close warning.
    expect(storedText()).not.toContain("SECRET_BODY");
    expect(atRiskOrphanedDraftIds()).toHaveLength(1);
  });

  // The pair below reads the boundary exactly, so the capture's clock is
  // frozen: a second Date.now() call can tick a millisecond past the one
  // inside the capture, and the age these tests mean to set would be off by
  // that tick.
  // The floor runs on the way OUT of storage too. Nothing `storeDraft` writes
  // can hit this — it classifies the same path with the same pure function —
  // so the row below is what an older build, another tool, or a hand-edited
  // profile leaves in a plaintext key anything in the profile can write.
  it("refuses a stored row whose path the floor calls secret, and scrubs it", async () => {
    const capturedAt = Date.now();
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify([
        {
          id: 1,
          workspaceId: "ws-1",
          path: ".env",
          text: "API_KEY=shh",
          capturedAtMs: capturedAt,
        },
        {
          id: 2,
          workspaceId: "ws-1",
          path: "a.md",
          text: "kept",
          capturedAtMs: capturedAt,
        },
      ]),
    );
    // MUTATION (load floor): drop isPersistableDraftPath from
    // loadStoredDrafts. The secret row is restored into the notice AND left in
    // plaintext storage, and both assertions below fail.
    const next = await relaunch();
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", ".env")).toHaveLength(0);
    expect(storedText()).not.toContain("shh");
    // ...and the row beside it is untouched.
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
    ).toEqual(["kept"]);
  });

  // An id is the handle Dismiss uses, and `forgetStoredDraft` matches on it
  // alone. Two rows under one id would make one confirmation delete two texts
  // — and the confirm says it deletes the only copy, of one edit.
  it("gives every restored recovery an id of its own", async () => {
    const capturedAt = Date.now();
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify([
        {
          id: 4,
          workspaceId: "ws-1",
          path: "a.md",
          text: "FIRST",
          capturedAtMs: capturedAt,
        },
        {
          id: 4,
          workspaceId: "ws-1",
          path: "a.md",
          text: "SECOND",
          capturedAtMs: capturedAt,
        },
      ]),
    );
    // MUTATION (re-key): restore the rows as they are stored. One Dismiss then
    // takes both texts, and neither the notice nor storage keeps the other.
    const next = await relaunch();
    const restored = draftsFor(next.useOrphanedDrafts, "ws-1", "a.md");
    // Neither text is dropped — destroying recovery text is never this
    // store's call — and the two are now tellable apart.
    expect(restored.map((d) => d.text)).toEqual(["FIRST", "SECOND"]);
    expect(new Set(restored.map((d) => d.id)).size).toBe(2);

    next.dismissOrphanedDraft("ws-1", "a.md", restored[0].id);
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
    ).toEqual(["SECOND"]);
    expect(storedText()).toContain("SECOND");
    expect(storedText()).not.toContain("FIRST");
  });

  // `typeof x === "number"` is not an identity. `1e400` parses to Infinity,
  // which the rewrite serializes as JSON null — so the row came back durable,
  // the close guard let the app exit, and the launch AFTER that rejected the
  // null and took the text with it. A claimed durability that a later launch
  // un-claims is the worst shape this store has, which is why the round trip
  // below is the assertion that matters.
  //
  // Seeded as raw JSON: JSON.stringify would fold these into null before they
  // ever reached storage, and then the test would seed a different bug.
  it("re-keys an id nothing can count from, and keeps every text", async () => {
    const capturedAt = Date.now();
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      `[{"id":1e400,"workspaceId":"ws-1","path":"a.md","text":"OVERFLOW","capturedAtMs":${capturedAt}},
        {"id":-3.5,"workspaceId":"ws-1","path":"a.md","text":"FRACTION","capturedAtMs":${capturedAt}},
        {"id":2,"workspaceId":"ws-1","path":"a.md","text":"VALID","capturedAtMs":${capturedAt}}]`,
    );
    // MUTATION (usable id): let the watermark and the keep-it test read
    // `typeof row.id === "number"`. Infinity survives, every re-key draws the
    // same Infinity, the rewrite writes nulls, and the second relaunch below
    // comes back empty.
    const next = await relaunch();
    const restored = draftsFor(next.useOrphanedDrafts, "ws-1", "a.md");
    // No text is dropped for carrying a broken id...
    expect([...restored.map((d) => d.text)].sort()).toEqual([
      "FRACTION",
      "OVERFLOW",
      "VALID",
    ]);
    // ...every row can be counted from and told apart...
    expect(restored.every((d) => Number.isSafeInteger(d.id))).toBe(true);
    expect(new Set(restored.map((d) => d.id)).size).toBe(3);
    // ...and nothing serialized to a null the next launch would reject.
    expect(storedText()).not.toContain("null");

    // A dismissal retires exactly its own row.
    const dismissed = restored.find((d) => d.text === "OVERFLOW")!;
    next.dismissOrphanedDraft("ws-1", "a.md", dismissed.id);
    expect(
      [
        ...draftsFor(next.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
      ].sort(),
    ).toEqual(["FRACTION", "VALID"]);

    // The round trip: the launch after the repair still has both texts.
    const after = await relaunch();
    expect(
      [
        ...draftsFor(after.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
      ].sort(),
    ).toEqual(["FRACTION", "VALID"]);
  });

  // The capture time has the id's hole exactly: `1e400` reads as not yet
  // expired, comes back durable, then serializes as JSON null and the launch
  // after that drops the row. The other direction is worse still — a negative
  // or a zero reads as older than the window, so the retention filter would
  // delete the text before anything could repair it. (NaN cannot be seeded:
  // JSON has no literal for it, and the whole value fails to parse.)
  it("repairs a capture time nothing can age, and keeps the text", async () => {
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      `[{"id":1,"workspaceId":"ws-1","path":"a.md","text":"OVERFLOWED","capturedAtMs":1e400},
        {"id":2,"workspaceId":"ws-1","path":"a.md","text":"NEGATIVE","capturedAtMs":-5},
        {"id":3,"workspaceId":"ws-1","path":"a.md","text":"EPOCH","capturedAtMs":0}]`,
    );
    const repairedAt = Date.now();
    // MUTATION (capture-time repair): take `row.capturedAtMs` as given. The
    // overflowed row survives this launch reported durable and is gone from
    // the next one, and the negative row never reaches the store at all.
    const next = await relaunch(repairedAt);
    expect(
      [
        ...draftsFor(next.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
      ].sort(),
    ).toEqual(["EPOCH", "NEGATIVE", "OVERFLOWED"]);
    expect(storedText()).not.toContain("null");

    // The round trip that matters: the launch after the repair still has them.
    const after = await relaunch(repairedAt);
    expect(draftsFor(after.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(3);

    // ...and they age from the repair, so the window still ends them.
    const expired = await relaunch(repairedAt + ORPHANED_DRAFT_RETENTION_MS);
    expect(draftsFor(expired.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
  });

  // Allocating above the highest id walks out of the safe range when the rows
  // already sit near the top of it: `MAX_SAFE_INTEGER + 1` increments to
  // itself, so the third repair reuses the second one's id and one Dismiss
  // takes both texts.
  it("allocates repaired ids inside the safe range, however high the stored ones", async () => {
    const capturedAt = Date.now();
    const top = Number.MAX_SAFE_INTEGER - 1;
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify(
        ["TOP", "DUP1", "DUP2", "DUP3"].map((text) => ({
          id: top,
          workspaceId: "ws-1",
          path: "a.md",
          text,
          capturedAtMs: capturedAt,
        })),
      ),
    );
    // MUTATION (allocation): draw replacements from `highest + 1` again. Two
    // of the four land on the same id and the distinct-id count below fails.
    const next = await relaunch();
    const restored = draftsFor(next.useOrphanedDrafts, "ws-1", "a.md");
    expect(restored.map((d) => d.text).sort()).toEqual([
      "DUP1",
      "DUP2",
      "DUP3",
      "TOP",
    ]);
    expect(restored.every((d) => Number.isSafeInteger(d.id))).toBe(true);
    expect(new Set(restored.map((d) => d.id)).size).toBe(4);

    // One confirmation retires one edit.
    next.dismissOrphanedDraft(
      "ws-1",
      "a.md",
      restored.find((d) => d.text === "DUP2")!.id,
    );
    const left = ["DUP1", "DUP3", "TOP"];
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")
        .map((d) => d.text)
        .sort(),
    ).toEqual(left);
    const after = await relaunch();
    expect(
      draftsFor(after.useOrphanedDrafts, "ws-1", "a.md")
        .map((d) => d.text)
        .sort(),
    ).toEqual(left);
  });

  // The live twin of the repair allocator. Counting up from the highest
  // RESTORED id walks a fresh capture out of the safe range just as surely:
  // from MAX_SAFE_INTEGER-1 the second and third captures land on the same id,
  // and on one path one Dismiss takes both texts.
  it("gives this run's captures ids of their own, however high the restored one", async () => {
    const capturedAt = Date.now();
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify([
        {
          id: Number.MAX_SAFE_INTEGER - 1,
          workspaceId: "ws-1",
          path: "a.md",
          text: "RESTORED",
          capturedAtMs: capturedAt,
        },
      ]),
    );
    // MUTATION (live allocation): count up from the highest restored id again.
    // The two captures below collide and the distinct-id count fails.
    const next = await relaunch();
    next.captureOrphanedDraft("ws-1", "a.md", "FIRST");
    next.captureOrphanedDraft("ws-1", "a.md", "SECOND");

    const live = draftsFor(next.useOrphanedDrafts, "ws-1", "a.md");
    expect(live.map((d) => d.text)).toEqual(["RESTORED", "FIRST", "SECOND"]);
    expect(live.every((d) => Number.isSafeInteger(d.id))).toBe(true);
    expect(new Set(live.map((d) => d.id)).size).toBe(3);

    // One confirmation retires one edit, here and after the restart.
    next.dismissOrphanedDraft(
      "ws-1",
      "a.md",
      live.find((d) => d.text === "FIRST")!.id,
    );
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
    ).toEqual(["RESTORED", "SECOND"]);
    const after = await relaunch();
    expect(
      [
        ...draftsFor(after.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
      ].sort(),
    ).toEqual(["RESTORED", "SECOND"]);
  });

  // One order, whichever surface asks. The store sorts oldest first, and a
  // rename that merges two paths must not answer differently before and after
  // a restart.
  it("keeps one order for a merged rename, this run and the next", async () => {
    captureOrphanedDraft("ws-1", "a.md", "captured first");
    captureOrphanedDraft("ws-1", "target.md", "captured second");
    // MUTATION (merge order): append the moved drafts after the target's own.
    // This run reads newest-first while the next launch reads oldest-first,
    // and the two Copy buttons swap places across a restart.
    remapOrphanedDraftPaths("ws-1", (path) =>
      path === "a.md" ? "target.md" : path,
    );
    expect(
      draftsFor(useOrphanedDrafts, "ws-1", "target.md").map((d) => d.text),
    ).toEqual(["captured first", "captured second"]);

    const next = await relaunch();
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "target.md").map((d) => d.text),
    ).toEqual(["captured first", "captured second"]);
  });

  // The floor decides once, when the draft is captured. A rename can take a
  // row OUT of plaintext storage, because re-keying it would WRITE a row under
  // a secret path; it never puts one in, because that is a new write of text
  // the floor already refused.
  it("keeps a secret-path draft window-only after a rename onto a tracked path", () => {
    captureOrphanedDraft("ws-1", ".env", "API_KEY=shh");
    expect(atRiskOrphanedDraftIds()).toHaveLength(1);
    // MUTATION (promote on rename): store eligible drafts at the remap. The
    // text the floor refused at capture reaches plaintext storage because a
    // file was renamed.
    remapOrphanedDraftPaths("ws-1", (path) =>
      path === ".env" ? "notes.md" : path,
    );
    expect(
      draftsFor(useOrphanedDrafts, "ws-1", "notes.md").map((d) => d.text),
    ).toEqual(["API_KEY=shh"]);
    expect(storedText()).not.toContain("shh");
    expect(atRiskOrphanedDraftIds()).toHaveLength(1);
  });

  it("forgets a recovery nothing claimed within the retention window", async () => {
    const capturedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(capturedAt);
    captureOrphanedDraft("ws-1", "a.md", "abandoned");
    // MUTATION (expiry): drop the retention filter. Abandoned recoveries
    // accumulate for the life of the install.
    const next = await relaunch(capturedAt + ORPHANED_DRAFT_RETENTION_MS);
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
    // Cleaned out of storage, not just hidden from the restore.
    expect(storedText()).not.toContain("abandoned");
  });

  it("keeps a recovery one millisecond short of expiring", async () => {
    const capturedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(capturedAt);
    captureOrphanedDraft("ws-1", "a.md", "still fresh");
    const next = await relaunch(capturedAt + ORPHANED_DRAFT_RETENTION_MS - 1);
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(1);
  });

  it("reports a draft storage refused as at risk, and keeps the text", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    captureOrphanedDraft("ws-1", "a.md", "Nowhere to put it");
    // MUTATION (refusal): ignore storeDraft's answer and record it as stored.
    // The close warning goes quiet about text nothing can bring back.
    expect(atRiskOrphanedDraftIds()).toHaveLength(1);
    expect(
      draftsFor(useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
    ).toEqual(["Nowhere to put it"]);
  });

  it("restores nothing from storage that is not a list of drafts, and clears it", async () => {
    // A half-written value still holds whatever draft text reached it.
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      '[{"text":"UNPARSEABLE_BODY',
    );
    const broken = await relaunch();
    expect(draftsFor(broken.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
    // MUTATION (blob scrub): report no discard when the value does not parse.
    // The bytes stay in plaintext with no row to expire and no notice to
    // dismiss, so nothing can ever remove them.
    expect(storedText()).not.toContain("UNPARSEABLE_BODY");

    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify([
        {
          id: "1",
          workspaceId: "ws-1",
          path: "a.md",
          text: "SHAPE_BODY",
          capturedAtMs: 0,
        },
        null,
        7,
      ]),
    );
    const partial = await relaunch();
    expect(draftsFor(partial.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
    expect(storedText()).not.toContain("SHAPE_BODY");
    // MUTATION (empty write): write `[]` instead of removing the key. A scrub
    // that drops every row then has to ASK the store for space rather than
    // hand space back, which is the one way it could be refused.
    expect(localStorage.getItem(ORPHANED_DRAFT_STORAGE_KEY)).toBeNull();
  });

  // The scrub is not a promise the store can always keep, and the honest
  // answer is not a fallback. Removing the key instead would take the valid
  // row's durable copy with it — and the only refusal that can reach a write
  // which frees space is a store taking no writes at all, which refuses a
  // removal too. So the pass states what it really offers: it runs again.
  it("retries the scrub on the next launch when the store refuses the rewrite", async () => {
    const capturedAt = Date.now();
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify([
        {
          id: 1,
          workspaceId: "ws-1",
          path: ".env",
          text: "API_KEY=shh",
          capturedAtMs: capturedAt,
        },
        {
          id: 2,
          workspaceId: "ws-1",
          path: "b.md",
          text: "kept",
          capturedAtMs: capturedAt,
        },
      ]),
    );
    const refused = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    const blocked = await relaunch();
    // The floor still refuses to restore it, so no surface lists or copies it.
    expect(draftsFor(blocked.useOrphanedDrafts, "ws-1", ".env")).toHaveLength(0);
    // The store took no write, so it still holds the bytes. Nothing pretends
    // otherwise.
    expect(storedText()).toContain("shh");

    // MUTATION (retry): scrub once per install behind a flag, or treat the
    // refused write as handled because the row was left out of the restore.
    // The relaunch below then leaves the plaintext exactly where it is.
    refused.mockRestore();
    const next = await relaunch();
    expect(storedText()).not.toContain("shh");
    // ...and the valid row it was sharing the key with came through both runs.
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "b.md").map((d) => d.text),
    ).toEqual(["kept"]);
  });

  // The read drops a row that is not a draft BEFORE the load can compare what
  // survived against what it started with. With a valid row beside it the two
  // counts match, so the old check saw a clean store and rewrote nothing.
  it("scrubs a row that is not a draft, and keeps the one beside it", async () => {
    const capturedAt = Date.now();
    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify([
        {
          id: "not a number",
          workspaceId: "ws-1",
          path: "a.md",
          text: "MALFORMED_BODY",
          capturedAtMs: capturedAt,
        },
        {
          id: 2,
          workspaceId: "ws-1",
          path: "b.md",
          text: "kept",
          capturedAtMs: capturedAt,
        },
      ]),
    );
    // MUTATION (discard trigger): compare only kept.length with rows.length.
    // The counts agree, no rewrite runs, and MALFORMED_BODY stays in plaintext
    // for the life of the install.
    const next = await relaunch();
    expect(storedText()).not.toContain("MALFORMED_BODY");
    // ...and the row beside it restores and stays durable.
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "b.md").map((d) => d.text),
    ).toEqual(["kept"]);
    expect(next.atRiskOrphanedDraftIds()).toEqual([]);
    expect(storedText()).toContain("kept");
  });

  // The other half of the trigger: a clean store must not be rewritten, and an
  // empty one must not gain a key it never had.
  it("leaves an untouched store alone", async () => {
    captureOrphanedDraft("ws-1", "a.md", "clean");
    const written = storedText();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const next = await relaunch();
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(1);
    // MUTATION (always rewrite): drop the discard condition and write on every
    // load. Restoring becomes a write, and the launch after an empty store
    // creates the key for a user who never set an edit aside.
    expect(setItem).not.toHaveBeenCalled();
    expect(storedText()).toBe(written);

    localStorage.removeItem(ORPHANED_DRAFT_STORAGE_KEY);
    await relaunch();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(ORPHANED_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("keeps this run's ids clear of the ones it restored", async () => {
    captureOrphanedDraft("ws-1", "a.md", "from the last run");
    const next = await relaunch();
    next.captureOrphanedDraft("ws-1", "b.md", "from this run");
    const [restored] = draftsFor(next.useOrphanedDrafts, "ws-1", "a.md");
    const [fresh] = draftsFor(next.useOrphanedDrafts, "ws-1", "b.md");
    // MUTATION (id watermark): drop the nextId bump in restoreOrphanedDrafts.
    // The new draft reuses the restored one's id, and dismissing either one
    // deletes the other's stored copy.
    expect(fresh.id).not.toBe(restored.id);
  });
});

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

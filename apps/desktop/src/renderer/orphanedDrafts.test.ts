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
    // restored file shows the notice again.
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

  it("brings the notice back on the same file with the same text", async () => {
    captureOrphanedDraft("ws-1", "notes/plan.md", "# Plan\n\nTyped, unsaved.");
    // MUTATION (capture): stop calling storeDraft. Nothing reaches storage
    // and the relaunched app has no notice at all.
    const next = await relaunch();
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "notes/plan.md").map(
        (draft) => draft.text,
      ),
    ).toEqual(["# Plan\n\nTyped, unsaved."]);
    // A restored draft is durable, so nothing stays behind the close warning.
    expect(next.atRiskOrphanedDraftIds()).toEqual([]);
  });

  it("restores every draft on a path, oldest first", async () => {
    captureOrphanedDraft("ws-1", "a.md", "first");
    captureOrphanedDraft("ws-1", "a.md", "second");
    const next = await relaunch();
    expect(
      draftsFor(next.useOrphanedDrafts, "ws-1", "a.md").map((d) => d.text),
    ).toEqual(["first", "second"]);
  });

  it("restores nothing twice, however often it runs", async () => {
    captureOrphanedDraft("ws-1", "a.md", "once");
    const next = await relaunch();
    next.restoreOrphanedDrafts();
    // MUTATION (idempotence): drop the storedIds guard in
    // restoreOrphanedDrafts. One notice becomes two, each with a Dismiss the
    // user has to answer.
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(1);
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

  it("forgets a recovery nothing claimed within the retention window", async () => {
    captureOrphanedDraft("ws-1", "a.md", "abandoned");
    // MUTATION (expiry): drop the retention filter. Abandoned recoveries
    // accumulate for the life of the install.
    const next = await relaunch(Date.now() + ORPHANED_DRAFT_RETENTION_MS + 1);
    expect(draftsFor(next.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
    // Cleaned out of storage, not just hidden from the restore.
    expect(storedText()).not.toContain("abandoned");
  });

  it("keeps a recovery one millisecond short of expiring", async () => {
    captureOrphanedDraft("ws-1", "a.md", "still fresh");
    const next = await relaunch(Date.now() + ORPHANED_DRAFT_RETENTION_MS - 1);
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

  it("restores nothing from storage that is not a list of drafts", async () => {
    localStorage.setItem(ORPHANED_DRAFT_STORAGE_KEY, "{not json");
    const broken = await relaunch();
    expect(draftsFor(broken.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);

    localStorage.setItem(
      ORPHANED_DRAFT_STORAGE_KEY,
      JSON.stringify([
        { id: "1", workspaceId: "ws-1", path: "a.md", text: "x", capturedAtMs: 0 },
        null,
        7,
      ]),
    );
    const partial = await relaunch();
    expect(draftsFor(partial.useOrphanedDrafts, "ws-1", "a.md")).toHaveLength(0);
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

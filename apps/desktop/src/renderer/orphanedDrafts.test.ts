// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  captureOrphanedDraft,
  dismissOrphanedDraft,
  freezeOrphanedCaptures,
  orphanedDraftCount,
  remapOrphanedDraftPaths,
  resetOrphanedDrafts,
  thawOrphanedCaptures,
  useOrphanedDrafts,
} from "./orphanedDrafts";

function draftsFor(workspaceId: string, path: string) {
  const { result, unmount } = renderHook(() =>
    useOrphanedDrafts(workspaceId, path),
  );
  const current = result.current;
  unmount();
  return current;
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
    expect(draftsFor("ws-1", "a.md")).toHaveLength(0);
    expect(draftsFor("ws-1", "renamed.md").map((d) => d.text)).toEqual(["kept"]);
    // The other workspace's identical path is untouched.
    expect(draftsFor("ws-2", "a.md").map((d) => d.text)).toEqual([
      "other workspace",
    ]);
  });

  it("merges into the target's existing drafts instead of overwriting", () => {
    captureOrphanedDraft("ws-1", "target.md", "already there");
    captureOrphanedDraft("ws-1", "a.md", "moving in");
    remapOrphanedDraftPaths("ws-1", (path) =>
      path === "a.md" ? "target.md" : path,
    );
    expect(draftsFor("ws-1", "target.md").map((d) => d.text)).toEqual([
      "already there",
      "moving in",
    ]);
  });

  it("keeps drafts whose path a delete projects to null", () => {
    captureOrphanedDraft("ws-1", "notes/a.md", "survives");
    remapOrphanedDraftPaths("ws-1", () => null);
    // Destroying recovery text is never the store's call: a recreated or
    // restored file shows the notice again.
    expect(draftsFor("ws-1", "notes/a.md").map((d) => d.text)).toEqual([
      "survives",
    ]);
  });

  it("dismisses by id after a remap", () => {
    captureOrphanedDraft("ws-1", "a.md", "kept");
    remapOrphanedDraftPaths("ws-1", () => "b.md");
    const [draft] = draftsFor("ws-1", "b.md");
    dismissOrphanedDraft("ws-1", "b.md", draft.id);
    expect(draftsFor("ws-1", "b.md")).toHaveLength(0);
  });
});

// #579 review r13: an approval is only valid for the store state it was given.
// The close guard freezes the store from the moment the user confirms the loss
// until the exit runs or is cancelled, so the approved list cannot grow behind
// the answer.
describe("orphanedDrafts capture freeze", () => {
  afterEach(() => {
    resetOrphanedDrafts();
  });

  it("refuses captures while frozen and reports the refusal to the caller", () => {
    captureOrphanedDraft("ws-1", "a.md", "approved");
    freezeOrphanedCaptures();

    // MUTATION (freeze): capture unconditionally. The store grows past the
    // list the user approved losing, and the exit destroys the difference.
    expect(captureOrphanedDraft("ws-1", "b.md", "never shown")).toBe(false);
    expect(orphanedDraftCount()).toBe(1);
    expect(draftsFor("ws-1", "b.md")).toHaveLength(0);

    // A cancelled exit lifts it, and the caller's retry is taken for real.
    thawOrphanedCaptures();
    expect(captureOrphanedDraft("ws-1", "b.md", "never shown")).toBe(true);
    expect(draftsFor("ws-1", "b.md").map((draft) => draft.text)).toEqual([
      "never shown",
    ]);
  });
});

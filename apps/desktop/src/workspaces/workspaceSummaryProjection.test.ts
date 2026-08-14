import { describe, expect, it } from "vitest";
import type { RegistryEntry } from "./registryStore";
import {
  workspaceSummariesFrom,
  workspaceSummaryFor,
} from "./workspaceSummaryProjection";

// The registry file is data, not a contract. These drive the projection with
// the damaged shapes a stored record can actually carry, and pin the blast
// radius: a share-sized fault stays share-sized.

const entry = (extra: Record<string, unknown> = {}): RegistryEntry =>
  ({
    workspaceId: "ws-1",
    rootPath: "/home/ice/dohc/ws",
    kind: "personal",
    mode: "local-first",
    ...extra,
  }) as unknown as RegistryEntry;

const goodSelector = { paths: ["docs"], versionId: null, access: "view" };
// A grant written before the level existed.
const staleSelector = { paths: ["docs"], versionId: null };

const shareView = (selector: unknown) => ({
  shareId: "share-1",
  granterEmail: "sam@dohc.test",
  grantedSelector: selector,
});

const mount = (id: string, label: string, selector: unknown) => ({
  shareId: id,
  label,
  granterEmail: "sam@dohc.test",
  relayUrl: "http://relay.test",
  grantedSelector: selector,
});

describe("workspace summary projection", () => {
  it("carries the level from the pinned grant", () => {
    const summary = workspaceSummaryFor(
      entry({
        shareView: shareView({ ...goodSelector, access: "comment" }),
        shareMounts: [mount("m-1", "alex", { ...goodSelector, access: "edit" })],
      }),
    );
    expect(summary.shareView?.access).toBe("comment");
    expect(summary.shareMounts?.[0]?.access).toBe("edit");
  });

  // The defect CodeRabbit found: one unreadable share record threw out of the
  // whole projection, so a single stale grant answered "you have no
  // workspaces" — false, and with no way back from the UI.
  it("keeps every other workspace when one stored share record is unreadable", () => {
    const summaries = workspaceSummariesFrom([
      entry({ workspaceId: "ws-healthy" }),
      entry({ workspaceId: "ws-stale", shareView: shareView(staleSelector) }),
      entry({ workspaceId: "ws-also-healthy" }),
    ]);
    expect(
      summaries.map((summary) => summary.workspaceId),
      "MUTATION: one unreadable share record must not empty the workspace list",
    ).toEqual(["ws-healthy", "ws-stale", "ws-also-healthy"]);
  });

  // The share-view marker is RESTRICTIVE: it is what makes the shell treat
  // the workspace as someone else's. Dropping it would present a share view
  // as an ordinary writable workspace — damage failing OPEN, which is the one
  // direction this PR must never fail in.
  it("keeps the share-view marker when its grant is unreadable, and marks it damaged", () => {
    const summary = workspaceSummaryFor(
      entry({ shareView: shareView(staleSelector) }),
    );
    expect(summary.workspaceId).toBe("ws-1");
    expect(
      summary.shareView,
      "MUTATION: dropping the marker presents a share view as an ordinary workspace",
    ).toBeDefined();
    expect(summary.shareView?.damaged).toBe(true);
    expect(summary.shareView?.shareId).toBe("share-1");
    // The level is dropped, never guessed. A level nobody granted must not
    // appear, and `damaged` is not a claim about WHY.
    expect(summary.shareView?.access).toBeUndefined();
    expect(summary.shareView?.ended).toBeUndefined();
  });

  it("keeps a readable share view undamaged", () => {
    const summary = workspaceSummaryFor(
      entry({ shareView: shareView(goodSelector) }),
    );
    expect(summary.shareView?.damaged).toBeUndefined();
    expect(summary.shareView?.access).toBe("view");
  });

  it("omits only the unreadable mount and keeps the readable ones", () => {
    const summary = workspaceSummaryFor(
      entry({
        shareMounts: [
          mount("m-good", "alex", goodSelector),
          mount("m-stale", "sam", staleSelector),
          mount("m-good-2", "kim", { ...goodSelector, access: "edit" }),
        ],
      }),
    );
    expect(summary.shareMounts?.map((m) => m.shareId)).toEqual([
      "m-good",
      "m-good-2",
    ]);
  });

  it("refuses a level the relay could never have issued", () => {
    for (const access of ["View", " view", "read-only", "", null, 7]) {
      const summary = workspaceSummaryFor(
        entry({ shareView: shareView({ ...goodSelector, access }) }),
      );
      expect(summary.shareView?.damaged, JSON.stringify(access)).toBe(true);
      expect(summary.shareView?.access, JSON.stringify(access)).toBeUndefined();
    }
  });

  // A row does not have to be an object. Reading a field off one that turned
  // out to be `null` threw out of the whole projection, which is the same
  // zero-workspaces defect by another door.
  it("survives rows that are not objects at all", () => {
    const summaries = workspaceSummariesFrom([
      entry({ workspaceId: "ws-healthy" }),
      entry({
        workspaceId: "ws-null-row",
        shareMounts: [null, mount("m-good", "alex", goodSelector), "nonsense", 7],
      }),
      entry({ workspaceId: "ws-null-view", shareView: null }),
      entry({ workspaceId: "ws-scalar-view", shareView: "nonsense" }),
    ]);
    expect(
      summaries.map((summary) => summary.workspaceId),
      "MUTATION: a non-object row must not empty the workspace list",
    ).toEqual(["ws-healthy", "ws-null-row", "ws-null-view", "ws-scalar-view"]);
    // Only the readable mount survives the listing.
    expect(summaries[1]?.shareMounts?.map((m) => m.shareId)).toEqual(["m-good"]);
  });

  // PRESENCE decides the restriction, not readability. A share-view field
  // that lost its value is a share view that lost its value — reading it as
  // "ordinary workspace" is the presentation failing OPEN.
  it("keeps a present-but-unreadable share view restricted", () => {
    for (const raw of [null, "nonsense", 7, [], true]) {
      const summary = workspaceSummaryFor(entry({ shareView: raw }));
      expect(
        summary.shareView?.damaged,
        `MUTATION: shareView ${JSON.stringify(raw)} must not present as an ordinary workspace`,
      ).toBe(true);
      // Nothing is invented for a marker that carried nothing.
      expect(summary.shareView?.shareId).toBeUndefined();
      expect(summary.shareView?.granterEmail).toBeNull();
      expect(summary.shareView?.access).toBeUndefined();
    }
  });

  it("treats an ABSENT share view as an ordinary workspace", () => {
    expect(workspaceSummaryFor(entry()).shareView).toBeUndefined();
    expect(workspaceSummaryFor(entry({ shareView: undefined })).shareView).toBeUndefined();
  });

  // The pinned grant is read back through the SAME function the refresh path
  // uses. A selector the pull permanently refuses must read as damaged here
  // too, or the shell presents (and retries) a share that can never load.
  it("marks every selector the pull would refuse as damaged", () => {
    const refusedByThePull = [
      { paths: [], versionId: null, access: "view" }, // selects nothing
      { paths: ["docs"], versionId: "", access: "view" }, // unissuable version
      { paths: ["docs"], versionId: " v1 ", access: "view" }, // padded version
      { paths: "docs", versionId: null, access: "view" }, // paths not an array
      { paths: ["docs", 7], versionId: null, access: "view" }, // non-string path
      { versionId: null, access: "view" }, // no paths at all
    ];
    for (const selector of refusedByThePull) {
      const summary = workspaceSummaryFor(entry({ shareView: shareView(selector) }));
      expect(
        summary.shareView?.damaged,
        `MUTATION: ${JSON.stringify(selector)} loads here but is refused by the pull`,
      ).toBe(true);
    }
  });

  it("drops a mount whose pinned grant the pull would refuse", () => {
    const summary = workspaceSummaryFor(
      entry({
        shareMounts: [
          mount("m-good", "alex", goodSelector),
          mount("m-empty", "sam", { paths: [], versionId: null, access: "view" }),
          mount("m-badversion", "kim", {
            paths: ["docs"],
            versionId: " v1 ",
            access: "view",
          }),
        ],
      }),
    );
    expect(summary.shareMounts?.map((m) => m.shareId)).toEqual(["m-good"]);
  });

  // Damage to the WORKSPACE is not share-sized and must not be swallowed:
  // the refusal screen exists for exactly this, and silently hiding a
  // workspace would be an unrecoverable answer to a fault worth reporting.
  it("still throws when the workspace itself is unreadable", () => {
    expect(() =>
      workspaceSummaryFor(entry({ workspaceId: "", shareView: undefined })),
    ).toThrow();
  });
});

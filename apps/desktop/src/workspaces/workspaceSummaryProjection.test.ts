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

  it("omits an unreadable share view and keeps its workspace", () => {
    const summary = workspaceSummaryFor(
      entry({ shareView: shareView(staleSelector) }),
    );
    expect(summary.workspaceId).toBe("ws-1");
    // Omitted, never defaulted: a level nobody granted must not appear.
    expect(summary.shareView).toBeUndefined();
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
      expect(summary.shareView, JSON.stringify(access)).toBeUndefined();
    }
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

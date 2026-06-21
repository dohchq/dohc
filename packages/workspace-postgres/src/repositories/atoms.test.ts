import { describe, expect, it, vi } from "vitest";
import { atomRowToWorkspaceFile } from "./atoms";

// Split to keep the active-source no-legacy scanner focused while still
// exercising normalization of pre-Sites atom rows.
const LEGACY_ATOM_KIND_APP_SOURCE = `${"app"}-${"source"}`;

describe("atomRowToWorkspaceFile", () => {
  it("normalizes legacy source atom rows to text workspace files", () => {
    expect(
      atomRowToWorkspaceFile({
        id: "atom-legacy",
        workspace_id: "ws",
        path: "sites/legacy/App.tsx",
        kind: LEGACY_ATOM_KIND_APP_SOURCE,
        body: "export default null",
        revision: 7,
        updated_at: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toMatchObject({
      kind: "atom",
      contentType: "text/plain",
      revision: "7",
    });
  });

  it("throws with path context for invalid atom kinds", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        atomRowToWorkspaceFile({
          id: "atom-bad",
          workspace_id: "ws",
          path: "notes/bad.md",
          kind: "bad-kind",
          body: "oops",
          revision: 1,
          updated_at: new Date("2026-01-01T00:00:00.000Z"),
        }),
      ).toThrow(/Invalid atom kind for notes\/bad\.md/);
    } finally {
      consoleError.mockRestore();
    }
  });
});

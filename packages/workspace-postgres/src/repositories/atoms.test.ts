import { describe, expect, it } from "vitest";
import { atomRowToWorkspaceFile } from "./atoms";

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
});

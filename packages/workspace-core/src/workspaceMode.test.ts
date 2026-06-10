import { describe, expect, it } from "vitest";
import { createFileRecord, createWorkspaceManifest } from "./metadata";
import { defaultWorkspaceMode } from "./workspaceMode";

describe("workspace modes", () => {
  it("defaults personal workspaces to local-first", () => {
    expect(defaultWorkspaceMode("personal")).toBe("local-first");
  });

  it("defaults shared workspaces to cloud-first with a local copy", () => {
    expect(defaultWorkspaceMode("shared")).toBe("cloud-first-local-copy");
  });

  it("defaults cloud-only workspaces to cloud-only", () => {
    expect(defaultWorkspaceMode("cloud-only")).toBe("cloud-only");
  });

  it("stores mode on the workspace manifest, never on file records", () => {
    const manifest = createWorkspaceManifest({
      workspaceId: "ws-1",
      kind: "shared",
    });
    expect(manifest.mode).toBe("cloud-first-local-copy");
    expect(manifest.version).toBe(1);

    const record = createFileRecord({
      path: "notes/today.md",
      contentHash: "abc123",
    });
    expect("mode" in record).toBe(false);
  });
});

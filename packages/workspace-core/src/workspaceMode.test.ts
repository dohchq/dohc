import { describe, expect, it } from "vitest";
import { checkManifest, createWorkspaceManifest } from "./metadata";
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
  });
});

describe("manifest validation", () => {
  it("accepts a complete v1 manifest", () => {
    const result = checkManifest({
      version: 1,
      workspaceId: "ws-1",
      kind: "personal",
      mode: "local-first",
    });
    expect(result.status).toBe("valid");
  });

  it("rejects a partial manifest (missing kind/mode) instead of adopting it", () => {
    const result = checkManifest({ version: 1, workspaceId: "ws-1" });
    expect(result.status).toBe("invalid");
  });

  it("rejects an empty workspaceId", () => {
    const result = checkManifest({
      version: 1,
      workspaceId: "",
      kind: "personal",
      mode: "local-first",
    });
    expect(result.status).toBe("invalid");
  });

  it("rejects an invalid kind or mode value", () => {
    expect(
      checkManifest({ version: 1, workspaceId: "ws-1", kind: "evil", mode: "local-first" }).status,
    ).toBe("invalid");
    expect(
      checkManifest({ version: 1, workspaceId: "ws-1", kind: "personal", mode: "evil" }).status,
    ).toBe("invalid");
  });

  it("flags a newer-version manifest so callers refuse to overwrite it", () => {
    const result = checkManifest({ version: 2, workspaceId: "ws-1" });
    expect(result.status).toBe("newer-version");
  });

  it("treats non-objects as invalid", () => {
    expect(checkManifest(null).status).toBe("invalid");
    expect(checkManifest("nope").status).toBe("invalid");
  });
});

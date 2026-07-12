import { describe, expect, it } from "vitest";
import {
  isWorkspaceRelativeSrc,
  joinWorkspacePath,
  resolveWorkspaceImageSrc,
} from "./imageSrc";

describe("isWorkspaceRelativeSrc", () => {
  it("treats scheme-less, non-absolute paths as workspace-relative", () => {
    expect(isWorkspaceRelativeSrc("assets/pic.png")).toBe(true);
    expect(isWorkspaceRelativeSrc("./assets/pic.png")).toBe(true);
  });

  it("treats http(s) and other schemes as non-relative", () => {
    expect(isWorkspaceRelativeSrc("https://example.com/x.png")).toBe(false);
    expect(isWorkspaceRelativeSrc("http://example.com/x.png")).toBe(false);
    expect(isWorkspaceRelativeSrc("data:image/png;base64,AAAA")).toBe(false);
  });

  it("treats absolute and protocol-relative paths as non-relative", () => {
    expect(isWorkspaceRelativeSrc("/etc/pic.png")).toBe(false);
    expect(isWorkspaceRelativeSrc("//host/pic.png")).toBe(false);
  });
});

describe("joinWorkspacePath", () => {
  it("resolves relative to the document's folder", () => {
    expect(joinWorkspacePath("notes/plan.md", "assets/pic.png")).toBe(
      "notes/assets/pic.png",
    );
  });

  it("resolves against the workspace root for a top-level document", () => {
    expect(joinWorkspacePath("plan.md", "assets/pic.png")).toBe(
      "assets/pic.png",
    );
  });

  it("collapses leading ./ segments", () => {
    expect(joinWorkspacePath("notes/plan.md", "./assets/pic.png")).toBe(
      "notes/assets/pic.png",
    );
  });

  it("resolves `..` by popping the parent folder (global-folder attachments)", () => {
    expect(joinWorkspacePath("notes/plan.md", "../attachments/pic.png")).toBe(
      "attachments/pic.png",
    );
    expect(joinWorkspacePath("a/b/plan.md", "../../attachments/pic.png")).toBe(
      "attachments/pic.png",
    );
  });

  it("preserves leading `..` when a path climbs above the workspace root", () => {
    // notes/ pops once, then the extra `..` underflows and is kept so callers
    // can detect the escape.
    expect(joinWorkspacePath("notes/plan.md", "../../escape.png")).toBe(
      "../escape.png",
    );
    expect(joinWorkspacePath("plan.md", "../escape.png")).toBe("../escape.png");
  });
});

describe("resolveWorkspaceImageSrc", () => {
  const ctx = { workspaceId: "ws1", docPath: "notes/plan.md" };

  it("maps a workspace-relative src to a dohc-file URL under the doc folder", () => {
    expect(resolveWorkspaceImageSrc(ctx, "assets/pic.png")).toBe(
      "dohc-file://ws1/notes/assets/pic.png",
    );
  });

  it("percent-encodes each path segment", () => {
    expect(resolveWorkspaceImageSrc(ctx, "assets/my pic.png")).toBe(
      "dohc-file://ws1/notes/assets/my%20pic.png",
    );
  });

  it("leaves http(s) srcs untouched", () => {
    expect(
      resolveWorkspaceImageSrc(ctx, "https://example.com/x.png"),
    ).toBe("https://example.com/x.png");
  });

  it("resolves an upward-relative src to a dohc-file URL under the root", () => {
    expect(resolveWorkspaceImageSrc(ctx, "../attachments/x.png")).toBe(
      "dohc-file://ws1/attachments/x.png",
    );
  });

  it("refuses to mint a URL for a src that escapes the workspace root", () => {
    // notes/plan.md + ../../outside.png climbs above the root: the raw src is
    // returned (renders nothing) rather than reaching the protocol layer.
    expect(resolveWorkspaceImageSrc(ctx, "../../outside.png")).toBe(
      "../../outside.png",
    );
  });
});

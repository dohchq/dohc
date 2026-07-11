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
});

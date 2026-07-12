// @vitest-environment jsdom
// jsdom: makeImageNodeView builds a real <img> element.
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_IMAGE_SRC,
  isWorkspaceRelativeSrc,
  joinWorkspacePath,
  makeImageNodeView,
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

  it("blocks a src that escapes the workspace root (never returns the raw path)", () => {
    // notes/plan.md + ../../outside.png climbs above the root. Returning the RAW
    // path would not contain anything: the renderer page has its own base URL
    // (file:// when packaged), so the browser would resolve the escape against
    // the APP directory and decode whatever it found. Blocked → no src at all.
    expect(resolveWorkspaceImageSrc(ctx, "../../outside.png")).toBe(
      BLOCKED_IMAGE_SRC,
    );
    expect(resolveWorkspaceImageSrc(ctx, "../../../../etc/pic.png")).toBe(
      BLOCKED_IMAGE_SRC,
    );
    // A root-level document: even a single `..` already escapes.
    expect(
      resolveWorkspaceImageSrc(
        { workspaceId: "ws1", docPath: "plan.md" },
        "../outside.png",
      ),
    ).toBe(BLOCKED_IMAGE_SRC);
  });

  it("blocks a src that normalizes to nothing", () => {
    // A root-level document: "./" normalizes away entirely, leaving no path to
    // serve — never mint `dohc-file://ws1/` for the workspace root itself.
    expect(
      resolveWorkspaceImageSrc({ workspaceId: "ws1", docPath: "plan.md" }, "./"),
    ).toBe(BLOCKED_IMAGE_SRC);
  });
});

describe("makeImageNodeView", () => {
  const node = (src: string): ProseMirrorNode =>
    ({ attrs: { src, alt: "alt text", title: null } }) as unknown as ProseMirrorNode;

  it("renders a servable src as a dohc-file URL", () => {
    const view = makeImageNodeView(() => ({
      workspaceId: "ws1",
      docPath: "notes/plan.md",
    }))(node("assets/pic.png"));
    expect((view.dom as HTMLImageElement).getAttribute("src")).toBe(
      "dohc-file://ws1/notes/assets/pic.png",
    );
  });

  it("emits NO src attribute for a blocked (escaping) src", () => {
    // Not `src=""` — an empty src re-requests the page's own URL — and above all
    // not the raw `../../outside.png`, which the app page would resolve against
    // its own directory.
    const view = makeImageNodeView(() => ({
      workspaceId: "ws1",
      docPath: "notes/plan.md",
    }))(node("../../outside.png"));
    const img = view.dom as HTMLImageElement;
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("alt")).toBe("alt text");
  });
});

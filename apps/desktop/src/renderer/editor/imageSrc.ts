import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

// Resolving a workspace-relative image src → a servable URL, desktop-only.
//
// The canonical image node attr stays the ORIGINAL relative path (e.g.
// `assets/pic.png`, relative to the document) so the markdown round-trips
// losslessly. Only at render time does the desktop editor rewrite that path to
// the privileged `dohc-file://` scheme the main process serves bytes from —
// keeping the ydoc-projection copy (which never paints to a screen) pure.

export type ImageSrcContext = {
  workspaceId: string;
  // The current document's workspace-relative path (e.g. `notes/plan.md`).
  // Relative image srcs resolve against this document's folder.
  docPath: string;
  // Browser-hosted consumers can provide an in-memory asset URL while the
  // desktop app keeps using its privileged dohc-file protocol.
  resolveWorkspaceAssetUrl?: (workspacePath: string) => string | null;
};

// True when `src` is a plain path relative to the document — no URI scheme, not
// protocol-relative, not root-absolute. Anything else (http(s), and defensively
// any leftover scheme) is left untouched so the browser loads it directly.
export function isWorkspaceRelativeSrc(src: string): boolean {
  const trimmed = src.trim();
  if (trimmed.length === 0) return false;
  const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, "");
  if (/^[a-z][a-z\d+.-]*:/i.test(compact)) return false;
  const forCheck = compact.replace(/\\/g, "/");
  if (forCheck.startsWith("/")) return false;
  return true;
}

// The document's folder as a workspace-relative prefix, with a trailing slash
// (or "" when the document sits at the workspace root). Exported so the
// attachment write path (imagePaste) computes targets against the same notion
// of "the document's folder" the resolver uses.
export function documentDir(docPath: string): string {
  const normalized = docPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash + 1);
}

// Joins a document-relative src onto the document's folder via pure lexical
// normalization: `.`/`./` are collapsed and `..` pops the parent segment.
//
// Upward-relative links (`../attachments/x.png`) are now first-class — the
// global-folder attachment mode writes them so a nested doc can reference one
// folder at the workspace root. If `..` climbs ABOVE the workspace root the
// escaping `..` segments are PRESERVED at the front of the result (e.g.
// "../escape.png"), so callers can DETECT the escape rather than have it
// silently flattened; resolveWorkspaceImageSrc refuses to serve such a path.
export function joinWorkspacePath(docPath: string, src: string): string {
  const combined = documentDir(docPath) + src.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = segments[segments.length - 1];
      if (segments.length > 0 && last !== "..") {
        segments.pop();
      } else {
        // Underflow: nothing left to pop (or only prior escapes) — keep the
        // `..` so the result is recognizably outside the workspace root.
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

// True when a normalized workspace path escapes the workspace root — i.e. it is
// (or begins with) a leftover `..` segment. Such a path must never be minted
// into a dohc-file:// URL.
export function escapesWorkspaceRoot(workspacePath: string): boolean {
  return workspacePath === ".." || workspacePath.startsWith("../");
}

// Builds the privileged URL the dohc-file protocol serves bytes from (mirrors
// FileInspector.assetUrl). The main process re-validates containment against
// the real workspace root, so this URL can never escape the workspace.
export function assetUrl(workspaceId: string, workspacePath: string): string {
  const encoded = workspacePath.split("/").map(encodeURIComponent).join("/");
  return `dohc-file://${workspaceId}/${encoded}`;
}

// The resolver's "serve nothing" answer, and the ONLY safe one for a src we
// refuse to serve. Handing the RAW relative path back to the browser is not
// containment: the renderer document is itself loaded from a real URL (file://
// in a packaged app, the dev server otherwise), so `../../build/icon.png` would
// resolve against the APP's own page — outside the workspace entirely — and
// Chromium would happily decode it. The node view drops the src attribute for
// this value, so a blocked image issues no request at all.
export const BLOCKED_IMAGE_SRC = "";

// Maps an image node's stored src to the URL the renderer should actually load:
// workspace-relative → dohc-file://…; http(s) is passed through untouched; a
// src that cannot be served safely → BLOCKED_IMAGE_SRC (no request at all).
export function resolveWorkspaceImageSrc(
  context: ImageSrcContext,
  src: string,
): string {
  if (!isWorkspaceRelativeSrc(src)) return src;
  const workspacePath = joinWorkspacePath(context.docPath, src.trim());
  // Containment: refuse to mint a privileged dohc-file:// URL for a path that
  // normalizes to nothing or climbs out of the workspace root — and refuse to
  // hand the raw path back to the browser either (see BLOCKED_IMAGE_SRC). The
  // escaping link renders as its alt text and reaches nothing. (readWorkspaceAsset
  // / the dohc-file handler also re-check real-path containment; this is the
  // first, purely-lexical gate.)
  if (workspacePath.length === 0 || escapesWorkspaceRoot(workspacePath)) {
    return BLOCKED_IMAGE_SRC;
  }
  const consumerUrl = context.resolveWorkspaceAssetUrl?.(workspacePath);
  if (consumerUrl) return consumerUrl;
  return assetUrl(context.workspaceId, workspacePath);
}

// A ProseMirror NodeView (registered through the image extension's
// addNodeView — TipTap 3.x ignores editorProps.nodeViews) that renders the
// image node with a render-time-resolved src while leaving the node's attrs —
// the canonical, round-tripped markdown path — untouched.
//
// `getContext` may return null (serialization / non-desktop consumers that have
// no workspace/document context): the src then renders as the raw stored path,
// exactly as the default renderHTML would, so nothing breaks off the desktop.
export function makeImageNodeView(
  getContext: () => ImageSrcContext | null,
): (node: ProseMirrorNode) => NodeView {
  return (node) => {
    const img = document.createElement("img");
    img.className = "dohc-editor-image";

    const apply = (current: ProseMirrorNode): void => {
      const src = String(current.attrs.src ?? "");
      const context = getContext();
      const resolved = context ? resolveWorkspaceImageSrc(context, src) : src;
      // A blocked (or empty) src means NO src attribute — not `src=""`, which
      // browsers resolve to the page's own URL and re-request. Nothing is
      // fetched; the node's attrs (the canonical markdown path) are untouched,
      // so the escaping link still round-trips losslessly into the .md.
      if (resolved.length === 0) {
        img.removeAttribute("src");
      } else {
        img.setAttribute("src", resolved);
      }
      img.setAttribute("alt", String(current.attrs.alt ?? ""));
      const title = current.attrs.title;
      if (typeof title === "string" && title.length > 0) {
        img.setAttribute("title", title);
      } else {
        img.removeAttribute("title");
      }
    };

    apply(node);

    return {
      dom: img,
      update(updated) {
        if (updated.type.name !== "image") return false;
        apply(updated);
        return true;
      },
      // The <img> DOM is entirely author-managed: we set src/alt/title in
      // `apply`, and the browser mutates it further while decoding. Without
      // this, ProseMirror's DOM observer treats those mutations as user edits
      // and tries to read them back into the atom — which resets the selection
      // or throws (no editor-level error boundary → a white-screen "crash").
      // The sibling math node view guards the same way.
      ignoreMutation() {
        return true;
      },
    };
  };
}

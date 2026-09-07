// The one Markdown image-src sanitizer. The projection pipeline and the
// desktop editor both import it (the desktop through the
// @dohc/ydoc-projection/image-src subpath) so the image-src contract cannot
// drift between the two adapters.
export function sanitizeImageSrc(src: string): string {
  const trimmed = src.trim()
  if (trimmed.length === 0) return ''
  // Strip control chars/whitespace before sniffing so obfuscated schemes
  // ("java\nscript:") can't slip a colon past the check.
  const compact = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, '')
  const compactProtocol = /^[a-z][a-z\d+.-]*:/i.exec(compact)?.[0]
  if (compactProtocol) {
    const protocol = compactProtocol.slice(0, -1).toLowerCase()
    // Only remote http(s) images render; data:/javascript:/file:/every other
    // scheme is dropped.
    return protocol === 'http' || protocol === 'https' ? trimmed : ''
  }
  // Scheme-less: allow only a workspace-relative path. Backslashes are folded
  // to '/' for the checks so a Windows-style traversal can't sneak through,
  // but the original (lossless) src is what we return — agents edit the.md.
  const forCheck = compact.replace(/\\/g, '/')
  // Reject protocol-relative ("//host") and absolute ("/abs") — both escape
  // the document's folder and can never be a workspace-relative asset.
  if (forCheck.startsWith('/')) return ''
  // CONTRACT: forward-slash parent traversal (`../foo`) is preserved
  // losslessly. Agents legitimately author upward-relative asset links — the
  // global-folder attachment mode writes `../assets/x.png` so a nested doc can
  // point at one folder at the workspace root.
  //
  // Containment is not enforced here — the sanitizer's job is the MARKDOWN
  // (what round-trips into the .md), not what any given surface may load. Every
  // surface that can actually FETCH the src gates it itself, and none of them
  // may fall back to the raw path:
  //   - the editor: imageSrc.ts serves a src over dohc-file:// only if it
  //     normalizes inside the workspace root, and emits NO src otherwise (a raw
  //     relative path would resolve against the app's own page);
  //   - the protocol layer: readOwnedWorkspaceAsset / the dohc-file handler re-check
  //     real-path containment;
  //   - exports: documentExport.ts drops any src that could climb out of the
  //     exported file's own folder (see its EXPORT IMAGE CONTRACT).
  //
  // A BACKSLASH-obfuscated `..\` is never legitimate authored markdown, so it
  // stays blocked here (backslashes are folded to '/' first).
  if (compact.includes('\\') && /(^|\/)\.\.(\/|$)/.test(forCheck)) return ''
  return trimmed
}

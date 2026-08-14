import * as Y from "yjs";

// Both halves of the recovery snapshot contract (#769): the encoder the
// deletion/delivery boundaries write, and the decoder every recovery surface
// reads. The marker is the whole contract, so it lives in ONE module — a
// second spelling of it in the surface that copies the text is how the user
// ends up with an opaque blob on the clipboard.

// `@dohc/ydoc-projection` statically pulls in the full Tiptap stack and
// builds its schema at module load. `useEngineDoc` backs every FileInspector,
// so a static import here put that whole editor stack in the renderer's
// eager chunk. Loaded once, lazily, and cached — every caller in this module
// shares the same in-flight/resolved promise instead of re-importing.
type ProjectionModule = typeof import("@dohc/ydoc-projection");
let projectionModulePromise: Promise<ProjectionModule> | null = null;
export function loadProjectionModule(): Promise<ProjectionModule> {
  if (projectionModulePromise === null) {
    // A rejected import must not be cached: a transient chunk-fetch failure
    // (a bundle replaced mid-session by an update, for example) would
    // otherwise fail every later deletion's faithful capture for the rest of
    // the session. Clearing on rejection lets the next deletion retry.
    const pending = import("@dohc/ydoc-projection");
    projectionModulePromise = pending;
    void pending.catch(() => {
      if (projectionModulePromise === pending) projectionModulePromise = null;
    });
  }
  return projectionModulePromise;
}

// A deletion's draft text depends on the projection module, but the BYTES
// that produce it must not: the live doc can be destroyed (unmount) before
// the module resolves, so the doc is snapshotted synchronously at the event
// and projected to markdown lazily, off a reconstructed doc.
export function markdownFromSnapshot(snapshot: Uint8Array): Promise<string> {
  return loadProjectionModule().then(({ yDocToMarkdown }) => {
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, snapshot);
    return yDocToMarkdown(rebuilt);
  });
}

// The crude fallback the deletion boundary persists BEFORE the projection
// module is even guaranteed to load — pure yjs, no Tiptap, so it never waits
// on the chunk this whole lazy-load exists to defer. Faithful markdown
// (frontmatter ordering, table/list formatting, escaping) replaces this the
// moment `markdownFromSnapshot` resolves; this only has to outlast a crash.
function crudeMarkdownFromDoc(doc: Y.Doc): string {
  const meta = doc.getMap("meta");
  if (meta.get("contentKind") === "plain-text") {
    return doc.getText("plainText").toString();
  }
  const frontmatter = doc.getMap("frontmatter");
  const frontmatterLines: string[] = [];
  for (const [key, value] of frontmatter.entries()) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      frontmatterLines.push(`${key}: ${String(value)}`);
    }
  }
  const frontmatterText =
    frontmatterLines.length > 0
      ? `---\n${frontmatterLines.join("\n")}\n---\n\n`
      : "";
  const blockText = (node: Y.XmlText | Y.XmlElement | Y.XmlHook): string => {
    if (node instanceof Y.XmlText) return node.toString();
    if (node instanceof Y.XmlElement) {
      return node.toArray().map(blockText).join("");
    }
    return "";
  };
  const blocks = doc
    .getXmlFragment("body")
    .toArray()
    .map(blockText)
    .filter((text) => text.length > 0);
  return frontmatterText + blocks.join("\n\n");
}

const YDOC_RECOVERY_MARKER = "dohc-ydoc-recovery-v1";
// The encoder always appends the comment last, after the crude fallback.
// A payload the encoder cannot have produced still has to be strippable: the
// user must never be shown the encoding, whatever state it reached disk in.
const RECOVERY_COMMENT = new RegExp(
  `\\n*<!-- ${YDOC_RECOVERY_MARKER}:([\\s\\S]*?) -->$`,
  "u",
);

function snapshotAsBase64(snapshot: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < snapshot.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...snapshot.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export function durableMarkdownFromSnapshot(
  doc: Y.Doc,
  snapshot: Uint8Array,
): string {
  const fallback = crudeMarkdownFromDoc(doc);
  if (doc.getMap("meta").get("contentKind") === "plain-text") return fallback;
  const separator = fallback.length > 0 ? "\n\n" : "";
  // The text store cannot hold a Uint8Array. Keep the canonical Y.Doc update
  // in an inert Markdown comment until the async projection replaces this
  // whole fallback. A failed chunk load or renderer exit can lose formatting
  // from the readable fallback, but it cannot lose the document structure.
  return `${fallback}${separator}<!-- ${YDOC_RECOVERY_MARKER}:${snapshotAsBase64(
    snapshot,
  )} -->`;
}

// Rebuilding the document is the only step that can fail on the DATA, so it
// runs before the projection: that split is what separates "these bytes are
// gone" from "the projection did not run". Null means gone.
function recoverSnapshotDoc(encoded: string): Y.Doc | null {
  try {
    const binary = atob(encoded);
    const snapshot = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, snapshot);
    return recovered;
  } catch {
    return null;
  }
}

// The recovery text as the user must receive it. A draft the projection never
// refined carries the full document in the encoded comment, so the snapshot —
// not the crude fallback beside it — is what Copy has to hand back.
//
// Resolved per copy, at the click. The lazy import can still be in flight when
// the row renders, and a failed one clears its own cache — so a copy waits for
// the lossless answer, and the copy after a transient failure retries instead
// of serving that failure's fallback for as long as the row stays mounted.
//
// It REJECTS when the projection fails over intact bytes. Copy then reports
// the failure and the next click retries, because the document is still whole
// and the user must not be handed the lossy half — and then delete the row
// believing they have their text.
export async function restoreRecoveryDraftText(text: string): Promise<string> {
  const match = RECOVERY_COMMENT.exec(text);
  if (!match) return text;
  const recovered = recoverSnapshotDoc(match[1]!);
  // Unrecoverable bytes: the readable half beside them is all that is left,
  // and handing it over is why both halves are stored.
  if (recovered === null) return text.slice(0, match.index);
  try {
    const { yDocToMarkdown } = await loadProjectionModule();
    return yDocToMarkdown(recovered);
  } finally {
    recovered.destroy();
  }
}

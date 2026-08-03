import type {
  VersionFileChange,
  VersionId,
  VersionedTextStore,
  WorkspaceId,
} from "@dohc/workspace-contracts/engine";

// UI-facing whole-version comparison, page-shaped (#562). The per-file
// three-way comparison (compareTextFileVersions) answers "how do these sides
// relate for ONE path"; this hydrates the engine's differing-path listing
// (`versions.compareFiles`) into the shape the compare surface needs: one page
// of differing paths, with both texts for diffing, and a continuation for the
// rest. The old shape hydrated EVERY file of BOTH versions and returned one
// unbounded array; nothing between the store and the renderer bounded it.
//
// Status reads from the SOURCE version's perspective against the TARGET
// (product framing: "what does this Version change relative to Main"):
//   - added:    the path exists only in the source version.
//   - deleted:  the path exists only in the target version.
//   - modified: both versions have the path with different content.
// Identical paths are omitted — an empty final page means "no differences".

export type {
  VersionFileChange,
  VersionFileChangeStatus,
} from "@dohc/workspace-contracts/engine";

/**
 * `COMPARE_PAGE_TEXT_BYTE_BUDGET`: how many UTF-8 bytes of hydrated text one
 * compare page may carry, measured over both sides of every row.
 *
 * The number is the engine's own page discipline: every daemon list family
 * pages under a 256 KiB serialized budget (`CONFLICTS_PAGE_BYTE_BUDGET`,
 * `CHAT_PAGE_BYTE_BUDGET`, `MOMENTS_PAGE_BYTE_BUDGET` in
 * crates/dohc-workspace-engine/src/lib.rs), and this page rides the same IPC
 * transport as those. It never rejects work: a row that alone exceeds the
 * budget still ships, on a page of its own, and the continuation reaches
 * everything else. `versionCompare.test.ts` holds the progress guarantee and
 * the measured evidence that representative healthy compares fit in one page.
 */
export const COMPARE_PAGE_TEXT_BYTE_BUDGET = 256 * 1024;

export interface VersionComparePage {
  files: VersionFileChange[];
  // Pass back as afterPath to fetch the next page; null when this page
  // reached the end of the comparison.
  nextAfterPath: string | null;
}

// UTF-8 length without building the encoded copy: the budget is spent on
// multi-megabyte bodies, and encoding one just to count it would allocate a
// second copy.
function utf8Length(text: string): number {
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code < 0x10000) length += 3;
    else length += 4;
  }
  return length;
}

function changeBytes(change: VersionFileChange): number {
  return (
    (change.currentText === undefined ? 0 : utf8Length(change.currentText)) +
    (change.incomingText === undefined ? 0 : utf8Length(change.incomingText))
  );
}

export async function compareVersionFilesPage(
  // The comparison reads the differing-path listing, then only the sides the
  // page's rows need.
  store: Pick<VersionedTextStore, "compareVersionFilesPage" | "readTextFile">,
  input: {
    workspaceId: WorkspaceId;
    sourceVersionId: VersionId;
    targetVersionId: VersionId;
    afterPath?: string;
    byteBudget?: number;
  },
): Promise<VersionComparePage> {
  const budget = input.byteBudget ?? COMPARE_PAGE_TEXT_BYTE_BUDGET;
  const delta = await store.compareVersionFilesPage({
    workspaceId: input.workspaceId,
    sourceVersionId: input.sourceVersionId,
    targetVersionId: input.targetVersionId,
    ...(input.afterPath !== undefined ? { afterPath: input.afterPath } : {}),
  });

  const files: VersionFileChange[] = [];
  let spentBytes = 0;
  for (const [index, entry] of delta.entries.entries()) {
    if (entry.binary) {
      files.push({ path: entry.path, status: entry.status, binary: true });
      continue;
    }
    const read = async (versionId: VersionId) =>
      await store.readTextFile({
        workspaceId: input.workspaceId,
        versionId,
        path: entry.path,
      });
    const current =
      entry.status === "added" ? null : await read(input.targetVersionId);
    const incoming =
      entry.status === "deleted" ? null : await read(input.sourceVersionId);
    const change: VersionFileChange = {
      path: entry.path,
      status: entry.status,
      // A side the listing promised can vanish between the listing and this
      // read (a concurrent write). The row keeps its status and simply
      // carries the sides that still exist.
      ...(current !== null ? { currentText: current.text } : {}),
      ...(incoming !== null ? { incomingText: incoming.text } : {}),
    };
    spentBytes += changeBytes(change);
    files.push(change);
    // The budget bounds the page, never the row: the first row always ships,
    // however large, and the cut lands after the row that crossed the line.
    if (spentBytes >= budget && index < delta.entries.length - 1) {
      return { files, nextAfterPath: entry.path };
    }
  }
  return { files, nextAfterPath: delta.nextAfterPath };
}

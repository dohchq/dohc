// Splits markdown source into block-safe chunks for incremental rendering
// (Phase 16: a 250KB document parses ~575ms as one tree; the first visible
// window parses in single-digit ms). Chunk boundaries sit only at blank lines
// OUTSIDE fenced code, so each chunk parses to the same blocks it would inside
// the full document. Reference-style link definitions are collected doc-wide
// and appended to every chunk (definitions render nothing), so links keep
// resolving across chunk boundaries.

const CHUNK_TARGET_BYTES = 4 * 1024;

const FENCE_RE = /^\s{0,3}(```|~~~)/;
const LINK_DEF_RE = /^\s{0,3}\[[^\]]+\]:\s+\S/;

export function splitMarkdownBlocks(source: string): string[] {
  const lines = source.split("\n");

  // Segment at blank lines outside fences; collect link definitions.
  const segments: string[] = [];
  const definitions: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (current.length === 0) return;
    segments.push(current.join("\n"));
    current = [];
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence === null && fenceMatch) fence = fenceMatch[1];
    else if (fence !== null && fenceMatch && line.trim().startsWith(fence)) fence = null;

    if (fence === null && line.trim() === "") {
      flush();
      continue;
    }
    if (fence === null && LINK_DEF_RE.test(line)) definitions.push(line);
    current.push(line);
  }
  flush();

  // Pack segments into chunks around the byte target — block count stays low
  // (one memoized React subtree per chunk), boundaries stay block-safe.
  const defsSuffix = definitions.length > 0 ? `\n\n${definitions.join("\n")}` : "";
  const chunks: string[] = [];
  let pack: string[] = [];
  let packBytes = 0;
  for (const segment of segments) {
    pack.push(segment);
    packBytes += segment.length + 2;
    if (packBytes >= CHUNK_TARGET_BYTES) {
      chunks.push(pack.join("\n\n") + defsSuffix);
      pack = [];
      packBytes = 0;
    }
  }
  if (pack.length > 0) chunks.push(pack.join("\n\n") + defsSuffix);
  return chunks.length > 0 ? chunks : [source];
}

// How many leading chunks make up the first visible window (~bytes worth).
export function initialChunkCount(chunks: string[], windowBytes: number): number {
  let bytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    bytes += chunks[i].length;
    if (bytes >= windowBytes) return i + 1;
  }
  return chunks.length;
}

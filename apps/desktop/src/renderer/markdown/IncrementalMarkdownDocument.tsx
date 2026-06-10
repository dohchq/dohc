import { memo, useEffect, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { initialChunkCount, splitMarkdownBlocks } from "./splitMarkdownBlocks";

// Visible-first markdown rendering (Phase 16 recovery): parse + commit only
// the opening window on mount, then backfill the rest in idle slices. The
// first usable document lands in tens of ms instead of paying the full-tree
// parse+commit (~575ms for 250KB) up front. Same react-markdown, same
// component map, no raw HTML — the security model is untouched; each chunk is
// a memoized subtree so backfill never re-parses what is already on screen.

// Documents under this size render as a single chunk — byte-identical
// behavior to the pre-incremental path.
const INCREMENTAL_THRESHOLD_BYTES = 32 * 1024;
const FIRST_WINDOW_BYTES = 12 * 1024;

type IdleScheduler = (cb: () => void) => () => void;

// requestIdleCallback in the Electron renderer; setTimeout under test DOM
// environments that lack it. Returns a canceller.
const scheduleIdle: IdleScheduler =
  typeof requestIdleCallback === "function"
    ? (cb) => {
        const id = requestIdleCallback(() => cb(), { timeout: 50 });
        return () => cancelIdleCallback(id);
      }
    : (cb) => {
        const id = setTimeout(cb, 0);
        return () => clearTimeout(id);
      };

const MarkdownChunk = memo(function MarkdownChunk(props: {
  source: string;
  components: Components;
}) {
  return <Markdown components={props.components}>{props.source}</Markdown>;
});

export function IncrementalMarkdownDocument(props: {
  body: string;
  components: Components;
}) {
  const chunks = useMemo(
    () =>
      props.body.length <= INCREMENTAL_THRESHOLD_BYTES
        ? [props.body]
        : splitMarkdownBlocks(props.body),
    [props.body],
  );
  const firstWindow = useMemo(
    () => initialChunkCount(chunks, FIRST_WINDOW_BYTES),
    [chunks],
  );
  const [visibleCount, setVisibleCount] = useState(firstWindow);

  // New document: reset to its opening window (state initializer only runs on
  // mount; the same component instance survives a path switch).
  useEffect(() => {
    setVisibleCount(firstWindow);
  }, [chunks, firstWindow]);

  // Idle backfill: append chunks until the whole document is committed.
  useEffect(() => {
    if (visibleCount >= chunks.length) return;
    return scheduleIdle(() => {
      setVisibleCount((count) => Math.min(count + 16, chunks.length));
    });
  }, [visibleCount, chunks]);

  return (
    <>
      {chunks.slice(0, visibleCount).map((chunk, i) => (
        // Chunks are content-stable for a given body; index keys are correct
        // because a body change rebuilds the whole list.
        <MarkdownChunk key={i} source={chunk} components={props.components} />
      ))}
    </>
  );
}

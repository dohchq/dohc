import { memo, useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import {
  activateReadOnlyLinkHref,
  type WorkspaceLinkTarget,
} from "../editor/linkMenu";
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
const scheduleIdle: IdleScheduler = (cb) => {
  if (typeof globalThis.requestIdleCallback === "function") {
    const id = globalThis.requestIdleCallback(() => cb(), { timeout: 50 });
    return () => globalThis.cancelIdleCallback(id);
  }
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
  onOpenWorkspaceLink?: (target: WorkspaceLinkTarget) => void;
}) {
  const onOpenWorkspaceLinkRef = useRef(props.onOpenWorkspaceLink);
  onOpenWorkspaceLinkRef.current = props.onOpenWorkspaceLink;
  const components = useMemo<Components>(
    () => ({
      ...props.components,
      a: ({ children, href }) => {
        if (!href) {
          return <span className="text-accent underline">{children}</span>;
        }
        const activate = (
          event: React.MouseEvent<HTMLAnchorElement> | React.KeyboardEvent<HTMLAnchorElement>,
        ) =>
          activateReadOnlyLinkHref(href, event, (target) =>
            onOpenWorkspaceLinkRef.current?.(target),
          );
        return (
          <a
            href={href}
            className="text-accent underline"
            onClick={activate}
            onAuxClick={(event) => {
              if (event.button === 1) activate(event);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") activate(event);
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [props.components],
  );
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
  const [renderWindow, setRenderWindow] = useState(() => ({
    chunks,
    visibleCount: firstWindow,
  }));

  // Reset before React commits a replacement document. An effect is too late:
  // it commits the new body with the previous body's expanded window first.
  if (renderWindow.chunks !== chunks) {
    setRenderWindow({ chunks, visibleCount: firstWindow });
  }
  const visibleCount =
    renderWindow.chunks === chunks ? renderWindow.visibleCount : firstWindow;

  // Idle backfill: append chunks until the whole document is committed.
  useEffect(() => {
    if (visibleCount >= chunks.length) return;
    return scheduleIdle(() => {
      setRenderWindow((current) =>
        current.chunks === chunks
          ? {
              chunks,
              visibleCount: Math.min(
                current.visibleCount + 16,
                chunks.length,
              ),
            }
          : current,
      );
    });
  }, [visibleCount, chunks]);

  return (
    <>
      {chunks.slice(0, visibleCount).map((chunk, i) => (
        // Chunks are content-stable for a given body; index keys are correct
        // because a body change rebuilds the whole list.
        <MarkdownChunk key={i} source={chunk} components={components} />
      ))}
    </>
  );
}

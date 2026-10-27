import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import type { Nodes, Parents, Root } from "mdast";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  TABLE_ROW_HEIGHTS_RE,
  tableRowHeights,
} from "@dohc/ydoc-projection/table-row-heights";
import {
  activateReadOnlyLinkHref,
  type WorkspaceLinkTarget,
} from "../linkActivation";
import { MARKDOWN_COMPONENTS } from "./markdownComponents";
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
// The chunks of about two large documents.
const CHUNK_CACHE_BYTES = 512 * 1024;

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

// The editor reads a resized row's height from the comment above its table
// and sets it on the row. Read that one comment with the projection's own
// rule and set the same height, so a row does not grow when the editor
// replaces the read body. Any other comment stays text, as in the editor.
function remarkTableRowHeights() {
  return (tree: Root) => applyTableRowHeights(tree);
}

function applyTableRowHeights(parent: Parents): void {
  const children: Nodes[] = parent.children;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const next = children[index + 1];
    if (node.type === "html" && next?.type === "table") {
      const annotation = TABLE_ROW_HEIGHTS_RE.exec(node.value);
      if (!annotation) continue;
      for (const [row, height] of tableRowHeights(annotation[1])) {
        const tableRow = next.children[row];
        if (tableRow) tableRow.data = { hProperties: { style: `height: ${height}px` } };
      }
      children.splice(index, 1);
    } else if ("children" in node) {
      applyTableRowHeights(node);
    }
  }
}

// GFM is what people actually write in a README: tables, strikethrough, bare
// URLs, task lists. Chunk boundaries sit at blank lines, and no GFM block
// carries one, so every chunk parses the same extensions the whole document
// would. Still no raw HTML — remark-gfm adds syntax, not an HTML escape, and
// remarkTableRowHeights takes only numbers from one kind of comment.
const REMARK_PLUGINS = [remarkGfm, remarkTableRowHeights];

// Links reach the document that mounted them through context, so a chunk's
// rendered elements hold nothing of the document and can be reused.
const OpenWorkspaceLink = createContext<
  RefObject<((target: WorkspaceLinkTarget) => void) | undefined>
>({ current: undefined });

function ReadOnlyLink({ children, href }: { children?: ReactNode; href?: string }) {
  const openWorkspaceLink = useContext(OpenWorkspaceLink);
  if (!href) {
    return <span className="text-accent underline">{children}</span>;
  }
  const activate = (
    event: React.MouseEvent<HTMLAnchorElement> | React.KeyboardEvent<HTMLAnchorElement>,
  ) =>
    activateReadOnlyLinkHref(href, event, (target) =>
      openWorkspaceLink.current?.(target),
    );
  return (
    <a
      href={href}
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
}

// Reopening a document mounts every chunk again. Keep the rendered elements
// of recent chunks so a reopen skips parsing the text it already parsed,
// oldest evicted first once their source passes `maxBytes`. Elements name
// their components, so a hit needs the same map.
export function createMarkdownChunkRenderer(maxBytes: number) {
  const cache = new Map<string, { components: Components; element: ReactElement }>();
  let cachedBytes = 0;
  return (source: string, components: Components): ReactElement => {
    const cached = cache.get(source);
    if (cached) {
      cache.delete(source);
      cachedBytes -= source.length;
    }
    const element =
      cached?.components === components
        ? cached.element
        : Markdown({
            children: source,
            components: { ...components, a: ReadOnlyLink },
            remarkPlugins: REMARK_PLUGINS,
          });
    if (source.length <= maxBytes) {
      cache.set(source, { components, element });
      cachedBytes += source.length;
      for (const oldest of cache.keys()) {
        if (cachedBytes <= maxBytes) break;
        cache.delete(oldest);
        cachedBytes -= oldest.length;
      }
    }
    return element;
  };
}

const renderChunk = createMarkdownChunkRenderer(CHUNK_CACHE_BYTES);

const MarkdownChunk = memo(function MarkdownChunk(props: {
  source: string;
  components: Components;
}) {
  return renderChunk(props.source, props.components);
});

export function IncrementalMarkdownDocument(props: {
  body: string;
  components: Components;
  onOpenWorkspaceLink?: (target: WorkspaceLinkTarget) => void;
}) {
  const onOpenWorkspaceLinkRef = useRef(props.onOpenWorkspaceLink);
  onOpenWorkspaceLinkRef.current = props.onOpenWorkspaceLink;
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
    <OpenWorkspaceLink.Provider value={onOpenWorkspaceLinkRef}>
      {chunks.slice(0, visibleCount).map((chunk, i) => (
        // Chunks are content-stable for a given body; index keys are correct
        // because a body change rebuilds the whole list.
        <MarkdownChunk key={i} source={chunk} components={props.components} />
      ))}
    </OpenWorkspaceLink.Provider>
  );
}

export type MarkdownReadViewProps = {
  body: string;
  onOpenWorkspaceLink?: (target: WorkspaceLinkTarget) => void;
  onRendered?: () => void;
};

export default function MarkdownReadView(props: MarkdownReadViewProps) {
  // This effect runs after the initial visible Markdown window has parsed and
  // committed. Idle backfill is deliberately outside the open-time measure.
  useEffect(() => {
    props.onRendered?.();
  }, [props.onRendered]);

  return (
    <IncrementalMarkdownDocument
      body={props.body}
      components={MARKDOWN_COMPONENTS}
      onOpenWorkspaceLink={props.onOpenWorkspaceLink}
    />
  );
}

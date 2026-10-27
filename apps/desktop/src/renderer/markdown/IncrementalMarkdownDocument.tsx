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
  TABLE_ROW_HEIGHTS_COMMENT,
  TABLE_ROW_HEIGHTS_RE,
  tableRowHeights,
} from "@dohc/ydoc-projection/table-row-heights";
import { assertSupportedListMarkdown } from "@dohc/ydoc-projection/list-markdown";
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
// and sets it on the row. Read that one comment where the editor reads it,
// with the projection's own rule, and set the same height, so a row does not
// grow when the editor replaces the read body. Any other comment stays text,
// as in the editor.
function remarkTableRowHeights() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    if (!source.includes(TABLE_ROW_HEIGHTS_COMMENT)) return;
    const lines = editorSource(source).split(/\r\n|\r|\n/u);
    applyTableRowHeights(tree, (line) => lines[line]);
  };
}

// In a list, the editor's import keeps the tabs in a line's text as text and
// hides them from marked, so a comment with a tab after it is text there.
// Its own list scan decides which tabs, so read the lines through it.
function editorSource(source: string): string {
  if (!source.includes("\t")) return source;
  try {
    return assertSupportedListMarkdown(source.replaceAll("\r\n", "\n"), (text) =>
      text.replaceAll("\t", "\u{FFFD}"),
    );
  } catch {
    // The editor can't open this list Markdown, so it has no height to match.
    return source;
  }
}

// The editor's parser, marked, reads a quote or a list item from its lines
// without its prefix: a quote's `>` and one space or tab after it, a list
// item's indent with each tab four spaces. `editorLine` gives a source line
// as the editor reads it inside `parent`.
const QUOTE_PREFIX_RE = /^ {0,3}>[ \t]?/u;

function applyTableRowHeights(parent: Parents, editorLine: (line: number) => string): void {
  const children: Nodes[] = parent.children;
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const next = children[index + 1];
    if (node.type === "html" && next?.type === "table" && node.position && next.position) {
      // The editor reads the comment only at the start of its line, and only
      // across blank lines that hold nothing, not even a space.
      const annotation = TABLE_ROW_HEIGHTS_RE.exec(editorLine(node.position.start.line - 1));
      const tableLine = next.position.start.line - 1;
      let line = node.position.end.line;
      while (line < tableLine && editorLine(line) === "") line += 1;
      if (!annotation || line < tableLine) continue;
      for (const [row, height] of tableRowHeights(annotation[1])) {
        const tableRow = next.children[row];
        if (tableRow) tableRow.data = { hProperties: { style: `height: ${height}px` } };
      }
      children.splice(index, 1);
    } else if (node.type === "blockquote") {
      applyTableRowHeights(node, (line) => editorLine(line).replace(QUOTE_PREFIX_RE, ""));
    } else if (node.type === "list") {
      applyTableRowHeights(node, editorLine);
    } else if (node.type === "listItem" && node.position) {
      // marked expands the tabs on an item's first line to the next tab stop.
      const first = node.position.start.line - 1;
      const indent = listItemIndent(expandTabs(editorLine(first)));
      applyTableRowHeights(node, (line) =>
        (line === first
          ? expandTabs(editorLine(line))
          : editorLine(line).replaceAll("\t", "    ")
        ).slice(indent),
      );
    }
  }
}

// marked's indent for a list item: its marker and the spaces after it, or the
// marker and one space when nothing follows it or more than four spaces do.
function listItemIndent(firstLine: string): number {
  const [, marker = "", spaces = "", text = ""] =
    /^( *(?:[*+-]|\d+[.)]))( *)(.*)$/u.exec(firstLine) ?? [];
  return marker.length + (text === "" || spaces.length > 4 ? 1 : spaces.length);
}

function expandTabs(line: string): string {
  let expanded = "";
  for (const char of line) {
    expanded += char === "\t" ? " ".repeat(4 - (expanded.length % 4)) : char;
  }
  return expanded;
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

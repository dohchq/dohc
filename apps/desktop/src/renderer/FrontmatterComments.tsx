import { frontmatterText, type FrontmatterLine } from "@dohc/ydoc-projection/frontmatter-comments";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type * as Y from "yjs";

// The frontmatter text a live document keeps as written, beside its values.
const FRONTMATTER_SOURCE_META_KEY = "dohcFrontmatterSource";

// Comments, anchors, aliases, and tags in the frontmatter show as no property
// value, yet an agent reading the file receives them. Show them, read-only,
// under the properties. A local document shows an unreadable block in its
// body; a live document keeps it beside the body, so it shows here whole.
export function FrontmatterComments(
  props: { markdown: string; ydoc?: never } | { ydoc: Y.Doc; markdown?: never },
) {
  const ydoc = props.ydoc ?? null;
  const [source, setSource] = useState<unknown>(() => ydoc?.getMap("meta").get(FRONTMATTER_SOURCE_META_KEY));

  useEffect(() => {
    if (!ydoc) return;
    const meta = ydoc.getMap("meta");
    const update = () => setSource(meta.get(FRONTMATTER_SOURCE_META_KEY));
    update();
    meta.observe(update);
    return () => meta.unobserve(update);
  }, [ydoc]);

  const markdown = ydoc ? (typeof source === "string" ? source : "") : (props.markdown ?? "");
  const block = useMemo(() => frontmatterText(markdown), [markdown]);
  if (!block || (!block.readable && !ydoc)) return null;
  const lines = block.readable ? block.lines.filter((line) => line.spans.length > 0) : block.lines;
  if (lines.length === 0) return null;
  const label = block.readable ? "Comments in this file's properties" : "Properties dohc can't read";

  return (
    <section data-testid="frontmatter-comments" className="dohc-page-properties" aria-label={label}>
      <div className="dohc-page-properties__inner">
        <details open className="group">
          <summary className="flex h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted transition-colors duration-75 hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight size={13} aria-hidden className="transition-transform duration-150 group-open:rotate-90" />
            {label}
          </summary>
          <div className="mb-1 whitespace-pre-wrap break-words rounded-md bg-panel-2 px-2.5 py-1.5 font-mono text-[12px] leading-5 text-muted">
            {lines.map((line, index) => (
              <div key={index} data-testid="frontmatter-comment-line" className="min-h-5">
                {block.readable ? <MarkedLine line={line} /> : <span className="text-ink">{line.text}</span>}
              </div>
            ))}
          </div>
        </details>
      </div>
    </section>
  );
}

// The line as written, with the text no value shows in ink.
function MarkedLine({ line }: { line: FrontmatterLine }) {
  const parts: ReactNode[] = [];
  let column = 0;
  for (const span of line.spans) {
    if (span.start > column) parts.push(line.text.slice(column, span.start));
    parts.push(
      <span key={span.start} className="text-ink">
        {line.text.slice(span.start, span.end)}
      </span>,
    );
    column = span.end;
  }
  if (column < line.text.length) parts.push(line.text.slice(column));
  return <>{parts}</>;
}

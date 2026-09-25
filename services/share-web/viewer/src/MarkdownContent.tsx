import { frontmatterText, type FrontmatterLine } from "@dohc/ydoc-projection/frontmatter-comments";
import { useMemo, type MouseEvent, type ReactNode } from "react";
import { useImageRetryHandlers } from "./imageRetry";
import { renderSafeMarkdown } from "./markdown";

export function MarkdownContent(props: {
  markdown: string;
  resolveImage?: (href: string) => string | null;
  resolveLink?: (href: string) => string | null;
  onNavigate?: (path: string) => void;
}) {
  const frontmatter = useMemo(() => frontmatterText(props.markdown), [props.markdown]);
  const body = frontmatter ? props.markdown.slice(frontmatter.block.length) : props.markdown;
  const html = useMemo(
    () => renderSafeMarkdown(body, props.resolveImage, props.resolveLink),
    [body, props.resolveImage, props.resolveLink],
  );
  const { retryImage, stopImageRetry } = useImageRetryHandlers(html);
  const navigate = (event: MouseEvent<HTMLElement>) => {
    if (!props.resolveLink || !props.onNavigate || !(event.target instanceof Element)) {
      return;
    }
    const anchor = event.target.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    const path = props.resolveLink(href);
    if (!path) return;
    event.preventDefault();
    props.onNavigate(path);
  };
  const article = (
    <article
      className="markdown"
      onClick={navigate}
      onErrorCapture={retryImage}
      onLoadCapture={stopImageRetry}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
  if (!frontmatter) return article;
  // The properties show as written, so a comment, anchor, alias, or tag an
  // agent reading the file receives is in view too.
  return (
    <>
      <section className="frontmatter" aria-label="Properties">
        <p className="section-label">Properties</p>
        <pre className="source-text">
          {frontmatter.lines.map((line, index) => (
            <span key={index}>
              <MarkedLine line={line} />
              {"\n"}
            </span>
          ))}
        </pre>
      </section>
      {article}
    </>
  );
}

// Text no property value shows is marked, so a comment reads as one.
function MarkedLine({ line }: { line: FrontmatterLine }) {
  const parts: ReactNode[] = [];
  let column = 0;
  for (const span of line.spans) {
    if (span.start > column) parts.push(line.text.slice(column, span.start));
    parts.push(
      <mark key={span.start} className="frontmatter-note">
        {line.text.slice(span.start, span.end)}
      </mark>,
    );
    column = span.end;
  }
  if (column < line.text.length) parts.push(line.text.slice(column));
  return <>{parts}</>;
}

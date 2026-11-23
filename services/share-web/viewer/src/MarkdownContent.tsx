import { useMemo, type MouseEvent } from "react";
import { useImageRetryHandlers } from "./imageRetry";
import { headingSlug, renderSafeMarkdown } from "./markdown";
import { PropertiesAsWritten, splitFrontmatter } from "./PropertiesAsWritten";

function findHeadingTarget(article: Element, hash: string): Element | null {
  const fragment = hash.slice(1);
  if (!fragment) return null;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    decoded = fragment;
  }
  const normalized = decoded.startsWith("h-") ? decoded : `h-${headingSlug(decoded)}`;
  for (const heading of article.querySelectorAll(
    "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]",
  )) {
    const id = heading.getAttribute("id");
    if (id === decoded || id === normalized) return heading;
  }
  return null;
}

export function MarkdownContent(props: {
  markdown: string;
  resolveImage?: (href: string) => string | null;
  resolveLink?: (href: string) => string | null;
  onNavigate?: (path: string) => void;
  collapseProperties?: boolean;
}) {
  const { block, body } = useMemo(() => splitFrontmatter(props.markdown), [props.markdown]);
  const html = useMemo(
    () => renderSafeMarkdown(body, props.resolveImage, props.resolveLink),
    [body, props.resolveImage, props.resolveLink],
  );
  const { retryImage, stopImageRetry } = useImageRetryHandlers(html);
  const navigate = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      const target = findHeadingTarget(event.currentTarget, href);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView?.({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      return;
    }
    if (!props.resolveLink || !props.onNavigate) return;
    const path = props.resolveLink(href);
    if (!path) return;
    event.preventDefault();
    props.onNavigate(path);
  };
  return (
    <>
      <PropertiesAsWritten block={block} collapsed={props.collapseProperties} />
      <article
        className="markdown"
        onClick={navigate}
        onErrorCapture={retryImage}
        onLoadCapture={stopImageRetry}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}

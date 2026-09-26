import { useMemo, type MouseEvent } from "react";
import { useImageRetryHandlers } from "./imageRetry";
import { renderSafeMarkdown } from "./markdown";
import { PropertiesAsWritten, splitFrontmatter } from "./PropertiesAsWritten";

export function MarkdownContent(props: {
  markdown: string;
  resolveImage?: (href: string) => string | null;
  resolveLink?: (href: string) => string | null;
  onNavigate?: (path: string) => void;
}) {
  const { block, body } = useMemo(() => splitFrontmatter(props.markdown), [props.markdown]);
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
  return (
    <>
      <PropertiesAsWritten block={block} />
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

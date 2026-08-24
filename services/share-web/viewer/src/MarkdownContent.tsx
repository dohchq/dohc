import { useMemo } from "react";
import { renderSafeMarkdown } from "./markdown";

export function MarkdownContent(props: {
  markdown: string;
  resolveImage?: (href: string) => string | null;
}) {
  const html = useMemo(
    () => renderSafeMarkdown(props.markdown, props.resolveImage),
    [props.markdown, props.resolveImage],
  );
  return <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

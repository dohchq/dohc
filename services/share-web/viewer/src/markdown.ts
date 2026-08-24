import DOMPurify, { type Config } from "dompurify";
import { Marked } from "marked";

const BLOB_IMAGE =
  /^\/api\/view\/blob\/[a-f0-9]{64}(?:\?session=[A-Za-z0-9_-]{12})?$/u;
const SAFE_LINK = /^(?:https?:\/\/|mailto:|\/[^/]|#|\.\.?\/)/iu;

export const MARKDOWN_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  ALLOWED_ATTR: ["alt", "href", "src", "title"],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_TAGS: [
    "base",
    "button",
    "embed",
    "form",
    "iframe",
    "input",
    "link",
    "math",
    "meta",
    "object",
    "script",
    "select",
    "style",
    "svg",
    "template",
    "textarea",
  ],
  FORBID_ATTR: ["style"],
  KEEP_CONTENT: false,
};

export const RAW_HTML_STRIP_CONFIG: Config = {
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  KEEP_CONTENT: true,
};

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node instanceof HTMLAnchorElement && data.attrName === "href") {
    data.keepAttr = SAFE_LINK.test(data.attrValue) && !/^\s*(?:data|javascript):/iu.test(data.attrValue);
  }
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSafeMarkdown(
  markdown: string,
  resolveImage: (href: string) => string | null = (href) =>
    BLOB_IMAGE.test(href) ? href : null,
): string {
  const parser = new Marked({
    async: false,
    gfm: true,
    renderer: {
      image({ href, text, title }) {
        const safeHref = resolveImage(href);
        if (!safeHref || !BLOB_IMAGE.test(safeHref)) return escapeHtml(text);
        return (
          `<img src="${safeHref}" alt="${escapeHtml(text)}"` +
          (title ? ` title="${escapeHtml(title)}"` : "") +
          ">"
        );
      },
    },
  });
  const markdownWithoutRawHtml = String(
    DOMPurify.sanitize(markdown, RAW_HTML_STRIP_CONFIG),
  );
  const rendered = parser.parse(markdownWithoutRawHtml);
  if (typeof rendered !== "string") throw new Error("Markdown rendering must be synchronous.");
  const sanitized = String(DOMPurify.sanitize(rendered, MARKDOWN_SANITIZE_CONFIG));
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  for (const image of template.content.querySelectorAll("img")) {
    if (!BLOB_IMAGE.test(image.getAttribute("src") ?? "")) image.remove();
  }
  return template.innerHTML;
}

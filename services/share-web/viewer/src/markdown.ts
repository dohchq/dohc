import { escapeHtml } from "@dohc/workspace-core/html";
import DOMPurify, { type Config } from "dompurify";
import { Marked } from "marked";

const BLOB_IMAGE =
  /^\/api\/view\/blob\/[a-f0-9]{64}(?:\?session=[A-Za-z0-9_-]{12})?$/u;
const SAFE_LINK = /^(?:https?:\/\/|mailto:|\/[^/]|#|\.\.?\/)/iu;
const EXTERNAL_LINK = /^(?:https?:\/\/|mailto:)/iu;
const NON_FILE_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu;

export const MARKDOWN_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    "#text",
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

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node instanceof HTMLAnchorElement && data.attrName === "href") {
    data.keepAttr = SAFE_LINK.test(data.attrValue) && !/^\s*(?:data|javascript):/iu.test(data.attrValue);
  }
});

export function renderSafeMarkdown(
  markdown: string,
  resolveImage: (href: string) => string | null = (href) =>
    BLOB_IMAGE.test(href) ? href : null,
  resolveLink: (href: string) => string | null = () => null,
): string {
  const parser = new Marked({
    async: false,
    gfm: true,
    tokenizer: {
      html(source) {
        // Block HTML can absorb later nonblank Markdown.
        // Escape one line so the rest still tokenizes.
        const match = this.rules.block.html.exec(source);
        if (!match) return false;
        const newlineIndex = source.indexOf("\n");
        const raw =
          newlineIndex < 0 ? source : source.slice(0, newlineIndex + 1);
        const pre = match[1] === "pre" || match[1] === "script" || match[1] === "style";
        return { type: "html", raw, text: raw, block: true, pre };
      },
    },
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      image({ href, text, title }) {
        const safeHref = resolveImage(href);
        if (!safeHref || !BLOB_IMAGE.test(safeHref)) return escapeHtml(text);
        return (
          `<img src="${safeHref}" alt="${escapeHtml(text)}"` +
          (title ? ` title="${escapeHtml(title)}"` : "") +
          ">"
        );
      },
      link({ href, title, tokens }) {
        if (EXTERNAL_LINK.test(href) || href.startsWith("#")) return false;
        const text = this.parser.parseInline(tokens);
        if (NON_FILE_LINK.test(href)) return text;
        const sharedPath = resolveLink(href);
        if (!sharedPath) return text;
        const safeHref = `/${sharedPath.split("/").map(encodeURIComponent).join("/")}`;
        return (
          `<a href="${escapeHtml(safeHref)}"` +
          (title ? ` title="${escapeHtml(title)}"` : "") +
          `>${text}</a>`
        );
      },
    },
  });
  const rendered = parser.parse(markdown);
  if (typeof rendered !== "string") throw new Error("Markdown rendering must be synchronous.");
  const sanitized = String(DOMPurify.sanitize(rendered, MARKDOWN_SANITIZE_CONFIG));
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  for (const image of template.content.querySelectorAll("img")) {
    if (!BLOB_IMAGE.test(image.getAttribute("src") ?? "")) image.remove();
  }
  return template.innerHTML;
}

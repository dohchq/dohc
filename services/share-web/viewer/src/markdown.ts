import { escapeHtml } from "@dohc/workspace-core/html";
import DOMPurify, { type Config } from "dompurify";
import { Marked, type Tokens } from "marked";

const BLOB_IMAGE = /^\/api\/view\/blob\/[a-f0-9]{64}(?:\?session=[A-Za-z0-9_-]{12})?$/u;
const SAFE_LINK = /^(?:https?:\/\/|mailto:|\/[^/]|#|\.\.?\/)/iu;
const HTTP_LINK = /^https?:\/\//iu;
const MAILTO_LINK = /^mailto:/iu;
const NON_FILE_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu;
const HEADING_ID = /^h-[\p{L}\p{M}\p{N}-]+$/u;

const ALLOWED_CLASS_TOKENS = new Set([
  "sr-only",
  "task-list",
  "task-item",
  "task-item-checked",
  "task-check",
  "task-check-checked",
  "task-body",
  "dohc-callout",
  "callout-note",
  "callout-tip",
  "callout-info",
  "callout-warning",
  "callout-danger",
  "callout-quote",
  "callout-title",
  "callout-body",
  "dohc-wikilink-pill",
  "table-wrap",
]);

const CALLOUT_KIND_MAP: Record<string, string> = {
  note: "note",
  tip: "tip",
  hint: "tip",
  important: "tip",
  info: "info",
  abstract: "info",
  summary: "info",
  todo: "info",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  danger: "danger",
  error: "danger",
  bug: "danger",
  fail: "danger",
  failure: "danger",
  quote: "quote",
  cite: "quote",
};

export const MARKDOWN_SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    "#text",
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
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
    "mark",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  ALLOWED_ATTR: ["alt", "class", "href", "id", "rel", "src", "target", "title"],
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
    data.keepAttr =
      SAFE_LINK.test(data.attrValue) && !/^\s*(?:data|javascript):/iu.test(data.attrValue);
    return;
  }
  if (data.attrName === "target") {
    data.keepAttr =
      node instanceof HTMLAnchorElement &&
      data.attrValue === "_blank" &&
      HTTP_LINK.test(node.getAttribute("href") ?? "");
    return;
  }
  if (data.attrName === "rel") {
    data.keepAttr = node instanceof HTMLAnchorElement && data.attrValue === "noopener noreferrer";
    return;
  }
  if (data.attrName === "id") {
    data.keepAttr = /^H[1-6]$/u.test(node.tagName) && HEADING_ID.test(data.attrValue);
    return;
  }
  if (data.attrName === "class") {
    const allowed = data.attrValue.split(/\s+/u).filter((token) => ALLOWED_CLASS_TOKENS.has(token));
    if (allowed.length === 0) {
      data.keepAttr = false;
    } else {
      data.attrValue = allowed.join(" ");
      data.keepAttr = true;
    }
  }
});

export function headingSlug(text: string): string {
  const cleaned = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned || "section";
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/gu, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'");
}

function splitWikilink(inner: string): [string, string | null] {
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === "\\") {
      index += 1;
      continue;
    }
    if (inner[index] === "|") {
      return [
        inner.slice(0, index).replace(/\\([\\\]|])/gu, "$1"),
        inner.slice(index + 1).replace(/\\([\\\]|])/gu, "$1"),
      ];
    }
  }
  return [inner.replace(/\\([\\\]|])/gu, "$1"), null];
}

function findClosingHighlight(src: string): number {
  for (let index = 2; index < src.length - 1; index += 1) {
    if (src[index] === "\\") {
      index += 1;
      continue;
    }
    if (src[index] === "=" && src[index + 1] === "=") return index;
  }
  return -1;
}

const CALLOUT_HEADER_RE = /^ {0,3}> ?\[!([a-z0-9_-]+)\]([+-]?)[ \t]*([^\n]*)/iu;
const CALLOUT_LINE_RE = /^ {0,3}>/;

function stripQuotePrefix(line: string): string {
  return line.replace(/^ {0,3}> ?/u, "");
}

function encodeSharedPath(sharedPath: string): string {
  return `/${sharedPath.split("/").map(encodeURIComponent).join("/")}`;
}

export function renderSafeMarkdown(
  markdown: string,
  resolveImage: (href: string) => string | null = (href) => (BLOB_IMAGE.test(href) ? href : null),
  resolveLink: (href: string) => string | null = () => null,
): string {
  const usedIds = new Set<string>();

  const parser = new Marked({
    async: false,
    gfm: true,
    extensions: [
      {
        name: "dohcCallout",
        level: "block",
        start(src) {
          const match = /(?:^|\n) {0,3}> ?\[!/u.exec(src);
          return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
        },
        tokenizer(src) {
          const newline = src.indexOf("\n");
          const first = newline < 0 ? src : src.slice(0, newline);
          const header = CALLOUT_HEADER_RE.exec(first);
          if (!header) return undefined;
          const lines = src.split("\n");
          let count = 1;
          while (count < lines.length && CALLOUT_LINE_RE.test(lines[count] ?? "")) {
            count += 1;
          }
          const consumed = lines.slice(0, count);
          const rawKind = (header[1] ?? "note").toLowerCase();
          const kind = CALLOUT_KIND_MAP[rawKind] ?? "note";
          const customTitle = (header[3] ?? "").trim();
          const title = customTitle || rawKind.charAt(0).toUpperCase() + rawKind.slice(1);
          const body = consumed.slice(1).map(stripQuotePrefix).join("\n");
          return {
            type: "dohcCallout",
            raw: consumed.join("\n") + (count < lines.length ? "\n" : ""),
            kind,
            title,
            tokens: body.trim() ? this.lexer.blockTokens(body) : [],
          };
        },
        renderer(token) {
          const kind = typeof token.kind === "string" ? token.kind : "note";
          const title = typeof token.title === "string" ? token.title : "Note";
          const bodyHtml = token.tokens?.length ? this.parser.parse(token.tokens) : "";
          return (
            `<div class="dohc-callout callout-${escapeHtml(kind)}">` +
            `<div class="callout-title">${escapeHtml(title)}</div>` +
            (bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : "") +
            `</div>\n`
          );
        },
      },
      {
        name: "dohcHighlight",
        level: "inline",
        start(src) {
          for (let at = src.indexOf("=="); at >= 0; at = src.indexOf("==", at + 1)) {
            const before = src[at - 1];
            const after = src[at + 2];
            if (before !== "\\" && before !== "=" && after !== undefined && /[^\s=]/u.test(after)) {
              return at;
            }
          }
          return undefined;
        },
        tokenizer(src) {
          if (!src.startsWith("==") || src.length < 5) return undefined;
          if (/[\s=]/u.test(src[2] ?? "")) return undefined;
          const closing = findClosingHighlight(src);
          if (closing < 3) return undefined;
          if (/[\s=]/u.test(src[closing - 1] ?? "")) return undefined;
          const raw = src.slice(0, closing + 2);
          const inner = raw.slice(2, -2).replace(/\\=/gu, "=");
          if (!inner) return undefined;
          return {
            type: "dohcHighlight",
            raw,
            tokens: this.lexer.inlineTokens(inner),
          };
        },
        renderer(token) {
          return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
        },
      },
      {
        name: "dohcWikilink",
        level: "inline",
        start(src) {
          const at = src.indexOf("[[");
          return at >= 0 ? at : undefined;
        },
        tokenizer(src) {
          if (!src.startsWith("[[")) return undefined;
          let closing = -1;
          for (let index = 2; index < src.length - 1; index += 1) {
            if (src[index] === "\n") return undefined;
            if (src[index] === "\\") {
              index += 1;
              continue;
            }
            if (src[index] === "]" && src[index + 1] === "]") {
              closing = index;
              break;
            }
          }
          if (closing < 3) return undefined;
          const raw = src.slice(0, closing + 2);
          const [rawTarget, rawLabel] = splitWikilink(raw.slice(2, -2));
          const target = rawTarget.trim();
          if (!target) return undefined;
          const label = rawLabel?.trim() || null;
          return { type: "dohcWikilink", raw, target, label };
        },
        renderer(token) {
          const target = typeof token.target === "string" ? token.target : "";
          const label = typeof token.label === "string" ? token.label : null;
          const display = label || target;
          const sharedPath =
            resolveLink(target) ??
            (!/\.[a-z0-9]+$/iu.test(target) ? resolveLink(`${target}.md`) : null);
          if (sharedPath) {
            return `<a href="${escapeHtml(encodeSharedPath(sharedPath))}">${escapeHtml(display)}</a>`;
          }
          return `<span class="dohc-wikilink-pill">${escapeHtml(display)}</span>`;
        },
      },
    ],
    tokenizer: {
      html(source) {
        // Block HTML can absorb later nonblank Markdown.
        // Escape one line so the rest still tokenizes.
        const match = this.rules.block.html.exec(source);
        if (!match) return false;
        const newlineIndex = source.indexOf("\n");
        const raw = newlineIndex < 0 ? source : source.slice(0, newlineIndex + 1);
        const pre = match[1] === "pre" || match[1] === "script" || match[1] === "style";
        return { type: "html", raw, text: raw, block: true, pre };
      },
    },
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      heading({ tokens, depth }) {
        const inlineHtml = this.parser.parseInline(tokens);
        const base = headingSlug(stripTags(inlineHtml));
        let suffix = 1;
        let id = `h-${base}`;
        while (usedIds.has(id)) {
          suffix += 1;
          id = `h-${base}-${suffix}`;
        }
        usedIds.add(id);
        return `<h${depth} id="${id}">${inlineHtml}</h${depth}>\n`;
      },
      checkbox() {
        return "";
      },
      list(token: Tokens.List) {
        if (!token.ordered && token.items.some((item) => item.task)) {
          let body = "";
          for (const item of token.items) body += this.listitem(item);
          return `<ul class="task-list">\n${body}</ul>\n`;
        }
        return false;
      },
      listitem(item: Tokens.ListItem) {
        if (!item.task) return false;
        const innerTokens = item.tokens.filter((child) => child.type !== "checkbox");
        const body = this.parser.parse(innerTokens);
        const itemClass = item.checked ? "task-item task-item-checked" : "task-item";
        const checkClass = item.checked ? "task-check task-check-checked" : "task-check";
        const statusLabel = item.checked ? "Completed task: " : "Incomplete task: ";
        return `<li class="${itemClass}"><span class="${checkClass}"></span><span class="sr-only">${statusLabel}</span><div class="task-body">${body}</div></li>\n`;
      },
      table(token: Tokens.Table) {
        const headCells = token.header
          .map((cell) => `<th>${this.parser.parseInline(cell.tokens)}</th>`)
          .join("");
        const bodyRows = token.rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`,
          )
          .join("");
        return `<div class="table-wrap"><table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>\n`;
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
        if (HTTP_LINK.test(href)) {
          const text = this.parser.parseInline(tokens);
          return (
            `<a href="${escapeHtml(href)}"` +
            (title ? ` title="${escapeHtml(title)}"` : "") +
            ` target="_blank" rel="noopener noreferrer">${text}</a>`
          );
        }
        if (MAILTO_LINK.test(href) || href.startsWith("#")) return false;
        const text = this.parser.parseInline(tokens);
        if (NON_FILE_LINK.test(href)) return text;
        const sharedPath = resolveLink(href);
        if (!sharedPath) return text;
        return (
          `<a href="${escapeHtml(encodeSharedPath(sharedPath))}"` +
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

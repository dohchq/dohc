import { buildWorkLinkHandoffUrl } from "@dohc/workspace-contracts/deep-links";
import { workLinkPathReference, workLinkServerOrigin } from "@dohc/workspace-contracts/work-links";
import { opaqueLinkRefusal } from "./linkRefusal";
import { SHARE_WEB_SECURITY_HEADERS } from "./securityHeaders";

/** The launch page's paper and ink in both themes, with nothing fetched. */
const PAGE_STYLE = ":root{color-scheme:light dark;--bg:#faf9f5;--ink:#1c1b18;--mark:#2d342e;--line:#d8d4c8}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#131211;--ink:#f6f4ee;--mark:#e4e1d8;--line:#3a3833}}" +
  "body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,\"Segoe UI\",sans-serif}" +
  "main{box-sizing:border-box;display:flex;min-height:100vh;min-height:100dvh;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:24px 16px}" +
  "svg{color:var(--mark)}a{padding:8px 16px;border:1px solid var(--line);border-radius:8px;color:var(--ink);font-weight:500;text-decoration:none}" +
  "a:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}";
/** DohcMark from packages/brand/src/DohcLogo.tsx at 48px, inlined as apps/site's pages inline it. The sign-in pages size it with CSS. */
export const DOHC_MARK = `<svg width="48" height="52" viewBox="0 0 96 104" role="img" aria-label="dohc"><path d="M48 10c14 0 25 9 25 23 0 5-2 9-4 13 10 5 17 15 17 27 0 16-12 27-29 27-12 0-22-5-31-12L12 78C8 68 7 56 10 44 15 23 29 10 48 10Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="8"/><circle cx="38" cy="58" r="9" fill="currentColor"/></svg>`;
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * What `<origin>/l/<reference>` shows in a browser: the dohc mark and Open in dohc.
 * Every well-formed reference gets the same page, so it says nothing about what the link names
 * or whether it exists. Any other path under /l/ is not found.
 */
export function serveWorkLinkPage(request: Request, pathname: string, origin: string): Response {
  const reference = request.method === "GET" ? workLinkPathReference(pathname) : null;
  const server = workLinkServerOrigin(origin);
  if (reference === null || server === null) return opaqueLinkRefusal();
  const open = escapeAttribute(buildWorkLinkHandoffUrl({ server, reference }));
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>dohc</title><style>${PAGE_STYLE}</style></head>` +
      `<body><main>${DOHC_MARK}<a href="${open}">Open in dohc</a></main></body></html>`,
    { headers: { ...SHARE_WEB_SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP } },
  );
}

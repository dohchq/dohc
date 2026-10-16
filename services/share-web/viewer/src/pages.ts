// Each viewer route is its own HTML page, so a browser loads only that route's code.
const ROUTES = ["edit", "chat", "apps"] as const;

export const VIEWER_PAGES = ["index.html", ...ROUTES.map(route => `${route}.html`)];

/** The page that serves a viewer path. The share link viewer serves every path no other route claims. */
export function viewerPage(pathname: string): string {
  const route = ROUTES.find(route => pathname.startsWith(`/s/${route}/`));
  return route ? `${route}.html` : "index.html";
}

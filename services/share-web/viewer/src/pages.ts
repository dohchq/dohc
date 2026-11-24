// Each viewer route is its own HTML page, so a browser loads only that route's code.
const ROUTES = ["edit", "chat", "apps", "workspace"] as const;

export const VIEWER_PAGES = ["index.html", ...ROUTES.map((route) => `${route}.html`), "join.html"];

/** The invite link's page. Its token follows `#`, so the server never sees it. */
export const JOIN_PATH = "/join";

/** The signed-in account's workspaces, each linking to its workspace page. */
export const WORKSPACES_PATH = "/workspaces";

/** The page that serves a viewer path. The share link viewer serves every path no other route claims. */
export function viewerPage(pathname: string): string {
  if (pathname === JOIN_PATH) return "join.html";
  if (pathname === WORKSPACES_PATH) return "workspace.html";
  const route = ROUTES.find((route) => pathname.startsWith(`/s/${route}/`));
  return route ? `${route}.html` : "index.html";
}

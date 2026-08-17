import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { hasReservedSegment } from "../ui/sites.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Read-only, and refuse a final-component symlink where the platform can say
// so. O_NOFOLLOW is POSIX-only; on win32 it is undefined, and `?? 0` keeps
// that explicit rather than silently yielding 0.
const READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** How often a waiting page asks whether the site is ready, in seconds. */
const STATUS_REFRESH_SECONDS = 2;

/** How many log lines a waiting page shows. */
const STATUS_LOG_LINES = 200;

interface ServedDirectory {
  root: string;
  entry: string;
}

interface ServedStatus {
  heading: string;
  detail: string;
  log: readonly string[];
  failed: boolean;
}

/**
 * One site's server.
 *
 * It answers on one origin for as long as the preview tab is open, and what it
 * answers with changes: a page reporting what dohc is waiting for, then the
 * site itself. Holding one origin across both is what lets a build take longer
 * than dohc's limit on starting a web app — the tab is already open and
 * watching by the time the build finishes.
 */
export interface SiteServer {
  /** The origin this preview is served on, with a trailing slash. */
  url: string;
  /** Reports what the preview is waiting for, until a directory is served. */
  setStatus(status: { heading: string; detail: string; log?: readonly string[] }): void;
  /** Reports that the preview will not arrive. */
  setFailed(status: { heading: string; detail: string; log?: readonly string[] }): void;
  /**
   * Serves a directory from now on. Throws, and keeps serving what it served
   * before, if the directory is not one this workspace may publish.
   */
  serveDirectory(input: { rootPath: string; entry: string }): Promise<void>;
  stop(): Promise<void>;
}

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rest = relative(parent, child);
  return rest.length > 0 && !isAbsolute(rest) && !rest.startsWith("..") && !rest.startsWith(sep);
}

function mimeType(pathname: string): string {
  return MIME_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusPage(status: ServedStatus): string {
  const log = status.log.slice(-STATUS_LOG_LINES).map(escapeHtml).join("\n");
  // A failed preview stops asking. One that is still working reloads, and
  // lands on the site itself as soon as the server has one to serve.
  const refresh = status.failed
    ? ""
    : `<meta http-equiv="refresh" content="${STATUS_REFRESH_SECONDS}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${refresh}
<title>${escapeHtml(status.heading)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px; font: 13px/1.6 ui-sans-serif, system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 20px; opacity: 0.7; }
  pre { margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap;
        font: 12px/1.5 ui-monospace, monospace; opacity: 0.85;
        border: 1px solid rgb(128 128 128 / 0.3); border-radius: 6px; }
</style>
</head>
<body>
<h1>${escapeHtml(status.heading)}</h1>
<p>${escapeHtml(status.detail)}</p>
${log ? `<pre>${log}</pre>` : ""}
</body>
</html>
`;
}

/**
 * Starts a server for one site preview.
 *
 * The site's own code runs in the page this serves, so containment here is
 * what keeps that page from reading the rest of the workspace: every response
 * resolves inside the served directory, reserved directories are refused, and
 * the file that is checked is the file that is read.
 *
 * dohc locks the guest showing this server to its exact origin and denies it
 * navigation, popups, and downloads. That containment is dohc's, and it does
 * not depend on this file being right.
 */
export async function startSiteServer(input: {
  /** The workspace root. Every directory served must resolve inside it. */
  workspaceRoot: string;
  /** What the preview reports before it has anything to serve. */
  status: { heading: string; detail: string };
}): Promise<SiteServer> {
  const workspaceRoot = await realpath(input.workspaceRoot);
  let served: ServedDirectory | null = null;
  let status: ServedStatus = { ...input.status, log: [], failed: false };

  const server = createServer(async (request, response) => {
    const directory = served;
    if (!directory) {
      const body = statusPage(status);
      response.writeHead(status.failed ? 503 : 200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      const requested = decoded === "/" ? directory.entry : decoded.replace(/^\/+/, "");
      if (
        requested.includes("\0") ||
        requested.split("/").some((segment) => segment === ".." || segment === ".")
      ) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid path");
        return;
      }
      if (hasReservedSegment(requested)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      // The check above read the request path as spelled. Resolving it decides
      // where an alias inside the served directory really points, and the read
      // below uses that same resolution — resolving twice would let an alias
      // swapped in between serve bytes no rule was applied to.
      const target = await realpath(join(directory.root, requested));
      if (!isInside(directory.root, target)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      // One open, and everything after it comes from that handle, so the file
      // that is checked is the file that is read.
      //
      // RESIDUAL: this narrows the window, it does not close it. win32 has no
      // O_NOFOLLOW, so a leaf swapped for a link after the check is still
      // followed, and a directory component swapped mid-traversal is followed
      // everywhere, because Node offers no openat.
      const handle = await open(target, READ_NO_FOLLOW);
      try {
        if (!(await handle.stat()).isFile()) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        const body = await handle.readFile();
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": mimeType(target),
          "x-content-type-options": "nosniff",
        });
        response.end(body);
      } finally {
        await handle.close();
      }
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  server.unref();
  const origin = await listen(server);

  return {
    url: `${origin}/`,
    setStatus: (next) => {
      status = { ...next, log: next.log ?? [], failed: false };
    },
    setFailed: (next) => {
      status = { ...next, log: next.log ?? [], failed: true };
      served = null;
    },
    async serveDirectory(directory) {
      const root = await realpath(directory.rootPath);
      if (!isInside(workspaceRoot, root)) {
        throw new Error(`This site resolves outside the workspace: ${directory.rootPath}`);
      }
      const rootRelative = relative(workspaceRoot, root).replaceAll("\\", "/");
      if (rootRelative && hasReservedSegment(rootRelative)) {
        throw new Error(`This site resolves onto a reserved workspace path: ${rootRelative}`);
      }
      assertContainedFilePath(directory.entry, "site entry");
      await access(join(root, directory.entry), constants.R_OK);
      served = { root, entry: directory.entry };
    },
    stop: () => stopServer(server),
  };
}

export function assertContainedFilePath(path: string, label: string): void {
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid ${label}: ${path}`);
  }
  if (hasReservedSegment(path)) {
    throw new Error(`Invalid ${label}: reserved workspace path ${path}`);
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The site server did not start.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  });
}

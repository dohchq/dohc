import { hasIgnoredSegment, isSharedWithMePath } from "@dohc/workspace-core";
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { assertResolvedWorkspacePath } from "../workspaces/workspaceRealPath";

/**
 * Serves one directory on loopback for a sandboxed frame to load, and refuses
 * every path that would leave it. Neutral on purpose: dohc's plugin panels are
 * served by this, and nothing here knows what a panel is.
 */

export interface StaticDirectoryPreview {
  url: string;
  root: string;
  stop(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
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

// Read-only, and do not follow a final-component symlink where the platform
// can say so. O_NOFOLLOW is POSIX-only: on win32 `fs.constants.O_NOFOLLOW` is
// undefined, and `O_RDONLY | undefined` silently yields 0 rather than failing
// loudly, so `?? 0` keeps the intent explicit. Windows therefore keeps the
// residual named at the read site.
const READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !isAbsolute(rel) && !rel.startsWith("..") && !rel.startsWith(sep);
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
  if (hasIgnoredSegment(path)) {
    throw new Error(`Invalid ${label}: reserved metadata path ${path}`);
  }
}

function mimeType(pathname: string): string {
  return MIME_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Static server did not start.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  });
}

export async function startStaticDirectoryPreview(
  rootPath: string,
  options: {
    containmentRoot: string;
    entry: string;
    entryLabel: string;
    forbidSharedWithMePaths?: boolean;
  },
): Promise<StaticDirectoryPreview> {
  const root = await realpath(rootPath);
  const containmentRoot = await realpath(options.containmentRoot);
  if (!isInside(containmentRoot, root)) {
    throw new Error(`Static root escapes its containment root: ${rootPath}`);
  }
  const rootRelative = relative(containmentRoot, root).replaceAll("\\", "/");
  if (rootRelative && hasIgnoredSegment(rootRelative)) {
    throw new Error(`Static root uses a reserved metadata path: ${rootRelative}`);
  }
  const entry = options.entry;
  assertContainedFilePath(entry, options.entryLabel);
  await access(join(root, entry), constants.R_OK);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      const relativePath = decoded === "/" ? entry : decoded.replace(/^\/+/, "");
      const containmentSpelledPath = rootRelative
        ? `${rootRelative}/${relativePath}`
        : relativePath;
      if (
        relativePath.includes("\0") ||
        relativePath.split("/").some((segment) => segment === ".." || segment === ".")
      ) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid path");
        return;
      }
      if (
        hasIgnoredSegment(relativePath) ||
        (options.forbidSharedWithMePaths &&
          isSharedWithMePath(containmentSpelledPath))
      ) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      const target = join(root, relativePath);
      // The check above read the request path as SPELLED. A directory alias
      // inside the served root (`assets -> ../.dohc`) still spells an ordinary
      // folder. The reservation is decided against the caller's containment
      // root, while the final check below keeps every response inside `root`.
      //
      // The stat and the read below use the resolution this JUDGED. Resolving
      // the request's spelling a second time would let an alias swapped
      // between the two serve bytes no rule was applied to.
      let realTarget: string;
      try {
        realTarget = (
          await assertResolvedWorkspacePath({
            rootPath: containmentRoot,
            absolutePath: target,
            spelled: relativePath,
            label: "Static request path",
            access: "read",
          })
        ).resolvedAbsolute;
      } catch {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      const containmentRelative = relative(containmentRoot, realTarget).replaceAll(
        "\\",
        "/",
      );
      if (
        options.forbidSharedWithMePaths &&
        isSharedWithMePath(containmentRelative)
      ) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      if (!isInside(root, realTarget)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      // ONE open, and everything after it comes from that handle. The fd is
      // bound to the object open() found, so the file that is checked is the
      // file that is read — a stat followed by a separate read let the name be
      // swapped in between and served bytes nothing had checked.
      //
      // RESIDUAL, stated rather than papered over: this narrows the window to
      // the single open() call, it does not close it.
      //
      // The LEAF: on POSIX O_NOFOLLOW makes the open refuse a leaf swapped for
      // a symlink. On win32 Node exposes no O_NOFOLLOW and no fd->path
      // affordance, so a leaf swapped between the guard and this open is still
      // followed.
      //
      // The ANCESTORS: O_NOFOLLOW never covered those on any platform. Binding
      // each traversed component needs openat-style dirfd traversal, and Node's
      // fs does not expose it -- no openat, no relative open on FileHandle, Dir
      // hands out no fd, and O_DIRECTORY/O_PATH are undefined here. So a
      // directory component swapped mid-traversal is followed everywhere.
      //
      // Both are left as residuals on purpose. Closing them needs an API Node
      // does not offer; an identity compare here would only be another
      // checkable proxy with its own window.
      const handle = await open(realTarget, READ_NO_FOLLOW);
      try {
        const entryInfo = await handle.stat();
        if (!entryInfo.isFile()) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        const body = await handle.readFile();
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": mimeType(realTarget),
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
    root,
    url: `${origin}/`,
    stop: () => stopServer(server),
  };
}

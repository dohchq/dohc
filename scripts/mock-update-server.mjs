#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const CONTENT_TYPES = new Map([
  [".yml", "text/yaml; charset=utf-8"],
  [".yaml", "text/yaml; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".zip", "application/zip"],
  [".dmg", "application/octet-stream"],
  [".exe", "application/vnd.microsoft.portable-executable"],
  [".AppImage", "application/octet-stream"],
]);

function isOutsideRoot(rootRealPath, targetRealPath) {
  const rel = relative(rootRealPath, targetRealPath);
  return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
}

export async function resolveServablePath(root, requestUrl = "/") {
  const rootRealPath = await realpath(root);
  let pathname;
  try {
    pathname = new URL(requestUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const lexicalTarget = resolve(
    rootRealPath,
    `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`,
  );
  if (isOutsideRoot(rootRealPath, lexicalTarget)) return null;

  let targetRealPath;
  try {
    targetRealPath = await realpath(lexicalTarget);
  } catch {
    return null;
  }
  if (isOutsideRoot(rootRealPath, targetRealPath)) return null;

  const info = await stat(targetRealPath).catch(() => null);
  return info?.isFile() ? targetRealPath : null;
}

export function contentTypeFor(pathname) {
  return CONTENT_TYPES.get(extname(pathname)) ?? "application/octet-stream";
}

export async function createMockUpdateServer(options = {}) {
  const root = resolve(options.root ?? process.env.DOHC_DESKTOP_MOCK_UPDATE_SERVER_ROOT ?? "release");
  const host = options.host ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.DOHC_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 0);

  const server = createServer(async (request, response) => {
    try {
      const filePath = await resolveServablePath(root, request.url ?? "/");
      if (!filePath) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }
      const bytes = await readFile(filePath);
      response.writeHead(200, {
        "content-type": contentTypeFor(filePath),
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
      });
      response.end(bytes);
    } catch {
      if (!response.destroyed) {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        response.end("Internal Server Error");
      }
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    root,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    server,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };
    if (arg === "--root") out.root = readValue();
    else if (arg === "--port") out.port = Number(readValue());
    else if (arg === "--host") out.host = readValue();
    else throw new Error(`Unknown argument '${arg}'.`);
  }
  return out;
}

async function main() {
  const server = await createMockUpdateServer(parseArgs(process.argv.slice(2)));
  console.log(`Serving ${server.root} at ${server.url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

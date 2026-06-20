import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";

export interface SiteLogEntry {
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: number;
}

export interface SiteProcessHandle {
  url: string;
  command: string;
  args: string[];
  cwd: string;
  logs(): SiteLogEntry[];
  stop(): Promise<void>;
}

export interface StaticSitePreview {
  url: string;
  root: string;
  stop(): Promise<void>;
}

export interface BuildSiteResult {
  ok: boolean;
  command: string;
  args: string[];
  outputPath: string | null;
  logs: SiteLogEntry[];
  exitCode: number | null;
}

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const MAX_LOG_ENTRIES = 500;
const BUILD_TIMEOUT_MS = 120000;
const BUILD_HARD_KILL_GRACE_MS = 5000;
const DEV_URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?)/i;
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

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !isAbsolute(rel) && !rel.startsWith("..") && !rel.startsWith(sep);
}

async function resolveContainedDir(rootPath: string, relativePath: string): Promise<string> {
  if (relativePath.includes("\0") || relativePath.includes("\\")) {
    throw new Error(`Invalid site path: ${relativePath}`);
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`Site path must be relative: ${relativePath}`);
  }
  const parts = relativePath === "." ? [] : relativePath.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Site path contains traversal: ${relativePath}`);
  }
  const realRoot = await realpath(rootPath);
  const absolute = join(rootPath, ...parts);
  const realSite = await realpath(absolute);
  if (!isInside(realRoot, realSite)) {
    throw new Error(`Site path escapes the workspace: ${relativePath}`);
  }
  const info = await stat(realSite);
  if (!info.isDirectory()) throw new Error(`Site path is not a directory: ${relativePath}`);
  return realSite;
}

function assertContainedFilePath(path: string, label: string): void {
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid ${label}: ${path}`);
  }
}

function pushLog(logs: SiteLogEntry[], stream: SiteLogEntry["stream"], text: string): void {
  const at = Date.now();
  for (const chunk of text.split(/\r?\n/)) {
    if (chunk.length === 0) continue;
    logs.push({ stream, text: chunk, at });
  }
  if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
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
  if (!address || typeof address === "string") throw new Error("Site server did not start.");
  return `http://127.0.0.1:${address.port}`;
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  });
}

export async function startStaticSitePreview(
  workspaceRoot: string,
  siteRoot: string,
  options: { entry?: string } = {},
): Promise<StaticSitePreview> {
  const root = await resolveContainedDir(workspaceRoot, siteRoot);
  const entry = options.entry ?? "index.html";
  assertContainedFilePath(entry, "site entry");
  await access(join(root, entry), constants.R_OK);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      const relativePath = decoded === "/" ? entry : decoded.replace(/^\/+/, "");
      if (
        relativePath.includes("\0") ||
        relativePath.split("/").some((segment) => segment === ".." || segment === ".")
      ) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid path");
        return;
      }
      const target = join(root, relativePath);
      const realTarget = await realpath(target);
      if (!isInside(root, realTarget)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }
      const entryInfo = await stat(realTarget);
      if (!entryInfo.isFile()) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": mimeType(realTarget),
        "x-content-type-options": "nosniff",
      });
      response.end(await readFile(realTarget));
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

export function detectPackageManager(files: Iterable<string>): PackageManager {
  const names = new Set([...files].map((file) => file.split("/").pop()));
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  if (names.has("yarn.lock")) return "yarn";
  return "npm";
}

export function packageManagerCommand(manager: PackageManager, script: string): {
  command: string;
  args: string[];
} {
  if (manager === "npm") return { command: "npm", args: ["run", script] };
  if (manager === "yarn") return { command: "yarn", args: [script] };
  if (manager === "bun") return { command: "bun", args: ["run", script] };
  return { command: "pnpm", args: [script] };
}

export function splitCommandLine(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of commandLine.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (escaped) token += "\\";
  if (quote) throw new Error("Command contains an unterminated quote.");
  if (token) tokens.push(token);
  const [command, ...args] = tokens;
  if (!command) throw new Error("Command cannot be empty.");
  return { command, args };
}

export function detectDevUrl(text: string): string | null {
  return DEV_URL_RE.exec(text)?.[1]?.replace("[::1]", "127.0.0.1") ?? null;
}

export async function startSiteDevServer(input: {
  workspaceRoot: string;
  siteRoot: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}): Promise<SiteProcessHandle> {
  const cwd = await resolveContainedDir(input.workspaceRoot, input.siteRoot);
  const args = input.args ?? [];
  const logs: SiteLogEntry[] = [];
  const child = spawn(input.command, args, {
    cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();

  let resolved = false;
  let stopped = false;

  return await new Promise<SiteProcessHandle>((resolve, reject) => {
    const failTimer = setTimeout(() => {
      if (resolved) return;
      stopped = true;
      child.kill("SIGTERM");
      reject(new Error(`Site dev server did not report a local URL within ${input.readyTimeoutMs ?? 15000}ms.`));
    }, input.readyTimeoutMs ?? 15000);

    function maybeResolve(chunk: string) {
      const url = detectDevUrl(chunk);
      if (!url || resolved) return;
      resolved = true;
      clearTimeout(failTimer);
      resolve({
        url,
        command: input.command,
        args,
        cwd,
        logs: () => [...logs],
        stop: () => stopChild(child, () => {
          stopped = true;
        }),
      });
    }

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      pushLog(logs, "stdout", text);
      maybeResolve(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      pushLog(logs, "stderr", text);
      maybeResolve(text);
    });
    child.once("error", (error) => {
      clearTimeout(failTimer);
      if (!resolved) reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(failTimer);
      if (!resolved && !stopped) {
        reject(new Error(`Site dev server exited before it was ready (code=${code}, signal=${signal}).`));
      }
    });
  });
}

async function stopChild(
  child: ChildProcess,
  beforeKill?: () => void,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  beforeKill?.();
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const hardKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, BUILD_HARD_KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(hardKill);
      resolve();
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectBuildOutput(siteRoot: string, configured?: string): Promise<string | null> {
  const candidates = configured ? [configured] : ["dist", "build", "out"];
  const realSiteRoot = await realpath(siteRoot);
  for (const candidate of candidates) {
    try {
      assertContainedFilePath(candidate, "build output");
    } catch {
      return null;
    }
    const absolute = join(siteRoot, candidate);
    if (!(await pathExists(absolute))) continue;
    const realOutput = await realpath(absolute);
    if (!isInside(realSiteRoot, realOutput)) return null;
    const info = await stat(absolute);
    if (info.isDirectory()) return absolute;
  }
  return null;
}

export async function buildSite(input: {
  workspaceRoot: string;
  siteRoot: string;
  command: string;
  args?: string[];
  output?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<BuildSiteResult> {
  const cwd = await resolveContainedDir(input.workspaceRoot, input.siteRoot);
  const args = input.args ?? [];
  const timeoutMs = input.timeoutMs ?? BUILD_TIMEOUT_MS;
  const logs: SiteLogEntry[] = [];
  const child = spawn(input.command, args, {
    cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolve(code);
    }

    timer = setTimeout(() => {
      pushLog(logs, "system", `Build timed out after ${timeoutMs}ms.`);
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        finish(null);
      }, BUILD_HARD_KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => pushLog(logs, "stdout", String(chunk)));
    child.stderr.on("data", (chunk) => pushLog(logs, "stderr", String(chunk)));
    child.once("error", (error) => {
      pushLog(logs, "system", error.message);
      finish(null);
    });
    child.once("exit", (code) => {
      finish(code);
    });
  });

  const outputPath = exitCode === 0 ? await detectBuildOutput(cwd, input.output) : null;
  return {
    ok: exitCode === 0 && outputPath !== null,
    command: input.command,
    args,
    outputPath,
    logs,
    exitCode,
  };
}

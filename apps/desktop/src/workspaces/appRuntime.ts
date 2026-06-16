import { appScope, appWriteAllowed, validateUserWritePath } from "@dohc/workspace-core";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import type { AppPackageInfo } from "./appPackage";
import { getAppPackage } from "./appPackage";
import {
  registerRuntimeDocument,
  runtimeDocument,
  runtimeOrigin,
  runtimeScript,
  setRuntimeOrigin,
} from "./appRuntimeRegistry";
import { existingAncestor } from "./workspaceFiles";

export interface AppRuntimeInfo {
  root: string;
  title: string;
  src: string;
  token: string;
}

export interface AppRuntimeRpcRequest {
  id: string;
  op: "collection.list" | "collection.insert";
  args: Record<string, unknown>;
}

const MAX_RUNTIME_SOURCE_BYTES = 512 * 1024;
const MAX_COLLECTION_ROW_BYTES = 256 * 1024;
const MAX_COLLECTION_ROWS = 500;
const COLLECTION_NAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 100;
const MAX_JSON_ARRAY_ITEMS = 500;
const MAX_JSON_STRING_BYTES = 64 * 1024;
function appRuntimeCsp(): string {
  return "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
}
let runtimeServer: Server | null = null;

async function ensureRuntimeServer(): Promise<string> {
  const existingOrigin = runtimeOrigin();
  if (existingOrigin) return existingOrigin;
  runtimeServer = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/([0-9a-f-]{36})\/(index\.html|runtime\.js)$/.exec(url.pathname);
      const token = match?.[1];
      const file = match?.[2];
      const body =
        token && file === "index.html"
          ? runtimeDocument(token)
          : token && file === "runtime.js"
            ? runtimeScript(token)
            : null;
      if (!body) {
        response.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end("Not found");
        return;
      }
      const isScript = file === "runtime.js";
      response.writeHead(200, {
        "content-type": isScript
          ? "application/javascript; charset=utf-8"
          : "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(isScript ? {} : { "content-security-policy": appRuntimeCsp() }),
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  runtimeServer.unref();
  await new Promise<void>((resolve, reject) => {
    runtimeServer?.once("error", reject);
    runtimeServer?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = runtimeServer.address();
  if (!address || typeof address === "string") {
    throw new Error("App runtime server did not start.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  setRuntimeOrigin(origin);
  return origin;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function runtimeAllowed(info: AppPackageInfo): boolean {
  if (info.readiness !== "ready") return false;
  return !info.requiresTrust || info.trusted;
}

function scopeJoin(scope: string, ...parts: string[]): string {
  return [scope, ...parts].filter(Boolean).join("/");
}

function collectionName(value: unknown): string {
  if (typeof value !== "string" || !COLLECTION_NAME_RE.test(value)) {
    throw new Error("Invalid app collection name.");
  }
  return value;
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App collection record must be an object.");
  }
  assertBoundedJson(value);
  return value as Record<string, unknown>;
}

function assertBoundedJson(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) throw new Error("App collection record is too deeply nested.");
  if (value === null) return;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_BYTES) {
      throw new Error("App collection record contains an oversized string.");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("App collection record contains an invalid number.");
    }
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      throw new Error("App collection record contains too many array items.");
    }
    for (const item of value) assertBoundedJson(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_JSON_KEYS) {
      throw new Error("App collection record contains too many keys.");
    }
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > 512) {
        throw new Error("App collection record contains an oversized key.");
      }
      assertBoundedJson(item, depth + 1);
    }
    return;
  }
  throw new Error("App collection record must be JSON-serializable.");
}

function safeRecordId(record: Record<string, unknown>): string {
  const raw = record.id === undefined || record.id === null ? randomUUID() : String(record.id);
  if (raw.trim().length === 0 || raw.length > 180) {
    throw new Error("App collection record id is invalid.");
  }
  const encoded = encodeURIComponent(raw).replace(/~/g, "~7E").replace(/%/g, "~");
  if (encoded.length > 240) {
    throw new Error("App collection record id is invalid.");
  }
  return encoded;
}

function collectionDir(info: AppPackageInfo, name: string): string {
  return scopeJoin(appScope(info.root), name);
}

function collectionRecordPath(info: AppPackageInfo, name: string, id: string): string {
  return scopeJoin(collectionDir(info, name), `${id}.json`);
}

async function assertNoSymlinkedSegments(rootPath: string, relativePath: string): Promise<void> {
  let cursor = rootPath;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new Error("App runtime collection paths cannot use symbolic links.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function existingPlainFile(rootPath: string, relativePath: string): Promise<boolean> {
  await assertNoSymlinkedSegments(rootPath, relativePath);
  try {
    const entry = await lstat(join(rootPath, relativePath));
    if (!entry.isFile()) {
      throw new Error("App collection record path is not a regular file.");
    }
    if (entry.size > MAX_COLLECTION_ROW_BYTES) {
      throw new Error("App collection record is too large.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function existingPlainDir(rootPath: string, relativePath: string): Promise<boolean> {
  await assertNoSymlinkedSegments(rootPath, relativePath);
  try {
    const entry = await lstat(join(rootPath, relativePath));
    if (!entry.isDirectory()) {
      throw new Error("App collection path is not a directory.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !isAbsolute(rel) && !rel.startsWith("..") && !rel.startsWith(sep);
}

async function writeNewWorkspaceText(
  rootPath: string,
  relativePath: string,
  text: string,
): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_COLLECTION_ROW_BYTES) {
    throw new Error("App collection record is too large.");
  }
  await assertNoSymlinkedSegments(rootPath, relativePath);
  const absolute = join(rootPath, relativePath);
  const parent = dirname(absolute);
  const realRoot = await realpath(rootPath);
  if (!isInside(realRoot, await existingAncestor(parent))) {
    throw new Error("App collection write escapes the workspace.");
  }
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkedSegments(rootPath, dirname(relativePath));
  if (!isInside(realRoot, await realpath(parent))) {
    throw new Error("App collection write escapes the workspace.");
  }
  // O_NOFOLLOW is unavailable on Windows; the segment lstat checks, parent
  // realpath containment, and O_EXCL final create keep the cross-platform
  // write boundary explicit.
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(absolute, flags, 0o666).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("App collection record already exists.");
    }
    throw error;
  });
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

function globToRegExp(glob: string): RegExp {
  if (glob === "." || glob === "" || glob === "**") return /^.*$/;
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function appReadAllowed(info: AppPackageInfo, targetPath: string): boolean {
  if (targetPath === info.root || targetPath.startsWith(`${info.root}/`)) return true;
  if (targetPath === ".dohc" || targetPath.startsWith(".dohc/")) return false;
  const scope = appScope(info.root);
  const rel =
    scope === "" ? targetPath : targetPath.startsWith(`${scope}/`) ? targetPath.slice(scope.length + 1) : null;
  if (rel === null) return false;
  return info.manifest.read.some((glob) => globToRegExp(glob).test(rel));
}

function compileAppEntry(source: string): string {
  const compiled = ts.transpileModule(source, {
    fileName: "App.tsx",
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const diagnostic = compiled.diagnostics?.find(
    (item) => item.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  return compiled.outputText;
}

function buildRuntimeScript(compiledEntry: string, token: string): string {
  const prefix = `
(() => {
  const runtimeToken = ${JSON.stringify(token)};
  const pending = new Map();
  let seq = 0;
  const Fragment = Symbol("fragment");
  const hookState = [];
  let hookIndex = 0;

  function request(op, args = {}) {
    const id = String(++seq);
    parent.postMessage({ type: "dohc:runtime-rpc", token: runtimeToken, id, op, args }, "*");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (
      !data ||
      data.type !== "dohc:runtime-rpc-result" ||
      data.token !== runtimeToken ||
      typeof data.id !== "string"
    ) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.value);
    else entry.reject(new Error(data.error || "App request failed."));
  });

  function collectionApi(name) {
    return {
      list: (query) => request("collection.list", { name, query }),
      insert: (record) => request("collection.insert", { name, record }),
    };
  }

  const dohc = {
    collection: (name) => collectionApi(name),
  };

  function jsx(type, props, key) {
    return { type, props: props || {}, key };
  }
  const jsxs = jsx;
  const React = {
    useState(initial) {
      const index = hookIndex++;
      if (hookState[index] === undefined) {
        hookState[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        hookState[index],
        (next) => {
          hookState[index] =
            typeof next === "function" ? next(hookState[index]) : next;
          renderApp();
        },
      ];
    },
    useEffect() {},
    useMemo(factory) {
      return factory();
    },
  };

  function require(specifier) {
    if (specifier === "@dohc/app") return { dohc };
    if (specifier === "react") return React;
    if (specifier === "react/jsx-runtime") return { Fragment, jsx, jsxs };
    throw new Error("Unsupported app import: " + specifier);
  }

  Object.defineProperty(window, "fetch", {
    configurable: false,
    value() {
      return Promise.reject(new Error("Network access is disabled for dohc apps."));
    },
  });
  Object.defineProperty(window, "WebSocket", {
    configurable: false,
    value() {
      throw new Error("Network access is disabled for dohc apps.");
    },
  });

  function showRuntimeError(error) {
    const message = error?.message || "App runtime failed.";
    document.body.dataset.runtimeError = message;
    const root = document.getElementById("root");
    if (root) {
      root.textContent = message;
      root.style.padding = "18px";
      root.style.color = "#dc2626";
    }
    parent.postMessage({ type: "dohc:runtime-error", token: runtimeToken, error: message }, "*");
  }

  let RuntimeApp;
  try {
    const module = { exports: {} };
    const exports = module.exports;`;
  const suffix = `
    RuntimeApp = module.exports.default || module.exports.App || module.exports;
    if (typeof RuntimeApp !== "function") {
      throw new Error("App must export a component function.");
    }
  } catch (error) {
    showRuntimeError(error);
    return;
  }

  function setProp(element, key, value) {
    if (value === undefined || value === null || key === "children") return;
    if (key === "className") {
      element.setAttribute("class", String(value));
      return;
    }
    if (key === "style" && typeof value === "object") {
      Object.assign(element.style, value);
      return;
    }
    if (/^on[A-Z]/.test(key) && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), (event) => {
        Promise.resolve(value(event)).catch((error) => {
          document.body.dataset.runtimeError = error?.message || "App action failed.";
        });
      });
      return;
    }
    if (typeof value === "boolean") {
      if (value) element.setAttribute(key, "");
      return;
    }
    element.setAttribute(key, String(value));
  }

  function renderNode(node, parent) {
    if (node === null || node === undefined || node === false || node === true) return;
    if (typeof node === "string" || typeof node === "number") {
      parent.appendChild(document.createTextNode(String(node)));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) renderNode(child, parent);
      return;
    }
    if (typeof node.type === "function") {
      renderNode(node.type(node.props || {}), parent);
      return;
    }
    if (node.type === Fragment) {
      renderNode(node.props?.children, parent);
      return;
    }
    if (typeof node.type !== "string") return;
    const element = document.createElement(node.type);
    for (const [key, value] of Object.entries(node.props || {})) setProp(element, key, value);
    renderNode(node.props?.children, element);
    parent.appendChild(element);
  }

  function renderApp() {
    hookIndex = 0;
    const root = document.getElementById("root");
    root.textContent = "";
    renderNode(jsx(RuntimeApp, {}), root);
  }

  try {
    renderApp();
    parent.postMessage({ type: "dohc:runtime-ready", token: runtimeToken }, "*");
  } catch (error) {
    showRuntimeError(error);
  }
})();`;
  return prefix + "\n" + compiledEntry + "\n" + suffix;
}

function buildRuntimeHtml(title: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(appRuntimeCsp())}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; font: 13px Inter, ui-sans-serif, system-ui, sans-serif; }
html, body, #root { min-height: 100%; margin: 0; }
body { background: #fff; color: #18181b; }
main { min-height: 100%; padding: 18px; box-sizing: border-box; }
button { font: inherit; border: 1px solid #d4d4d8; border-radius: 6px; background: #18181b; color: #fff; padding: 6px 10px; }
@media (prefers-color-scheme: dark) {
  body { background: #18181b; color: #f4f4f5; }
  button { background: #f4f4f5; color: #18181b; border-color: #3f3f46; }
}
</style>
</head>
<body>
<div id="root"></div>
<script src="./runtime.js"></script>
</body>
</html>`;
}

export async function getAppRuntime(
  rootPath: string,
  appRoot: string,
): Promise<AppRuntimeInfo> {
  const info = await getAppPackage(rootPath, appRoot);
  if (!info) throw new Error(`Not an app package: ${appRoot}`);
  if (!runtimeAllowed(info)) {
    throw new Error("App must pass AppTester and be trusted before it can run.");
  }
  const entryPath = `${info.root}/${info.manifest.entry}`;
  if (!info.sourceFiles.includes(entryPath)) {
    throw new Error(`App entry file is missing: ${info.manifest.entry}`);
  }
  const entry = await readFile(join(rootPath, entryPath), "utf8");
  if (Buffer.byteLength(entry, "utf8") > MAX_RUNTIME_SOURCE_BYTES) {
    throw new Error("App entry is too large to run in the desktop preview.");
  }
  const title = info.manifest.title ?? info.name;
  const token = randomUUID();
  const compiled = compileAppEntry(entry);
  const script = buildRuntimeScript(compiled, token);
  registerRuntimeDocument(token, {
    html: buildRuntimeHtml(title),
    script,
  });
  const origin = await ensureRuntimeServer();
  return {
    root: info.root,
    title,
    token,
    src: `${origin}/${token}/index.html`,
  };
}

export async function runAppRuntimeRpc(
  rootPath: string,
  appRoot: string,
  request: AppRuntimeRpcRequest,
): Promise<unknown> {
  const info = await getAppPackage(rootPath, appRoot);
  if (!info) throw new Error(`Not an app package: ${appRoot}`);
  if (!runtimeAllowed(info)) {
    throw new Error("App must pass AppTester and be trusted before it can write.");
  }
  const name = collectionName(request.args.name);
  if (request.op === "collection.list") {
    const dir = collectionDir(info, name);
    if (!appReadAllowed(info, collectionRecordPath(info, name, "__read__.json"))) {
      throw new Error("App read is outside its declared scope.");
    }
    if (!(await existingPlainDir(rootPath, dir))) return { rows: [] };
    const absolute = join(rootPath, dir);
    const names = await readdir(absolute);
    const rows: Array<Record<string, unknown>> = [];
    for (const file of names.filter((item) => item.endsWith(".json")).slice(0, MAX_COLLECTION_ROWS)) {
      try {
        const recordPath = scopeJoin(dir, file);
        if (!(await existingPlainFile(rootPath, recordPath))) continue;
        const parsed = JSON.parse(await readFile(join(rootPath, recordPath), "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          rows.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore malformed user-edited collection rows; they stay visible on disk.
      }
    }
    return { rows };
  }
  const record = recordPayload(request.args.record);
  const id = safeRecordId(record);
  const row = { ...record, id: record.id ?? id };
  const target = collectionRecordPath(info, name, id);
  const validated = validateUserWritePath(target);
  if (!validated.ok) throw new Error(`Invalid app write path: ${validated.reason}`);
  if (!appWriteAllowed(info.manifest, { trusted: info.trusted }, info.root, validated.normalized)) {
    throw new Error("App write is outside its declared trusted scope.");
  }
  if (await existingPlainFile(rootPath, validated.normalized)) {
    throw new Error("App collection record already exists.");
  }
  await writeNewWorkspaceText(rootPath, validated.normalized, `${JSON.stringify(row, null, 2)}\n`);
  return { row };
}

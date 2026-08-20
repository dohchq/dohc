import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import type {
  PluginAgentDriver,
  PluginAgentEvent,
  PluginAgentProbe,
  PluginAgentSession,
  PluginPermissionDecision,
  PluginWebAppStart,
} from "@dohc/sdk/node";

const CHAT_WEB_APP_ID = "chat";
// A memory guard, not a measured retention target -- no healthy turn size
// was measured before choosing 500. A turn longer than this replays
// starting mid-turn on reconnect, not from the beginning: ui/chat.js resets
// its transcript on every EventSource open and rebuilds it purely from
// what this log currently holds.
const MAX_BUFFERED_EVENTS = 500;
const TOKEN_PLACEHOLDER = "__CHAT_TOKEN__";

type SessionStateEvent = Extract<PluginAgentEvent, { kind: "session-state" }>;

/** A submitted prompt, recorded so a reconnect replays both sides of the
 * conversation. clientId lets the submitting page's own optimistic card
 * recognize its own echo instead of rendering a duplicate. */
interface UserMessageEvent {
  kind: "user-message";
  text: string;
  clientId: string;
}

type ChatStreamEvent = PluginAgentEvent | UserMessageEvent;

export interface ChatWebApp {
  startWebApp(webAppId: string, instanceKey: string | null): Promise<PluginWebAppStart>;
  stopWebApp(webAppId: string, instanceKey: string | null): Promise<void>;
  deactivate(): Promise<void>;
}

interface RequestError extends Error {
  statusCode: number;
}

function requestError(statusCode: number, message: string): RequestError {
  return Object.assign(new Error(message), { statusCode });
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

// Credential-free and local-only, on purpose. The desktop's own chat spawns
// dohc-mcp with --home pointed at the app state directory plus SDK metadata
// and cached cloud credentials (mcpRuntimeConfigFor in main.ts) -- that is
// host-main-process-only state a plugin has no SDK seam to reach, and must
// not be handed to fetch it (that would route host credentials into
// full-trust plugin code). Without --home, dohc-mcp resolves its home to
// the OS default, so registry-backed tools here read that default registry
// rather than the desktop's, and cloud-aware tools have no runtime
// environment. See both plugins' README.md.
function mcpConfig(workspaceRoot: string): { command: string; args: string[] } {
  return {
    command: process.env.DOHC_MCP_COMMAND?.trim() || "dohc-mcp",
    args: ["--workspace", workspaceRoot],
  };
}

function isPermissionDecision(value: unknown): value is PluginPermissionDecision {
  return (
    value === "allow_once" ||
    value === "allow_always" ||
    value === "reject_once" ||
    value === "reject_always" ||
    value === "cancel"
  );
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/** True for a mutating request carrying the per-start bearer token AND a
 * real `application/json` content type. Both together: a CORS-simple
 * request (a hostile page's cross-origin POST that skips preflight) can
 * only ever use a simple content type, so requiring the real one forces a
 * preflight our server never grants -- the token alone would not stop a
 * caller who happened to already know it from some other leak. */
function isAuthorizedMutation(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
  if (!match?.[1] || !tokensMatch(match[1], token)) return false;
  const rawContentType = request.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw requestError(400, "The request body must contain valid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

function writeError(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}

function staticAsset(pathname: string): { file: string; contentType: string } | null {
  if (pathname === "/") {
    return { file: "index.html", contentType: "text/html; charset=utf-8" };
  }
  if (pathname === "/chat.css") {
    return { file: "chat.css", contentType: "text/css; charset=utf-8" };
  }
  if (pathname === "/chat.js") {
    return { file: "chat.js", contentType: "application/javascript; charset=utf-8" };
  }
  return null;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The Codex chat server did not start.");
  }
  return "http://127.0.0.1:" + address.port + "/";
}

export function createChatWebApp(
  driver: PluginAgentDriver,
  workspaceRoot: string,
  uiRoot: string,
): ChatWebApp {
  let server: Server | null = null;
  let serverUrl: string | null = null;
  let serverStart: Promise<string> | null = null;
  let token: string | null = null;
  let sessionStart: Promise<PluginAgentSession> | null = null;
  let sessionGeneration = 0;
  let processSession: PluginAgentSession | null = null;
  // Set while a session is tearing down (POST /stop's own driver.stop()
  // call). liveSession() awaits this before starting a fresh session, so a
  // message that races a stop cannot start a second driver session while
  // the first one is still shutting down.
  let teardown: Promise<void> | null = null;
  let state: SessionStateEvent = { kind: "session-state", state: "closed" };
  const eventLog: ChatStreamEvent[] = [];
  const clients = new Set<ServerResponse>();
  const pendingPermissions = new Set<string>();

  function frame(event: ChatStreamEvent): string {
    return "data: " + JSON.stringify(event) + "\n\n";
  }

  function publish(event: ChatStreamEvent): void {
    if (event.kind === "session-state") state = event;
    if (event.kind === "error" && event.fatal) {
      state = { kind: "session-state", state: "error", reason: event.message };
    }
    if (event.kind === "turn-completed") {
      state = { kind: "session-state", state: "ready" };
    }
    if (event.kind === "permission-request") pendingPermissions.add(event.requestId);
    if (event.kind === "permission-resolved") pendingPermissions.delete(event.requestId);
    eventLog.push(event);
    if (eventLog.length > MAX_BUFFERED_EVENTS) {
      eventLog.splice(0, eventLog.length - MAX_BUFFERED_EVENTS);
    }
    const encoded = frame(event);
    for (const client of clients) client.write(encoded);
  }

  function sessionEnded(event: PluginAgentEvent): boolean {
    return (
      (event.kind === "error" && event.fatal) ||
      (event.kind === "session-state" && (event.state === "error" || event.state === "closed"))
    );
  }

  async function startSession(): Promise<PluginAgentSession> {
    const generation = ++sessionGeneration;
    pendingPermissions.clear();
    // Set once this driver.startSession call itself ends before it even
    // resolves (a session that fails during its own handshake).
    let ended = false;
    const created = await driver.startSession({
      workspaceRoot,
      mode: "approval-required",
      mcp: mcpConfig(workspaceRoot),
      onEvent(event) {
        if (generation !== sessionGeneration) return;
        publish(event);
        if (sessionEnded(event)) {
          ended = true;
          processSession = null;
          pendingPermissions.clear();
        }
      },
    });
    // A newer generation means a /stop (or deactivate) ran while this
    // session was still starting -- it already bumped sessionGeneration
    // even though processSession was still null to invalidate. Either way,
    // this session must never become the live one.
    if (ended || generation !== sessionGeneration) {
      await Promise.resolve(created.dispose()).catch(() => undefined);
      throw requestError(
        503,
        ended
          ? "The Codex session ended while it started."
          : "The Codex session was stopped while it started.",
      );
    }
    processSession = created;
    return created;
  }

  async function liveSession(): Promise<PluginAgentSession> {
    if (teardown) await teardown.catch(() => undefined);
    if (processSession) return processSession;
    const available = await Promise.resolve(driver.probe()).catch((error: unknown) => {
      const message = errorMessage(error);
      publish({ kind: "error", message, fatal: true });
      throw requestError(503, message);
    });
    if (!available.installed) {
      const message =
        available.errorMessage?.trim() ||
        "Codex isn't installed. Install the Codex CLI and add it to your PATH.";
      publish({ kind: "error", message, fatal: true });
      throw requestError(503, message);
    }
    sessionStart ??= startSession().finally(() => {
      sessionStart = null;
    });
    return sessionStart;
  }

  async function message(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await jsonBody(request);
    if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") {
      throw requestError(400, "Enter a message before sending.");
    }
    const clientId =
      typeof body.clientId === "string" && body.clientId ? body.clientId : randomUUID();
    // Recorded before the session even starts: the user did send this, and
    // a reconnect should show it regardless of whether the prompt below
    // succeeds. A failure follows as its own fatal error event.
    publish({ kind: "user-message", text: body.text, clientId });
    const live = await liveSession();
    try {
      await live.prompt({ text: body.text });
    } catch (error) {
      if (processSession === live) {
        processSession = null;
        pendingPermissions.clear();
      }
      const message = errorMessage(error);
      publish({ kind: "error", message, fatal: true });
      await Promise.resolve(live.dispose()).catch(() => undefined);
      throw requestError(500, message);
    }
    writeEmpty(response, 202);
  }

  async function stop(response: ServerResponse): Promise<void> {
    // Bumped unconditionally, even with no live session: a start can still
    // be pending (processSession is null until driver.startSession
    // resolves), and this is what tells that pending start to dispose
    // itself instead of installing.
    sessionGeneration += 1;
    const live = processSession;
    processSession = null;
    pendingPermissions.clear();
    if (!live) {
      writeEmpty(response, 204);
      return;
    }
    const settling = (async () => {
      try {
        await live.stop();
        publish({ kind: "session-state", state: "closed", reason: "Stopped" });
      } catch (error) {
        // live.stop() itself failed (a transport error during cancel or
        // dispose). Best effort: release the handle anyway so nothing keeps
        // running with no owner, and say why it closed instead of leaving
        // the page showing stale state under a 500.
        await Promise.resolve(live.dispose()).catch(() => undefined);
        publish({ kind: "session-state", state: "closed", reason: errorMessage(error) });
      }
    })();
    teardown = settling.finally(() => {
      if (teardown === settling) teardown = null;
    });
    await settling;
    writeEmpty(response, 204);
  }

  async function permission(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const live = processSession;
    if (!live || !pendingPermissions.has(requestId)) {
      throw requestError(404, "This permission request is no longer pending.");
    }
    const body = await jsonBody(request);
    const decision = isRecord(body) ? body.decision : undefined;
    if (!isPermissionDecision(decision)) {
      throw requestError(400, "Choose a valid permission response.");
    }
    await live.answerPermission(requestId, decision);
    pendingPermissions.delete(requestId);
    writeEmpty(response, 204);
  }

  function events(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    response.flushHeaders();
    response.write(frame(state));
    for (const event of eventLog) response.write(frame(event));
    clients.add(response);
    request.once("close", () => clients.delete(response));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!token) throw requestError(503, "The chat server is not ready yet.");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/events") {
        // EventSource cannot set a header, so its one credential is a query
        // parameter instead of the bearer header the POST routes use.
        const provided = url.searchParams.get("token");
        if (!provided || !tokensMatch(provided, token)) {
          throw requestError(401, "This chat session's request was not authorized.");
        }
        events(request, response);
        return;
      }
      const isMutation =
        request.method === "POST" &&
        (url.pathname === "/message" ||
          url.pathname === "/stop" ||
          /^\/permission\/.+$/.test(url.pathname));
      if (isMutation && !isAuthorizedMutation(request, token)) {
        throw requestError(401, "This chat session's request was not authorized.");
      }
      if (request.method === "POST" && url.pathname === "/message") {
        await message(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        await stop(response);
        return;
      }
      const permissionMatch =
        request.method === "POST" ? /^\/permission\/(.+)$/.exec(url.pathname) : null;
      if (permissionMatch?.[1]) {
        await permission(request, response, decodeURIComponent(permissionMatch[1]));
        return;
      }
      // Static assets stay tokenless: the browser cannot read a
      // cross-origin response body without CORS permission this server
      // never grants, so a hostile page gains nothing from fetching them --
      // and the page needs to load them before it has a token to send.
      const asset = request.method === "GET" ? staticAsset(url.pathname) : null;
      if (asset) {
        const raw = await readFile(join(uiRoot, asset.file));
        const body =
          asset.file === "index.html"
            ? Buffer.from(raw.toString("utf8").replace(TOKEN_PLACEHOLDER, token), "utf8")
            : raw;
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": asset.contentType,
          "x-content-type-options": "nosniff",
        });
        response.end(body);
        return;
      }
      writeError(response, 404, "Not found.");
    } catch (error) {
      // Every path above that can end the session already published its own
      // event before throwing. A request failure that reaches here -- a bad
      // body, a missing static asset, an unauthorized caller -- is a
      // transport problem, not a session problem, so it 4xx/5xx's the
      // request without touching session state.
      const failure = error as Partial<RequestError>;
      const message = errorMessage(error);
      if (!response.headersSent) writeError(response, failure.statusCode ?? 500, message);
      else response.end();
    }
  }

  async function startServer(): Promise<string> {
    token = randomBytes(24).toString("hex");
    const nextServer = createServer((request, response) => {
      void handle(request, response);
    });
    nextServer.unref();
    server = nextServer;
    try {
      serverUrl = await listen(nextServer);
      return serverUrl;
    } catch (error) {
      server = null;
      token = null;
      throw error;
    }
  }

  return {
    async startWebApp(webAppId, instanceKey) {
      if (webAppId !== CHAT_WEB_APP_ID || instanceKey !== null) {
        throw new Error(
          'The Codex plugin serves only the singleton "' + CHAT_WEB_APP_ID + '" web app.',
        );
      }
      if (serverUrl) return { url: serverUrl };
      serverStart ??= startServer().finally(() => {
        serverStart = null;
      });
      return { url: await serverStart };
    },
    async stopWebApp(webAppId, instanceKey) {
      if (webAppId !== CHAT_WEB_APP_ID || instanceKey !== null) {
        throw new Error(
          'The Codex plugin serves only the singleton "' + CHAT_WEB_APP_ID + '" web app.',
        );
      }
      // Closing the tab does not stop the server or the agent. A later tab reattaches to both.
    },
    async deactivate() {
      // Bumped first, unconditionally: a start pending through deactivation
      // must not be able to install itself as the live session afterward.
      sessionGeneration += 1;
      const live = processSession;
      processSession = null;
      pendingPermissions.clear();
      // Guarded: a rejection here must not skip the cleanup below and leave
      // the server listening (and the session's process running) after the
      // plugin deactivates.
      await Promise.resolve(live?.dispose()).catch(() => undefined);
      for (const client of clients) client.end();
      clients.clear();
      const runningServer = server;
      server = null;
      serverUrl = null;
      token = null;
      if (runningServer) {
        const closed = new Promise<void>((resolve) => runningServer.close(() => resolve()));
        // close() alone waits for every open connection to end on its own --
        // an in-flight request (one still awaiting a gated driver call, for
        // instance) would hold deactivate() open indefinitely. Force any
        // still-open sockets closed right behind it so this always settles.
        runningServer.closeAllConnections();
        await closed;
      }
    },
  };
}

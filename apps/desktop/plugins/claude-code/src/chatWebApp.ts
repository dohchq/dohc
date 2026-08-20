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
// Reloads replay enough history for long turns without retaining an unbounded transcript.
const MAX_BUFFERED_EVENTS = 500;

type SessionStateEvent = Extract<PluginAgentEvent, { kind: "session-state" }>;

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
    throw new Error("The Claude Code chat server did not start.");
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
  let sessionStart: Promise<PluginAgentSession> | null = null;
  let sessionGeneration = 0;
  let processSession: PluginAgentSession | null = null;
  let state: SessionStateEvent = { kind: "session-state", state: "closed" };
  const eventLog: PluginAgentEvent[] = [];
  const clients = new Set<ServerResponse>();
  const pendingPermissions = new Set<string>();

  function frame(event: PluginAgentEvent): string {
    return "data: " + JSON.stringify(event) + "\n\n";
  }

  function publish(event: PluginAgentEvent): void {
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
    // resolves (a session that fails during its own handshake). Local to
    // this call: a later call gets its own flag, so nothing here needs to
    // be reset between attempts.
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
    if (ended) {
      await Promise.resolve(created.dispose()).catch(() => undefined);
      throw requestError(503, "The Claude Code session ended while it started.");
    }
    processSession = created;
    return created;
  }

  async function liveSession(): Promise<PluginAgentSession> {
    if (processSession) return processSession;
    const available = await Promise.resolve(driver.probe()).catch((error: unknown) => {
      const message = errorMessage(error);
      publish({ kind: "error", message, fatal: true });
      throw requestError(503, message);
    });
    if (!available.installed) {
      const message =
        available.errorMessage?.trim() ||
        "Claude Code isn't installed. Install the Claude Code CLI and add it to your PATH.";
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
    const live = processSession;
    if (live) {
      processSession = null;
      sessionGeneration += 1;
      pendingPermissions.clear();
      await live.stop();
      publish({ kind: "session-state", state: "closed", reason: "Stopped" });
    }
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
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/events") {
        events(request, response);
        return;
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
      const asset = request.method === "GET" ? staticAsset(url.pathname) : null;
      if (asset) {
        const body = await readFile(join(uiRoot, asset.file));
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
      // body, a missing static asset -- is a transport problem, not a
      // session problem, so it 5xx's the request without touching session
      // state.
      const failure = error as Partial<RequestError>;
      const message = errorMessage(error);
      if (!response.headersSent) writeError(response, failure.statusCode ?? 500, message);
      else response.end();
    }
  }

  async function startServer(): Promise<string> {
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
      throw error;
    }
  }

  return {
    async startWebApp(webAppId, instanceKey) {
      if (webAppId !== CHAT_WEB_APP_ID || instanceKey !== null) {
        throw new Error(
          'The Claude Code plugin serves only the singleton "' + CHAT_WEB_APP_ID + '" web app.',
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
          'The Claude Code plugin serves only the singleton "' + CHAT_WEB_APP_ID + '" web app.',
        );
      }
      // Closing the tab does not stop the server or the agent. A later tab reattaches to both.
    },
    async deactivate() {
      sessionGeneration += 1;
      const live = processSession;
      processSession = null;
      pendingPermissions.clear();
      await live?.dispose();
      for (const client of clients) client.end();
      clients.clear();
      const runningServer = server;
      server = null;
      serverUrl = null;
      if (runningServer) {
        await new Promise<void>((resolve) => runningServer.close(() => resolve()));
      }
    },
  };
}

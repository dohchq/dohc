import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PluginAgentDriver,
  PluginAgentEvent,
  PluginAgentProbe,
  PluginAgentSession,
  PluginAgentSessionStartInput,
  PluginPermissionDecision,
} from "@dohc/sdk/node";
import { afterEach, describe, expect, it } from "vitest";
import { createChatWebApp, type ChatWebApp } from "./chatWebApp.ts";

// The plugin's real ui/ folder. Once installed, the built plugin root serves
// this same content from pluginRoot/snapshot/ui (main.ts computes that join;
// see 0ab34172) -- this constant is the unbundled source it copies from.
const PLUGIN_UI_ROOT = fileURLToPath(new URL("../ui/", import.meta.url));
/** A scratch directory carrying the real index.html and chat.css but not
 * chat.js -- lets a test reach a real token (GET / still works) and still
 * exercise a genuinely missing asset. */
function uiRootMissingScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-chat-ui-"));
  cpSync(join(PLUGIN_UI_ROOT, "index.html"), join(dir, "index.html"));
  cpSync(join(PLUGIN_UI_ROOT, "chat.css"), join(dir, "chat.css"));
  return dir;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeSession extends PluginAgentSession {
  promptCalls: string[];
  stopCalls: number;
  permissionCalls: Array<{ requestId: string; decision: PluginPermissionDecision }>;
  /** Set by a test right before triggering /stop, to make this session's
   * own stop() reject exactly once (a transport failure during cancel or
   * dispose, from the concrete drivers' perspective). */
  stopError: Error | null;
  /** Same idea, for dispose(). */
  disposeError: Error | null;
}

interface FakeDriverOptions {
  /** Runs the instant driver.startSession is entered, before anything else
   * -- lets a test know the server-side call has actually begun without
   * guessing at timing. */
  onStartSessionEntered?: () => void;
  /** Awaited inside driver.startSession before it does anything else, so a
   * test can hold a session "starting" open on demand. */
  startGate?: () => Promise<void>;
  /** Same pair, for session.stop(). */
  onStopEntered?: () => void;
  stopGate?: () => Promise<void>;
}

interface FakeDriver {
  driver: PluginAgentDriver;
  probeCalls(): number;
  startInputs: PluginAgentSessionStartInput[];
  sessions: FakeSession[];
  /** Every sessionId dispose() was called for, in call order, regardless of
   * whether that call went on to reject. */
  disposed: string[];
}

const installedProbe: PluginAgentProbe = {
  installed: true,
  auth: { status: "authenticated" },
  models: [],
};

function fakeDriver(
  probe: () => PluginAgentProbe = () => installedProbe,
  options: FakeDriverOptions = {},
): FakeDriver {
  const startInputs: PluginAgentSessionStartInput[] = [];
  const sessions: FakeSession[] = [];
  const disposed: string[] = [];
  let probes = 0;

  const driver: PluginAgentDriver = {
    async probe() {
      probes += 1;
      return probe();
    },
    async startSession(input) {
      options.onStartSessionEntered?.();
      if (options.startGate) await options.startGate();
      startInputs.push(input);
      const promptCalls: string[] = [];
      const permissionCalls: Array<{
        requestId: string;
        decision: PluginPermissionDecision;
      }> = [];
      let stopCalls = 0;
      const sessionId = `session-${sessions.length + 1}`;
      const session: FakeSession = {
        sessionId,
        promptCalls,
        permissionCalls,
        stopError: null,
        disposeError: null,
        get stopCalls() {
          return stopCalls;
        },
        async prompt(message) {
          promptCalls.push(message.text);
          return { turnId: `turn-${promptCalls.length}` };
        },
        async cancel() {},
        async answerPermission(requestId, decision) {
          permissionCalls.push({ requestId, decision });
        },
        async stop() {
          stopCalls += 1;
          options.onStopEntered?.();
          if (options.stopGate) await options.stopGate();
          if (session.stopError) {
            const error = session.stopError;
            session.stopError = null;
            throw error;
          }
        },
        async dispose() {
          disposed.push(sessionId);
          if (session.disposeError) {
            const error = session.disposeError;
            session.disposeError = null;
            throw error;
          }
        },
      };
      sessions.push(session);
      return session;
    },
  };

  return { driver, probeCalls: () => probes, startInputs, sessions, disposed };
}

interface EventStream {
  next(): Promise<PluginAgentEvent | { kind: "user-message"; text: string; clientId: string }>;
  close(): Promise<void>;
}

async function eventStream(url: string, token: string): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(new URL("events?token=" + encodeURIComponent(token), url), {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("The event response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return {
    async next() {
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) return JSON.parse(data);
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("The event stream ended before the next event.");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function rawPost(url: string, path: string, init: RequestInit): Promise<Response> {
  return fetch(new URL(path, url), { method: "POST", ...init });
}

async function post(url: string, path: string, body: unknown, token: string): Promise<Response> {
  return rawPost(url, path, {
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function fetchToken(url: string): Promise<string> {
  const page = await fetch(new URL("/", url));
  const html = await page.text();
  const match = /<meta name="chat-token" content="([0-9a-f]+)">/.exec(html);
  if (!match?.[1]) throw new Error("The chat page did not carry a session token.");
  return match[1];
}

const runningApps: ChatWebApp[] = [];

async function start(
  fake: FakeDriver,
  uiRoot = PLUGIN_UI_ROOT,
): Promise<{ app: ChatWebApp; url: string; token: string }> {
  const app = createChatWebApp(fake.driver, "C:\\workspace", uiRoot);
  runningApps.push(app);
  const started = await app.startWebApp("chat", null);
  const token = await fetchToken(started.url);
  return { app, url: started.url, token };
}

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.deactivate().catch(() => undefined)));
});

describe("Claude Code chat web app", () => {
  it("starts one session and sends later messages through the same session", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);

    expect(await post(url, "message", { text: "First message" }, token)).toMatchObject({
      status: 202,
    });
    expect(fake.probeCalls()).toBe(1);
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.startInputs[0]).toMatchObject({
      workspaceRoot: "C:\\workspace",
      mode: "approval-required",
      mcp: {
        command: process.env.DOHC_MCP_COMMAND?.trim() || "dohc-mcp",
        args: ["--workspace", "C:\\workspace"],
      },
    });
    expect(fake.startInputs[0]?.resumeCursor).toBeUndefined();
    expect(fake.sessions[0]?.promptCalls).toEqual(["First message"]);

    expect(await post(url, "message", { text: "Second message" }, token)).toMatchObject({
      status: 202,
    });
    expect(fake.probeCalls()).toBe(1);
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.sessions[0]?.promptCalls).toEqual(["First message", "Second message"]);
  });

  it("streams driver events as parseable SSE frames in order", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    expect(await stream.next()).toEqual({ kind: "session-state", state: "closed" });
    await post(url, "message", { text: "Begin", clientId: "c1" }, token);
    expect(await stream.next()).toEqual({ kind: "user-message", text: "Begin", clientId: "c1" });

    const events: PluginAgentEvent[] = [
      { kind: "session-state", state: "ready" },
      { kind: "text-delta", itemId: "answer", stream: "assistant", text: "Hello" },
      { kind: "token-usage", used: 12, input: 8, output: 4 },
    ];
    for (const event of events) fake.startInputs[0]?.onEvent(event);

    const received: unknown[] = [];
    for (let index = 0; index < events.length; index += 1) {
      received.push(await stream.next());
    }
    expect(received).toEqual(events);
    await stream.close();
  });

  it("replays buffered events -- including the user's own message -- and reuses the HTTP server after a reload", async () => {
    const fake = fakeDriver();
    const { app, url, token } = await start(fake);
    await post(url, "message", { text: "Begin", clientId: "c1" }, token);
    const ready: PluginAgentEvent = { kind: "session-state", state: "ready" };
    const text: PluginAgentEvent = {
      kind: "text-delta",
      itemId: "answer",
      stream: "assistant",
      text: "Buffered",
    };
    fake.startInputs[0]?.onEvent(ready);
    fake.startInputs[0]?.onEvent(text);

    const reattached = await eventStream(url, token);
    // "ready" appears twice on purpose: once as the current-state snapshot
    // every new connection gets first, and again from the buffered event
    // log replayed right after it -- the same event reached the snapshot
    // and the log, because publish() updates both.
    expect(await reattached.next()).toEqual(ready);
    expect(await reattached.next()).toEqual({ kind: "user-message", text: "Begin", clientId: "c1" });
    expect(await reattached.next()).toEqual(ready);
    expect(await reattached.next()).toEqual(text);

    const restarted = await app.startWebApp("chat", null);
    expect(restarted.url).toBe(url);
    expect(fake.startInputs).toHaveLength(1);
    await reattached.close();
  });

  it("stops the live session and starts a fresh session for the next message", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "First session" }, token);

    expect(await post(url, "stop", undefined, token)).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.stopCalls).toBe(1);

    expect(await post(url, "message", { text: "Fresh session" }, token)).toMatchObject({
      status: 202,
    });
    expect(fake.startInputs).toHaveLength(2);
    expect(fake.sessions[1]?.promptCalls).toEqual(["Fresh session"]);
    expect(fake.startInputs[1]?.resumeCursor).toBeUndefined();
  });

  it("answers the pending permission request with the selected decision", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next();
    await post(url, "message", { text: "Needs permission", clientId: "c1" }, token);
    await stream.next(); // the user-message echo
    const request: PluginAgentEvent = {
      kind: "permission-request",
      requestId: "request/1",
      requestType: "command",
      title: "Run tests",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    };
    fake.startInputs[0]?.onEvent(request);
    expect(await stream.next()).toEqual(request);

    expect(
      await post(
        url,
        `permission/${encodeURIComponent("request/1")}`,
        { decision: "allow_once" },
        token,
      ),
    ).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.permissionCalls).toEqual([
      { requestId: "request/1", decision: "allow_once" },
    ]);
    await stream.close();
  });

  it("serves its own static chat page, stylesheet, and script, with a real token injected", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake);

    const page = await fetch(new URL("/", url));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("<title>Claude Code Chat</title>");
    expect(html).not.toContain("__CHAT_TOKEN__");
    expect(html).toMatch(/<meta name="chat-token" content="[0-9a-f]{48}">/);

    const css = await fetch(new URL("chat.css", url));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const script = await fetch(new URL("chat.js", url));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
  });

  it("500s a missing static asset without publishing a session error", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake, uiRootMissingScript());
    const stream = await eventStream(url, token);
    expect(await stream.next()).toEqual({ kind: "session-state", state: "closed" });

    const missing = await fetch(new URL("chat.js", url));
    expect(missing.status).toBe(500);

    // A missing asset never touched the session: a normal message still
    // starts one, and the next frame on the stream is that message's own
    // user-message echo, not a stray fatal error from the 500'd asset.
    await post(url, "message", { text: "Still works", clientId: "c1" }, token);
    expect(fake.startInputs).toHaveLength(1);
    expect(await stream.next()).toEqual({
      kind: "user-message",
      text: "Still works",
      clientId: "c1",
    });
    await stream.close();
  });

  it("probes again on every attempt -- installing the CLI after a failed probe lets the next message through", async () => {
    let installed = false;
    const fake = fakeDriver(() =>
      installed
        ? installedProbe
        : {
            installed: false,
            auth: { status: "unknown" },
            models: [],
            errorMessage: "Claude Code isn't here yet.",
          },
    );
    const { url, token } = await start(fake);

    expect(await post(url, "message", { text: "First try" }, token)).toMatchObject({
      status: 503,
    });
    expect(fake.startInputs).toHaveLength(0);
    expect(fake.probeCalls()).toBe(1);

    installed = true;
    expect(await post(url, "message", { text: "Second try" }, token)).toMatchObject({
      status: 202,
    });
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.probeCalls()).toBe(2);
  });

  it("streams a fatal probe error and does not start a missing harness", async () => {
    const fake = fakeDriver(() => ({
      installed: false,
      auth: { status: "unknown" },
      models: [],
      errorMessage: "Claude Code failed its probe.",
    }));
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next();

    expect(await post(url, "message", { text: "Hello", clientId: "c1" }, token)).toMatchObject({
      status: 503,
    });
    expect(fake.startInputs).toHaveLength(0);
    expect(await stream.next()).toEqual({ kind: "user-message", text: "Hello", clientId: "c1" });
    expect(await stream.next()).toEqual({
      kind: "error",
      message: "Claude Code failed its probe.",
      fatal: true,
    });
    await stream.close();
  });

  describe("control server authentication", () => {
    it("rejects a mutation with no token, and the session survives", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);
      await post(url, "message", { text: "Live one" }, token);
      expect(fake.sessions[0]?.stopCalls).toBe(0);

      const unauthenticated = await rawPost(url, "stop", {
        headers: { "content-type": "application/json" },
      });
      expect(unauthenticated.status).toBe(401);
      // The session is untouched: no stop reached the driver.
      expect(fake.sessions[0]?.stopCalls).toBe(0);

      const authenticated = await post(url, "stop", undefined, token);
      expect(authenticated.status).toBe(204);
      expect(fake.sessions[0]?.stopCalls).toBe(1);
    });

    it("rejects a mutation sent with a CORS-simple content type, even with the right token", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);

      const simple = await rawPost(url, "stop", {
        headers: { "content-type": "text/plain", authorization: "Bearer " + token },
      });
      expect(simple.status).toBe(401);
    });

    it("rejects a wrong token", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);

      const wrong = await post(url, "message", { text: "Hi" }, token + "x");
      expect(wrong.status).toBe(401);
      expect(fake.startInputs).toHaveLength(0);
    });

    it("rejects /events with no token, and accepts it with the right one", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);

      const unauthenticated = await fetch(new URL("events", url));
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(
        new URL("events?token=" + encodeURIComponent(token), url),
      );
      expect(authenticated.status).toBe(200);
      await authenticated.body?.cancel();
    });

    it("serves static assets without a token", async () => {
      const fake = fakeDriver();
      const { url } = await start(fake);
      expect((await fetch(new URL("chat.css", url))).status).toBe(200);
    });
  });

  describe("session lifecycle races", () => {
    it("stop during startup disposes the pending session instead of installing it", async () => {
      const entered = deferred();
      const gate = deferred();
      const fake = fakeDriver(undefined, {
        onStartSessionEntered: () => entered.resolve(),
        startGate: () => gate.promise,
      });
      const { url, token } = await start(fake);

      const messagePromise = post(url, "message", { text: "Hello" }, token);
      await entered.promise;

      const stopResponse = await post(url, "stop", undefined, token);
      expect(stopResponse.status).toBe(204);

      gate.resolve();
      const messageResponse = await messagePromise;
      expect(messageResponse.status).toBe(503);
      expect(fake.disposed).toEqual(["session-1"]);

      // The invalidated session was never installed: the next message
      // starts an entirely new one.
      const nextResponse = await post(url, "message", { text: "Fresh" }, token);
      expect(nextResponse.status).toBe(202);
      expect(fake.startInputs).toHaveLength(2);
    });

    it("message during stop waits for teardown instead of starting a second session", async () => {
      const stopEntered = deferred();
      const stopGate = deferred();
      const fake = fakeDriver(undefined, {
        onStopEntered: () => stopEntered.resolve(),
        stopGate: () => stopGate.promise,
      });
      const { url, token } = await start(fake);
      await post(url, "message", { text: "First" }, token);
      expect(fake.startInputs).toHaveLength(1);

      const stopPromise = post(url, "stop", undefined, token);
      await stopEntered.promise;

      const duringStop = post(url, "message", { text: "During stop" }, token);
      // Give the event loop a real turn: if liveSession() were not gated on
      // teardown, a second session would already exist by now.
      await new Promise((resolve) => setImmediate(resolve));
      expect(fake.startInputs).toHaveLength(1);

      stopGate.resolve();
      await stopPromise;
      const duringStopResponse = await duringStop;
      expect(duringStopResponse.status).toBe(202);
      expect(fake.startInputs).toHaveLength(2);
      expect(fake.sessions[1]?.promptCalls).toEqual(["During stop"]);
    });

    it("a stop that rejects still closes the session and recovers a startable state", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);
      const stream = await eventStream(url, token);
      await stream.next(); // initial closed snapshot
      await post(url, "message", { text: "First", clientId: "c1" }, token);
      await stream.next(); // the user-message echo
      const session = fake.sessions[0];
      if (!session) throw new Error("The fake driver did not start a session.");
      session.stopError = new Error("Claude Code refused to stop.");

      const stopResponse = await post(url, "stop", undefined, token);
      expect(stopResponse.status).toBe(204);
      expect(session.stopCalls).toBe(1);
      expect(fake.disposed).toEqual(["session-1"]);
      expect(await stream.next()).toEqual({
        kind: "session-state",
        state: "closed",
        reason: "Claude Code refused to stop.",
      });

      const nextResponse = await post(url, "message", { text: "Fresh" }, token);
      expect(nextResponse.status).toBe(202);
      expect(fake.startInputs).toHaveLength(2);
      await stream.close();
    });

    it("deactivate closes the server and its clients even when session dispose rejects", async () => {
      const fake = fakeDriver();
      const { app, url, token } = await start(fake);
      await post(url, "message", { text: "First" }, token);
      const session = fake.sessions[0];
      if (!session) throw new Error("The fake driver did not start a session.");
      session.disposeError = new Error("dispose blew up");

      const stream = await eventStream(url, token);
      // Consume the frames events() already wrote on connect: the current
      // state snapshot, and the buffered replay of the message sent above.
      await stream.next();
      await stream.next();
      await app.deactivate();

      expect(fake.disposed).toEqual(["session-1"]);
      await expect(fetch(new URL("/", url))).rejects.toThrow();
      await expect(stream.next()).rejects.toThrow();
    });

    it("a start pending through deactivate never becomes installable afterward", async () => {
      const entered = deferred();
      const gate = deferred();
      const fake = fakeDriver(undefined, {
        onStartSessionEntered: () => entered.resolve(),
        startGate: () => gate.promise,
      });
      const { app, url, token } = await start(fake);

      const messagePromise = post(url, "message", { text: "Hello" }, token);
      await entered.promise;
      await app.deactivate();
      gate.resolve();

      await messagePromise.catch(() => undefined);
      expect(fake.disposed).toEqual(["session-1"]);
    });
  });
});

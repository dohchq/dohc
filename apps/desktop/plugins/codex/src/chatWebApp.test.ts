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
// This test file's own directory: a real directory with no index.html,
// chat.css, or chat.js in it, for exercising the missing-asset path.
const NO_UI_ASSETS_ROOT = fileURLToPath(new URL(".", import.meta.url));

interface FakeSession extends PluginAgentSession {
  promptCalls: string[];
  stopCalls: number;
  permissionCalls: Array<{ requestId: string; decision: PluginPermissionDecision }>;
}

interface FakeDriver {
  driver: PluginAgentDriver;
  probeCalls(): number;
  startInputs: PluginAgentSessionStartInput[];
  sessions: FakeSession[];
}

const installedProbe: PluginAgentProbe = {
  installed: true,
  auth: { status: "authenticated" },
  models: [],
};

function fakeDriver(probe: () => PluginAgentProbe = () => installedProbe): FakeDriver {
  const startInputs: PluginAgentSessionStartInput[] = [];
  const sessions: FakeSession[] = [];
  let probes = 0;

  const driver: PluginAgentDriver = {
    async probe() {
      probes += 1;
      return probe();
    },
    async startSession(input) {
      startInputs.push(input);
      const promptCalls: string[] = [];
      const permissionCalls: Array<{
        requestId: string;
        decision: PluginPermissionDecision;
      }> = [];
      let stopCalls = 0;
      const session: FakeSession = {
        sessionId: `session-${sessions.length + 1}`,
        promptCalls,
        permissionCalls,
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
        },
        async dispose() {},
      };
      sessions.push(session);
      return session;
    },
  };

  return { driver, probeCalls: () => probes, startInputs, sessions };
}

interface EventStream {
  next(): Promise<PluginAgentEvent>;
  close(): Promise<void>;
}

async function eventStream(url: string): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(new URL("events", url), { signal: controller.signal });
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
          if (data) return JSON.parse(data) as PluginAgentEvent;
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

async function post(url: string, path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, url), {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const runningApps: ChatWebApp[] = [];

async function start(
  fake: FakeDriver,
  uiRoot = PLUGIN_UI_ROOT,
): Promise<{ app: ChatWebApp; url: string }> {
  const app = createChatWebApp(fake.driver, "C:\\workspace", uiRoot);
  runningApps.push(app);
  const started = await app.startWebApp("chat", null);
  return { app, url: started.url };
}

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.deactivate()));
});

describe("Codex chat web app", () => {
  it("starts one session and sends later messages through the same session", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake);

    expect(await post(url, "message", { text: "First message" })).toMatchObject({
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

    expect(await post(url, "message", { text: "Second message" })).toMatchObject({
      status: 202,
    });
    expect(fake.probeCalls()).toBe(1);
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.sessions[0]?.promptCalls).toEqual(["First message", "Second message"]);
  });

  it("streams driver events as parseable SSE frames in order", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake);
    const stream = await eventStream(url);
    expect(await stream.next()).toEqual({ kind: "session-state", state: "closed" });
    await post(url, "message", { text: "Begin" });

    const events: PluginAgentEvent[] = [
      { kind: "session-state", state: "ready" },
      { kind: "text-delta", itemId: "answer", stream: "assistant", text: "Hello" },
      { kind: "token-usage", used: 12, input: 8, output: 4 },
    ];
    for (const event of events) fake.startInputs[0]?.onEvent(event);

    const received: PluginAgentEvent[] = [];
    for (let index = 0; index < events.length; index += 1) {
      received.push(await stream.next());
    }
    expect(received).toEqual(events);
    await stream.close();
  });

  it("replays buffered events and reuses the HTTP server after a reload", async () => {
    const fake = fakeDriver();
    const { app, url } = await start(fake);
    await post(url, "message", { text: "Begin" });
    const ready: PluginAgentEvent = { kind: "session-state", state: "ready" };
    const text: PluginAgentEvent = {
      kind: "text-delta",
      itemId: "answer",
      stream: "assistant",
      text: "Buffered",
    };
    fake.startInputs[0]?.onEvent(ready);
    fake.startInputs[0]?.onEvent(text);

    const reattached = await eventStream(url);
    // "ready" appears twice on purpose: once as the current-state snapshot
    // every new connection gets first, and again from the buffered event
    // log replayed right after it -- the same event reached the snapshot
    // and the log, because publish() updates both.
    expect(await reattached.next()).toEqual(ready);
    expect(await reattached.next()).toEqual(ready);
    expect(await reattached.next()).toEqual(text);

    const restarted = await app.startWebApp("chat", null);
    expect(restarted.url).toBe(url);
    expect(fake.startInputs).toHaveLength(1);
    await reattached.close();
  });

  it("stops the live session and starts a fresh session for the next message", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake);
    await post(url, "message", { text: "First session" });

    expect(await post(url, "stop")).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.stopCalls).toBe(1);

    expect(await post(url, "message", { text: "Fresh session" })).toMatchObject({
      status: 202,
    });
    expect(fake.startInputs).toHaveLength(2);
    expect(fake.sessions[1]?.promptCalls).toEqual(["Fresh session"]);
    expect(fake.startInputs[1]?.resumeCursor).toBeUndefined();
  });

  it("answers the pending permission request with the selected decision", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake);
    const stream = await eventStream(url);
    await stream.next();
    await post(url, "message", { text: "Needs permission" });
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
      await post(url, `permission/${encodeURIComponent("request/1")}`, {
        decision: "allow_once",
      }),
    ).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.permissionCalls).toEqual([
      { requestId: "request/1", decision: "allow_once" },
    ]);
    await stream.close();
  });

  it("serves its own static chat page, stylesheet, and script", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake);

    const page = await fetch(new URL("/", url));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<title>Codex Chat</title>");

    const css = await fetch(new URL("chat.css", url));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const script = await fetch(new URL("chat.js", url));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
  });

  it("500s a missing static asset without publishing a session error", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake, NO_UI_ASSETS_ROOT);
    const stream = await eventStream(url);
    expect(await stream.next()).toEqual({ kind: "session-state", state: "closed" });

    const missing = await fetch(new URL("chat.js", url));
    expect(missing.status).toBe(500);

    // A missing asset never touched the session: a normal message still
    // starts one, and the next frame on the stream is that session's own
    // event, not a stray fatal error from the 404'd asset.
    await post(url, "message", { text: "Still works" });
    expect(fake.startInputs).toHaveLength(1);
    const ready: PluginAgentEvent = { kind: "session-state", state: "ready" };
    fake.startInputs[0]?.onEvent(ready);
    expect(await stream.next()).toEqual(ready);
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
            errorMessage: "Codex isn't here yet.",
          },
    );
    const { url } = await start(fake);

    expect(await post(url, "message", { text: "First try" })).toMatchObject({ status: 503 });
    expect(fake.startInputs).toHaveLength(0);
    expect(fake.probeCalls()).toBe(1);

    installed = true;
    expect(await post(url, "message", { text: "Second try" })).toMatchObject({ status: 202 });
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.probeCalls()).toBe(2);
  });

  it("streams a fatal probe error and does not start a missing harness", async () => {
    const fake = fakeDriver(() => ({
      installed: false,
      auth: { status: "unknown" },
      models: [],
      errorMessage: "Codex failed its probe.",
    }));
    const { url } = await start(fake);
    const stream = await eventStream(url);
    await stream.next();

    expect(await post(url, "message", { text: "Hello" })).toMatchObject({ status: 503 });
    expect(fake.startInputs).toHaveLength(0);
    expect(await stream.next()).toEqual({
      kind: "error",
      message: "Codex failed its probe.",
      fatal: true,
    });
    await stream.close();
  });
});

import { cpSync, mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** Races a promise against a bounded wait, for proving a negative -- "this
 * never arrives" -- that a plain await can't express without hanging
 * forever. */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

interface FakeSession extends PluginAgentSession {
  promptCalls: string[];
  cancelCalls: number;
  permissionCalls: Array<{ requestId: string; decision: PluginPermissionDecision }>;
  /** Same idea, for dispose(). */
  disposeError: Error | null;
  /** Same idea, for prompt() -- a driver that rejects a submitted turn. */
  promptError: Error | null;
  /** Same idea, for answerPermission() -- a driver call that fails because
   * the session it belonged to is already gone underneath it. */
  answerPermissionError: Error | null;
  /** Set by a test right before triggering /stop, to make this session's
   * own cancel() reject exactly once (a transport failure while
   * interrupting the turn). */
  cancelError: Error | null;
}

interface FakeDriverOptions {
  /** Runs the instant driver.startSession is entered, before anything else
   * -- lets a test know the server-side call has actually begun without
   * guessing at timing. */
  onStartSessionEntered?: () => void;
  /** Awaited inside driver.startSession before it does anything else, so a
   * test can hold a session "starting" open on demand. */
  startGate?: () => Promise<void>;
  /** Same pair, for session.prompt() -- lets a test inject driver events
   * (through onEvent) while a prompt call is still pending, before it
   * resolves. */
  onPromptEntered?: () => void;
  promptGate?: () => Promise<void>;
  /** Same pair, for session.answerPermission() -- lets a test force a
   * second concurrent POST to arrive while the first is still inside the
   * driver call, deterministically, instead of hoping two real HTTP
   * requests happen to interleave at the right instant. */
  onAnswerPermissionEntered?: () => void;
  answerPermissionGate?: () => Promise<void>;
  /** Same pair, for session.cancel() -- /stop's own driver call now that
   * Stop interrupts the turn instead of ending the session. */
  onCancelEntered?: () => void;
  cancelGate?: () => Promise<void>;
  /** If set, every session this driver creates rejects its first prompt()
   * with this error, then clears (a retry through a fresh session
   * succeeds normally). */
  promptError?: Error;
  /** If set, driver.startSession() itself rejects with this error (a spawn
   * or handshake failure) instead of ever returning a session. */
  startSessionError?: Error;
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
      if (options.startSessionError) {
        // Mirrors both real drivers: a bare "closed" (no reason) reported
        // through onEvent right before the call itself rejects.
        input.onEvent({ kind: "session-state", state: "closed" });
        throw options.startSessionError;
      }
      startInputs.push(input);
      const promptCalls: string[] = [];
      const permissionCalls: Array<{
        requestId: string;
        decision: PluginPermissionDecision;
      }> = [];
      let cancelCalls = 0;
      const sessionId = `session-${sessions.length + 1}`;
      const session: FakeSession = {
        sessionId,
        promptCalls,
        permissionCalls,
        disposeError: null,
        promptError: options.promptError ?? null,
        answerPermissionError: null,
        cancelError: null,
        get cancelCalls() {
          return cancelCalls;
        },
        async prompt(message) {
          options.onPromptEntered?.();
          if (options.promptGate) await options.promptGate();
          if (session.promptError) {
            const error = session.promptError;
            session.promptError = null;
            throw error;
          }
          promptCalls.push(message.text);
          return { turnId: `turn-${promptCalls.length}` };
        },
        async cancel() {
          cancelCalls += 1;
          options.onCancelEntered?.();
          if (options.cancelGate) await options.cancelGate();
          if (session.cancelError) {
            const error = session.cancelError;
            session.cancelError = null;
            throw error;
          }
        },
        async answerPermission(requestId, decision) {
          options.onAnswerPermissionEntered?.();
          if (options.answerPermissionGate) await options.answerPermissionGate();
          if (session.answerPermissionError) {
            const error = session.answerPermissionError;
            session.answerPermissionError = null;
            throw error;
          }
          permissionCalls.push({ requestId, decision });
        },
        // Not exercised by chatWebApp.ts (it calls cancel() directly, never
        // this) -- kept only to satisfy the SDK interface, mirroring both
        // real drivers' own stop() = cancel() + dispose().
        async stop() {
          await session.cancel();
          await session.dispose();
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
  /** The event with its wire metadata stripped -- `at` (publish time),
   * `snapshot` (the initial connection-state frame's own marker), and
   * `replay` (a frame rebuilt from the log rather than happening now) --
   * for every assertion that only cares about semantic content. */
  next(): Promise<PluginAgentEvent | { kind: "user-message"; text: string; clientId: string }>;
  /** The exact wire object, `at`/`snapshot` included -- for the tests that
   * specifically pin those two fields. */
  nextRaw(): Promise<Record<string, unknown>>;
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

  async function nextRaw(): Promise<Record<string, unknown>> {
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
  }

  return {
    async next() {
      const { at: _at, snapshot: _snapshot, replay: _replay, ...rest } = await nextRaw();
      return rest as PluginAgentEvent | { kind: "user-message"; text: string; clientId: string };
    },
    nextRaw,
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

/** The token startWebApp hands the guest travels only in the URL fragment
 * it returns -- never in anything the server itself serves. */
function tokenFromUrl(url: string): string {
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token");
  if (!token) throw new Error("The chat page's URL did not carry a session token.");
  return token;
}

/** Sends a GET with an arbitrary Host header -- fetch forbids overriding
 * Host (a browser would too), so proving the anti-rebinding check needs
 * Node's own low-level client instead. */
async function fetchWithHost(url: string, host: string): Promise<{ status: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "GET",
        headers: { host },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const runningApps: ChatWebApp[] = [];

async function start(
  fake: FakeDriver,
  uiRoot = PLUGIN_UI_ROOT,
): Promise<{ app: ChatWebApp; url: string; token: string }> {
  const app = createChatWebApp(fake.driver, "C:\\workspace", uiRoot);
  runningApps.push(app);
  const started = await app.startWebApp("chat", null);
  return { app, url: started.url, token: tokenFromUrl(started.url) };
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

    // The first turn has to settle before a second message is accepted --
    // see the "overlapping turns" describe block for the 409 itself.
    fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "completed" });

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
      { kind: "text-delta", itemId: "answer", stream: "assistant", text: "Hel" },
      { kind: "text-delta", itemId: "answer", stream: "assistant", text: "lo" },
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

  it("stamps every event with its real publish time, so a reconnect replays chronology instead of \"now\"", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    const before = Date.now();
    await post(url, "message", { text: "Hello", clientId: "c1" }, token);
    const after = Date.now();

    const reattached = await eventStream(url, token);
    await reattached.nextRaw(); // the initial snapshot
    const replayed = await reattached.nextRaw();
    expect(replayed.kind).toBe("user-message");
    expect(typeof replayed.at).toBe("number");
    expect(replayed.at as number).toBeGreaterThanOrEqual(before);
    expect(replayed.at as number).toBeLessThanOrEqual(after);
    await reattached.close();
  });

  it("marks the initial connection snapshot, so a reasoned terminal state renders exactly one card, not two", async () => {
    // Stop only produces a reasoned "closed" event now while a session is
    // still starting (there is no session or context yet to preserve, only
    // an attempt to give up on) -- a live session's Stop cancels the turn
    // instead and publishes nothing terminal, so that is the one remaining
    // source of the transition this test needs.
    const entered = deferred();
    const gate = deferred();
    const fake = fakeDriver(undefined, {
      onStartSessionEntered: () => entered.resolve(),
      startGate: () => gate.promise,
    });
    const { url, token } = await start(fake);
    const messagePromise = post(url, "message", { text: "First" }, token);
    await entered.promise;
    await post(url, "stop", undefined, token);
    gate.resolve();
    await messagePromise.catch(() => undefined);

    const reattached = await eventStream(url, token);
    const snapshot = await reattached.nextRaw();
    expect(snapshot).toMatchObject({
      kind: "session-state",
      state: "closed",
      reason: "Stopped",
      snapshot: true,
    });

    // The buffered replay carries the same transition again -- the client
    // must be able to tell these apart, or it renders the "Stopped" card
    // twice: once for the snapshot, once for the replayed event.
    const closedReplay = await reattached.nextRaw();
    expect(closedReplay).toMatchObject({
      kind: "session-state",
      state: "closed",
      reason: "Stopped",
    });
    expect(closedReplay.snapshot).toBeUndefined();
    await reattached.close();
  });

  it("keeps a reconnect's replay in turn order even when the driver publishes before its own prompt resolves", async () => {
    // The driver can call onEvent synchronously (or on a fast tick) inside
    // prompt() before that call ever resolves -- without reserving this
    // turn's log position first, that early event would land in the log
    // ahead of the user-message it was actually caused by, and a reconnect
    // would replay the reply before the question.
    const entered = deferred();
    const gate = deferred();
    const fake = fakeDriver(undefined, {
      onPromptEntered: () => entered.resolve(),
      promptGate: () => gate.promise,
    });
    const { url, token } = await start(fake);
    let timestamp = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => timestamp++);
    try {
      const sendPromise = post(url, "message", { text: "Hello", clientId: "c1" }, token);
      await entered.promise;
      fake.startInputs[0]?.onEvent({ kind: "session-state", state: "running" });
      gate.resolve();
      expect((await sendPromise).status).toBe(202);

      const reattached = await eventStream(url, token);
      await reattached.nextRaw(); // the initial closed snapshot
      const userMessage = await reattached.nextRaw();
      expect(userMessage).toMatchObject({
        kind: "user-message",
        text: "Hello",
        clientId: "c1",
      });
      const running = await reattached.nextRaw();
      expect(running).toMatchObject({ kind: "session-state", state: "running" });
      expect(userMessage.at as number).toBeLessThanOrEqual(running.at as number);
      await reattached.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("replays nothing for a reservation the driver hasn't accepted yet, but carries it in order once it has", async () => {
    // A reconnect landing in the exact window between the reservation and
    // the driver's accept would have no live fetch on THAT connection to
    // ever mark the send failed -- it must see nothing at all for it, not
    // an unconfirmed message rendered as if it were sent.
    const entered = deferred();
    const gate = deferred();
    const fake = fakeDriver(undefined, {
      onPromptEntered: () => entered.resolve(),
      promptGate: () => gate.promise,
    });
    const { url, token } = await start(fake);

    const sendPromise = post(url, "message", { text: "Hello", clientId: "c1" }, token);
    await entered.promise;

    const reattached = await eventStream(url, token);
    expect((await reattached.nextRaw()).snapshot).toBe(true);
    const raced = await raceTimeout(reattached.nextRaw(), 200);
    expect(raced).toBe("timeout");
    await reattached.close();

    gate.resolve();
    expect((await sendPromise).status).toBe(202);

    // Once accepted, a fresh connection carries it in order, same as
    // round-6's own ordering guarantee.
    const after = await eventStream(url, token);
    await after.next(); // snapshot
    expect(await after.next()).toEqual({ kind: "user-message", text: "Hello", clientId: "c1" });
    await after.close();
  });

  it("marks replayed frames, and only replayed frames, as replay", async () => {
    // The page renders a replayed failure quietly (role="status") instead
    // of re-alerting a screen reader to history it already heard -- this
    // marker is how it tells the difference.
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "Hello", clientId: "c1" }, token);

    const reattached = await eventStream(url, token);
    expect((await reattached.nextRaw()).snapshot).toBe(true);
    const replayed = await reattached.nextRaw();
    expect(replayed.kind).toBe("user-message");
    expect(replayed.replay).toBe(true);

    fake.startInputs[0]?.onEvent({ kind: "error", message: "boom", fatal: false });
    const live = await reattached.nextRaw();
    expect(live.kind).toBe("error");
    expect(live.replay).toBeUndefined();
    await reattached.close();
  });

  it("marks the cut when one turn overflows the whole log, so a replay says history is missing", async () => {
    // No user-message boundary exists ahead of the cut here, so the bare
    // cap applies -- and the replay must open by saying earlier messages
    // are gone rather than silently starting mid-turn.
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "Question" }, token);
    for (let index = 0; index < 550; index += 1) {
      fake.startInputs[0]?.onEvent({
        kind: "item",
        phase: "completed",
        item: { id: `t-${index}`, type: "command", title: "Run", status: "completed" },
      });
    }

    const reattached = await eventStream(url, token);
    await reattached.next(); // the initial state snapshot
    expect(await reattached.next()).toEqual({ kind: "history-trimmed" });
    // What follows the notice is a whole card, never a fragment of one.
    expect((await reattached.next()).kind).toBe("item");
    await reattached.close();
  });

  it("carries a long streamed reply whole through a reload, never starting mid-delta", async () => {
    // A single streamed reply can easily outnumber the log cap in deltas.
    // The log coalesces them into one entry per item, so overflowing the
    // log with a long streamed turn can never leave a replay that starts
    // mid-sentence.
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "Question", clientId: "c1" }, token);

    let full = "";
    for (let index = 0; index < 600; index += 1) {
      const text = "word" + index + " ";
      full += text;
      fake.startInputs[0]?.onEvent({ kind: "text-delta", itemId: "i1", stream: "assistant", text });
    }
    fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "completed" });

    const reattached = await eventStream(url, token);
    await reattached.next(); // the initial state snapshot
    expect(await reattached.next()).toEqual({
      kind: "user-message",
      text: "Question",
      clientId: "c1",
    });
    expect(await reattached.next()).toEqual({
      kind: "text-delta",
      itemId: "i1",
      stream: "assistant",
      text: full,
    });
    expect(await reattached.next()).toEqual({
      kind: "turn-completed",
      turnId: "turn-1",
      status: "completed",
    });
    await reattached.close();
  });

  it("evicts whole turns on overflow, so a replay starts at a turn boundary", async () => {
    // Eviction used to drop oldest events one by one, which could keep a
    // turn's reply while dropping the question that caused it. The cut now
    // extends to the next user-message: what remains replays from a turn's
    // own start.
    const fake = fakeDriver();
    const { url, token } = await start(fake);

    for (const [turn, text] of [
      [1, "one"],
      [2, "two"],
    ] as const) {
      await post(url, "message", { text }, token);
      for (let index = 0; index < 300; index += 1) {
        fake.startInputs[0]?.onEvent({
          kind: "item",
          phase: "completed",
          item: { id: `t${turn}-${index}`, type: "command", title: "Run", status: "completed" },
        });
      }
      fake.startInputs[0]?.onEvent({
        kind: "turn-completed",
        turnId: `turn-${turn}`,
        status: "completed",
      });
    }

    // 604 entries were published; the overflow cut extended through the
    // whole first turn, so the replay opens with the second turn's own
    // user-message -- never an orphaned mid-turn event.
    const reattached = await eventStream(url, token);
    await reattached.next(); // the initial state snapshot
    expect(await reattached.next()).toMatchObject({ kind: "user-message", text: "two" });
    await reattached.close();
  });

  it("a Stop before the turn is accepted cancels it the moment it is accepted", async () => {
    // In the window between /message reaching the driver and the driver
    // accepting the prompt, no turn id exists yet -- Stop's cancel() is a
    // documented no-op there, so without the recorded intent the turn
    // would run on after a successful-looking Stop.
    const entered = deferred();
    const gate = deferred();
    const fake = fakeDriver(undefined, {
      onPromptEntered: () => entered.resolve(),
      promptGate: () => gate.promise,
    });
    const { url, token } = await start(fake);

    const sendPromise = post(url, "message", { text: "Hello" }, token);
    await entered.promise;
    // Stop lands while the prompt is still awaiting acceptance: the
    // driver-level cancel it issues now has no turn to reach.
    expect(await post(url, "stop", undefined, token)).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.cancelCalls).toBe(1);

    gate.resolve();
    expect((await sendPromise).status).toBe(202);
    // The acceptance honored the recorded stop: a second cancel reached
    // the driver now that the turn exists to interrupt.
    expect(fake.sessions[0]?.cancelCalls).toBe(2);
    // Still the same live session -- a pre-acceptance Stop interrupts the
    // turn, it never retires the session.
    expect(fake.disposed).toEqual([]);
  });

  it("refuses a second message while a prompt is still awaiting acceptance", async () => {
    // The pre-acceptance window holds the single active turn just as much
    // as an accepted one: admitting a second prompt there would overlap
    // the drivers' one tracked turn and steal a recorded stop's target.
    const entered = deferred();
    const gate = deferred();
    const fake = fakeDriver(undefined, {
      onPromptEntered: () => entered.resolve(),
      promptGate: () => gate.promise,
    });
    const { url, token } = await start(fake);

    const sendPromise = post(url, "message", { text: "First" }, token);
    await entered.promise;
    expect(await post(url, "message", { text: "Second" }, token)).toMatchObject({ status: 409 });

    gate.resolve();
    expect((await sendPromise).status).toBe(202);
    expect(fake.sessions[0]?.promptCalls).toEqual(["First"]);
  });

  it("claims the prompt slot before waiting for a live session", async () => {
    const startEntered = deferred();
    const startGate = deferred();
    const fake = fakeDriver(undefined, {
      onStartSessionEntered: () => startEntered.resolve(),
      startGate: () => startGate.promise,
    });
    const { url, token } = await start(fake);

    const accepted = post(url, "message", { text: "First" }, token);
    await startEntered.promise;
    const refusedResponse = await post(url, "message", { text: "Second" }, token);
    expect(refusedResponse.status).toBe(409);

    startGate.resolve();
    const acceptedResponse = await accepted;
    expect(acceptedResponse.status).toBe(202);
    expect(fake.sessions[0]?.promptCalls).toEqual(["First"]);

    expect(await post(url, "stop", undefined, token)).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.cancelCalls).toBe(1);
  });

  it("continues an oversized streamed reply in a fresh log entry, keeping replay content exact", async () => {
    // Coalescing must not turn the entry cap into no memory guard at all:
    // one entry stops growing at its own bound and the item continues in a
    // new entry, whole deltas only, so a replay's concatenation never
    // changes.
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "Question", clientId: "c1" }, token);

    const chunk = "y".repeat(1024);
    for (let index = 0; index < 300; index += 1) {
      fake.startInputs[0]?.onEvent({
        kind: "text-delta",
        itemId: "i1",
        stream: "assistant",
        text: chunk,
      });
    }
    fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "completed" });

    const reattached = await eventStream(url, token);
    await reattached.next(); // the initial state snapshot
    await reattached.next(); // the user's own message
    let text = "";
    let frames = 0;
    for (;;) {
      const event = await reattached.next();
      if (event.kind === "turn-completed") break;
      expect(event.kind).toBe("text-delta");
      if (event.kind === "text-delta") {
        text += event.text;
        frames += 1;
      }
    }
    expect(frames).toBeGreaterThan(1);
    expect(text).toBe(chunk.repeat(300));
    await reattached.close();
  });

  it("a Stop with no prompt in flight never dooms the next message's turn", async () => {
    // The stop intent is scoped to the one prompt that was in flight when
    // Stop arrived -- an idle Stop must not linger and cancel a turn the
    // user asks for afterward.
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "First" }, token);
    fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "completed" });

    expect(await post(url, "stop", undefined, token)).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.cancelCalls).toBe(1);

    expect(await post(url, "message", { text: "Second" }, token)).toMatchObject({ status: 202 });
    // Accepted cleanly: no cancel fired at this acceptance.
    expect(fake.sessions[0]?.cancelCalls).toBe(1);
  });

  it("Stop cancels the current turn -- the session and its context stay alive, never a fresh one", async () => {
    // Per the product invariant (a reversible action needs a reverse path,
    // or the user has to be told before it runs): ending the whole session
    // on Stop made the next message silently start context-free, with no
    // warning. Stop now interrupts the turn and nothing else.
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "First session" }, token);

    expect(await post(url, "stop", undefined, token)).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.cancelCalls).toBe(1);
    // Never disposed -- the session and its context are still there.
    expect(fake.disposed).toEqual([]);

    // Still refused: the driver hasn't reported the turn as actually
    // settled yet (no turn-completed arrived), same as any other message
    // racing an active turn.
    expect(await post(url, "message", { text: "Too soon" }, token)).toMatchObject({
      status: 409,
    });

    fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "cancelled" });

    expect(await post(url, "message", { text: "Second turn" }, token)).toMatchObject({
      status: 202,
    });
    // The SAME session, not a fresh one: no second startSession call.
    expect(fake.startInputs).toHaveLength(1);
    expect(fake.sessions[0]?.promptCalls).toEqual(["First session", "Second turn"]);
  });

  it("Stop is a safe no-op when nothing is running -- cancel() still reaches the driver", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    await post(url, "message", { text: "First" }, token);
    fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "completed" });

    // No turn active -- both concrete drivers document cancel() as a safe
    // no-op here, so this still calls it (simplest, and harmless) rather
    // than special-casing idle client-side.
    expect(await post(url, "stop", undefined, token)).toMatchObject({ status: 204 });
    expect(fake.sessions[0]?.cancelCalls).toBe(1);
    expect(fake.disposed).toEqual([]);

    // Immediately usable: no turn was active, so nothing gates the next
    // message.
    expect(await post(url, "message", { text: "Still here" }, token)).toMatchObject({
      status: 202,
    });
    expect(fake.startInputs).toHaveLength(1);
  });

  it("a cancel that rejects doesn't end the session either", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next(); // initial closed snapshot
    await post(url, "message", { text: "First", clientId: "c1" }, token);
    await stream.next(); // the user-message echo
    const session = fake.sessions[0];
    if (!session) throw new Error("The fake driver did not start a session.");
    session.cancelError = new Error("Claude Code refused to interrupt.");

    // Reported honestly rather than faked as a success, but never at the
    // cost of the session: no session-state event, no dispose.
    const stopResponse = await post(url, "stop", undefined, token);
    expect(stopResponse.status).toBe(500);
    expect(session.cancelCalls).toBe(1);
    expect(fake.disposed).toEqual([]);

    fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "cancelled" });
    expect(await stream.next()).toEqual({
      kind: "turn-completed",
      turnId: "turn-1",
      status: "cancelled",
    });

    // The SAME session, not a fresh one.
    const nextResponse = await post(url, "message", { text: "Second" }, token);
    expect(nextResponse.status).toBe(202);
    expect(fake.startInputs).toHaveLength(1);
    await stream.close();
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

  it("carries a permission request's affected locations through to the client", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next();
    await post(url, "message", { text: "Needs permission", clientId: "c1" }, token);
    await stream.next();
    const request: PluginAgentEvent = {
      kind: "permission-request",
      requestId: "request/1",
      requestType: "file-change",
      title: "Edit files",
      locations: ["src/foo.ts", "src/bar.ts"],
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    };
    fake.startInputs[0]?.onEvent(request);
    const received = await stream.next();
    expect(received).toEqual(request);
    expect((received as { locations?: string[] }).locations).toEqual(["src/foo.ts", "src/bar.ts"]);
    await stream.close();
  });

  it("settles a pending permission when the session dies, so a late answer 404s instead of reaching a dead session", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next(); // initial closed snapshot
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

    // The session dies with the permission still pending.
    fake.startInputs[0]?.onEvent({ kind: "error", message: "Claude Code crashed.", fatal: true });
    expect(await stream.next()).toEqual({
      kind: "error",
      message: "Claude Code crashed.",
      fatal: true,
    });
    // Without the fix, this never arrives: the card stays "pending" forever
    // with nothing to settle it, and a reconnect's replay recreates the
    // same unusable card from the buffered permission-request event alone.
    expect(await stream.next()).toEqual({
      kind: "permission-resolved",
      requestId: "request/1",
      decision: "cancel",
    });

    // A late answer to the now-settled request 404s -- it is no longer
    // pending, rather than reaching a session that no longer exists.
    const lateAnswer = await post(
      url,
      `permission/${encodeURIComponent("request/1")}`,
      { decision: "allow_once" },
      token,
    );
    expect(lateAnswer.status).toBe(404);

    // A reconnect's replay carries both the request and its resolution, in
    // that order -- never just the request on its own. (Snapshot, then the
    // buffered user-message, permission-request, error, and
    // permission-resolved events, in publish order.)
    const reattached = await eventStream(url, token);
    const replayed: unknown[] = [];
    for (let index = 0; index < 5; index += 1) replayed.push(await reattached.next());
    expect(replayed).toContainEqual({
      kind: "permission-resolved",
      requestId: "request/1",
      decision: "cancel",
    });
    await stream.close();
    await reattached.close();
  });

  it("answers a permission request exactly once even when two POSTs race for it", async () => {
    // Forces the race deterministically instead of hoping two real HTTP
    // requests happen to interleave at the right instant: the first POST
    // is held inside the driver's own answerPermission() call, and only
    // then does the test fire the second.
    const entered = deferred();
    const gate = deferred();
    const fake = fakeDriver(undefined, {
      onAnswerPermissionEntered: () => entered.resolve(),
      answerPermissionGate: () => gate.promise,
    });
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next(); // initial closed snapshot
    await post(url, "message", { text: "Needs permission", clientId: "c1" }, token);
    await stream.next(); // the user-message echo
    fake.startInputs[0]?.onEvent({
      kind: "permission-request",
      requestId: "request/1",
      requestType: "command",
      title: "Run tests",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    });
    await stream.next(); // the permission-request itself

    const first = post(
      url,
      `permission/${encodeURIComponent("request/1")}`,
      { decision: "allow_once" },
      token,
    );
    await entered.promise;
    // The first POST is now gated deep inside the driver call, having
    // already claimed the requestId (with the fix) or not yet (without
    // it) -- the second must see whichever is true right now, not
    // whatever becomes true once the first eventually finishes.
    const second = await post(
      url,
      `permission/${encodeURIComponent("request/1")}`,
      { decision: "reject_once" },
      token,
    );
    gate.resolve();
    const firstResponse = await first;

    expect(firstResponse.status).toBe(204);
    expect(second.status).toBe(404);
    expect(fake.sessions[0]?.permissionCalls).toEqual([
      { requestId: "request/1", decision: "allow_once" },
    ]);
    await stream.close();
  });

  it("settles a permission claimed just before Stop, instead of resurrecting it as an unkillable zombie", async () => {
    const entered = deferred();
    const gate = deferred();
    const fake = fakeDriver(undefined, {
      onAnswerPermissionEntered: () => entered.resolve(),
      answerPermissionGate: () => gate.promise,
    });
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next(); // initial closed snapshot
    await post(url, "message", { text: "Needs permission", clientId: "c1" }, token);
    await stream.next(); // the user-message echo
    fake.startInputs[0]?.onEvent({
      kind: "permission-request",
      requestId: "request/1",
      requestType: "command",
      title: "Run tests",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    });
    await stream.next(); // the permission-request itself

    const answerPromise = post(
      url,
      `permission/${encodeURIComponent("request/1")}`,
      { decision: "allow_once" },
      token,
    );
    await entered.promise; // claimed, gated deep inside the driver call

    // The claim already removed the id from pendingPermissions before Stop
    // (now a cancel, not a teardown) got a chance to see it there -- the
    // exact interleaving the bug depended on. The session itself stays
    // alive throughout: Stop cancels the turn, not the session.
    const fakeSession = fake.sessions[0];
    if (!fakeSession) throw new Error("No session started.");
    fakeSession.answerPermissionError = new Error("The driver refused to answer.");

    const stopResponse = await post(url, "stop", undefined, token);
    expect(stopResponse.status).toBe(204);
    expect(fake.disposed).toEqual([]);

    gate.resolve();
    const answerResponse = await answerPromise;
    expect(answerResponse.status).toBe(500);

    // Stop's own settlePendingPermissions published the cancellation
    // before the driver call even started rejecting -- there is nothing
    // else for the session to publish, since it never ends here.
    expect(await stream.next()).toEqual({
      kind: "permission-resolved",
      requestId: "request/1",
      decision: "cancel",
    });

    // A retry 404s because the request is already resolved -- never
    // because the claim wrongly resurrected the id as pending for a
    // request that was never actually re-opened.
    const retry = await post(
      url,
      `permission/${encodeURIComponent("request/1")}`,
      { decision: "reject_once" },
      token,
    );
    expect(retry.status).toBe(404);

    // A second /stop still runs settlePendingPermissions unconditionally --
    // if the catch above had ignored the claimedPermissions check and
    // re-added the id anyway, this would publish a second, bogus
    // cancellation for a request that was already fully settled.
    const secondStop = await post(url, "stop", undefined, token);
    expect(secondStop.status).toBe(204);
    const racedSecondCancel = await raceTimeout(stream.next(), 200);
    expect(racedSecondCancel).toBe("timeout");

    // A reconnect's replay carries the cancellation, not a bare unanswered
    // request that would recreate a clickable, dead-end card. Four frames
    // total: the snapshot, then the user-message, permission-request, and
    // permission-resolved replay entries -- Stop no longer adds a fifth
    // (a session-state closed) now that the session survives it.
    const reattached = await eventStream(url, token);
    const replayed: unknown[] = [];
    for (let index = 0; index < 4; index += 1) replayed.push(await reattached.next());
    expect(replayed).toContainEqual({
      kind: "permission-resolved",
      requestId: "request/1",
      decision: "cancel",
    });
    await stream.close();
    await reattached.close();
  });

  it("serves its own static chat page, stylesheet, and script -- the page itself is token-free", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);

    const page = await fetch(new URL("/", url));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("<title>Claude Code Chat</title>");
    // The token lives only in the fragment startWebApp returned -- anything
    // "/" itself serves must never carry it, or any local process that
    // merely fetches this route (or a rebound page reading its own
    // same-origin response) would learn it too.
    expect(html).not.toContain(token);
    expect(html).not.toContain("chat-token");
    // The transcript itself is not a live region: a streamed reply fires
    // one text-delta per fragment, and announcing every one would drown
    // out a permission request or failure. A separate, visually hidden
    // region carries only settled announcements.
    expect(html).not.toMatch(/id="transcript"[^>]*aria-live/);
    expect(html).toMatch(/id="status"[^>]*aria-live="polite"/);

    const css = await fetch(new URL("chat.css", url));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const script = await fetch(new URL("chat.js", url));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
  });

  it("hands the token only in the URL fragment startWebApp returns", async () => {
    const fake = fakeDriver();
    const { url, token } = await start(fake);
    expect(url).toContain("#token=" + token);

    // Reattaching (already-running server) hands back the same URL, token
    // included -- the guest can navigate back to it and still authenticate.
    const app = runningApps.at(-1);
    if (!app) throw new Error("No running app to reattach to.");
    const again = await app.startWebApp("chat", null);
    expect(again.url).toBe(url);
  });

  it("refuses a request whose Host header isn't this loopback server -- a DNS-rebound page can't just ask", async () => {
    const fake = fakeDriver();
    const { url } = await start(fake);
    const target = new URL(url);

    const rebound = await fetchWithHost(url, "attacker.example");
    expect(rebound.status).toBe(403);

    // The legitimate Host (what every other test's real fetch() sends)
    // still works -- this isn't rejecting the server's own requests.
    const legitimate = await fetchWithHost(url, target.host);
    expect(legitimate.status).toBe(200);
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

  it("streams the friendly install guidance first when not installed, with the raw diagnostic riding along as detail", async () => {
    // The probe's own diagnostic (a raw "spawn claude ENOENT" from the real
    // driver) always exists for a not-installed probe, so it used to win
    // over the friendly guidance every time -- the reader never saw the
    // one actionable instruction, only a message meant for a bug report.
    const fake = fakeDriver(() => ({
      installed: false,
      auth: { status: "unknown" },
      models: [],
      errorMessage: "spawn claude ENOENT",
    }));
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    await stream.next();

    expect(await post(url, "message", { text: "Hello", clientId: "c1" }, token)).toMatchObject({
      status: 503,
    });
    expect(fake.startInputs).toHaveLength(0);
    // No user-message echo: the probe failed before the driver ever
    // accepted the prompt, so the message was never really sent.
    expect(await stream.next()).toEqual({
      kind: "error",
      message:
        "Claude Code isn't installed. Install the Claude Code CLI and add it to your PATH. (spawn claude ENOENT)",
      fatal: true,
    });
    await stream.close();
  });

  it("publishes a terminal error when driver.startSession itself rejects", async () => {
    // Unlike the probe failure above, the probe succeeds here -- the
    // rejection comes from driver.startSession itself (a spawn or
    // handshake failure), after the driver has already published
    // "starting". Without a terminal event for this specific path, the
    // pill sits on Starting forever with Stop still enabled and no session
    // behind it.
    const fake = fakeDriver(undefined, {
      startSessionError: new Error("Claude Code failed to spawn."),
    });
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    expect(await stream.next()).toEqual({ kind: "session-state", state: "closed" });

    const response = await post(url, "message", { text: "Hello" }, token);
    expect(response.status).toBe(503);
    expect(await stream.next()).toEqual({
      kind: "error",
      message: "Claude Code failed to spawn.",
      fatal: true,
    });
    await stream.close();

    // The internal snapshot settled too: a reconnect sees the real state
    // immediately, not a stale "closed" with no explanation.
    const reattached = await eventStream(url, token);
    expect(await reattached.next()).toEqual({
      kind: "session-state",
      state: "error",
      reason: "Claude Code failed to spawn.",
    });
    await reattached.close();
  });

  it("renders exactly one boundary card for a startup failure, not the driver's own closed plus our fatal error", async () => {
    // Both concrete drivers report their own cleanup with a bare "closed"
    // (no reason) through onEvent right before a spawn or handshake
    // failure rejects driver.startSession -- without deduping, a
    // reconnect's replay would carry both that and the more informative
    // fatal error this catch publishes, rendering two boundary cards for
    // one failure.
    const fake = fakeDriver(undefined, {
      startSessionError: new Error("Claude Code failed to spawn."),
    });
    const { url, token } = await start(fake);

    const response = await post(url, "message", { text: "Hello" }, token);
    expect(response.status).toBe(503);

    const reattached = await eventStream(url, token);
    await reattached.next(); // the internal snapshot, already settled to error
    const replayed: unknown[] = [];
    for (;;) {
      const raced = await raceTimeout(reattached.next(), 200);
      if (raced === "timeout") break;
      replayed.push(raced);
    }
    expect(replayed).toEqual([
      { kind: "error", message: "Claude Code failed to spawn.", fatal: true },
    ]);
    await reattached.close();
  });

  it("does not log an accepted-message echo for a message the driver goes on to reject", async () => {
    // The probe and session start both succeed; only prompt() rejects --
    // this is the specific gap CR-I5 named: the earlier code published
    // user-message before this point, so a prompt failure left an
    // accepted-looking echo in the log for a message that never sent.
    const fake = fakeDriver(undefined, { promptError: new Error("Claude Code refused the turn.") });
    const { url, token } = await start(fake);
    const stream = await eventStream(url, token);
    expect(await stream.next()).toEqual({ kind: "session-state", state: "closed" });

    const response = await post(url, "message", { text: "Hello", clientId: "c1" }, token);
    expect(response.status).toBe(500);

    // Only the fatal error reaches the log -- no user-message frame ever
    // arrives, before it or after it, for the rejected send.
    expect(await stream.next()).toEqual({
      kind: "error",
      message: "Claude Code refused the turn.",
      fatal: true,
    });
    await stream.close();
  });

  describe("control server authentication", () => {
    it("rejects a mutation with no token, and the session survives", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);
      await post(url, "message", { text: "Live one" }, token);
      expect(fake.sessions[0]?.cancelCalls).toBe(0);

      const unauthenticated = await rawPost(url, "stop", {
        headers: { "content-type": "application/json" },
      });
      expect(unauthenticated.status).toBe(401);
      // The session is untouched: no stop reached the driver.
      expect(fake.sessions[0]?.cancelCalls).toBe(0);

      const authenticated = await post(url, "stop", undefined, token);
      expect(authenticated.status).toBe(204);
      expect(fake.sessions[0]?.cancelCalls).toBe(1);
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

    it("a message sent right after Stop reuses the same session once the interrupted turn clears", async () => {
      // Superseded by cancel-based Stop: there is no teardown to race
      // anymore, since the session is never disposed here. What still
      // matters is that the turn-active gate is honest about the turn not
      // being over yet, and that the eventual clear reuses the same
      // session rather than starting a fresh one.
      const fake = fakeDriver();
      const { url, token } = await start(fake);
      await post(url, "message", { text: "First" }, token);
      expect(fake.startInputs).toHaveLength(1);

      const stopResponse = await post(url, "stop", undefined, token);
      expect(stopResponse.status).toBe(204);
      expect(fake.sessions[0]?.cancelCalls).toBe(1);

      const tooSoon = await post(url, "message", { text: "Too soon" }, token);
      expect(tooSoon.status).toBe(409);
      expect(fake.startInputs).toHaveLength(1);

      fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "cancelled" });

      const afterCancel = await post(url, "message", { text: "After cancel" }, token);
      expect(afterCancel.status).toBe(202);
      expect(fake.startInputs).toHaveLength(1);
      expect(fake.sessions[0]?.promptCalls).toEqual(["First", "After cancel"]);
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

    it("stop during a pending startup does not leave a later message reusing the doomed promise", async () => {
      const entered = deferred();
      const gate = deferred();
      const fake = fakeDriver(undefined, {
        onStartSessionEntered: () => entered.resolve(),
        startGate: () => gate.promise,
      });
      const { url, token } = await start(fake);
      const stream = await eventStream(url, token);
      expect(await stream.next()).toEqual({ kind: "session-state", state: "closed" });

      const firstMessage = post(url, "message", { text: "Hello" }, token);
      await entered.promise;

      const stopResponse = await post(url, "stop", undefined, token);
      expect(stopResponse.status).toBe(204);
      // Without the fix, this never arrives: the pill would sit on
      // Starting with no closed event to bring it back, since /stop
      // returned 204 without publishing anything for a session that was
      // still only pending.
      expect(await stream.next()).toEqual({
        kind: "session-state",
        state: "closed",
        reason: "Stopped",
      });

      // Sent before the doomed first attempt even settles. Without the
      // fix, liveSession() reuses the same still-pending sessionStart
      // promise instead of starting a fresh attempt, and this 503s along
      // with the first one.
      const secondMessage = post(url, "message", { text: "Fresh" }, token);
      gate.resolve();

      const [firstResponse, secondResponse] = await Promise.all([firstMessage, secondMessage]);
      expect(firstResponse.status).toBe(503);
      expect(secondResponse.status).toBe(202);
      expect(fake.startInputs).toHaveLength(2);
      expect(fake.disposed).toEqual(["session-1"]);
      await stream.close();
    });
  });

  describe("stopWebApp retires the pairing", () => {
    it("tears down for real, so the next start is completely fresh", async () => {
      const fake = fakeDriver();
      const { app, url, token } = await start(fake);
      await post(url, "message", { text: "First" }, token);
      expect(fake.startInputs).toHaveLength(1);

      // The host dispatches this on failed-guest-load recovery, not on an
      // ordinary tab close -- see the comment on stopWebApp itself.
      await app.stopWebApp("chat", null);

      // The old server is really gone: nothing to reattach to.
      await expect(fetch(new URL("/", url))).rejects.toThrow();

      const restarted = await app.startWebApp("chat", null);
      expect(restarted.url).not.toBe(url);
      const freshToken = tokenFromUrl(restarted.url);
      expect(freshToken).not.toBe(token);

      // A fresh session, not the old one reused or reattached.
      const response = await post(restarted.url, "message", { text: "Second" }, freshToken);
      expect(response.status).toBe(202);
      expect(fake.startInputs).toHaveLength(2);
    });
  });

  describe("overlapping turns", () => {
    it("refuses a second message while a turn is active, and never overwrites the single active turn", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);

      const first = await post(url, "message", { text: "First" }, token);
      expect(first.status).toBe(202);
      expect(fake.sessions[0]?.promptCalls).toEqual(["First"]);

      // No turn-completed yet: the turn is still active.
      const second = await post(url, "message", { text: "Second" }, token);
      expect(second.status).toBe(409);
      // The driver never saw the second prompt at all -- one active turn,
      // never overwritten.
      expect(fake.sessions[0]?.promptCalls).toEqual(["First"]);
      expect(fake.startInputs).toHaveLength(1);

      fake.startInputs[0]?.onEvent({ kind: "turn-completed", turnId: "turn-1", status: "completed" });

      const third = await post(url, "message", { text: "Third" }, token);
      expect(third.status).toBe(202);
      expect(fake.sessions[0]?.promptCalls).toEqual(["First", "Third"]);
    });

    it("a fatal error also releases the active-turn gate", async () => {
      const fake = fakeDriver();
      const { url, token } = await start(fake);
      await post(url, "message", { text: "First" }, token);

      fake.startInputs[0]?.onEvent({ kind: "error", message: "Claude Code crashed.", fatal: true });

      const retry = await post(url, "message", { text: "Retry" }, token);
      expect(retry.status).toBe(202);
    });

    it("a mid-turn close with no turn-completed also releases the active-turn gate", async () => {
      // A harness that exits idle mid-turn reports the session ending, not
      // a fatal error and not turn-completed -- without releasing the gate
      // here too, every later message would 409 forever with no live
      // session left to blame it on.
      const fake = fakeDriver();
      const { url, token } = await start(fake);
      await post(url, "message", { text: "First" }, token);

      fake.startInputs[0]?.onEvent({ kind: "session-state", state: "closed" });

      const retry = await post(url, "message", { text: "Retry" }, token);
      expect(retry.status).toBe(202);
    });
  });

  it("a deactivate racing the server's own listen settles instead of hanging, and the next start is clean", async () => {
    // The beforeListen test hook forces the exact race deterministically,
    // rather than hoping a real timing window gets hit: deactivate the app
    // before its server is ever told to listen, so listen()'s "close" guard
    // is the only thing that can settle this startWebApp call.
    const fake = fakeDriver();
    const ref: { app?: ChatWebApp } = {};
    let triggered = false;
    const app = createChatWebApp(fake.driver, "C:\\workspace", PLUGIN_UI_ROOT, {
      beforeListen: async () => {
        if (triggered) return;
        triggered = true;
        await ref.app?.deactivate();
      },
    });
    ref.app = app;
    runningApps.push(app);

    const started = await app.startWebApp("chat", null).then(
      (result) => ({ ok: true as const, url: result.url }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    if (started.ok) {
      // A raced start that still resolves must hand back a URL that
      // actually answers -- not a stale one for a server already closed
      // underneath it.
      const response = await fetch(new URL("/", started.url)).catch(() => null);
      expect(response?.status).toBe(200);
    }

    // Either way, a fresh start afterward must produce a real, working
    // server: the race must not leave the app permanently wedged.
    const restarted = await app.startWebApp("chat", null);
    const page = await fetch(new URL("/", restarted.url));
    expect(page.status).toBe(200);
  }, 10_000);
});

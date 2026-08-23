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
// was measured before choosing 500. ui/chat.js resets its transcript on
// every EventSource open and rebuilds it purely from what this log
// currently holds, so what the log evicts decides what a reload can still
// replay coherently: streamed text coalesces into one entry per item (see
// publish), and eviction drops whole turns (see trimLog), so a replay
// starts at a turn boundary instead of mid-sentence.
const MAX_BUFFERED_EVENTS = 500;
// Bounds what one coalesced entry can retain, so the entry cap above stays
// a real memory guard. Replays keep the newest text and receive a notice
// when an item's earlier text no longer fits.
const MAX_COALESCED_TEXT_CHARS = 256 * 1024;

type SessionStateEvent = Extract<PluginAgentEvent, { kind: "session-state" }>;

/** A submitted prompt, recorded so a reconnect replays both sides of the
 * conversation. clientId lets the submitting page's own optimistic card
 * recognize its own echo instead of rendering a duplicate. Published only
 * once the driver has accepted the prompt -- a rejected message never
 * appears here, so the log never claims a failed send was accepted. */
interface UserMessageEvent {
  kind: "user-message";
  text: string;
  clientId: string;
}

/** Log-only marker left where buffered history is incomplete: the page
 * renders it as a notice that earlier messages are missing. Never broadcast
 * live -- it only exists in the replayed log. */
interface HistoryTrimmedEvent {
  kind: "history-trimmed";
}

/** A fatal error whose only real recovery is restarting dohc itself --
 * sending another message can never fix it, since nothing changes until
 * the launcher this session needs becomes available again. Distinguished
 * from an ordinary fatal error so the client can show the one action that
 * actually works, instead of the generic (and here, false) "send a
 * message to start a new session". */
interface LauncherUnavailableErrorEvent {
  kind: "error";
  message: string;
  fatal: true;
  restartOnly: true;
}

interface ControlsChangedEvent {
  kind: "controls";
}

type ChatStreamEvent =
  | PluginAgentEvent
  | UserMessageEvent
  | HistoryTrimmedEvent
  | LauncherUnavailableErrorEvent
  | ControlsChangedEvent;

interface EventLogEntry {
  event: ChatStreamEvent;
  at: number;
  seq?: number;
  provisional?: boolean;
  truncated?: boolean;
}

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
  if (process.env.DOHC_MCP_COMMAND_UNAVAILABLE === "1") {
    throw Object.assign(
      new Error("dohc could not prepare its MCP launcher. Restart dohc to try again."),
      { restartOnly: true as const },
    );
  }
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

/** Anti-DNS-rebinding belt, alongside the token: a browser sets the Host
 * header from the URL bar's hostname, not the address it actually resolved
 * to, so an attacker-owned hostname that some DNS answer points at
 * 127.0.0.1 would still reach this server carrying its own hostname in
 * Host. Only a request that names our loopback address gets past this. */
function isLoopbackHost(header: string | string[] | undefined): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return false;
  return raw.split(":")[0].toLowerCase() === "127.0.0.1";
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

/** Test-only extension point: nothing in main.ts's production wiring passes
 * this. It exists so a test can force a deterministic race against startup
 * instead of hoping to land in a narrow, real timing window. */
export interface ChatWebAppTestHooks {
  /** Runs just before the server's own listen() call, and is awaited before
   * that call happens. */
  beforeListen?: (server: Server) => Promise<void> | void;
}

async function listen(
  server: Server,
  beforeListen?: (server: Server) => Promise<void> | void,
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      run();
    };
    server.once("error", (error) => settle(() => reject(error)));
    // A close before the server ever started listening (deactivate or
    // stopWebApp racing this same startup) fires no "error" and no listen
    // callback -- only "close". Without this, that race left this promise,
    // and everything awaiting startServer() through it, pending forever.
    server.once("close", () =>
      settle(() => reject(new Error("The chat server closed before it started listening."))),
    );
    Promise.resolve(beforeListen?.(server)).then(() => {
      // The close handler above may already have settled this promise
      // while beforeListen was pending (exactly the race a test forces).
      // Calling listen() now would reopen a socket nothing tracks anymore
      // -- shutdown() already forgot this server object.
      if (settled) return;
      server.listen(0, "127.0.0.1", resolve);
    }, (error) => settle(() => reject(error)));
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
  testHooks?: ChatWebAppTestHooks,
): ChatWebApp {
  let server: Server | null = null;
  let serverUrl: string | null = null;
  let serverStart: Promise<string> | null = null;
  let token: string | null = null;
  let sessionStart: Promise<PluginAgentSession> | null = null;
  let sessionGeneration = 0;
  let processSession: PluginAgentSession | null = null;
  let turnSequence = 0;
  // This server's own monotonic turn identity -- assigned once per accepted
  // prompt, independent of whatever opaque turnId the underlying driver
  // generates internally (that one is not guaranteed comparable across
  // drivers). Included in every published control fact so each fact names
  // the turn it describes. The separate seq orders those facts for the
  // client.
  let currentTurnId: number | undefined;
  let seqCounter = 0;

  function nextSeq(): number {
    seqCounter += 1;
    return seqCounter;
  }
  // True from the moment a prompt is accepted until its turn settles
  // (turn-completed, or a fatal error). /message refuses a second prompt
  // while this is true instead of overlapping it on the single active turn
  // both concrete drivers track.
  let turnActive = false;
  // Set while a /message's prompt() call is still awaiting the driver's
  // accept. A Stop landing in that window has no turn to interrupt yet --
  // the driver holds no turn id until prompt() resolves, so its cancel()
  // is a no-op and the turn would run on after a successful-looking Stop.
  // Instead the stop is recorded here and honored the moment the prompt
  // is accepted.
  let pendingPrompt: { stopRequested: boolean } | null = null;
  let state: SessionStateEvent = { kind: "session-state", state: "closed" };

  /** The one fact the client ever needs: is a send valid right now, is a
   * stop valid right now, and what turn (if any) is that answer about. Pure
   * -- computed fresh from existing state every time it's read, never
   * cached or stored on anything. `canSend` mirrors message()'s own 409
   * gate exactly. `canStop` includes a claimed prompt before the session
   * opens; after that, Stop stays available while the session is alive. */
  function computeControls(): {
    canSend: boolean;
    canStop: boolean;
    turnId: number | null;
  } {
    return {
      canSend: !turnActive && !pendingPrompt,
      canStop: pendingPrompt !== null || (state.state !== "closed" && state.state !== "error"),
      turnId: currentTurnId ?? null,
    };
  }

  // The last controls fact actually broadcast to connected clients (never a
  // per-connection snapshot or a per-requester response body -- see frame()
  // below, the only place that updates this). Compared against on every
  // pendingPrompt/turnActive/currentTurnId mutation outside a broadcast
  // of its own: if the derived fact differs, broadcast one, so a connected
  // page always learns the change even when the response body that would
  // also have carried it is lost, delayed, or never read.
  let lastPublishedControls = computeControls();

  function controlsEqual(
    a: { canSend: boolean; canStop: boolean; turnId: number | null },
    b: { canSend: boolean; canStop: boolean; turnId: number | null },
  ): boolean {
    return a.canSend === b.canSend && a.canStop === b.canStop && a.turnId === b.turnId;
  }

  /** Call after any pendingPrompt/turnActive/currentTurnId assignment not
   * immediately followed (synchronously) by its own broadcast/frame() call
   * for some other event -- those already recompute controls fresh and
   * announce the change as a side effect; calling this there too would only
   * be redundant, not wrong, so it is reserved for sites that otherwise
   * have no announcement: message()'s reservation, turn-id assignment and
   * finally-block release, plus shutdown()'s release before it awaits
   * disposal. A no-op
   * `{ kind: "controls" }` event carries nothing but the fact itself --
   * ChatStreamEvent's existing local union gains this one new shape. */
  function syncControls(): void {
    const next = computeControls();
    if (controlsEqual(next, lastPublishedControls)) return;
    broadcastLive({ kind: "controls" }, Date.now(), nextSeq());
  }

  function attachControls(error: unknown): unknown {
    if (error && typeof error === "object") {
      return Object.assign(error, { controls: computeControls(), seq: nextSeq() });
    }
    return error;
  }
  // Each entry's own publish time -- a replay renders it, not the moment
  // the reconnecting client happened to receive it, so history stays in
  // its real chronological order instead of collapsing to "now".
  //
  // provisional marks a /message reservation still awaiting the driver's
  // accept/reject (see message() below): filtered out of every replay so a
  // reconnect that lands in that exact window can never render an
  // unconfirmed send as if it were accepted, with no live fetch left on
  // that connection to ever mark it failed if the driver goes on to reject
  // it. Live clients still see it normally, once it's actually confirmed.
  const eventLog: EventLogEntry[] = [];
  // The log entry currently accumulating each item's streamed text, keyed
  // by "stream:itemId". Live clients still get every delta as its own
  // frame; only the log coalesces, so a single long streamed reply is one
  // bounded entry the log keeps or evicts whole. Cleared when its turn
  // settles, and pruned when eviction drops the entry it points at.
  const openDeltas = new Map<string, EventLogEntry>();
  const clients = new Set<ServerResponse>();
  const pendingPermissions = new Set<string>();
  // A request permission() has claimed (removed from pendingPermissions, so
  // a second concurrent POST can't also answer it) but hasn't finished
  // answering yet. Tracked separately so settlePendingPermissions can still
  // resolve it if the session ends while it's in flight -- otherwise no
  // permission-resolved event ever lands for it, and a reconnect's replay
  // recreates its request-card as if it were still pending, with no live
  // session left behind it.
  const claimedPermissions = new Set<string>();

  /** replay marks a frame rebuilt from the buffered log for a new
   * connection, as opposed to one happening now: the page renders replayed
   * failures quietly (role="status") instead of re-alerting a screen
   * reader to history it already heard. */
  function frame(
    event: ChatStreamEvent,
    at: number,
    seq: number | undefined,
    replay?: boolean,
  ): string {
    const controls = computeControls();
    lastPublishedControls = controls;
    return (
      "data: " +
      JSON.stringify({
        ...event,
        at,
        seq,
        controls,
        ...(replay ? { replay: true } : {}),
      }) +
      "\n\n"
    );
  }

  function broadcastLive(event: ChatStreamEvent, at: number, seq: number): void {
    const encoded = frame(event, at, seq);
    for (const client of clients) client.write(encoded);
  }

  /** The current-state snapshot every new connection gets first, marked so
   * the client applies it to the pill only. The buffered replay right
   * behind it (or a live event still to come) is what actually narrates
   * the transcript -- without this flag a reasoned terminal state (say,
   * "closed" with reason "Stopped") renders its card twice: once from this
   * snapshot, once from the same transition's own entry in the replay. */
  function snapshotFrame(): string {
    return (
      "data: " +
      JSON.stringify({
        ...state,
        snapshot: true,
        seq: nextSeq(),
        controls: computeControls(),
      }) +
      "\n\n"
    );
  }

  /** Evicts oldest entries once the log exceeds its cap -- in whole turns:
   * the cut extends forward to the next user-message, so a replay starts
   * at a turn boundary rather than with an answer whose question is gone.
   * When no boundary remains ahead of the cut (a single turn larger than
   * the whole cap), it falls back to the bare cap; entries are whole cards
   * either way, never a fragment of one. */
  function trimLog(): void {
    if (eventLog.length <= MAX_BUFFERED_EVENTS) return;
    let cut = eventLog.length - MAX_BUFFERED_EVENTS;
    let boundary = cut;
    while (boundary < eventLog.length && eventLog[boundary].event.kind !== "user-message") {
      boundary += 1;
    }
    const cutAtBoundary = boundary < eventLog.length;
    if (cutAtBoundary) cut = boundary;
    for (const dropped of eventLog.splice(0, cut)) {
      if (dropped.event.kind !== "text-delta") continue;
      const key = dropped.event.stream + ":" + dropped.event.itemId;
      if (openDeltas.get(key) === dropped) openDeltas.delete(key);
    }
    // A cut that could not reach a boundary starts the replay mid-turn --
    // leave a marker saying so instead of replaying as if nothing were
    // missing. At the front, so repeated bare-cap trims never stack a
    // second one.
    if (!cutAtBoundary && eventLog[0]?.event.kind !== "history-trimmed") {
      eventLog.unshift({
        event: { kind: "history-trimmed" },
        at: Date.now(),
        seq: nextSeq(),
      });
    }
  }

  function publish(event: ChatStreamEvent): void {
    if (event.kind === "session-state") state = event;
    if (event.kind === "error" && event.fatal) {
      state = { kind: "session-state", state: "error", reason: event.message };
    }
    if (event.kind === "turn-completed") state = { kind: "session-state", state: "ready" };
    // A turn is no longer active once it completes, or once the session
    // itself ends -- a harness that exits mid-turn (closed with no
    // turn-completed, say an idle CLI process dying) must not leave every
    // later message refused with a stale 409 forever.
    if (event.kind === "turn-completed" || (event.kind !== "user-message" && sessionEnded(event))) {
      turnActive = false;
      openDeltas.clear();
    }
    if (event.kind === "permission-request") pendingPermissions.add(event.requestId);
    if (event.kind === "permission-resolved") pendingPermissions.delete(event.requestId);
    const at = Date.now();
    let liveSeq: number;
    if (event.kind === "text-delta") {
      // The log coalesces streamed text into one entry per item; the live
      // broadcast below still carries just this delta. The stored copy is
      // this server's own object -- never the driver's, which must not be
      // mutated as later deltas append.
      const key = event.stream + ":" + event.itemId;
      let open = openDeltas.get(key);
      if (open && open.event.kind === "text-delta" && open.seq !== undefined) {
        open.event.text += event.text;
        liveSeq = nextSeq();
      } else {
        const entrySeq = nextSeq();
        open = { event: { ...event }, at, seq: entrySeq };
        eventLog.push(open);
        openDeltas.set(key, open);
        trimLog();
        liveSeq = entrySeq;
      }
      if (open.event.kind === "text-delta" && open.event.text.length > MAX_COALESCED_TEXT_CHARS) {
        open.event.text = open.event.text.slice(-MAX_COALESCED_TEXT_CHARS);
        if (!open.truncated) {
          open.truncated = true;
          eventLog.push({
            event: { kind: "history-trimmed" },
            at,
            seq: nextSeq(),
          });
          trimLog();
        }
      }
    } else {
      liveSeq = nextSeq();
      eventLog.push({ event, at, seq: liveSeq });
      trimLog();
    }
    broadcastLive(event, at, liveSeq);
  }

  function sessionEnded(event: ChatStreamEvent): boolean {
    return (
      (event.kind === "error" && event.fatal) ||
      (event.kind === "session-state" && (event.state === "error" || event.state === "closed"))
    );
  }

  /** Answers every still-open permission card with "cancel" before clearing
   * the set. Every path that ends a session (or the attempt to start one)
   * must settle through here, not a bare pendingPermissions.clear() -- an
   * unresolved card left in place stays clickable with no session behind
   * it (every answer 404s), and a reconnect's replay would recreate the
   * same unusable card from the buffered permission-request event. */
  function settlePendingPermissions(): void {
    for (const requestId of new Set([...pendingPermissions, ...claimedPermissions])) {
      publish({ kind: "permission-resolved", requestId, decision: "cancel" });
    }
    pendingPermissions.clear();
    claimedPermissions.clear();
  }

  async function startSession(): Promise<PluginAgentSession> {
    const generation = ++sessionGeneration;
    settlePendingPermissions();
    turnActive = false;
    openDeltas.clear();
    // Set once this driver.startSession call itself ends before it even
    // resolves (a session that fails during its own handshake).
    let ended = false;
    // True only for the duration of the driver.startSession() call itself:
    // both concrete drivers report their own cleanup with a bare "closed"
    // (no reason) through onEvent just before a spawn or handshake failure
    // rejects that call -- held back rather than published immediately
    // while this is happening. If the call goes on to reject (the
    // overwhelmingly common case), the catch below publishes one, more
    // informative fatal error instead; publishing this too would render
    // two boundary cards in the replay for the one failure. A bare
    // "closed" arriving any time after startup (the session dying
    // mid-conversation) is the only real signal for that and is never
    // suppressed.
    let starting = true;
    let deferredClose: PluginAgentEvent | null = null;
    let created: PluginAgentSession;
    try {
      created = await driver.startSession({
        workspaceRoot,
        mode: "approval-required",
        mcp: mcpConfig(workspaceRoot),
        onEvent(event) {
          if (generation !== sessionGeneration) return;
          if (
            starting &&
            event.kind === "session-state" &&
            event.state === "closed" &&
            !event.reason
          ) {
            ended = true;
            processSession = null;
            settlePendingPermissions();
            deferredClose = event;
            return;
          }
          publish(event);
          if (sessionEnded(event)) {
            ended = true;
            processSession = null;
            settlePendingPermissions();
          }
        },
      });
    } catch (error) {
      const restartOnly =
        error instanceof Error && "restartOnly" in error && error.restartOnly === true;
      // Both concrete drivers publish "starting" synchronously before this
      // can reject (a spawn failure, an init or handshake error). Without a
      // terminal event here, the pill would sit on Starting forever with
      // Stop still enabled and no session behind it to stop.
      if (generation === sessionGeneration) {
        publish(
          restartOnly
            ? { kind: "error", message: errorMessage(error), fatal: true, restartOnly: true }
            : { kind: "error", message: errorMessage(error), fatal: true },
        );
      }
      // Carried onward on the thrown error too: the outer request handler
      // (not this function) is what actually shapes the HTTP response
      // body, and needs to know this failure's kind to give the fetch
      // path the same truthful action the SSE path already renders.
      throw Object.assign(
        requestError(503, errorMessage(error)),
        restartOnly ? { restartOnly: true } : {},
      );
    } finally {
      starting = false;
    }
    if (deferredClose && generation === sessionGeneration) publish(deferredClose);
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
    if (processSession) return processSession;
    const probeResult = await Promise.resolve(driver.probe()).then(
      (available) => ({ ok: true as const, available }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    // A Stop that arrived while the probe was still in flight has no
    // sessionStart yet for stop() to abandon on its own -- pendingPrompt
    // .stopRequested is the only record of it, and this is the first point
    // after that await where message() can honor it, before this attempt
    // goes on to start a session nobody wants anymore. Nothing async
    // separates this line from the decision, a few lines down, to actually
    // start that session -- one check covers the whole stretch. If the probe
    // rejected too, that rejection is not news the user asked about: report
    // the stop as the outcome, not an unrelated fatal error and a recovery
    // card for nothing left to recover.
    if (pendingPrompt?.stopRequested) {
      throw requestError(503, "The Codex session was stopped while it started.");
    }
    if (!probeResult.ok) {
      const message = errorMessage(probeResult.error);
      publish({ kind: "error", message, fatal: true });
      throw requestError(503, message);
    }
    const available = probeResult.available;
    if (!available.installed) {
      // The provider's own diagnostic (often a raw "spawn codex ENOENT")
      // always exists for a probe that reports not-installed, so it used to
      // win over this guidance every time and the friendly install/PATH
      // instruction never showed. Lead with the guidance; the diagnostic
      // rides along as detail for anyone who needs it.
      const guidance = "Codex isn't installed. Install the Codex CLI and add it to your PATH.";
      const diagnostic = available.errorMessage?.trim();
      const message = diagnostic ? guidance + " (" + diagnostic + ")" : guidance;
      publish({ kind: "error", message, fatal: true });
      throw requestError(503, message);
    }
    if (!sessionStart) {
      const attempt = startSession();
      sessionStart = attempt;
      // A separate chain off the same promise, not the one callers await:
      // this one only ever clears the slot, and only if a later attempt
      // (from /stop clearing sessionStart directly, then a fresh message
      // starting a new one) has not already replaced it. Caught here so
      // this cleanup-only chain can never itself become an unhandled
      // rejection -- attempt's real rejection still reaches every caller
      // that awaits liveSession() through sessionStart itself.
      attempt.catch(() => undefined).finally(() => {
        if (sessionStart === attempt) sessionStart = null;
      });
    }
    return sessionStart;
  }

  async function message(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await jsonBody(request);
    if (!isRecord(body) || typeof body.text !== "string" || body.text.trim() === "") {
      throw requestError(400, "Enter a message before sending.");
    }
    // pendingPrompt gates alongside turnActive: a prompt still awaiting the
    // driver's accept holds the single active turn just as much as an
    // accepted one -- admitting a second prompt in that window would
    // overlap the drivers' one tracked turn and steal the stop intent
    // recorded for the first.
    if (turnActive || pendingPrompt) {
      throw requestError(409, "Wait for the current response to finish.");
    }
    const inFlight = { stopRequested: false };
    pendingPrompt = inFlight;
    syncControls();
    const clientId =
      typeof body.clientId === "string" && body.clientId ? body.clientId : randomUUID();
    try {
      const live = await liveSession();
      // Reserve this turn's own position in the replay log before invoking
      // the driver: prompt() can itself publish turn events (through onEvent)
      // before it resolves, and those must never replay ahead of the user's
      // own message that caused them. Filled in on accept, dropped on
      // rejection -- never broadcast live here, only once accepted below,
      // same as before.
      const reserved: {
        event: ChatStreamEvent;
        at: number;
        seq?: number;
        provisional?: boolean;
      } = {
        event: { kind: "user-message", text: body.text, clientId },
        at: Date.now(),
        provisional: true,
      };
      eventLog.push(reserved);
      trimLog();
      // Drops the reservation and the rest of this orphaned turn's OWN
      // events (a stray "running" state, deltas) -- while
      // pendingPrompt/turnActive gate every other /message, nothing but
      // this turn's own driver can have added anything past this point.
      // Used both when prompt() itself rejects and when it resolves into a
      // session that died out from under it. A genuine terminal event
      // (fatal error, or session-state closed/error) can already be
      // sitting in that same tail -- the session's own onEvent handler
      // published it independently of this call, before prompt() ever
      // settled -- and it is the ONLY place a reconnect ever sees why the
      // session ended, so it is kept, in its original position, not swept
      // away with the rest of the orphaned turn.
      const dropOrphanedReservation = (): void => {
        const index = eventLog.indexOf(reserved);
        if (index === -1) return;
        for (const entry of eventLog.splice(index)) {
          if (sessionEnded(entry.event)) {
            eventLog.push(entry);
            continue;
          }
          if (entry.event.kind !== "text-delta") continue;
          const key = entry.event.stream + ":" + entry.event.itemId;
          if (openDeltas.get(key) === entry) openDeltas.delete(key);
        }
      };
      // Assigned before the call, not after it resolves: prompt() can
      // itself publish events (through onEvent) while it is still
      // pending, and those must carry this turn's real identity, not a
      // stale leftover from whatever the previous turn was.
      currentTurnId = ++turnSequence;
      syncControls();
      try {
        await live.prompt({ text: body.text });
      } catch (error) {
        dropOrphanedReservation();
        if (processSession === live) {
          processSession = null;
          settlePendingPermissions();
        }
        const message = errorMessage(error);
        publish({ kind: "error", message, fatal: true });
        await Promise.resolve(live.dispose()).catch(() => undefined);
        throw requestError(500, message);
      }
      // prompt() can resolve successfully even though the session itself
      // ended while it was still pending: a fatal error or a bare "closed"
      // arriving through the session's own onEvent handler already
      // published the real terminal card and cleared processSession,
      // independently of this call. Marking the turn active here would
      // leave nothing left to ever emit turn-completed, stranding every
      // later /message behind a 409 forever -- treat it exactly like a
      // rejection instead, without publishing a second, redundant terminal
      // event (the client already has the real one).
      if (processSession !== live) {
        dropOrphanedReservation();
        await Promise.resolve(live.dispose()).catch(() => undefined);
        throw requestError(500, "The session ended before this message could be confirmed.");
      }
      // Published only now that the driver actually accepted it: a reconnect
      // must never replay a message that was never really sent, and the
      // submitting page's own optimistic card must never be told "not sent"
      // for one that in fact was.
      turnActive = true;
      reserved.provisional = false;
      reserved.seq = nextSeq();
      // The reservation can have aged out of the buffer's cap while prompt()
      // was still pending (a very active turn ahead of it) -- put it back at
      // the end rather than lose the confirmation entirely.
      if (!eventLog.includes(reserved)) {
        reserved.at = Date.now();
        eventLog.push(reserved);
        trimLog();
      }
      broadcastLive(reserved.event, reserved.at, reserved.seq);
      // A Stop that arrived while the prompt was still awaiting acceptance:
      // now that the driver holds the turn, the recorded intent becomes a
      // real cancel. Best-effort like any cancel after Stop's own 200
      // response -- a transport failure here must not fail the accepted
      // /message.
      if (inFlight.stopRequested) {
        await Promise.resolve(live.cancel()).catch(() => undefined);
      }
      response.writeHead(202, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify({ controls: computeControls(), seq: nextSeq() }));
    } finally {
      if (pendingPrompt === inFlight) pendingPrompt = null;
      syncControls();
    }
  }

  async function stop(response: ServerResponse): Promise<void> {
    const live = processSession;
    if (!live) {
      // No live session: if a start is still pending, abort it -- there is
      // no session or context yet to preserve, only an attempt to give up
      // on.
      // A prompt still awaiting the driver's probe has no sessionStart yet
      // for the branch below to abandon -- pendingPrompt.stopRequested is
      // the only record of the stop in that window, honored the moment
      // liveSession()'s own probe-await resolves (see there). Marking it
      // here is a no-op for the sessionStart branch just below: that one
      // still abandons its attempt through the sessionGeneration bump, and
      // nulls pendingPrompt outright (deliberately, so a fresh /message is
      // accepted immediately rather than waiting for the doomed handshake to
      // unwind -- do not change that).
      if (pendingPrompt) pendingPrompt.stopRequested = true;
      if (sessionStart) {
        // The generation bump dooms the pending attempt -- once
        // driver.startSession resolves it disposes itself instead of
        // installing -- but sessionStart still points at that doomed
        // promise until then. Clear it now, or a message sent before it
        // settles would await the same dying attempt instead of starting
        // fresh, and the pill would sit on Starting with nothing left to
        // bring it back.
        sessionGeneration += 1;
        sessionStart = null;
        // message()'s identity guard keeps its cleanup from clearing a newer reservation.
        pendingPrompt = null;
        publish({ kind: "session-state", state: "closed", reason: "Stopped" });
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify({ controls: computeControls(), seq: nextSeq() }));
      return;
    }
    // The session and its context stay alive: this interrupts the current
    // turn, if one is running, and nothing more. Session retirement is a
    // different decision made elsewhere -- deactivate, stopWebApp, or a
    // fatal error the driver reports on its own -- never through this
    // route (a reversible action needs a reverse path; ending the session
    // here would leave the next message silently starting one with no
    // context, which is not that). turnActive clears on its own once the
    // driver's own asynchronous turn-completed(cancelled) notification
    // arrives; cancel() is a documented no-op on both concrete drivers
    // when nothing was running.
    settlePendingPermissions();
    // A prompt still awaiting the driver's accept has no turn id yet, so
    // the cancel() below cannot reach it. Record the stop so message()
    // cancels the turn the moment it is accepted.
    if (pendingPrompt) pendingPrompt.stopRequested = true;
    await live.cancel();
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify({ controls: computeControls(), seq: nextSeq() }));
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
    // Claimed synchronously, before the first await: two concurrent POSTs
    // for the same requestId must not both pass the check above and both
    // answer the driver. The loser has to see it already gone and 404.
    // Tracked in claimedPermissions (not just removed), so anything that
    // settles pending permissions while this is still in flight --
    // settlePendingPermissions, from a Stop, a fresh session start, or
    // teardown -- can still resolve it, and clears the claim here too:
    // the catch below reads that absence as its signal not to resurrect
    // a request someone else already settled.
    pendingPermissions.delete(requestId);
    claimedPermissions.add(requestId);
    try {
      const body = await jsonBody(request);
      const decision = isRecord(body) ? body.decision : undefined;
      if (!isPermissionDecision(decision)) {
        throw requestError(400, "Choose a valid permission response.");
      }
      await live.answerPermission(requestId, decision);
    } catch (error) {
      // Only restore it as pending if nothing else settled it in the
      // meantime -- if the claim is already gone from here, some
      // settlePendingPermissions call already resolved it with its own
      // cancellation. Resurrecting it here would recreate exactly the
      // zombie card, stuck showing "pending" forever with every retry
      // 404ing, that this claim exists to prevent.
      if (claimedPermissions.has(requestId)) pendingPermissions.add(requestId);
      throw error;
    } finally {
      claimedPermissions.delete(requestId);
    }
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
    response.write(snapshotFrame());
    for (const entry of eventLog) {
      if (entry.provisional) continue;
      response.write(frame(entry.event, entry.at, entry.seq, true));
    }
    clients.add(response);
    request.once("close", () => clients.delete(response));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackHost(request.headers.host)) {
        throw requestError(403, "This request's Host header is not accepted.");
      }
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
        try {
          await message(request, response);
        } catch (error) {
          throw attachControls(error);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        try {
          await stop(response);
        } catch (error) {
          throw attachControls(error);
        }
        return;
      }
      const permissionMatch =
        request.method === "POST" ? /^\/permission\/(.+)$/.exec(url.pathname) : null;
      if (permissionMatch?.[1]) {
        await permission(request, response, decodeURIComponent(permissionMatch[1]));
        return;
      }
      // Static assets carry no token at all: the page reads its own
      // credential from the URL fragment it was navigated to (see
      // urlWithToken below), which never travels in this GET's request line
      // and so never has to be embedded in what this route serves. Any
      // local process fetching "/" learns nothing a hostile caller could
      // use.
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
      // body, a missing static asset, an unauthorized caller -- is a
      // transport problem, not a session problem, so it 4xx/5xx's the
      // request without touching session state.
      const failure = error as Partial<RequestError> & {
        restartOnly?: boolean;
        controls?: { canSend: boolean; canStop: boolean; turnId: number | null };
        seq?: number;
      };
      const message = errorMessage(error);
      if (!response.headersSent) {
        if (failure.controls !== undefined) {
          response.writeHead(failure.statusCode ?? 500, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
          });
          response.end(
            JSON.stringify({
              message,
              ...(failure.restartOnly ? { kind: "restartOnly" } : {}),
              controls: failure.controls,
              seq: failure.seq,
            }),
          );
        } else {
          writeError(response, failure.statusCode ?? 500, message);
        }
      } else {
        response.end();
      }
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
      serverUrl = await listen(nextServer, testHooks?.beforeListen);
      return serverUrl;
    } catch (error) {
      server = null;
      token = null;
      throw error;
    }
  }

  /** Full teardown: ends the session best-effort, closes the server, and
   * clears every field a later startWebApp must not see stale. Shared by
   * stopWebApp (the host's failed-load recovery path -- see the comment on
   * stopWebApp below) and deactivate. */
  async function shutdown(): Promise<void> {
    // Bumped first, unconditionally: a start pending through this teardown
    // must not be able to install itself as the live session afterward.
    sessionGeneration += 1;
    const live = processSession;
    processSession = null;
    settlePendingPermissions();
    turnActive = false;
    sessionStart = null;
    // A message() still awaiting the driver's accept when teardown runs
    // holds a reservation for a session that no longer exists -- release
    // it here exactly like the Stop-during-startup path does, or a
    // restarted server 409s every message until that abandoned prompt()
    // call itself eventually settles (which can be indefinite, against a
    // hung driver). message()'s own identity-checked finally
    // (`pendingPrompt === inFlight`) still no-ops safely if a request from
    // AFTER the restart has already reclaimed the slot by the time the
    // old one settles.
    pendingPrompt = null;
    syncControls();
    // Guarded: a rejection here must not skip the cleanup below and leave
    // the server listening (and the session's process running) after
    // teardown.
    await Promise.resolve(live?.dispose()).catch(() => undefined);
    for (const client of clients) client.end();
    clients.clear();
    eventLog.length = 0;
    openDeltas.clear();
    state = { kind: "session-state", state: "closed" };
    const runningServer = server;
    server = null;
    serverUrl = null;
    token = null;
    if (runningServer) {
      const closed = new Promise<void>((resolve) => runningServer.close(() => resolve()));
      // close() alone waits for every open connection to end on its own --
      // an in-flight request (one still awaiting a gated driver call, for
      // instance) would hold this open indefinitely. Force any still-open
      // sockets closed right behind it so this always settles.
      runningServer.closeAllConnections();
      await closed;
    }
  }

  // The token reaches only the guest the host itself navigates: a URL
  // fragment is never sent in an HTTP request (unlike a query string or
  // header) and is invisible to any other local caller that only ever
  // fetches "/". chat.js reads it from location.hash on load and strips it
  // right back out with history.replaceState.
  function urlWithToken(): string {
    if (!serverUrl || !token) throw new Error("The chat server has no URL yet.");
    return serverUrl + "#token=" + encodeURIComponent(token);
  }

  return {
    async startWebApp(webAppId, instanceKey) {
      if (webAppId !== CHAT_WEB_APP_ID || instanceKey !== null) {
        throw new Error(
          'The Codex plugin serves only the singleton "' + CHAT_WEB_APP_ID + '" web app.',
        );
      }
      if (serverUrl) return { url: urlWithToken() };
      serverStart ??= startServer().finally(() => {
        serverStart = null;
      });
      await serverStart;
      return { url: urlWithToken() };
    },
    async stopWebApp(webAppId, instanceKey) {
      if (webAppId !== CHAT_WEB_APP_ID || instanceKey !== null) {
        throw new Error(
          'The Codex plugin serves only the singleton "' + CHAT_WEB_APP_ID + '" web app.',
        );
      }
      // The host calls this to retire a pairing whose guest failed to load
      // (recovery after a bad start) so the next start pairs completely
      // fresh -- not on an ordinary tab close, which never dispatches this
      // method. Tearing down for real here is safe for exactly that reason:
      // a closed tab still reattaches to the live server and session, and
      // this path is never reached by closing one.
      await shutdown();
    },
    async deactivate() {
      await shutdown();
    },
  };
}

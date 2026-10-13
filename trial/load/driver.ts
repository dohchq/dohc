// Load driver for the Drive trial. It acts as real clients against a deployed
// dohc server: accounts over HTTPS, owners through the release's engine
// binary, and live editors over the desktop live route. Runs inside the
// dohc-cf-driver image, which is the release image plus this file.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { WebSocket as NodeWebSocket } from "ws";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createNamedLiveBrowserTransport, parseNamedLiveBrowserLimits, type NamedLiveSelection } from "@dohc/ydoc-projection/named-live-browser-transport";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { createEngineClient } from "/app/packages/workspace-engine-client/src/daemon/index.ts";

const ORIGIN = new URL(required("DOHC_ORIGIN")).origin;
const TRIAL_KEY = process.env.DOHC_TRIAL_KEY;
const STATE_DIR = process.env.DOHC_STATE_DIR ?? "/state";
const STATE_PATH = join(STATE_DIR, "state.json");
const ENGINE = "/app/bin/dohc-workspace-engine";

interface Account { role: "owner" | "editor"; email: string; password: string; token: string; userId: string }
interface LiveDoc { path: string; objectId: string }
interface Workspace { id: string; owner: string; files: number; bytes: number; live: LiveDoc[]; shareId?: string; editor?: string; readyMs?: number }
interface State { origin: string; accounts: Account[]; workspaces: Workspace[] }
type Json = Record<string, unknown>;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function load(): State {
  if (!existsSync(STATE_PATH)) return { origin: ORIGIN, accounts: [], workspaces: [] };
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  if (state.origin !== ORIGIN) throw new Error(`State belongs to ${state.origin}.`);
  return state;
}
function save(state: State) { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function log(event: string, fields: Json = {}) { console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (TRIAL_KEY) headers.set("x-dohc-trial-key", TRIAL_KEY);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return fetch(new URL(path, ORIGIN), { ...init, body, headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
}
async function json(response: Response, what: string): Promise<Json> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Json;
}

// Accounts: sign-up sends a verification mail; sign-in alone yields the bearer the relay accepts.
async function accounts(state: State, owners: number, editors: number) {
  const stamp = Date.now().toString(36);
  for (const [role, count] of [["owner", owners], ["editor", editors]] as const) {
    for (let index = state.accounts.filter(row => row.role === role).length; index < count; index++) {
      const email = `trial-${role}-${index}-${stamp}@dohc.invalid`, password = randomBytes(18).toString("base64url");
      const headers = { origin: ORIGIN };
      await json(await call("/api/auth/sign-up/email", { method: "POST", headers, json: { name: `Trial ${role} ${index}`, email, password } }), "Sign-up");
      const signedIn = await json(await call("/api/auth/sign-in/email", { method: "POST", headers, json: { email, password } }), "Sign-in");
      const user = signedIn.user as Json;
      state.accounts.push({ role, email, password, token: String(signedIn.token), userId: String(user.id) });
      save(state);
      log("account", { role, email });
    }
  }
}

function paragraphText(bytes: number, seed: number): string {
  const words = ["plan", "route", "budget", "venue", "notes", "guest", "draft", "update", "review", "today", "share", "agent"];
  const lines: string[] = [`# Document ${seed}`, ""];
  let size = lines.join("\n").length, word = seed;
  while (size < bytes) {
    const sentence = Array.from({ length: 12 }, () => words[word++ % words.length]).join(" ");
    lines.push(`${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`, "");
    size += sentence.length + 3;
  }
  return lines.join("\n");
}

type Engine = Awaited<ReturnType<typeof createEngineClient>>;
async function ownerEngine(account: Account): Promise<{ engine: Engine; next(): number }> {
  const stderr = join(STATE_DIR, `engine-${account.userId}.log`);
  const engine = await createEngineClient({ command: ENGINE, authToken: randomUUID(), protocolVersion: 2, capabilities: ["core", "blobs"],
    connectTimeoutMs: 30_000, onStderr: (value: string) => appendFileSync(stderr, value) });
  let id = 1;
  return { engine, next: () => id++ };
}

// Seeds workspaces through the owner's engine exactly as a desktop would sync them.
async function seed(state: State, count: number, files: number, bytes: number, liveDocs: number) {
  const owners = state.accounts.filter(row => row.role === "owner");
  if (!owners.length) throw new Error("Create owner accounts first.");
  const engines = new Map<string, Awaited<ReturnType<typeof ownerEngine>>>();
  try {
    for (let index = 0; index < count; index++) {
      const owner = owners[state.workspaces.length % owners.length]!;
      let session = engines.get(owner.userId);
      if (!session) { session = await ownerEngine(owner); engines.set(owner.userId, session); }
      const started = Date.now(), workspaceId = randomUUID(), rootDir = join(STATE_DIR, "owners", owner.userId, workspaceId);
      mkdirSync(rootDir, { recursive: true });
      const { engine, next } = session;
      const opened = await engine.sendRequest({ id: next(), method: "workspace.open", deadlineMs: 120_000,
        params: { rootDir, workspaceId, captureMode: "none", relay: { baseUrl: ORIGIN, bearerToken: owner.token } } });
      const handle = (opened.result as Json).workspace as string;
      const rpc = async (method: string, params: Json, idempotencyKey?: string): Promise<Json> => {
        try {
          const response = await engine.sendRequest({ id: next(), workspace: handle, method, params, deadlineMs: 120_000, ...(idempotencyKey ? { idempotencyKey } : {}) });
          return response.result as Json;
        } catch (cause) { throw new Error(`Engine ${method} failed`, { cause }); }
      };
      const push = async () => {
        for (let page = 0; page < 256; page++) {
          const result = await rpc("sync.push", { workspaceId });
          for (const key of ["refusals", "sharingDeclined"]) {
            if (Array.isArray(result[key]) && (result[key] as unknown[]).length) throw new Error(`Push ${key}: ${JSON.stringify(result[key]).slice(0, 300)}`);
          }
          if (!result.hasMore) return;
        }
        throw new Error("Push did not finish.");
      };
      await rpc("sync.claim", { workspaceId });
      const versionId = (await rpc("versions.ensureMain", {})).id as string;
      await push();
      const live: LiveDoc[] = [];
      for (let file = 0; file < files; file++) {
        const isLive = file < liveDocs, path = isLive ? `live/doc-${file}.md` : `files/file-${file}.md`;
        const text = paragraphText(isLive ? Math.min(bytes, 4096) : bytes, file);
        const written = await rpc("versionedText.write", { workspaceId, versionId, path, text, origin: "api", publish: true }, randomUUID());
        const objectId = (written.object as Json).id as string;
        if (!isLive) continue;
        const editor = await rpc("ydoc.open", { versionId, path, expectedObjectId: objectId, contentKind: "richdoc" });
        // Seed as YdocLiveAdapter.openSession does: the engine's seed client id, plus an
        // exact-source witness when the Markdown does not round-trip.
        const source = String(editor.seedContent), doc = markdownToYDoc(source, { clientID: Number(editor.seedClientId) });
        const projection = yDocToMarkdown(doc);
        if (projection !== source) {
          const meta = doc.getMap("meta"), sha = (value: string) => createHash("sha256").update(value).digest("hex");
          meta.set("dohcMarkdownSource", source);
          meta.set("dohcMarkdownSourceSha256", sha(source));
          meta.set("dohcMarkdownSourceProjectionSha256", sha(projection));
        }
        await rpc("ydoc.recordUpdate", { sessionId: editor.sessionId, updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"), seed: true });
        await rpc("ydoc.settle", { sessionId: editor.sessionId });
        await rpc("ydoc.close", { sessionId: editor.sessionId });
        live.push({ path, objectId });
      }
      await push();
      await rpc("workspace.close", {});
      state.workspaces.push({ id: workspaceId, owner: owner.email, files, bytes, live });
      save(state);
      log("workspace", { id: workspaceId, files, bytes, live: live.length, ms: Date.now() - started });
    }
  } finally {
    for (const { engine } of engines.values()) await engine.close();
  }
}

// Shares each workspace's live folder with one editor and waits until the server hosts every document.
async function share(state: State, limit: number) {
  const editors = state.accounts.filter(row => row.role === "editor");
  if (!editors.length) throw new Error("Create editor accounts first.");
  const pending = state.workspaces.filter(row => row.live.length && !row.shareId).slice(0, limit);
  for (const workspace of pending) {
    const owner = state.accounts.find(row => row.email === workspace.owner)!;
    const editor = editors[state.workspaces.filter(row => row.shareId).length % editors.length]!;
    const started = Date.now();
    const created = await json(await call(`/sync/${workspace.id}/shares`, { method: "POST", token: owner.token,
      json: { recipientUserId: editor.userId, paths: ["live"], versionId: null, access: "edit" } }), "Share");
    workspace.shareId = String(created.shareId); workspace.editor = editor.email; save(state);
    const enrolled = await call(`/sync/${workspace.id}/live-host`, { method: "POST", token: owner.token, json: { shareId: workspace.shareId } });
    await json(enrolled, "Live host enrollment");
    for (;;) {
      const status = await json(await call(`/sync/${workspace.id}/live-host`, { token: owner.token }), "Live host status");
      const documents = (status.documents as { status: string }[]) ?? [];
      if (documents.length === workspace.live.length && documents.every(row => row.status === "ready")) break;
      if (Date.now() - started > 600_000) throw new Error(`Live host not ready: ${JSON.stringify(documents).slice(0, 300)}`);
      await sleep(500);
    }
    workspace.readyMs = Date.now() - started; save(state);
    log("shared", { workspace: workspace.id, documents: workspace.live.length, readyMs: workspace.readyMs });
  }
}

function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement) { const found = firstText(child); if (found) return found; }
  }
  return undefined;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

// Opens one live session per editor slot and types at a fixed rate; reports acknowledgement latency.
async function edit(state: State, sessions: number, ratePerSecond: number, seconds: number) {
  const documents = state.workspaces.filter(row => row.shareId).flatMap(row => row.live.map(doc => ({ workspace: row, doc })));
  if (!documents.length) throw new Error("Share live documents first.");
  const latencies: number[] = [], failures: string[] = [], connectMs: number[] = [];
  let sent = 0;
  const deadline = Date.now() + seconds * 1000;
  const closers: (() => void)[] = [];
  await Promise.all(Array.from({ length: sessions }, async (_unused, index) => {
    const { workspace, doc } = documents[index % documents.length]!;
    const editor = state.accounts.find(row => row.email === workspace.editor)!;
    const started = Date.now();
    try {
      const admit = async () => {
        const row = await json(await call("/sync/live/desktop-open", { method: "POST", token: editor.token,
          json: { shareId: workspace.shareId, path: doc.path } }), "Live admission");
        const ticket = row.ticket as Json;
        return { selection: { accountId: editor.userId, workspaceId: parseLiveUpdateIdentifier(row.workspaceId),
          grantId: parseLiveUpdateIdentifier(row.grantId), objectId: parseLiveUpdateIdentifier(row.objectId) } satisfies NamedLiveSelection,
          discriminator: String(row.discriminator), token: String(ticket.token), limits: parseNamedLiveBrowserLimits(row.editorLimits) };
      };
      let pending: Awaited<ReturnType<typeof admit>> | undefined = await admit();
      const first = pending;
      const transport = createNamedLiveBrowserTransport<NamedLiveSelection>({ publicOrigin: ORIGIN, limits: first.limits,
        recordingContext: () => ({ kind: "account", accountId: editor.userId }),
        authorize: async () => {
          const next = pending ?? await admit(); pending = undefined;
          const url = new URL("/sync/live/desktop", ORIGIN); url.protocol = "wss:"; url.searchParams.set("session", next.discriminator);
          return { ticketToken: next.token, discriminator: next.discriminator, websocketUrl: url.href };
        },
        openSocket: (url: string, protocols: string[]) => new NodeWebSocket(url, protocols, { headers: { authorization: `Bearer ${editor.token}` },
          perMessageDeflate: false, maxPayload: first.limits.provider.frames.receive.maxFrameBytes }) as unknown as WebSocket,
      });
      closers.push(() => transport.close());
      const session = transport.select(first.selection);
      await session.reconnect();
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          const status = session.state().status;
          if (status === "live") { unsubscribe(); resolve(); }
          else if (!["authorizing", "connecting", "syncing"].includes(status)) { unsubscribe(); reject(new Error(`Session ${status}`)); }
        };
        const unsubscribe = session.subscribe(check);
        check();
      });
      connectMs.push(Date.now() - started);
      const interval = 1000 / ratePerSecond;
      while (Date.now() < deadline) {
        const text = firstText(session.body);
        if (!text) throw new Error("Document has no text block.");
        const at = Date.now();
        session.edit(() => text.insert(text.length, String.fromCharCode(97 + (sent % 26))));
        sent++;
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            const current = session.state();
            if (current.status === "live" && current.pendingUpdates === 0) { unsubscribe(); resolve(); }
            else if (!["live", "authorizing", "connecting", "syncing"].includes(current.status)) { unsubscribe(); reject(new Error(`Session ${current.status}`)); }
          };
          const unsubscribe = session.subscribe(check);
          check();
        });
        latencies.push(Date.now() - at);
        await sleep(Math.max(0, interval - (Date.now() - at)));
      }
    } catch (error) {
      failures.push(`${doc.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  for (const close of closers) close();
  const result = { sessions, ratePerSecond, seconds, opened: connectMs.length, sent, acknowledged: latencies.length,
    connectMs: { p50: percentile(connectMs, 50), p95: percentile(connectMs, 95) },
    ackMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies.length ? Math.max(...latencies) : NaN },
    failures: failures.slice(0, 20) };
  log("edit", result);
  writeFileSync(join(STATE_DIR, `edit-${Date.now()}.json`), JSON.stringify(result, null, 2));
}

async function status(state: State) {
  for (const workspace of state.workspaces.filter(row => row.shareId)) {
    const owner = state.accounts.find(row => row.email === workspace.owner)!;
    const result = await json(await call(`/sync/${workspace.id}/live-host`, { token: owner.token }), "Live host status");
    log("status", { workspace: workspace.id, documents: (result.documents as { status: string }[]).map(row => row.status) });
  }
  log("summary", { accounts: state.accounts.length, workspaces: state.workspaces.length,
    shared: state.workspaces.filter(row => row.shareId).length, liveDocs: state.workspaces.reduce((sum, row) => sum + (row.shareId ? row.live.length : 0), 0) });
}

const [command, ...args] = process.argv.slice(2);
const numbers = args.map(Number);
const state = load();
const commands: Record<string, () => Promise<void>> = {
  accounts: () => accounts(state, numbers[0] ?? 2, numbers[1] ?? 4),
  seed: () => seed(state, numbers[0] ?? 1, numbers[1] ?? 20, numbers[2] ?? 4096, numbers[3] ?? 0),
  share: () => share(state, numbers[0] ?? 16),
  edit: () => edit(state, numbers[0] ?? 8, numbers[1] ?? 2, numbers[2] ?? 60),
  status: () => status(state),
};
const run = command ? commands[command] : undefined;
if (!run) throw new Error(`Use one of: ${Object.keys(commands).join(", ")}.`);
await run();
process.exit(0);

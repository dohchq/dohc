import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

export { ContainerProxy };

interface Env {
  CELL: DurableObjectNamespace<Cell>;
  WORKSPACE: DurableObjectNamespace<WorkspaceCell>;
  STATE: R2Bucket;
  SLEEP_AFTER: string;
  // "single": one cell serves everything. "per-workspace": workspace traffic goes to its own container.
  CELL_SHAPE: string;
  DOHC_PUBLIC_ORIGIN: string;
  TRIAL_KEY: string;
  POSTGRES_URL: string;
  BETTER_AUTH_SECRET: string;
  DOHC_RELAY_LINK_KEY: string;
  DOHC_RELAY_EXCHANGE_KEY: string;
}

const PORT = 8080;
// Cold start covers Postgres migration, relay initialization, and every service's readiness.
const START_TIMEOUT_MS = 180_000;

interface Generation {
  generation: number;
  parts: number;
  bytes: number;
  relayStamp: number;
  saveMs: number;
}

class TrialCell extends Container<Env> {
  defaultPort = PORT;

  constructor(ctx: DurableObjectState<{}>, env: Env, role: string) {
    super(ctx, env);
    this.sleepAfter = env.SLEEP_AFTER;
    this.envVars = {
      DOHC_CELL_ROLE: role,
      DOHC_PUBLIC_ORIGIN: env.DOHC_PUBLIC_ORIGIN,
      POSTGRES_URL: env.POSTGRES_URL,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      DOHC_RELAY_LINK_KEY: env.DOHC_RELAY_LINK_KEY,
      DOHC_RELAY_EXCHANGE_KEY: env.DOHC_RELAY_EXCHANGE_KEY,
    };
  }

  // Requests this object forwarded since it last started, by caller and path shape.
  // Tail sampling drops events under load; this count does not.
  private requests: Record<string, number> = {};
  private countingSince = Date.now();

  override async fetch(request: Request): Promise<Response> {
    const caller = /ureq/i.test(request.headers.get("user-agent") ?? "") ? "engine" : "client";
    const shape = new URL(request.url).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<id>").replace(/\/blobs\/.*/, "/blobs/*");
    const key = `${caller} ${request.method} ${shape}`;
    this.requests[key] = (this.requests[key] ?? 0) + 1;
    if (!this.ctx.container?.running || (await this.getState()).status !== "healthy") {
      const startedAt = Date.now();
      await this.startAndWaitForPorts(PORT, { portReadyTimeoutMS: START_TIMEOUT_MS, abort: request.signal });
      console.log(JSON.stringify({ trial: "cold-start", cell: this.ctx.id.name ?? this.ctx.id.toString(), ms: Date.now() - startedAt }));
    }
    return super.fetch(request);
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.log(JSON.stringify({ trial: "stop", cell: this.ctx.id.name ?? this.ctx.id.toString(), ...params }));
  }

  // The archive lives in R2. Which generation is current lives here, outside the
  // container, so a wake can refuse an archive older than the last committed save.
  async savedGeneration(): Promise<Generation> {
    return (await this.ctx.storage.get<Generation>("generation")) ?? { generation: 0, parts: 0, bytes: 0, relayStamp: 0, saveMs: 0 };
  }

  async commitGeneration(next: Generation): Promise<boolean> {
    if (next.generation !== (await this.savedGeneration()).generation + 1) return false;
    await this.ctx.storage.put("generation", next);
    console.log(JSON.stringify({ trial: "commit", cell: this.ctx.id.toString(), ...next }));
    return true;
  }

  async probeWrite(body: ArrayBuffer): Promise<void> {
    await this.ctx.storage.put("probe", body);
  }

  async trialControl(action: string): Promise<unknown> {
    if (action === "stop") await this.stop();
    else if (action === "kill") await this.destroy();
    if (action === "reset") { this.requests = {}; this.countingSince = Date.now(); }
    return { saved: await this.savedGeneration(), state: await this.getState(), countingMs: Date.now() - this.countingSince, requests: this.requests };
  }
}

export class Cell extends TrialCell {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, "all");
  }

  // Per-workspace routing directory: credentials the relay mints, mapped to their workspace.
  async directoryGet(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`directory:${key}`);
  }

  async directoryPut(key: string, workspaceId: string): Promise<void> {
    await this.ctx.storage.put(`directory:${key}`, workspaceId);
  }
}

export class WorkspaceCell extends TrialCell {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env, "workspace");
  }
}

const state = async (request: Request, env: Env, ctx: { containerId: string; className: string }) => {
  const namespace = (ctx.className === "WorkspaceCell" ? env.WORKSPACE : env.CELL).jurisdiction("eu");
  const cell = namespace.get(namespace.idFromString(ctx.containerId));
  const [, kind, generation, index] = new URL(request.url).pathname.split("/");
  if (kind === "generation") return Response.json(await cell.savedGeneration());
  if (kind === "parts" && request.method === "PUT") {
    await env.STATE.put(`${ctx.containerId}/${generation}/${index}`, request.body);
    return new Response(null, { status: 204 });
  }
  if (kind === "parts") {
    const object = await env.STATE.get(`${ctx.containerId}/${generation}/${index}`);
    return object ? new Response(object.body) : new Response(null, { status: 404 });
  }
  if (kind === "commit") {
    const next = { ...(await request.json<Omit<Generation, "generation">>()), generation: Number(generation) };
    return new Response(null, { status: (await cell.commitGeneration(next)) ? 204 : 409 });
  }
  if (kind === "probe" && generation === "do") await cell.probeWrite(await request.arrayBuffer());
  else if (kind === "probe" && generation === "r2") await env.STATE.put(`${ctx.containerId}/probe`, request.body);
  else return new Response(null, { status: 404 });
  return new Response(null, { status: 204 });
};
Cell.outboundByHost = { "state.trial": state };
WorkspaceCell.outboundByHost = { "state.trial": state };

const COOKIE = "dohc_trial";
const HEADER = "x-dohc-trial-key";

// Routes that already require an account token or share-link credential stay open,
// so the session host can reach the relay through its public origin.
function open(path: string): boolean {
  return path.startsWith("/sync/") || path === "/.well-known/dohc-server";
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function matches(given: string | null | undefined, expected: string): Promise<boolean> {
  if (!given) return false;
  return crypto.subtle.timingSafeEqual(await digest(given), await digest(expected));
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function withoutTrialCookie(header: string): string {
  return header.split(";").map(part => part.trim()).filter(part => part && !part.startsWith(`${COOKIE}=`)).join("; ");
}

const enterPage = `<!doctype html><meta name="viewport" content="width=device-width">
<form method="post"><label>Trial key <input name="key" type="password" autofocus></label> <button>Enter</button></form>`;

const WORKSPACE_PATH = /^\/sync\/(?:workspaces\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

function field(body: string, name: string): string | undefined {
  try {
    const value = (JSON.parse(body) as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}

// Finds the workspace a request belongs to. Only the routes the trial driver and a
// desktop editor use are covered; the rest stay on the home cell (see step5-map).
async function workspaceOf(request: Request, url: URL, body: string | undefined, home: DurableObjectStub<Cell>): Promise<string | undefined> {
  const inPath = WORKSPACE_PATH.exec(url.pathname)?.[1];
  if (inPath) return inPath;
  if (url.pathname === "/sync/workspaces" && body) return field(body, "workspaceId");
  if ((url.pathname === "/sync/live/desktop-open" || url.pathname === "/sync/live/desktop-ready") && body) {
    const shareId = field(body, "shareId");
    return shareId ? home.directoryGet(`share:${shareId}`) : undefined;
  }
  const session = url.searchParams.get("session");
  if (url.pathname === "/sync/live/desktop" && session) return home.directoryGet(`session:${session}`);
  return undefined;
}

// Records the identifiers a workspace relay mints, so later requests that carry only them can be routed.
async function learn(url: URL, request: Request, response: Response, workspaceId: string, home: DurableObjectStub<Cell>): Promise<void> {
  if (request.method !== "POST" || !response.ok) return;
  const learned = url.pathname === `/sync/${workspaceId}/shares` ? ["share", "shareId"]
    : url.pathname === "/sync/live/desktop-open" ? ["session", "discriminator"] : undefined;
  if (!learned) return;
  const value = field(await response.clone().text(), learned[1]!);
  if (value) await home.directoryPut(`${learned[0]}:${value}`, workspaceId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const secrets = [env.TRIAL_KEY, env.POSTGRES_URL, env.BETTER_AUTH_SECRET, env.DOHC_RELAY_LINK_KEY, env.DOHC_RELAY_EXCHANGE_KEY];
    if (secrets.some(value => !value) || env.DOHC_PUBLIC_ORIGIN.includes("SUBDOMAIN")) return new Response("This trial server is not configured.", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === "/__trial/enter") {
      if (request.method !== "POST") return new Response(enterPage, { headers: { "content-type": "text/html" } });
      const form = await request.formData();
      const key = form.get("key");
      if (typeof key !== "string" || !(await matches(key, env.TRIAL_KEY))) return new Response("Wrong key.", { status: 403 });
      return new Response(null, { status: 303, headers: { location: "/",
        "set-cookie": `${COOKIE}=${key}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800` } });
    }
    const allowed = open(url.pathname) ||
      (await matches(request.headers.get(HEADER), env.TRIAL_KEY)) || (await matches(cookie(request, COOKIE), env.TRIAL_KEY));
    if (!allowed) return new Response("This trial server needs its key.", { status: 403 });
    // Durable Objects default to the first caller's region; pin them next to their EU containers.
    const cells = env.CELL.jurisdiction("eu"), workspaces = env.WORKSPACE.jurisdiction("eu");
    const home = getContainer(cells, "cell-1");
    // Trial controls talk to a Durable Object without waking its container.
    const control = /^\/__trial\/control\/(stop|kill|state|reset)(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
    if (control && request.method === "POST") {
      const target = control[2] ? getContainer(workspaces, control[2]) : home;
      return Response.json(await target.trialControl(control[1]!));
    }

    const headers = new Headers(request.headers);
    headers.delete(HEADER);
    const remaining = withoutTrialCookie(headers.get("cookie") ?? "");
    if (remaining) headers.set("cookie", remaining); else headers.delete("cookie");
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");
    if (env.CELL_SHAPE !== "per-workspace") return home.fetch(new Request(request, { headers }));

    const body = request.method === "POST" && url.pathname.startsWith("/sync/") ? await request.text() : undefined;
    const forwarded = new Request(request, body === undefined ? { headers } : { headers, body });
    const workspaceId = await workspaceOf(request, url, body, home);
    if (!workspaceId) return home.fetch(forwarded);
    const response = await getContainer(workspaces, workspaceId.toLowerCase()).fetch(forwarded);
    await learn(url, request, response, workspaceId.toLowerCase(), home);
    return response;
  },
} satisfies ExportedHandler<Env>;

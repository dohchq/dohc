import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

export { ContainerProxy };

interface Env {
  CELL: DurableObjectNamespace<Cell>;
  STATE: R2Bucket;
  SLEEP_AFTER: string;
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

export class Cell extends Container<Env> {
  defaultPort = PORT;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.sleepAfter = env.SLEEP_AFTER;
    this.envVars = {
      DOHC_PUBLIC_ORIGIN: env.DOHC_PUBLIC_ORIGIN,
      POSTGRES_URL: env.POSTGRES_URL,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      DOHC_RELAY_LINK_KEY: env.DOHC_RELAY_LINK_KEY,
      DOHC_RELAY_EXCHANGE_KEY: env.DOHC_RELAY_EXCHANGE_KEY,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container?.running || (await this.getState()).status !== "healthy") {
      const startedAt = Date.now();
      await this.startAndWaitForPorts(PORT, { portReadyTimeoutMS: START_TIMEOUT_MS, abort: request.signal });
      console.log(JSON.stringify({ trial: "cold-start", ms: Date.now() - startedAt }));
    }
    return super.fetch(request);
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.log(JSON.stringify({ trial: "stop", ...params }));
  }

  // The archive lives in R2. Which generation is current lives here, outside the
  // container, so a wake can refuse an archive older than the last committed save.
  async savedGeneration(): Promise<Generation> {
    return (await this.ctx.storage.get<Generation>("generation")) ?? { generation: 0, parts: 0, bytes: 0, relayStamp: 0, saveMs: 0 };
  }

  async commitGeneration(next: Generation): Promise<boolean> {
    if (next.generation !== (await this.savedGeneration()).generation + 1) return false;
    await this.ctx.storage.put("generation", next);
    console.log(JSON.stringify({ trial: "commit", ...next }));
    return true;
  }

  async probeWrite(body: ArrayBuffer): Promise<void> {
    await this.ctx.storage.put("probe", body);
  }

  async trialControl(action: string): Promise<unknown> {
    if (action === "stop") await this.stop();
    else if (action === "kill") await this.destroy();
    return { saved: await this.savedGeneration(), state: await this.getState() };
  }
}

Cell.outboundByHost = {
  "state.trial": async (request: Request, env: Env, ctx: { containerId: string }) => {
    const cell = env.CELL.get(env.CELL.idFromString(ctx.containerId));
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
  },
};

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
    // Trial controls talk to the Durable Object without waking the container.
    if (url.pathname.startsWith("/__trial/control/") && request.method === "POST") {
      return Response.json(await getContainer(env.CELL, "cell-1").trialControl(url.pathname.slice("/__trial/control/".length)));
    }

    const headers = new Headers(request.headers);
    headers.delete(HEADER);
    const remaining = withoutTrialCookie(headers.get("cookie") ?? "");
    if (remaining) headers.set("cookie", remaining); else headers.delete("cookie");
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");
    const cell = getContainer(env.CELL, "cell-1");
    return cell.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

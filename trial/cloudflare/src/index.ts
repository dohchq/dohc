import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  CELL: DurableObjectNamespace<Cell>;
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

export class Cell extends Container<Env> {
  defaultPort = PORT;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
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
}

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

    const headers = new Headers(request.headers);
    headers.delete(HEADER);
    const remaining = withoutTrialCookie(headers.get("cookie") ?? "");
    if (remaining) headers.set("cookie", remaining); else headers.delete("cookie");
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");
    const cell = getContainer(env.CELL, "cell-1");
    return cell.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

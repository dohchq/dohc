// The site's Cloudflare Worker. wrangler.jsonc runs it first only for
// /ingest/*, which it forwards to PostHog, as PostHog's Cloudflare proxy
// guide describes. The assets binding serves every other path.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const PREFIX = "/ingest";
const API_HOST = "us.i.posthog.com";
// The SDK's scripts and its remote config.
const ASSET_HOST = "us-assets.i.posthog.com";

async function forward(request: Request, path: string): Promise<Response> {
  const host = /^\/(static|array)\//.test(path) ? ASSET_HOST : API_HOST;
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // This site's cookies, such as Cloudflare's security check, stay here.
  headers.delete("cookie");
  if (!/^Bearer ph[csx]_/.test(headers.get("authorization") ?? "")) headers.delete("authorization");
  // PostHog's cookieless mode hashes the visitor's address, not the Worker's.
  headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const response = await fetch(`https://${host}${path}${url.search}`, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
  const forwarded = new Response(response.body, response);
  forwarded.headers.delete("set-cookie");
  return forwarded;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(`${PREFIX}/`)) return forward(request, pathname.slice(PREFIX.length));
    return env.ASSETS.fetch(request);
  },
};

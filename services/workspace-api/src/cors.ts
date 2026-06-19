// Browser (cookie-session) access for the repositioned web client. CORS is
// OPT-IN: without DOHC_WEB_ORIGIN the API emits no CORS headers at all and the
// desktop Bearer flow is untouched. Exactly ONE origin is trusted, and
// credentials are allowed only for it (never a wildcard).
export function withCors(
  handler: (request: Request) => Promise<Response>,
  webOrigin?: string,
): (request: Request) => Promise<Response> {
  if (!webOrigin) return handler;
  return async (request) => {
    const allowed = request.headers.get("origin") === webOrigin;
    if (request.method === "OPTIONS" && allowed) {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(webOrigin),
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ?? "authorization, content-type",
          "access-control-max-age": "600",
        },
      });
    }
    const response = await handler(request);
    if (!allowed) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders(webOrigin))) {
      if (name === "vary") {
        headers.set("vary", mergeVary(headers.get("vary"), value));
      } else {
        headers.set(name, value);
      }
    }
    return new Response(response.body, { status: response.status, headers });
  };
}

function mergeVary(existing: string | null, added: string): string {
  const values = new Map<string, string>();
  for (const value of `${existing ?? ""},${added}`.split(",")) {
    const trimmed = value.trim();
    if (trimmed) values.set(trimmed.toLowerCase(), trimmed);
  }
  return [...values.values()].join(", ");
}

function corsHeaders(webOrigin: string): Record<string, string> {
  return {
    "access-control-allow-origin": webOrigin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

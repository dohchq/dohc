// One line per answered request: the service, when the request arrived, its
// method, the pattern of the route that matched it, and the status. Never the
// path, query, host, address or a header: paths and queries carry link secrets,
// session ids and sign-in tokens. Only a route pattern a service lists can
// appear: a mark outside the list is dropped, and a request with no mark logs as
// one fixed word.

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// Short lowercase literal segments, `:name` placeholders and an optional
// trailing `*` or `/`, or one lowercase word. This refuses most secrets and
// hashes, which are longer or mix cases, but not every id: a short lowercase id
// still passes. The lists stay source literals.
const SEGMENT = String.raw`(?:[a-z0-9.][a-z0-9._-]{0,31}|:[a-z][A-Za-z0-9]{0,31})`;
const PATTERN = new RegExp(String.raw`^(?:(?:/${SEGMENT})+(?:/\*|/)?|/\*?|[a-z]{1,16})$`);
const UNMATCHED = "unmatched";
const patterns = new WeakMap<Request, string>();

export interface RequestLog<Pattern extends string = string> {
  /** Records the route that matched `request`. */
  mark(request: Request, pattern: Pattern): void;
  /** Writes the line for an answer; with no marked request, its route is `unmatched`. */
  write(request: Request | undefined, method: string, status: number, arrivedAtMs: number): void;
}

/** Keeps the route `from` was marked with for `to`, which a wrapper answers with `from`'s response. */
export function carryRequestMark(from: Request, to: Request): void {
  const pattern = patterns.get(from);
  if (pattern !== undefined) patterns.set(to, pattern);
}

/** A service's request log over the only route patterns it may write. */
export function createRequestLog<const Patterns extends readonly string[]>(
  service: string,
  routePatterns: Patterns,
): RequestLog<Patterns[number]> {
  for (const pattern of routePatterns) {
    if (!PATTERN.test(pattern) || pattern === UNMATCHED) throw new TypeError(`${service} lists an unsafe route pattern.`);
  }
  const listed: ReadonlySet<string> = new Set(routePatterns);
  return {
    mark(request, pattern) {
      // The type allows only listed patterns; this holds when a cast gets past it.
      if (listed.has(pattern)) patterns.set(request, pattern);
    },
    write(request, method, status, arrivedAtMs) {
      const route = (request && patterns.get(request)) ?? UNMATCHED;
      console.log(`[${service}] request ${new Date(arrivedAtMs).toISOString()} ${METHODS.has(method) ? method : "OTHER"} ${route} ${status}`);
    },
  };
}

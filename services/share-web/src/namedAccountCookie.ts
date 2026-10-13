import {getCookies} from "better-auth/cookies";

/** Select permitted `name=value` pairs from a Cookie header, or null when a permitted name repeats. */
export function selectAccountCookies(header: string | null, permitted: ReadonlySet<string>): Map<string, string> | null {
  const selected = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const pair = part.trim(), separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    if (!permitted.has(name)) continue;
    if (selected.has(name)) return null;
    selected.set(name, pair);
  }
  return selected;
}

/** Forward only account session cookies to the trusted relay. */
export function namedAccountCookie(header: string | null, publicOrigin: string): string | null {
  const account = getCookies({baseURL: publicOrigin});
  const cookies = selectAccountCookies(header, new Set([account.sessionToken.name, account.dontRememberToken.name]));
  return cookies?.has(account.sessionToken.name) ? [...cookies.values()].join("; ") : null;
}

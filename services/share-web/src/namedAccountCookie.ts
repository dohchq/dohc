import {getCookies} from "better-auth/cookies";

/** Forward only account session cookies to the trusted relay. */
export function namedAccountCookie(header: string | null, publicOrigin: string): string | null {
  const account = getCookies({baseURL: publicOrigin});
  const permitted = new Set([account.sessionToken.name, account.dontRememberToken.name]);
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const pair = part.trim(), separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    if (!permitted.has(name)) continue;
    if (cookies.has(name)) return null;
    cookies.set(name, pair);
  }
  return cookies.has(account.sessionToken.name) ? [...cookies.values()].join("; ") : null;
}

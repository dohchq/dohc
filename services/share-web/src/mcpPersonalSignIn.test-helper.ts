import { getCookies } from "better-auth/cookies";
import { vi } from "vitest";
import type {
  ConsentCredentials, CredentialFence, CredentialFenceChange, CredentialFenceListener,
} from "@dohc/workspace-auth/credentialFence";
import { UnauthorizedError, type AccountSession } from "@dohc/workspace-auth/session";
import type { PersonalRunningEntry } from "../../sync-relay/src/personalAgents";
import {
  authorizePath, LOOPBACK_REDIRECT, pkce, registeredClient, tokenRequest, type ShareWebSend, type SignedInAgent,
} from "./mcpSignIn.test-helper";

// A personal agent's sign-in as a browser runs it: the account sign-in when
// the browser is signed out, the consent page, and Allow. TestAccounts stands
// in for the account server and its database, as share-web's account route
// and the relay each read them.

export interface TestAccount {
  userId: string;
  name: string;
  email: string;
  password: string;
}

export class TestAccounts implements CredentialFence {
  readonly sessionCookie: string;
  listener: CredentialFenceListener | undefined;
  private readonly sessions = new Map<string, string>();
  private signIns = 0;

  constructor(origin: string, private readonly accounts: readonly TestAccount[]) {
    this.sessionCookie = getCookies({ baseURL: origin }).sessionToken.name;
  }

  /** The account server's session, sign-in and sign-out, as share-web's account route calls them. */
  readonly fetchAuth = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const token = this.sessionToken(request);
    if (path === "/api/auth/get-session") {
      const account = token === null ? undefined : this.account(this.sessions.get(token));
      return Response.json(account
        ? { user: { id: account.userId, name: account.name, email: account.email }, session: { id: token, userId: account.userId } }
        : null);
    }
    if (path === "/api/auth/sign-in/email") {
      const input = await request.json() as { email: string; password: string };
      const account = this.accounts.find((entry) => entry.email === input.email && entry.password === input.password);
      if (!account) return Response.json({ code: "INVALID_EMAIL_OR_PASSWORD" }, { status: 401 });
      const session = `session-${String(++this.signIns)}`;
      this.sessions.set(session, account.userId);
      return Response.json({ user: { id: account.userId, name: account.name, email: account.email }, redirect: false },
        { headers: { "set-cookie": `${this.sessionCookie}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax` } });
    }
    if (path === "/api/auth/sign-out") {
      if (token !== null) this.sessions.delete(token);
      return Response.json({ success: true },
        { headers: { "set-cookie": `${this.sessionCookie}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }
    return new Response(null, { status: 404 });
  };

  /** The relay's account session, from the cookie share-web forwards. */
  readonly resolveAccountSession = async (request: Request): Promise<AccountSession> => {
    const token = this.sessionToken(request);
    const userId = token === null ? undefined : this.sessions.get(token);
    if (token === null || userId === undefined) throw new UnauthorizedError();
    return { userId, sessionId: token, expiresAtMs: Number.MAX_SAFE_INTEGER };
  };

  async readEpoch(): Promise<number> {
    return 0;
  }

  async readConsentCredentials(userId: string): Promise<ConsentCredentials | null> {
    const account = this.account(userId);
    return account ? { epoch: 0, sessionCurrent: true } : null;
  }

  async changedSince(): Promise<CredentialFenceChange[]> {
    return [];
  }

  listen(listener: CredentialFenceListener): { close(): Promise<void> } {
    this.listener = listener;
    return {
      close: async () => {
        if (this.listener === listener) this.listener = undefined;
      },
    };
  }

  private account(userId: string | undefined): TestAccount | undefined {
    return this.accounts.find((entry) => entry.userId === userId);
  }

  private sessionToken(request: Request): string | null {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const pair = part.trim(), separator = pair.indexOf("=");
      if (separator > 0 && pair.slice(0, separator) === this.sessionCookie && separator < pair.length - 1) return pair.slice(separator + 1);
    }
    return null;
  }
}

/** The relay's fence listener comes up and catches up, so a personal agent's work can start. */
export async function listening(relay: { personalAgents: { register(entry: PersonalRunningEntry): () => void } }, accounts: TestAccounts): Promise<void> {
  accounts.listener!.onUp();
  await vi.waitFor(() => relay.personalAgents.register({
    agentId: "probe", ownerUserId: "probe", connectionId: "probe", fenceEpoch: 0, workspaceIds: [], kind: "wait", terminate: () => {},
  })());
}

/** A browser's cookies for share-web: each Set-Cookie replaces its name, and an empty value removes it. */
export class CookieJar {
  private readonly values = new Map<string, string>();

  take(response: Response): Response {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0] ?? "", separator = pair.indexOf("=");
      const name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (value === "" || /;\s*max-age=0\s*(?:;|$)/iu.test(line)) this.values.delete(name);
      else this.values.set(name, value);
    }
    return response;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  forget(prefix: string): void {
    for (const name of [...this.values.keys()]) if (name.startsWith(prefix)) this.values.delete(name);
  }

  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** Sends as a browser: with the jar's cookies, keeping what each answer sets. */
export function browser(send: ShareWebSend, jar: CookieJar): ShareWebSend {
  return async (path, init = {}) => {
    const cookie = jar.header();
    return jar.take(await send(path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } }));
  };
}

/** A page's form field as the browser submits it, or undefined. */
export function formField(html: string, name: string): string | undefined {
  return new RegExp(`name="${name}" value="([^"]*)"`, "u").exec(html)?.[1]?.replace(/&#(\d+);/gu, (_, code: string) => String.fromCharCode(Number(code)));
}

/** A form post from share-web's own page. */
export function pagePost(origin: string, fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

export const personalResource = (origin: string, workspaceId: string) => `${origin}/mcp/agent/w/${encodeURIComponent(workspaceId)}`;

/** Signs the browser in on the page share-web drew, then follows its return. */
export async function signInBrowser(as: ShareWebSend, origin: string, page: string, account: TestAccount): Promise<Response> {
  const signedIn = await as("/oauth/authorize/sign-in", pagePost(origin, {
    return: formField(page, "return") ?? "", email: account.email, password: account.password,
  }));
  const location = signedIn.headers.get("location");
  if (signedIn.status !== 303 || !location) throw new Error(`No sign-in: ${signedIn.status} ${await signedIn.text()}`);
  const back = new URL(location);
  return as(back.pathname + back.search);
}

/**
 * Signs an agent in as `account`'s own at the address naming `workspaceId`.
 * By default it is a new agent, named after its client, at Comment in that
 * workspace; `choices` replaces any field the consent form posts.
 */
export async function signInPersonalAgent(input: {
  send: ShareWebSend;
  origin: string;
  workspaceId: string;
  account: TestAccount;
  clientName?: string;
  jar?: CookieJar;
  choices?: Record<string, string>;
}): Promise<SignedInAgent> {
  const { send, origin, workspaceId, account } = input;
  const as = browser(send, input.jar ?? new CookieJar());
  const resource = personalResource(origin, workspaceId);
  const clientName = input.clientName ?? "Test agent";
  const clientId = await registeredClient(send, clientName);
  const { verifier, challenge } = pkce();
  let page = await as(authorizePath({ clientId, resource, challenge, state: "personal" }));
  let html = await page.text();
  if (html.includes("action=\"/oauth/authorize/sign-in\"")) {
    page = await signInBrowser(as, origin, html, account);
    html = await page.text();
  }
  const request = formField(html, "request"), secret = formField(html, "secret"), back = formField(html, "return");
  if (page.status !== 200 || !request || !secret || back === undefined) throw new Error(`No consent page: ${page.status} ${html}`);
  const decided = await as("/oauth/authorize/agent", pagePost(origin, {
    request, secret, return: back, as: "new", name: clientName, [`w:${workspaceId}`]: "comment",
    ...input.choices, decision: "allow",
  }));
  const location = new URL(decided.headers.get("location") ?? "", LOOPBACK_REDIRECT);
  const code = location.searchParams.get("code");
  if (decided.status !== 303 || !code || location.searchParams.get("state") !== "personal") {
    throw new Error(`No code: ${decided.status} ${location.href} ${await decided.text()}`);
  }
  const tokens = await tokenRequest(send, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier,
    redirect_uri: LOOPBACK_REDIRECT, resource });
  const value = (await tokens.json()) as { access_token?: unknown; refresh_token?: unknown };
  if (tokens.status !== 200 || typeof value.access_token !== "string" || typeof value.refresh_token !== "string") {
    throw new Error(`No tokens: ${tokens.status} ${JSON.stringify(value)}`);
  }
  return { clientId, resource, accessToken: value.access_token, refreshToken: value.refresh_token };
}

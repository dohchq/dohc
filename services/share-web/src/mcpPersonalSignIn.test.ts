import { inspect } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { agentChannelWireId } from "@dohc/security-contract/chat-wire-ids";
import { handleForName } from "@dohc/workspace-contracts/chat-mentions";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import {
  appendLog, chatMessageAppend, chatThreadCreate, claimWorkspace, closeTestStorages, createShare, json, jsonBody, linkSecret,
  RELAY_EXCHANGE_KEY, request, sequenced, testHandler, testStorage, type ChatOp,
} from "../../sync-relay/src/testing";
import { MCP_CORS_HEADERS, signInPageCsp } from "./mcpSignIn";
import { authorizePath, LOOPBACK_REDIRECT, pkce, registeredClient, signInAgent, tokenRequest, type ShareWebSend } from "./mcpSignIn.test-helper";
import {
  browser, CookieJar, formField, listening, pagePost, personalResource, signInBrowser, signInPersonalAgent, TestAccounts, type TestAccount,
} from "./mcpPersonalSignIn.test-helper";
import { createShareWebApplication } from "./server";

// A personal agent's sign-in through the real share-web and the real relay:
// the browser signs in to its account if it has to, then the person chooses
// the agent and the workspaces it reaches, and allows it.
// The share link's sign-in is in mcpSignIn.test.ts.

const HOST = "share.example.test", ORIGIN = `https://${HOST}`;
const NOW = 10_000;
const ADA: TestAccount = { userId: "ada", name: "Ada", email: "ada@example.test", password: "ada password" };
const BEN: TestAccount = { userId: "ben", name: "Ben", email: "ben@example.test", password: "ben password" };
const TRIP = "trip", FUNDRAISER = "fundraiser", GARDEN = "garden";
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

const relays: Array<ReturnType<typeof testHandler>> = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(relays.splice(0).map((relay) => relay.dispose()));
  await closeTestStorages();
});

function expectCors(response: Response) {
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) expect(response.headers.get(name), name).toBe(value);
}

/** A page's text as a person reads it. */
const visible = (html: string) => html.replace(/&#(\d+);/gu, (_, code: string) => String.fromCharCode(Number(code)));

/** Each workspace's choice as the page draws it, by workspace: its radios, and the one checked. */
function reachOf(html: string): Record<string, { offered: string[]; selected: string | null }> {
  const reach: Record<string, { offered: string[]; selected: string | null }> = {};
  for (const [, workspaceId, value, checked] of html.matchAll(/<input type="radio" id="w-\d+-[a-z]+" name="w:([^"]+)" value="([a-z]+)"( checked)?/gu)) {
    const choice = reach[workspaceId!] ??= { offered: [], selected: null };
    choice.offered.push(value!);
    if (checked) choice.selected = value!;
  }
  return reach;
}

const selected = (html: string) => Object.fromEntries(Object.entries(reachOf(html)).map(([workspaceId, choice]) => [workspaceId, choice.selected]));

async function stack(options: { account?: boolean } = {}) {
  const storage = await testStorage();
  const accounts = new TestAccounts(ORIGIN, [ADA, BEN]);
  const relay = testHandler(storage, {
    nowMs: () => NOW, relayExchangeKey: RELAY_EXCHANGE_KEY, credentialFence: accounts,
    resolveAccountSession: accounts.resolveAccountSession, discussionActivity: new DiscussionActivityHub(),
  });
  relays.push(relay);
  await listening(relay, accounts);
  await claimWorkspace(relay, ADA.userId, TRIP);
  await claimWorkspace(relay, ADA.userId, FUNDRAISER);
  await claimWorkspace(relay, BEN.userId, GARDEN);
  const relayCalls: string[] = [];
  let noWorkspaces = false;
  // The next origin sequence of the owner's computer in each workspace.
  const ownerSeqs = new Map<string, number>();
  const ownerSeq = (workspaceId: string, count: number) => {
    const next = ownerSeqs.get(workspaceId) ?? 0;
    ownerSeqs.set(workspaceId, next + count);
    return next;
  };
  const fetchRelay = async (relayRequest: Request) => {
    const path = new URL(relayRequest.url).pathname;
    relayCalls.push(path);
    const answer = await relay(relayRequest);
    if (!noWorkspaces || path !== "/sync/link/agent-authorizations/personal-consent" || answer.status !== 200) return answer;
    // The page's empty state: the relay's answer names no workspace.
    return Response.json({ ...await json(answer), workspaces: [] });
  };
  const application = () => createShareWebApplication({
    relayUrl: "https://relay.example.test", publicRelayUrl: "https://relay.example.test", relayExchangeKey: RELAY_EXCHANGE_KEY,
    publicHosts: new Set([HOST]), nowMs: () => NOW, fetchRelay,
    ...(options.account === false ? {} : {
      accountAuth: { publicOrigin: ORIGIN, upstreamUrl: "https://accounts.example.test" }, fetchAuth: accounts.fetchAuth,
    }),
  });
  let app = application();
  const send: ShareWebSend = (path, init = {}) => app.handle(new Request(ORIGIN + path, { ...init, headers: { host: HOST, ...init.headers } }));
  /** An MCP client signed in with `accessToken` at the address `resource` names. */
  async function connect(accessToken: string, resource: string) {
    const client = new Client({ name: "personal-agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      fetch: async (input, init) => {
        const forwarded = new Request(input, init);
        forwarded.headers.set("host", HOST);
        return app.handle(forwarded);
      },
    }));
    clients.push(client);
    return client;
  }
  const mcp = (path: string, token?: string) => send(path, {
    method: "POST", body: TOOLS_LIST,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });

  /** Opens the consent page for a new client at `workspaceId`'s address, signing the browser in first when it is signed out. */
  async function open(jar: CookieJar, workspaceId: string, account: TestAccount = ADA, clientName = "Trip helper", redirectUri = LOOPBACK_REDIRECT) {
    const as = browser(send, jar);
    const clientId = await registeredClient(send, clientName, redirectUri);
    const { verifier, challenge } = pkce();
    let page = await as(authorizePath({ clientId, resource: personalResource(ORIGIN, workspaceId), challenge, redirectUri, state: "consent" }));
    let html = await page.text();
    if (html.includes("action=\"/oauth/authorize/sign-in\"")) {
      page = await signInBrowser(as, ORIGIN, html, account);
      html = await page.text();
    }
    return { as, page, html, clientId, verifier };
  }

  /** Posts the consent form the page drew, with `fields` as the person filled it in. */
  function choose(as: ShareWebSend, html: string, fields: Record<string, string>) {
    return as("/oauth/authorize/agent", pagePost(ORIGIN, {
      request: formField(html, "request") ?? "", secret: formField(html, "secret") ?? "", return: formField(html, "return") ?? "", ...fields,
    }));
  }

  return {
    send, mcp, connect, open, choose, accounts, relayCalls,
    answerNoWorkspaces() { noWorkspaces = true; },
    restart() { app = application(); },
    /** The owner's own posts, as their computer pushes them to `workspaceId`'s log. */
    ownerSays: (workspaceId: string, ops: ChatOp[]) => appendLog(relay, ADA.userId, workspaceId, sequenced(ops, ownerSeq(workspaceId, ops.length))),
    /** The relay's view of a personal agent's token at its address. */
    authority: (agent: { accessToken: string; resource: string }) => relay.linkAuthority.personal(new Request(
      "https://relay.example.test/sync/link/personal-agent/workspaces", { headers: {
        authorization: `DohcAgent ${agent.accessToken}`, "x-dohc-agent-resource": agent.resource, "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
      } })),
    async shareLinkSecret() {
      const shareId = await createShare(relay, ADA.userId, TRIP, { recipientUserId: "seed-recipient", paths: ["docs"] });
      const created = await relay(request(ADA.userId, `/sync/${TRIP}/shares/${shareId}/links`, jsonBody({ access: "view" })));
      expect(created.status).toBe(200);
      return linkSecret((await json(created)).url);
    },
  };
}

it("signs a signed-out browser in first, then returns to the same sign-in request", async () => {
  const s = await stack();
  const jar = new CookieJar(), as = browser(s.send, jar);
  const clientId = await registeredClient(s.send, "Trip helper");
  const path = authorizePath({ clientId, resource: personalResource(ORIGIN, TRIP), challenge: pkce().challenge, state: "return" });
  const signedOut = await as(path);
  const page = await signedOut.text();
  expect(signedOut.status).toBe(200);
  expect(signedOut.headers.get("content-security-policy")).toBe(signInPageCsp("'self'"));
  expect(page).toContain("<h1>Sign in to dohc</h1>");
  expect(formField(page, "return")).toBe(path.slice("/oauth/authorize?".length));
  // A signed-out view begins nothing at the relay.
  expect(s.relayCalls).not.toContain("/sync/link/agent-authorizations");

  const wrong = await as("/oauth/authorize/sign-in", pagePost(ORIGIN, { return: formField(page, "return")!, email: ADA.email, password: "not it" }));
  expect(wrong.status).toBe(401);
  const wrongPage = await wrong.text();
  expect(wrongPage).toContain("dohc could not sign in with that email and password. Check both, then sign in again.");
  expect(wrongPage).toContain(`value="${ADA.email}"`);
  expect(wrongPage).toContain("aria-invalid=\"true\" aria-describedby=\"password-error\" autofocus>");

  const signedIn = await as("/oauth/authorize/sign-in", pagePost(ORIGIN, { return: formField(page, "return")!, email: ADA.email, password: ADA.password }));
  expect(signedIn.status).toBe(303);
  expect(signedIn.headers.get("location")).toBe(`${ORIGIN}${path}`);
  expect(jar.has(s.accounts.sessionCookie)).toBe(true);

  const consent = await as(path);
  const html = await consent.text();
  expect(consent.status).toBe(200);
  expect(html).toContain(`<span class="host">${HOST}</span>`);
  // A new agent's tile is dashed, with the initial of the name it will have.
  expect(html).toContain("<span class=\"tile agent\">T</span>");
  expect(html).toContain("<h1>Sign in Trip helper as your agent</h1><p class=\"lede\">\"<bdi>Trip helper</bdi>\" is the name the agent gave.</p>");
  expect(html).toContain(`<bdi class="k">${ADA.email}</bdi><button type="submit" form="sign-out" class="link">Not you?</button>`);
  expect(formField(html, "name")).toBe("Trip helper");
  expect(html).toContain(`<p class="cap">@${handleForName("Trip helper")}</p>`);
  expect(html).toContain("<p class=\"cap\">View reads files and chats. Comment also posts in chats and Comments. " +
    "Edit also changes Collections, but no other files.</p>");
  expect(html).toContain("<bdi>Trip helper</bdi> runs outside dohc. dohc limits what it reaches here, not what it does elsewhere.");
  // The redirect goes to a loopback address, so the page names this computer, not the address.
  expect(html).toContain("<span class=\"to\">Returns to an app on this computer</span>");
  expect(html).not.toContain("Returns to 127.0.0.1");
  expect(html).toContain("value=\"cancel\" class=\"btn\">Cancel</button><button type=\"submit\" name=\"decision\" value=\"allow\" class=\"btn primary\">Allow</button>");
  // A browser signed in now is enough: consent asks for no password again.
  expect(html).not.toContain("type=\"password\"");

  // "Not you?" signs the browser out, and the same request asks for an account again.
  const signOut = await as("/oauth/authorize/sign-out", pagePost(ORIGIN, { return: formField(html, "return")! }));
  expect(signOut.status).toBe(303);
  expect(signOut.headers.get("location")).toBe(`${ORIGIN}${path}`);
  expect(jar.has(s.accounts.sessionCookie)).toBe(false);
  expect(await (await as(path)).text()).toContain("<h1>Sign in to dohc</h1>");
});

it("starts the address's workspace at Edit and every other at None, and offers None, View, Comment and Edit", async () => {
  const s = await stack();
  const { page, html } = await s.open(new CookieJar(), FUNDRAISER);
  expect(page.status).toBe(200);
  // Only the account's own workspaces, never another account's.
  expect(reachOf(html)).toEqual({
    [TRIP]: { offered: ["none", "view", "comment", "edit"], selected: "none" },
    [FUNDRAISER]: { offered: ["none", "view", "comment", "edit"], selected: "edit" },
  });
  expect(html).not.toContain(GARDEN);
  // With no agent signed in yet, there is no one to choose.
  expect(html).not.toContain("Who it is");
});

it("asks for at least one workspace and a name, and keeps the choices as the person made them", async () => {
  const s = await stack();
  const { as, html } = await s.open(new CookieJar(), TRIP);
  const none = await s.choose(as, html, { as: "new", name: "Trip helper", [`w:${TRIP}`]: "none", [`w:${FUNDRAISER}`]: "none", decision: "allow" });
  expect(none.status).toBe(400);
  const nonePage = await none.text();
  expect(nonePage).toContain("<div role=\"group\" aria-labelledby=\"reach-label\" aria-describedby=\"reach-error\">" +
    "<div class=\"sec\" id=\"reach-label\">What it can reach</div>");
  expect(nonePage).toContain("<p class=\"error\" id=\"reach-error\">Choose at least one workspace.</p>");
  // The first workspace's choice takes focus.
  expect(nonePage).toMatch(/<input type="radio" id="w-0-none" name="w:[^"]+" value="none" checked autofocus>/u);
  expect(selected(nonePage)).toEqual({ [TRIP]: "none", [FUNDRAISER]: "none" });

  const unnamed = await s.choose(as, html, { as: "new", name: " ", [`w:${TRIP}`]: "view", [`w:${FUNDRAISER}`]: "comment", decision: "allow" });
  expect(unnamed.status).toBe(400);
  const unnamedPage = await unnamed.text();
  expect(unnamedPage).toContain("aria-invalid=\"true\" aria-describedby=\"name-error\" autofocus>");
  expect(unnamedPage).toContain("<p class=\"error\" id=\"name-error\">Enter a name for this agent.</p>");
  expect(selected(unnamedPage)).toEqual({ [TRIP]: "view", [FUNDRAISER]: "comment" });
});

it("says when a sign-in request expired, and never calls another account's workspace expired", async () => {
  const s = await stack();
  const jar = new CookieJar();
  const { as, html } = await s.open(jar, TRIP);
  // The consent cookie lasts as long as the request.
  jar.forget("__Host-dohc_consent_");
  const expired = await s.choose(as, html, { as: "new", name: "Trip helper", [`w:${TRIP}`]: "comment", decision: "allow" });
  expect(expired.status).toBe(403);
  expect(await expired.text()).toContain("This sign-in request expired. Start the sign-in again from your agent.");

  const other = await s.open(new CookieJar(), TRIP, BEN);
  expect(other.page.status).toBe(403);
  const refusal = visible(other.html);
  expect(refusal).toContain(`${BEN.email} does not own the workspace in this agent's link. Sign in as the workspace's owner to continue.`);
  expect(refusal).not.toMatch(/expired|ended/u);
  expect(refusal).toContain("<form method=\"post\" action=\"/oauth/authorize/sign-out\">");
});

it("asks a browser that signed in before the password last changed to sign in again before it allows", async () => {
  const s = await stack();
  const { as, html } = await s.open(new CookieJar(), TRIP);
  s.accounts.changePassword(ADA.userId);
  const allowed = await s.choose(as, html, { as: "new", name: "Trip helper", [`w:${TRIP}`]: "comment", decision: "allow" });
  expect(allowed.status).toBe(200);
  const page = await allowed.text();
  expect(page).toContain("<h1>Sign in to dohc</h1>");
  expect(page).toContain("This browser signed in before your password last changed. Sign in again.");
  expect(page).not.toContain("type=\"radio\"");
});

it("offers only Cancel when the account has no workspace on this server", async () => {
  const s = await stack();
  s.answerNoWorkspaces();
  const { as, html } = await s.open(new CookieJar(), TRIP);
  expect(html).toContain(`<div class="sec">What it can reach</div><div class="empty">Sync a workspace to ${HOST} first.</div>`);
  expect([...html.matchAll(/<button type="submit"[^>]*>([^<]+)<\/button>/gu)].map((button) => button[1])).toEqual(["Not you?", "Cancel"]);

  const cancelled = await s.choose(as, html, { decision: "cancel" });
  expect(cancelled.status).toBe(303);
  const location = new URL(cancelled.headers.get("location") ?? "");
  expect([`${location.origin}${location.pathname}`, location.searchParams.get("error"), location.searchParams.get("state")])
    .toEqual([LOOPBACK_REDIRECT, "access_denied", "consent"]);
});

it("names the host a hosted agent returns to", async () => {
  const s = await stack();
  const { page, html } = await s.open(new CookieJar(), TRIP, ADA, "Relaybot", "https://agents.example.net/callback");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe(signInPageCsp("'self' https://agents.example.net"));
  expect(html).toContain("<span class=\"to\">Returns to agents.example.net</span>");
  expect(html).not.toContain("an app on this computer");
});

it("signs an agent in again from its current reach", async () => {
  const s = await stack();
  const jar = new CookieJar();
  const first = await signInPersonalAgent({ send: s.send, origin: ORIGIN, workspaceId: TRIP, account: ADA, jar,
    choices: { name: "Helper", [`w:${TRIP}`]: "comment", [`w:${FUNDRAISER}`]: "view" } });
  const { agentId } = await s.authority(first);

  const opened = await s.open(jar, FUNDRAISER);
  expect(opened.html).toContain("<div class=\"sec\" id=\"who-label\">Who it is</div><div class=\"box\" role=\"group\" aria-labelledby=\"who-label\">");
  expect(opened.html).toContain("name=\"as\" value=\"new\" class=\"opt\" aria-pressed=\"true\"><span class=\"tick\" aria-hidden=\"true\"></span>" +
    "<span class=\"k\">New agent</span></button>");
  // The first agent takes the first hue, olive.
  expect(opened.html).toContain(`name="as" value="${agentId}" class="opt" aria-pressed="false"><span class="tick" aria-hidden="true"></span>` +
    `<span class="av agent hue-olive" aria-hidden="true">H</span><span class="k"><bdi>Helper</bdi> <span class="sub">@${handleForName("Helper")}`);
  // A new agent starts from the address.
  expect(selected(opened.html)).toEqual({ [TRIP]: "none", [FUNDRAISER]: "edit" });

  const chosen = await s.choose(opened.as, opened.html, { as: agentId, decision: "choose" });
  expect(chosen.status).toBe(200);
  const page = await chosen.text();
  expect(page).toContain(`name="as" value="${agentId}" class="opt" aria-pressed="true">`);
  expect(formField(page, "as")).toBe(agentId);
  expect(page).not.toContain("id=\"name\"");
  // An agent signing in again has a solid tile in its own color.
  expect(page).toContain("<span class=\"tile agent known hue-olive\">H</span>");
  expect(selected(page)).toEqual({ [TRIP]: "comment", [FUNDRAISER]: "view" });
  expect(page).toContain("<bdi>Helper</bdi> runs outside dohc.");

  const allowed = await s.choose(opened.as, page, {
    as: agentId, [`w:${TRIP}`]: "comment", [`w:${FUNDRAISER}`]: "comment", decision: "allow",
  });
  expect(allowed.status).toBe(303);
  const resource = personalResource(ORIGIN, FUNDRAISER);
  const tokens = await tokenRequest(s.send, { grant_type: "authorization_code", client_id: opened.clientId,
    code: new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "", code_verifier: opened.verifier,
    redirect_uri: LOOPBACK_REDIRECT, resource });
  expect(tokens.status).toBe(200);
  const again = await tokens.json() as { access_token: string };
  expect((await s.authority({ accessToken: again.access_token, resource })).agentId).toBe(agentId);
});

it("challenges the personal address, publishes its metadata, and answers preflight from any origin", async () => {
  const s = await stack();
  const path = `/mcp/agent/w/${TRIP}`;
  const challenged = await s.send(path, { method: "POST", body: TOOLS_LIST,
    headers: { origin: "https://inspector.example.test", "content-type": "application/json" } });
  expect(challenged.status).toBe(401);
  expect(challenged.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${path}"`);
  expectCors(challenged);

  const metadata = await s.send(`/.well-known/oauth-protected-resource${path}`);
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toEqual({ resource: `${ORIGIN}${path}`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
  expectCors(metadata);
  for (const preflight of [path, `/.well-known/oauth-protected-resource${path}`]) {
    const answer = await s.send(preflight, { method: "OPTIONS",
      headers: { origin: "https://inspector.example.test", "access-control-request-method": "POST" } });
    expect(answer.status, preflight).toBe(204);
    expectCors(answer);
  }

  // Each address has one spelling, and exists only where a browser's account signs agents in.
  expect((await s.mcp("/mcp/agent/w/%74rip")).status).toBe(404);
  expect((await s.send("/.well-known/oauth-protected-resource/mcp/agent/w/%74rip")).status).toBe(404);
  const linkOnly = await stack({ account: false });
  expect((await linkOnly.mcp(path)).status).toBe(404);
  expect((await linkOnly.send(`/.well-known/oauth-protected-resource${path}`)).status).toBe(404);
});

it("never accepts one family's token at the other's address, nor a personal token at another workspace's", async () => {
  const s = await stack();
  const personal = await signInPersonalAgent({ send: s.send, origin: ORIGIN, workspaceId: TRIP, account: ADA });
  const link = await signInAgent(s.send, ORIGIN, await s.shareLinkSecret());
  const personalPath = new URL(personal.resource).pathname, linkPath = new URL(link.resource).pathname;
  const refused = (path: string) => [401, `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${path}", error="invalid_token"`];
  const crossed = [[personal.accessToken, linkPath], [link.accessToken, personalPath], [personal.accessToken, `/mcp/agent/w/${FUNDRAISER}`]] as const;
  for (const [token, path] of crossed) {
    const answer = await s.mcp(path, token);
    expect([answer.status, answer.headers.get("www-authenticate")], path).toEqual(refused(path));
  }
  // Neither refreshes at the other's address.
  for (const [agent, resource] of [[personal, link.resource], [link, personal.resource]] as const) {
    const refreshed = await tokenRequest(s.send, { grant_type: "refresh_token", client_id: agent.clientId, refresh_token: agent.refreshToken, resource });
    expect([refreshed.status, await refreshed.json()]).toEqual([400, { error: "invalid_grant" }]);
  }
  // Each still works at its own.
  expect((await s.mcp(linkPath, link.accessToken)).status).toBe(200);
  expect((await s.mcp(personalPath, personal.accessToken)).status).toBe(200);
});

it("keeps a personal agent working after share-web restarts: it waits, replies, reads and refreshes", async () => {
  const s = await stack();
  const agent = await signInPersonalAgent({ send: s.send, origin: ORIGIN, workspaceId: TRIP, account: ADA, clientName: "Trip helper" });
  const dm = agentChannelWireId((await s.authority(agent)).agentId);
  await s.ownerSays(TRIP, [
    chatThreadCreate("thread-dm", dm),
    chatMessageAppend("ask", "thread-dm", "Plan the first day?", { authorUserId: ADA.userId, authorDisplayName: ADA.name }),
  ]);
  // share-web keeps nothing for the agent, so a restart changes nothing for it.
  s.restart();
  const client = await s.connect(agent.accessToken, agent.resource);
  const waited = (await client.callTool({ name: "dohc_wait_for_messages", arguments: { timeoutMs: 0 } })).structuredContent as {
    messages: unknown[]; cursor: string; more: boolean;
  };
  expect(waited).toMatchObject({ more: false, messages: [{
    workspace: TRIP, channel: dm, path: null, threadId: "thread-dm", messageId: "ask",
    author: { kind: "human", displayName: ADA.name }, text: "Plan the first day?",
  }] });

  const reply = await client.callTool({ name: "dohc_post_channel",
    arguments: { workspace: TRIP, threadId: "thread-dm", body: "Museums in the morning.", idempotencyKey: "reply-1" } });
  expect(reply.structuredContent).toMatchObject({ ok: true, message: {
    workspace: TRIP, channel: dm, path: null, threadId: "thread-dm", authorKind: "agent", authorDisplayName: "Trip helper",
    body: "Museums in the morning.",
  } });
  const read = (await client.callTool({ name: "dohc_read_channel", arguments: { workspace: TRIP, channel: dm } })).structuredContent as {
    messages: Array<{ body: string | null }>;
  };
  expect(read.messages.map((message) => message.body)).toEqual(["Museums in the morning.", "Plan the first day?"]);
  // Its own reply doesn't come back to it.
  expect((await client.callTool({ name: "dohc_wait_for_messages", arguments: { cursor: waited.cursor, timeoutMs: 0 } })).structuredContent)
    .toMatchObject({ messages: [], more: false });

  const refreshed = await tokenRequest(s.send, { grant_type: "refresh_token", client_id: agent.clientId, refresh_token: agent.refreshToken,
    resource: agent.resource });
  expect(refreshed.status).toBe(200);
  const { access_token: accessToken } = await refreshed.json() as { access_token: string };
  const again = await s.connect(accessToken, agent.resource);
  expect((await again.callTool({ name: "dohc_list_workspaces", arguments: {} })).structuredContent)
    .toMatchObject({ ok: true, agent: { name: "Trip helper", handle: "Triphelper" }, workspaces: [{ workspace: TRIP, level: "comment", dmChannel: dm }] });
});

it("keeps the personal address, its tokens and the password out of the logs", async () => {
  const logged: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => typeof arg === "string" ? arg : inspect(arg, { depth: 6 })).join(" "));
    });
  }
  onTestFinished(() => { vi.restoreAllMocks(); });
  const s = await stack();
  const agent = await signInPersonalAgent({ send: s.send, origin: ORIGIN, workspaceId: TRIP, account: ADA });
  const path = new URL(agent.resource).pathname;
  await s.mcp(path);
  await s.mcp(path, agent.accessToken);
  await s.mcp(path, "D".repeat(43));
  await tokenRequest(s.send, { grant_type: "refresh_token", client_id: agent.clientId, refresh_token: agent.refreshToken, resource: agent.resource });
  for (const secret of [path, agent.accessToken, agent.refreshToken, ADA.password]) expect(logged.join("\n")).not.toContain(secret);
});

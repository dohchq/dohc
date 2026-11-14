import { inspect } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { agentChannelWireId } from "@dohc/security-contract/chat-wire-ids";
import { handleForName } from "@dohc/workspace-contracts/chat-mentions";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import {
  appendLog,
  chatMessageAppend,
  chatThreadCreate,
  claimWorkspace,
  closeTestStorages,
  createShare,
  json,
  jsonBody,
  linkSecret,
  RELAY_EXCHANGE_KEY,
  request,
  sequenced,
  testHandler,
  testStorage,
  type ChatOp,
} from "../../sync-relay/src/testing";
import {
  authorizePath,
  LOOPBACK_REDIRECT,
  pkce,
  registeredClient,
  signInAgent,
  tokenRequest,
  type ShareWebSend,
} from "./mcpSignIn.test-helper";
import {
  browser,
  CookieJar,
  formField,
  listening,
  pagePost,
  personalResource,
  signInBrowser,
  signInPersonalAgent,
  TestAccounts,
  type TestAccount,
} from "./mcpPersonalSignIn.test-helper";
import { createShareWebApplication } from "./server";

// A personal agent's sign-in through the real share-web and the real relay:
// the browser signs in to its account if it has to, then the person chooses
// the agent and the workspaces it reaches, and allows it.
// The share link's sign-in is in mcpSignIn.test.ts.

const HOST = "share.example.test",
  ORIGIN = `https://${HOST}`;
const NOW = 10_000;
const ADA: TestAccount = {
  userId: "ada",
  name: "Ada",
  email: "ada@example.test",
  password: "ada password",
};
const BEN: TestAccount = {
  userId: "ben",
  name: "Ben",
  email: "ben@example.test",
  password: "ben password",
};
const TRIP = "trip",
  FUNDRAISER = "fundraiser",
  GARDEN = "garden";
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
// share-web's live limits, which the personal MCP's live document tools need.
const LIVE_LIMITS = {
  requests: {
    maxPendingRequests: 4,
    maxRequestBytes: 2048,
    maxResponseBytes: 8192,
    timeoutMs: 1000,
  },
  editor: {
    provider: {
      frames: {
        receive: {
          maxFrameBytes: 1024,
          maxStateVectorBytes: 4096,
          maxUpdateBytes: 8192,
          maxSyncBytes: 16384,
        },
        maxQueuedBytes: 16384,
        maxQueuedFrames: 64,
        maxControlBytes: 4096,
        maxControlFrames: 8,
        maxAssemblyBytes: 16384,
      },
      maxPendingUpdateBytes: 16384,
      maxPendingUpdates: 8,
      maxDeliveryAttempts: 4,
    },
    maxHttpResponseBytes: 16384,
    maxSocketBufferedBytes: 16384,
    connectTimeoutMs: 2000,
    sendTimeoutMs: 500,
    drainPollMs: 10,
  },
};

const relays: Array<ReturnType<typeof testHandler>> = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(relays.splice(0).map((relay) => relay.dispose()));
  await closeTestStorages();
});

function reachOf(html: string): Record<string, { offered: string[]; selected: string | null }> {
  const reach: Record<string, { offered: string[]; selected: string | null }> = {};
  for (const [, workspaceId, value, checked] of html.matchAll(
    /<input type="radio" id="w-\d+-[a-z]+" name="w:([^"]+)" value="([a-z]+)"( checked)?/gu,
  )) {
    const choice = (reach[workspaceId!] ??= { offered: [], selected: null });
    choice.offered.push(value!);
    if (checked) choice.selected = value!;
  }
  return reach;
}

const selected = (html: string) =>
  Object.fromEntries(
    Object.entries(reachOf(html)).map(([workspaceId, choice]) => [workspaceId, choice.selected]),
  );

async function stack(options: { account?: boolean; live?: boolean } = {}) {
  const storage = await testStorage();
  const accounts = new TestAccounts(ORIGIN, [ADA, BEN]);
  const relay = testHandler(storage, {
    nowMs: () => NOW,
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    credentialFence: accounts,
    resolveAccountSession: accounts.resolveAccountSession,
    discussionActivity: new DiscussionActivityHub(),
  });
  relays.push(relay);
  await listening(relay, accounts);
  await claimWorkspace(relay, ADA.userId, TRIP);
  await claimWorkspace(relay, ADA.userId, FUNDRAISER);
  await claimWorkspace(relay, BEN.userId, GARDEN);
  const relayCalls: string[] = [];
  const liveCalls: Array<{ path: string; authorization: string | null }> = [];
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
    if (path.startsWith("/sync/live/"))
      liveCalls.push({ path, authorization: relayRequest.headers.get("authorization") });
    const answer = await relay(relayRequest);
    if (
      !noWorkspaces ||
      path !== "/sync/link/agent-authorizations/personal-consent" ||
      answer.status !== 200
    )
      return answer;
    return Response.json({ ...(await json(answer)), workspaces: [] });
  };
  const application = () =>
    createShareWebApplication({
      relayUrl: "https://relay.example.test",
      publicRelayUrl: "https://relay.example.test",
      relayExchangeKey: RELAY_EXCHANGE_KEY,
      publicHosts: new Set([HOST]),
      nowMs: () => NOW,
      fetchRelay,
      ...(options.live ? { linkLive: { publicOrigin: ORIGIN, ...LIVE_LIMITS } } : {}),
      ...(options.account === false
        ? {}
        : {
            accountAuth: { publicOrigin: ORIGIN, upstreamUrl: "https://accounts.example.test" },
            fetchAuth: accounts.fetchAuth,
          }),
    });
  let app = application();
  const send: ShareWebSend = (path, init = {}) =>
    app.handle(new Request(ORIGIN + path, { ...init, headers: { host: HOST, ...init.headers } }));
  async function connect(accessToken: string, resource: string) {
    const client = new Client({ name: "personal-agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        fetch: async (input, init) => {
          const forwarded = new Request(input, init);
          forwarded.headers.set("host", HOST);
          return app.handle(forwarded);
        },
      }),
    );
    clients.push(client);
    return client;
  }
  const mcp = (path: string, token?: string) =>
    send(path, {
      method: "POST",
      body: TOOLS_LIST,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });

  async function open(
    jar: CookieJar,
    workspaceId: string,
    account: TestAccount = ADA,
    clientName = "Trip helper",
    redirectUri = LOOPBACK_REDIRECT,
  ) {
    const as = browser(send, jar);
    const clientId = await registeredClient(send, clientName, redirectUri);
    const { verifier, challenge } = pkce();
    let page = await as(
      authorizePath({
        clientId,
        resource: personalResource(ORIGIN, workspaceId),
        challenge,
        redirectUri,
        state: "consent",
      }),
    );
    let html = await page.text();
    if (html.includes('action="/oauth/authorize/sign-in"')) {
      page = await signInBrowser(as, ORIGIN, html, account);
      html = await page.text();
    }
    return { as, page, html, clientId, verifier };
  }

  function choose(as: ShareWebSend, html: string, fields: Record<string, string>) {
    return as(
      "/oauth/authorize/agent",
      pagePost(ORIGIN, {
        request: formField(html, "request") ?? "",
        secret: formField(html, "secret") ?? "",
        return: formField(html, "return") ?? "",
        ...fields,
      }),
    );
  }

  return {
    send,
    mcp,
    connect,
    open,
    choose,
    accounts,
    relayCalls,
    liveCalls,
    answerNoWorkspaces() {
      noWorkspaces = true;
    },
    restart() {
      app = application();
    },
    ownerSays: (workspaceId: string, ops: ChatOp[]) =>
      appendLog(relay, ADA.userId, workspaceId, sequenced(ops, ownerSeq(workspaceId, ops.length))),
    authority: (agent: { accessToken: string; resource: string }) =>
      relay.linkAuthority.personal(
        new Request("https://relay.example.test/sync/link/personal-agent/workspaces", {
          headers: {
            authorization: `DohcAgent ${agent.accessToken}`,
            "x-dohc-agent-resource": agent.resource,
            "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
          },
        }),
      ),
    async shareLinkSecret() {
      const shareId = await createShare(relay, ADA.userId, TRIP, {
        recipientUserId: "seed-recipient",
        paths: ["docs"],
      });
      const created = await relay(
        request(ADA.userId, `/sync/${TRIP}/shares/${shareId}/links`, jsonBody({ access: "view" })),
      );
      expect(created.status).toBe(200);
      return linkSecret((await json(created)).url);
    },
  };
}

it("starts the address's workspace at Edit and every other at None, and offers None, View, Comment and Edit", async () => {
  const s = await stack();
  const { page, html } = await s.open(new CookieJar(), FUNDRAISER);
  expect(page.status).toBe(200);
  expect(reachOf(html)).toEqual({
    [TRIP]: { offered: ["none", "view", "comment", "edit"], selected: "none" },
    [FUNDRAISER]: { offered: ["none", "view", "comment", "edit"], selected: "edit" },
  });
  expect(html).not.toContain(GARDEN);
  // With no agent signed in yet, there is no one to choose.
  expect(html).not.toContain("Who it is");
});

it("asks a browser that signed in before the password last changed to sign in again before it allows", async () => {
  const s = await stack();
  const { as, html } = await s.open(new CookieJar(), TRIP);
  s.accounts.changePassword(ADA.userId);
  const allowed = await s.choose(as, html, {
    as: "new",
    name: "Trip helper",
    [`w:${TRIP}`]: "comment",
    decision: "allow",
  });
  expect(allowed.status).toBe(200);
  const page = await allowed.text();
  expect(page).toContain("<h1>Sign in to dohc</h1>");
  expect(page).toContain(
    "This browser signed in before your password last changed. Sign in again.",
  );
  expect(page).not.toContain('type="radio"');
});

it("signs an agent in again from its current reach", async () => {
  const s = await stack();
  const jar = new CookieJar();
  const first = await signInPersonalAgent({
    send: s.send,
    origin: ORIGIN,
    workspaceId: TRIP,
    account: ADA,
    jar,
    choices: { name: "Helper", [`w:${TRIP}`]: "comment", [`w:${FUNDRAISER}`]: "view" },
  });
  const { agentId } = await s.authority(first);

  const opened = await s.open(jar, FUNDRAISER);
  expect(opened.html).toContain(
    '<div class="sec" id="who-label">Who it is</div><div class="box" role="group" aria-labelledby="who-label">',
  );
  expect(opened.html).toContain(
    'name="as" value="new" class="opt" aria-pressed="true"><span class="tick" aria-hidden="true"></span>' +
      '<span class="k">New agent</span></button>',
  );
  expect(opened.html).toContain(
    `name="as" value="${agentId}" class="opt" aria-pressed="false"><span class="tick" aria-hidden="true"></span>` +
      `<span class="av agent hue-olive" aria-hidden="true">H</span><span class="k"><bdi>Helper</bdi> <span class="sub">@${handleForName("Helper")}`,
  );
  expect(selected(opened.html)).toEqual({ [TRIP]: "none", [FUNDRAISER]: "edit" });

  const chosen = await s.choose(opened.as, opened.html, { as: agentId, decision: "choose" });
  expect(chosen.status).toBe(200);
  const page = await chosen.text();
  expect(page).toContain(`name="as" value="${agentId}" class="opt" aria-pressed="true">`);
  expect(formField(page, "as")).toBe(agentId);
  expect(page).not.toContain('id="name"');
  expect(page).toContain('<span class="tile agent known hue-olive">H</span>');
  expect(selected(page)).toEqual({ [TRIP]: "comment", [FUNDRAISER]: "view" });
  expect(page).toContain("<bdi>Helper</bdi> runs outside dohc.");

  const allowed = await s.choose(opened.as, page, {
    as: agentId,
    [`w:${TRIP}`]: "comment",
    [`w:${FUNDRAISER}`]: "comment",
    decision: "allow",
  });
  expect(allowed.status).toBe(303);
  const resource = personalResource(ORIGIN, FUNDRAISER);
  const tokens = await tokenRequest(s.send, {
    grant_type: "authorization_code",
    client_id: opened.clientId,
    code: new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "",
    code_verifier: opened.verifier,
    redirect_uri: LOOPBACK_REDIRECT,
    resource,
  });
  expect(tokens.status).toBe(200);
  const again = (await tokens.json()) as { access_token: string };
  expect((await s.authority({ accessToken: again.access_token, resource })).agentId).toBe(agentId);
});

it("never accepts one family's token at the other's address, nor a personal token at another workspace's", async () => {
  const s = await stack();
  const personal = await signInPersonalAgent({
    send: s.send,
    origin: ORIGIN,
    workspaceId: TRIP,
    account: ADA,
  });
  const link = await signInAgent(s.send, ORIGIN, await s.shareLinkSecret());
  const personalPath = new URL(personal.resource).pathname,
    linkPath = new URL(link.resource).pathname;
  const refused = (path: string) => [
    401,
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${path}", error="invalid_token"`,
  ];
  const crossed = [
    [personal.accessToken, linkPath],
    [link.accessToken, personalPath],
    [personal.accessToken, `/mcp/agent/w/${FUNDRAISER}`],
  ] as const;
  for (const [token, path] of crossed) {
    const answer = await s.mcp(path, token);
    expect([answer.status, answer.headers.get("www-authenticate")], path).toEqual(refused(path));
  }
  for (const [agent, resource] of [
    [personal, link.resource],
    [link, personal.resource],
  ] as const) {
    const refreshed = await tokenRequest(s.send, {
      grant_type: "refresh_token",
      client_id: agent.clientId,
      refresh_token: agent.refreshToken,
      resource,
    });
    expect([refreshed.status, await refreshed.json()]).toEqual([400, { error: "invalid_grant" }]);
  }
  expect((await s.mcp(linkPath, link.accessToken)).status).toBe(200);
  expect((await s.mcp(personalPath, personal.accessToken)).status).toBe(200);
});

it("keeps a personal agent working after share-web restarts: it waits, replies, reads and refreshes", async () => {
  const s = await stack();
  const agent = await signInPersonalAgent({
    send: s.send,
    origin: ORIGIN,
    workspaceId: TRIP,
    account: ADA,
    clientName: "Trip helper",
  });
  const dm = agentChannelWireId((await s.authority(agent)).agentId);
  await s.ownerSays(TRIP, [
    chatThreadCreate("thread-dm", dm),
    chatMessageAppend("ask", "thread-dm", "Plan the first day?", {
      authorUserId: ADA.userId,
      authorDisplayName: ADA.name,
    }),
  ]);
  // share-web keeps nothing for the agent, so a restart changes nothing for it.
  s.restart();
  const client = await s.connect(agent.accessToken, agent.resource);
  const waited = (
    await client.callTool({ name: "dohc_wait_for_messages", arguments: { timeoutMs: 0 } })
  ).structuredContent as {
    messages: unknown[];
    cursor: string;
    more: boolean;
  };
  expect(waited).toMatchObject({
    more: false,
    messages: [
      {
        workspace: TRIP,
        channel: dm,
        path: null,
        threadId: "thread-dm",
        messageId: "ask",
        author: { kind: "human", displayName: ADA.name },
        text: "Plan the first day?",
      },
    ],
  });

  const reply = await client.callTool({
    name: "dohc_post_channel",
    arguments: {
      workspace: TRIP,
      threadId: "thread-dm",
      body: "Museums in the morning.",
      idempotencyKey: "reply-1",
    },
  });
  expect(reply.structuredContent).toMatchObject({
    ok: true,
    message: {
      workspace: TRIP,
      channel: dm,
      path: null,
      threadId: "thread-dm",
      authorKind: "agent",
      authorDisplayName: "Trip helper",
      body: "Museums in the morning.",
    },
  });
  const read = (
    await client.callTool({
      name: "dohc_read_channel",
      arguments: { workspace: TRIP, channel: dm },
    })
  ).structuredContent as {
    messages: Array<{ body: string | null }>;
  };
  expect(read.messages.map((message) => message.body)).toEqual([
    "Museums in the morning.",
    "Plan the first day?",
  ]);
  expect(
    (
      await client.callTool({
        name: "dohc_wait_for_messages",
        arguments: { cursor: waited.cursor, timeoutMs: 0 },
      })
    ).structuredContent,
  ).toMatchObject({ messages: [], more: false });

  const refreshed = await tokenRequest(s.send, {
    grant_type: "refresh_token",
    client_id: agent.clientId,
    refresh_token: agent.refreshToken,
    resource: agent.resource,
  });
  expect(refreshed.status).toBe(200);
  const { access_token: accessToken } = (await refreshed.json()) as { access_token: string };
  const again = await s.connect(accessToken, agent.resource);
  expect(
    (await again.callTool({ name: "dohc_list_workspaces", arguments: {} })).structuredContent,
  ).toMatchObject({
    ok: true,
    agent: { name: "Trip helper", handle: "Triphelper" },
    workspaces: [{ workspace: TRIP, level: "comment", dmChannel: dm }],
  });
});

it("opens each live document call with the token that call carries, before and after a refresh", async () => {
  const s = await stack({ live: true });
  const agent = await signInPersonalAgent({
    send: s.send,
    origin: ORIGIN,
    workspaceId: TRIP,
    account: ADA,
    choices: { [`w:${TRIP}`]: "edit" },
  });
  const read = async (accessToken: string) =>
    (
      await (
        await s.connect(accessToken, agent.resource)
      ).callTool({ name: "dohc_read_document", arguments: { workspace: TRIP, path: "plan.md" } })
    ).structuredContent;
  // This relay hosts no live document, so each call is refused, after it asks with its own token.
  expect(await read(agent.accessToken)).toMatchObject({
    ok: false,
    path: "plan.md",
    outcome: "not-applied",
  });
  const refreshed = await tokenRequest(s.send, {
    grant_type: "refresh_token",
    client_id: agent.clientId,
    refresh_token: agent.refreshToken,
    resource: agent.resource,
  });
  expect(refreshed.status).toBe(200);
  const { access_token: accessToken } = (await refreshed.json()) as { access_token: string };
  expect(accessToken).not.toBe(agent.accessToken);
  expect(await read(accessToken)).toMatchObject({
    ok: false,
    path: "plan.md",
    outcome: "not-applied",
  });
  expect(s.liveCalls).toEqual([
    { path: "/sync/live/personal-document", authorization: `DohcAgent ${agent.accessToken}` },
    { path: "/sync/live/personal-document", authorization: `DohcAgent ${accessToken}` },
  ]);
});

it("keeps the personal address, its tokens and the password out of the logs", async () => {
  const logged: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "),
      );
    });
  }
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const s = await stack();
  const agent = await signInPersonalAgent({
    send: s.send,
    origin: ORIGIN,
    workspaceId: TRIP,
    account: ADA,
  });
  const path = new URL(agent.resource).pathname;
  await s.mcp(path);
  await s.mcp(path, agent.accessToken);
  await s.mcp(path, "D".repeat(43));
  await tokenRequest(s.send, {
    grant_type: "refresh_token",
    client_id: agent.clientId,
    refresh_token: agent.refreshToken,
    resource: agent.resource,
  });
  for (const secret of [path, agent.accessToken, agent.refreshToken, ADA.password])
    expect(logged.join("\n")).not.toContain(secret);
});

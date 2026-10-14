import { createServer } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { getCookies } from "better-auth/cookies";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { openSyncRelayStorage } from "../../sync-relay/src/storage";
import type { StorageContext } from "../../sync-relay/src/storage/context";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import { createShareWebApplication } from "../src/server";
import { ensureLocalhostTls } from "../src/testing/device-control/localhostTls.js";

// Real viewer, share-web, relay handler, and SQLite relay storage. Only account identity is a fixture:
// the subprocess harness relay accepts only `Bearer test:` identities, and real accounts need workspace-api with Postgres.
const workspaceId = "workspace", shareId = "share-trip", channelWireId = "wire-trip", threadId = "thread-trip";
const exchangeKey = "shared-channel-browser-exchange-key-of-32-bytes";
const accounts = {
  "ana@example.test": { id: "ana", name: "Ana", grantId: "grant-ana" },
  "riley@example.test": { id: "riley", name: "Riley", grantId: "grant-riley" },
} as const;
type Email = keyof typeof accounts;

test("a group member reads and posts from a phone while a read-only member follows along", async ({ browser }, testInfo) => {
  const tls = await ensureLocalhostTls(), directory = mkdtempSync(join(tmpdir(), "dohc-shared-channel-"));
  const storage = openSyncRelayStorage(join(directory, "relay.sqlite")) as StorageContext;
  storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
  const now = Date.now();
  const history = Array.from({ length: 60 }, (_, index) => ({
    opKind: "chat.message.append",
    payload: { messageId: `seed-${index + 1}`, threadId, authorKind: "human", authorDisplayName: "Owner", authorUserId: "owner",
      body: `Plan item ${index + 1}`, createdAtMs: now - (60 - index) * 60_000 },
  }));
  storage.appendLogBatch({ workspaceId, originId: "owner-desktop", ops: [
    { opKind: "chat.channel.create", payload: { channelId: "channel-trip", name: "Lisbon trip", slug: "lisbon-trip", kind: "channel",
      createdAtMs: 1, wireId: channelWireId, type: "both", folderPath: "trip" } },
    { opKind: "chat.thread.create", payload: { threadId, title: "", createdAtMs: 2, channelSlug: "lisbon-trip", channelWireId } },
    ...history,
  ].map(({ payload, ...op }, originSeq) => ({ ...op, originSeq, recordedAtMs: 1000 + originSeq, payloadJson: JSON.stringify(payload) })) });
  storage.createShare({
    share: { shareId, workspaceId, granterUserId: "owner", createdAtMs: 1, selectorJson: JSON.stringify({ kind: "chat", channelWireId }),
      labels: { subjectName: "Lisbon trip" } },
    grant: { grantId: "grant-ana", shareId, principalKind: "user", principalUserId: "ana", principalEmail: null, access: "read-write",
      generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
  });
  storage.db.prepare(`INSERT INTO sync_relay_share_grants (grant_id, share_id, principal_kind, principal_user_id, principal_email, access,
    generation, status, created_at_ms, revoked_at_ms, parent_grant_id) VALUES ('grant-riley', ?, 'user', 'riley', NULL, 'read-only', 1, 'active', 1, NULL, NULL)`).run(shareId);

  const server = createServer({ key: await readFile(tls.key), cert: await readFile(tls.certificate) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("No listener");
  const viewer = `https://127.0.0.1:${address.port}`, cookieName = getCookies({ baseURL: viewer }).sessionToken.name;
  const sessions = new Map<string, Email>();
  const accountFor = (cookie: string | null) => {
    const email = cookie?.startsWith(`${cookieName}=`) ? sessions.get(cookie.slice(cookieName.length + 1)) : undefined;
    return email ? accounts[email] : null;
  };
  const relay = createSyncRelayHandler({ storage, lookupUserDisplayName: userId => Object.values(accounts).find(account => account.id === userId)?.name ?? null, discussionActivity: new DiscussionActivityHub(), shareWebOrigin: viewer, relayExchangeKey: exchangeKey,
    namedBrowserSessionLimits: { maxSessions: 16, retentionMs: 60_000, maxPendingRequests: 16, maxRequestBytes: 100_000, maxResponseBytes: 200_000, timeoutMs: 10_000 },
    resolveActor(request, scope) {
      if (request.headers.get("authorization") === "Bearer owner") return { workspaceId: scope, userId: "owner" };
      const account = accountFor(request.headers.get("cookie"));
      if (!account) throw new UnauthorizedError();
      return { workspaceId: scope, userId: account.id };
    } });
  const application = createShareWebApplication({
    relayUrl: "https://relay.example.org", publicRelayUrl: "https://relay.example.org", relayExchangeKey: exchangeKey,
    publicHosts: new Set([new URL(viewer).host]), viewerAssetsDir: fileURLToPath(new URL("../viewer/dist", import.meta.url)),
    accountAuth: { publicOrigin: viewer, upstreamUrl: "https://auth.example.org" },
    namedBrowserSessionLimits: { maxPendingRequests: 16, maxRequestBytes: 100_000, maxResponseBytes: 200_000, timeoutMs: 10_000 },
    fetchRelay: relay,
    fetchAuth: async request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session") {
        const account = accountFor(request.headers.get("cookie"));
        return Response.json(account ? { user: { id: account.id, name: account.name }, session: { userId: account.id } } : null);
      }
      if (path === "/api/auth/sign-in/email") {
        const input = await request.json() as { email: string; password: string };
        if (!(input.email in accounts) || input.password !== "fixture-password") return new Response(null, { status: 401 });
        const token = `${accounts[input.email as Email].id}-session`; sessions.set(token, input.email as Email);
        const account = accounts[input.email as Email];
        return Response.json({ redirect: false, user: { id: account.id, name: account.name } },
          { headers: { "set-cookie": `${cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/` } });
      }
      return new Response(null, { status: 404 });
    },
  });
  const failures: string[] = [];
  server.on("request", async (incoming, outgoing) => {
    // A browser that drops a long poll releases its relay waiter.
    const controller = new AbortController();
    outgoing.on("close", () => { if (!outgoing.writableFinished) controller.abort(); });
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const response = await application.handle(new Request(`https://${incoming.headers.host}${incoming.url}`, { method: incoming.method, headers,
        signal: controller.signal, ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }));
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers),
        ...(response.headers.has("set-cookie") ? { "set-cookie": response.headers.getSetCookie() } : {}) });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (!controller.signal.aborted) failures.push(String(error));
      if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end();
    }
  });

  const phone = (current: Browser) => current.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const open = async (page: Page, email: Email) => {
    page.on("pageerror", error => failures.push(String(error)));
    await page.goto(`${viewer}/s/chat/${encodeURIComponent(accounts[email].grantId)}`);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lisbon trip");
    await expect(page.getByText("Plan item 60", { exact: true })).toBeVisible();
  };
  const anaContext = await phone(browser), rileyContext = await phone(browser);
  try {
    const riley = await rileyContext.newPage();
    await open(riley, "riley@example.test");
    await expect(riley.getByText("You can read this channel but not post. The owner gave you read-only access.")).toBeVisible();
    await expect(riley.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await riley.screenshot({ path: testInfo.outputPath("shared-channel-read-only.png") });

    const ana = await anaContext.newPage();
    await open(ana, "ana@example.test");
    const composer = ana.getByRole("textbox", { name: "Message" });
    expect(await ana.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(844);
    await ana.screenshot({ path: testInfo.outputPath("shared-channel-phone.png") });

    // Older history arrives on demand and keeps the reader's place.
    const oldestLoaded = ana.getByText("Plan item 11", { exact: true });
    await expect(ana.getByText("Plan item 10", { exact: true })).toHaveCount(0);
    const loadEarlier = ana.getByRole("button", { name: "Load earlier messages", exact: true });
    await loadEarlier.scrollIntoViewIfNeeded();
    const before = (await oldestLoaded.boundingBox())!.y;
    await loadEarlier.click();
    await expect(ana.getByText("Plan item 1", { exact: true })).toBeAttached();
    expect(Math.abs((await oldestLoaded.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
    await expect(ana.getByRole("button", { name: "Load earlier messages", exact: true })).toHaveCount(0);

    await composer.focus();
    expect(await composer.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe("none");
    await composer.fill("Booked the **hotel** near Alfama.");
    await ana.getByRole("button", { name: "Send", exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(ana.locator(".chat-list strong", { hasText: "hotel" })).toBeVisible();
    await expect(riley.locator(".chat-list strong", { hasText: "hotel" })).toBeVisible();

    // A message from the owner's desktop reaches both browsers without a reload, after an agent message
    // that has no author ID and a body over the browser response budget.
    const tooLong = "This message is too long to show in the browser.";
    storage.appendLogBatch({ workspaceId, originId: "owner-agent", ops: [{ originSeq: 0, opKind: "chat.message.append", recordedAtMs: Date.now(),
      payloadJson: JSON.stringify({ messageId: "agent-report", threadId, authorKind: "agent", authorDisplayName: "Planner",
        authorOwnerDisplayName: "Owner", body: "x".repeat(210_000), createdAtMs: Date.now() }) }] });
    const owner = await relay(new Request(`https://relay.example.org/sync/${workspaceId}/log`, { method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ originId: "owner-laptop", ops: [{ originSeq: 0, opKind: "chat.message.append", recordedAtMs: Date.now(),
        payload: { messageId: "owner-live", threadId, authorKind: "human", authorDisplayName: "Owner", authorUserId: "owner",
          body: "Flights are confirmed.", createdAtMs: Date.now() } }] }) }));
    expect(owner.status).toBe(200);
    await expect(ana.getByText("Flights are confirmed.", { exact: true })).toBeVisible();
    await expect(riley.getByText("Flights are confirmed.", { exact: true })).toBeVisible();
    await expect(ana.getByText(tooLong, { exact: true })).toBeVisible();
    await expect(riley.getByText(tooLong, { exact: true })).toBeVisible();

    await ana.reload();
    await expect(ana.locator(".chat-list strong", { hasText: "hotel" })).toBeVisible();
    await expect(ana.getByText(tooLong, { exact: true })).toBeVisible();
    await ana.emulateMedia({ colorScheme: "dark" });
    await ana.screenshot({ path: testInfo.outputPath("shared-channel-phone-dark.png") });

    const refused = await riley.evaluate(async body => {
      const response = await fetch("/api/named-chat/messages", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as unknown };
    }, { shareId, channelWireId, id: "riley-direct", body: "Read-only post", authorKind: "human" });
    expect(refused).toEqual({ status: 403, body: expect.objectContaining({ ok: false, code: "share_read_only" }) });
    await riley.reload();
    await expect(riley.getByText("Flights are confirmed.", { exact: true })).toBeVisible();
    await expect(riley.getByText("Read-only post")).toHaveCount(0);
    expect(failures).toEqual([]);
  } finally {
    await anaContext.close(); await rileyContext.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

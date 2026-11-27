import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { getCookies } from "better-auth/cookies";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { openSyncRelayStorage } from "../../sync-relay/src/storage";
import type { StorageContext } from "../../sync-relay/src/storage/context";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import { createShareWebApplication } from "../src/server";
import { ensureLocalhostTls } from "../src/testing/device-control/localhostTls.js";

// Real viewer, share-web, relay handler and SQLite relay storage. Only account identity is a fixture, as in shared-channel.spec.ts.
// A workspace member who has no dohc app reads a page, comments on it and posts in a Group, while the owner's desktop reads the same log.
// The owner then opens the same workspace from their list of workspaces in another browser.
const workspaceId = "workspace-trip",
  exchangeKey = "member-workspace-browser-exchange-key-32b";
const accounts = {
  "sam@example.test": { id: "sam", name: "Sam" },
  "ana@example.test": { id: "owner", name: "Ana" },
} as const;
type Email = keyof typeof accounts;

test("a member reads a page, comments on it and posts in a Group in the browser while the owner's desktop reads them", async ({
  browser,
}, testInfo) => {
  const tls = await ensureLocalhostTls(),
    directory = mkdtempSync(join(tmpdir(), "dohc-member-workspace-"));
  const storage = openSyncRelayStorage(join(directory, "relay.sqlite")) as StorageContext;
  const server = createServer({
    key: await readFile(tls.key),
    cert: await readFile(tls.certificate),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No listener");
  const viewer = `https://127.0.0.1:${address.port}`,
    cookieName = getCookies({ baseURL: viewer }).sessionToken.name;
  const sessions = new Map<string, Email>();
  const accountFor = (cookie: string | null) => {
    const email = cookie?.startsWith(`${cookieName}=`)
      ? sessions.get(cookie.slice(cookieName.length + 1))
      : undefined;
    return email ? accounts[email] : null;
  };
  let ids = 0;
  const relay = createSyncRelayHandler({
    storage,
    discussionActivity: new DiscussionActivityHub(),
    shareWebOrigin: viewer,
    relayExchangeKey: exchangeKey,
    // share-web forwards the owner's browser to open a page with the account cookie it signed in with.
    resolvePhoneCapableAccountSession: async (request) => {
      const account = accountFor(request.headers.get("cookie"));
      if (!account) throw new UnauthorizedError();
      return {
        userId: account.id,
        sessionId: `${account.id}-browser`,
        expiresAtMs: Date.now() + 3_600_000,
        clientKind: "browser",
      };
    },
    lookupUserDisplayName: (userId) =>
      userId === "owner"
        ? "Ana"
        : (Object.values(accounts).find((account) => account.id === userId)?.name ?? null),
    resolveUserIdByEmail: (email) => (email in accounts ? accounts[email as Email].id : null),
    lookupUserEmail: (userId) => `${userId}@example.test`,
    lookupVerifiedUserEmail: (userId) => `${userId}@example.test`,
    newShareId: () => `share-${ids++}`,
    newGrantId: () => `grant-${ids++}`,
    namedBrowserSessionLimits: {
      maxSessions: 16,
      retentionMs: 60_000,
      maxPendingRequests: 16,
      maxRequestBytes: 100_000,
      maxResponseBytes: 200_000,
      timeoutMs: 10_000,
    },
    resolveActor(request, scope) {
      if (request.headers.get("authorization") === "Bearer owner")
        return { workspaceId: scope, userId: "owner" };
      const account = accountFor(request.headers.get("cookie"));
      if (!account) throw new UnauthorizedError();
      return { workspaceId: scope, userId: account.id };
    },
  });
  const owner = async (path: string, init: RequestInit = {}) => {
    const response = await relay(
      new Request(`https://relay.example.org${path}`, {
        ...init,
        headers: {
          authorization: "Bearer owner",
          ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      }),
    );
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
    return response;
  };
  let originSeq = 0;
  const append = (ops: Array<{ opKind: string; payload: Record<string, unknown> }>) =>
    owner(`/sync/${workspaceId}/log`, {
      method: "POST",
      body: JSON.stringify({
        originId: "owner-desktop",
        ops: ops.map((op) => ({ ...op, originSeq: originSeq++, recordedAtMs: Date.now() })),
      }),
    });
  // As the owner's dohc writes: an overwrite states the version it replaces, and a new file states that there was none.
  const written = new Map<string, { sha: string; momentId: string }>();
  const write = async (path: string, text: string) => {
    const sha = createHash("sha256").update(text).digest("hex"),
      momentId = `moment-${originSeq}`,
      before = written.get(path);
    await owner(`/sync/${workspaceId}/blobs/${sha}`, { method: "PUT", body: Buffer.from(text) });
    await append([
      {
        opKind: "moment.append",
        payload: {
          momentId,
          versionId: "main",
          objectId: `object-${path}`,
          path,
          recordedAtMs: Date.now(),
          operation: "write",
          payloadBeforeBlobSha256: before?.sha ?? null,
          payloadBeforePath: before ? path : null,
          payloadAfterBlobSha256: sha,
          payloadAfterPath: path,
          metadata: { origin: "user" },
          ...(before
            ? {
                beforePresent: "present",
                beforeObjectId: `object-${path}`,
                beforeVersionId: "main",
                beforePath: path,
                beforeBlobSha256: before.sha,
                beforeLatestMomentId: before.momentId,
              }
            : { beforePresent: "null" }),
        },
      },
    ]);
    written.set(path, { sha, momentId });
  };
  const group = (wireId: string, name: string) => [
    {
      opKind: "chat.channel.create",
      payload: {
        channelId: `channel-${wireId}`,
        name,
        slug: name,
        kind: "channel",
        createdAtMs: 1,
        wireId,
        type: "both",
        purpose: "",
        folderPath: name,
      },
    },
    {
      opKind: "chat.thread.create",
      payload: {
        threadId: `thread-${wireId}`,
        title: "",
        createdAtMs: 2,
        channelSlug: name,
        channelWireId: wireId,
      },
    },
  ];
  const message = (wireId: string, id: string, body: string) => ({
    opKind: "chat.message.append",
    payload: {
      messageId: id,
      threadId: `thread-${wireId}`,
      authorKind: "human",
      authorDisplayName: "Ana",
      authorUserId: "owner",
      body,
      createdAtMs: Date.now(),
    },
  });

  await owner("/sync/workspaces", { method: "POST", body: JSON.stringify({ workspaceId }) });
  await owner(`/sync/workspaces/${workspaceId}/name`, {
    method: "PUT",
    body: JSON.stringify({ name: "Lisbon trip" }),
  });
  await append([
    ...group("wire-planning", "planning"),
    message("wire-planning", "seed-1", "Hotel is booked."),
    ...group("wire-food", "food"),
  ]);
  await write("trip/itinerary.md", "# Itinerary\n\nLand at 10:40, then the metro to Baixa-Chiado.");
  await write("trip/packing.md", "# Packing\n\nWalking shoes.");
  await owner(`/sync/${workspaceId}/members/invites`, {
    method: "POST",
    body: JSON.stringify({ email: "sam@example.test", workspaceName: "Lisbon trip" }),
  });
  const grantId = storage.db
    .prepare(`SELECT g.grant_id AS grantId FROM sync_relay_share_grants g JOIN sync_relay_shares s ON s.share_id = g.share_id
    WHERE s.workspace_id = ? AND g.principal_user_id = 'sam' AND g.status = 'active'`)
    .get(workspaceId) as { grantId: string } | undefined;
  expect(grantId).toBeDefined();

  const application = createShareWebApplication({
    relayUrl: "https://relay.example.org",
    publicRelayUrl: "https://relay.example.org",
    relayExchangeKey: exchangeKey,
    publicHosts: new Set([new URL(viewer).host]),
    viewerAssetsDir: fileURLToPath(new URL("../viewer/dist", import.meta.url)),
    accountAuth: { publicOrigin: viewer, upstreamUrl: "https://auth.example.org" },
    namedBrowserSessionLimits: {
      maxPendingRequests: 16,
      maxRequestBytes: 100_000,
      maxResponseBytes: 200_000,
      timeoutMs: 10_000,
    },
    fetchRelay: relay,
    fetchAuth: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/get-session") {
        const account = accountFor(request.headers.get("cookie"));
        return Response.json(
          account
            ? { user: { id: account.id, name: account.name }, session: { userId: account.id } }
            : null,
        );
      }
      if (path === "/api/auth/sign-in/email") {
        const input = (await request.json()) as { email: string; password: string };
        if (!(input.email in accounts) || input.password !== "fixture-password")
          return new Response(null, { status: 401 });
        const account = accounts[input.email as Email],
          token = `${account.id}-session`;
        sessions.set(token, input.email as Email);
        return Response.json(
          { redirect: false, user: { id: account.id, name: account.name } },
          {
            headers: {
              "set-cookie": `${cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/`,
            },
          },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const failures: string[] = [],
    inflight = new Set<Promise<void>>();
  // Teardown waits for requests still running, so none reaches the relay's storage after it closes.
  server.on("request", (incoming, outgoing) => {
    const done = serve(incoming, outgoing);
    inflight.add(done);
    void done.finally(() => inflight.delete(done));
  });
  const serve = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const controller = new AbortController();
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const response = await application.handle(
        new Request(`https://${incoming.headers.host}${incoming.url}`, {
          method: incoming.method,
          headers,
          signal: controller.signal,
          ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      outgoing.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        ...(response.headers.has("set-cookie")
          ? { "set-cookie": response.headers.getSetCookie() }
          : {}),
      });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (!controller.signal.aborted) failures.push(String(error));
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    }
  };

  const newContext = () =>
    browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
  const context = await newContext();
  const ownerContext = await newContext();
  const signIn = async (page: Page, email: Email) => {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  };
  try {
    const page: Page = await context.newPage();
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${viewer}/s/workspace/${encodeURIComponent(grantId!.grantId)}`);
    await signIn(page, "sam@example.test");

    const files = page.getByRole("navigation", { name: "Workspace files" });
    await expect(files.getByRole("heading", { level: 1 })).toHaveText("Lisbon trip");
    await expect(page.getByText("Land at 10:40, then the metro to Baixa-Chiado.")).toBeVisible();
    await files.getByRole("treeitem", { name: "packing.md" }).click();
    await expect(page.getByText("Walking shoes.")).toBeVisible();

    const chats = page.getByRole("region", { name: "Chats" });
    await expect(chats.getByText("Hotel is booked.")).toBeVisible();
    await chats.getByRole("textbox", { name: "Message" }).fill("I'll buy the train tickets.");
    await chats.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chats.getByText("I'll buy the train tickets.")).toBeVisible();

    // The owner's desktop reads the member's message from the workspace log, in the Group it was posted to.
    const log = (await (await owner(`/sync/${workspaceId}/log?since=0&limit=500`)).json()) as {
      ops: Array<{ opKind: string; payload?: unknown; payloadJson?: string }>;
    };
    const payloads = log.ops.map((op) => ({
      opKind: op.opKind,
      ...((op.payload ?? JSON.parse(op.payloadJson ?? "{}")) as {
        body?: string;
        threadId?: string;
        authorUserId?: string;
        channelWireId?: string;
      }),
    }));
    const posted = payloads.find(
      (op) => op.opKind === "chat.message.append" && op.body === "I'll buy the train tickets.",
    );
    expect(posted).toMatchObject({ authorUserId: "sam" });
    expect(
      payloads.find((op) => op.opKind === "chat.thread.create" && op.threadId === posted!.threadId),
    ).toMatchObject({ channelWireId: "wire-planning" });

    // The owner's overwrite of the open page and next file reach the browser without a reload; the other Group counts its message.
    await files.getByRole("treeitem", { name: "itinerary.md" }).click();
    await write(
      "trip/itinerary.md",
      "# Itinerary\n\nLand at 10:40, then the 11:15 train to Sintra.",
    );
    await expect(page.getByText("Land at 10:40, then the 11:15 train to Sintra.")).toBeVisible();
    await write("trip/budget.md", "# Budget\n\nHotel 780, flights 640.");
    await files.getByRole("treeitem", { name: "budget.md" }).click();
    await expect(page.getByText("Hotel 780, flights 640.")).toBeVisible();
    await append([message("wire-food", "food-1", "Cervejaria Ramiro on Friday?")]);
    await expect(chats.getByRole("button", { name: "All Groups" })).toContainText("1");

    // Sam comments on the itinerary. The owner's desktop reads a thread on that file, written by Sam.
    await files.getByRole("treeitem", { name: "itinerary.md" }).click();
    await page.getByRole("tab", { name: "Comments" }).click();
    const comments = page.getByRole("region", { name: "Comments" });
    await expect(comments.getByText("No comments yet.")).toBeVisible();
    await comments.getByRole("textbox", { name: "Comment" }).fill("Can we take the earlier train?");
    await comments.getByRole("button", { name: "Send", exact: true }).click();
    await expect(comments.getByText("Can we take the earlier train?")).toBeVisible();
    const after = (await (
      await owner(`/sync/${workspaceId}/log?since=0&limit=500`)
    ).json()) as typeof log;
    const ops = after.ops.map((op) => ({
      opKind: op.opKind,
      ...((op.payload ?? JSON.parse(op.payloadJson ?? "{}")) as {
        body?: string;
        threadId?: string;
        authorUserId?: string;
        linkedObjectId?: string;
      }),
    }));
    const comment = ops.find(
      (op) => op.opKind === "chat.message.append" && op.body === "Can we take the earlier train?",
    );
    expect(comment).toMatchObject({ authorUserId: "sam" });
    expect(
      ops.find((op) => op.opKind === "chat.thread.create" && op.threadId === comment!.threadId),
    ).toMatchObject({ linkedObjectId: "object-trip/itinerary.md" });
    await page.screenshot({ path: testInfo.outputPath("member-workspace.png") });

    // Sam's list of workspaces links the one Sam joined.
    await page.goto(`${viewer}/workspaces`);
    await expect(page.getByRole("link", { name: "Lisbon trip" })).toHaveAttribute(
      "href",
      `/s/workspace/${encodeURIComponent(grantId!.grantId)}`,
    );

    // The owner signs in on the list, opens the workspace, reads it, and posts in a Group.
    const ownerPage = await ownerContext.newPage();
    ownerPage.on("pageerror", (error) => failures.push(String(error)));
    await ownerPage.goto(`${viewer}/workspaces`);
    await signIn(ownerPage, "ana@example.test");
    await expect(ownerPage.getByRole("link", { name: "Lisbon trip" })).toBeVisible();
    await ownerPage.screenshot({ path: testInfo.outputPath("owner-workspaces.png") });
    await ownerPage.getByRole("link", { name: "Lisbon trip" }).click();
    await expect(ownerPage).toHaveURL(`${viewer}/s/workspace/owner/${workspaceId}`);
    const ownerFiles = ownerPage.getByRole("navigation", { name: "Workspace files" });
    await expect(ownerFiles.getByRole("heading", { level: 1 })).toHaveText("Lisbon trip");
    // Opening a page asks the relay for the owner's live editor, as the phone does. This relay hosts no live pages, so the page reads quietly.
    const ownerOpen = ownerPage.waitForResponse((response) =>
      response.url().endsWith("/api/live/owner-open"),
    );
    await ownerFiles.getByRole("treeitem", { name: "budget.md" }).click();
    const opened = await ownerOpen;
    expect(opened.request().postDataJSON()).toEqual({ workspaceId, path: "trip/budget.md" });
    expect([opened.status(), await opened.json()]).toEqual([
      409,
      { ok: false, code: "live_hosting_unsupported" },
    ]);
    await expect(ownerPage.getByText("Hotel 780, flights 640.")).toBeVisible();
    await expect(ownerPage.getByText("Opening the file…")).toHaveCount(0);
    await expect(ownerPage.locator(".workspace-toast")).toHaveCount(0);
    await expect(ownerPage.locator("header + .page-band")).toHaveText("");
    await expect(ownerPage.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await ownerPage.screenshot({ path: testInfo.outputPath("owner-live.png") });
    await expect(ownerPage.getByText("Owner", { exact: true })).toBeVisible();
    const ownerChats = ownerPage.getByRole("region", { name: "Chats" });
    await expect(ownerChats.getByText("I'll buy the train tickets.")).toBeVisible();
    await ownerChats.getByRole("textbox", { name: "Message" }).fill("Thanks, Sam.");
    await ownerChats.getByRole("button", { name: "Send", exact: true }).click();
    await expect(ownerChats.getByText("Thanks, Sam.")).toBeVisible();
    // The owner's desktop reads the post from the log as a message of theirs, from their browser, in that Group.
    const ownerLog = (await (await owner(`/sync/${workspaceId}/log?since=0&limit=500`)).json()) as {
      ops: Array<{ opKind: string; originId: string; payload?: unknown; payloadJson?: string }>;
    };
    const ownerOps = ownerLog.ops.map((op) => ({
      opKind: op.opKind,
      originId: op.originId,
      ...((op.payload ?? JSON.parse(op.payloadJson ?? "{}")) as {
        body?: string;
        threadId?: string;
      }),
    }));
    const thanks = ownerOps.find(
      (op) => op.opKind === "chat.message.append" && op.body === "Thanks, Sam.",
    );
    expect(thanks).toMatchObject({ authorUserId: "owner", originId: "relay:owner-browser:owner" });
    expect(
      ownerOps.find((op) => op.opKind === "chat.thread.create" && op.threadId === thanks!.threadId),
    ).toMatchObject({ channelWireId: "wire-planning" });
    await ownerPage.screenshot({ path: testInfo.outputPath("owner-chat.png") });
    // The owner mentions their agent, whose only computer is offline. Only the owner's page says it waits.
    storage.replaceChatRunners({
      accountId: "owner",
      workspaceId,
      installId: "laptop",
      computerLabel: "Ana's laptop",
      runners: [{ agentId: "claude", handle: "claude", displayName: "Claude", enabled: true }],
      nowMs: Date.now(),
    });
    await ownerChats
      .getByRole("textbox", { name: "Message" })
      .fill("@claude book the Sintra train");
    await ownerChats.getByRole("button", { name: "Send", exact: true }).click();
    const waiting = ownerChats.locator(".chat-message", { hasText: "book the Sintra train" });
    await expect(waiting.locator(".chat-wake")).toHaveText("Claude is waiting for a computer");
    await expect(ownerChats.getByText("Ana's laptop")).toHaveCount(0);
    await waiting.screenshot({ path: testInfo.outputPath("owner-wake-light.png") });
    await ownerPage.emulateMedia({ colorScheme: "dark" });
    await waiting.screenshot({ path: testInfo.outputPath("owner-wake-dark.png") });
    await ownerPage.emulateMedia({ colorScheme: "light" });
    await page.goto(`${viewer}/s/workspace/${encodeURIComponent(grantId!.grantId)}`);
    await expect(chats.getByText("@claude book the Sintra train")).toBeVisible();
    await expect(page.locator(".chat-wake")).toHaveCount(0);
    // A write from the owner's computer reaches the open page without a reload.
    await write("trip/budget.md", "# Budget\n\nHotel 780, flights 640, train 30.");
    await expect(ownerPage.getByText("Hotel 780, flights 640, train 30.")).toBeVisible();
    await ownerPage.screenshot({ path: testInfo.outputPath("owner-workspace.png") });
    expect(failures).toEqual([]);
  } finally {
    await ownerContext.close();
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...inflight]);
    storage.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

import { afterEach, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  UnauthorizedError,
  type ResolveAccountSession,
  type StoredAccountSession,
} from "@dohc/workspace-auth/session";
import { createAccountFeedWaits } from "./accountFeed";
import { createAccountOperationRoute } from "./accountOperationRoutes";
import { createChatWakeWaits } from "./chatWakeRoutes";
import { DiscussionActivityHub } from "./discussionActivity";
import { errorResponse } from "./errors";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import type { LiveTicketScope } from "./liveBrowserContext";
import { binding, scope } from "./liveTickets.test-helper";
import { personalRouteFixture } from "./personalLiveDocumentRoutes.test-helper";
import { createPhonePages, PHONE_OWNER_DOCUMENTS_PER_ACCOUNT } from "./phonePages";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { SERVICE_HOST_ENROLLMENTS } from "./storage/serviceHostEnrollment";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { createLiveJournalHistoryAuthority } from "./storage/liveJournalHistory";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

// The personal route fixture's activation namespace, which its `ready()` retains an activation under.
const namespace = "personal-live-route-test";
const editorLimits = selfHostLiveProfile().editor;

// `Bearer session:<user>:<session>:<kind>`, or the cookie `account=<user>:<session>:<kind>`, as the relay's phone-capable resolver answers them.
const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match =
    /^Bearer session:([\w-]+):([\w-]+):(phone|desktop|browser)$/u.exec(
      request.headers.get("authorization") ?? "",
    ) ??
    /^account=([\w-]+):([\w-]+):(phone|desktop|browser)$/u.exec(
      request.headers.get("cookie") ?? "",
    );
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: match[3] as "phone" | "desktop" | "browser",
  };
};
const SHARE_WEB = "https://share.test",
  EXCHANGE_KEY = "k".repeat(43);

/**
 * The personal route fixture's workspace, with docs/a.md and the fake live
 * host, behind the account operation route on a server that keeps no copies.
 * docs/a.md has a live lineage on main, as a desktop's first open leaves it.
 */
async function phone(options: { waitMs?: number } = {}) {
  // Without the agents' route, whose readiness would attach a second history authority to the same storage.
  const f = await personalRouteFixture(
    (close) => {
      cleanup.push(close);
    },
    { live: false },
  );
  const now = 2_000;
  // The session table, as the uncached read finds it. The phone's sign-in ends sooner than its resolver says.
  const stored = new Map<string, StoredAccountSession>([
    ["phone-1", { userId: "owner-1", expiresAtMs: 2_020, clientKind: "phone" }],
    ["browser-1", { userId: "owner-1", expiresAtMs: 2_020, clientKind: "browser" }],
  ]);
  const sessions = {
    read: vi.fn(
      async (ids: readonly string[]) =>
        new Map(
          ids.flatMap((id): Array<[string, StoredAccountSession]> => {
            const session = stored.get(id);
            return session ? [[id, session]] : [];
          }),
        ),
    ),
  };
  const mint = vi.fn(
    async (_input: unknown, ticketScope: LiveTicketScope, _signal?: AbortSignal) => ({
      token: "ticket-token",
      expiresAtMs:
        ticketScope.kind === "owner"
          ? Math.min(now + 30_000, ticketScope.sessionExpiresAtMs)
          : now + 30_000,
    }),
  );
  let sequence = 100;
  /** A Y.Doc update for the object reaches the relay in `versionId`, as a desktop's first live open publishes one. */
  const publish = (objectId: string, versionId = "main") =>
    f.raw
      .prepare(
        "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'desktop',?,'ydoc.update',?,2,?)",
      )
      .run(scope.workspaceId, sequence, JSON.stringify({ objectId, versionId }), sequence++);
  publish(binding.objectId);
  const reconcile = vi.fn();
  const pages = createPhonePages({
    storage: f.storage,
    history: createLiveJournalHistoryAuthority({ namespace, reconciled: true }),
    host: { ...f.host, reconcile },
    supported: () => true,
    tickets: { mint },
    sessions,
    nowMs: () => now,
    editorLimits,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
  });
  const hub = new DiscussionActivityHub();
  const route = createAccountOperationRoute({
    storage: f.storage,
    resolveAccountSession,
    // No copies: a page open never visits one.
    copies: () => undefined,
    nowMs: () => now,
    limiter: new TokenBucketLimiter(1_000, 1_000, 4_096),
    feedWaits: createAccountFeedWaits(f.storage, hub),
    wakeWaits: createChatWakeWaits(f.storage, hub),
    phonePages: () => pages,
    browser: {
      origin: SHARE_WEB,
      hasExchangeKey: (request) =>
        verifyRelayExchangeKey(
          request.headers.get("x-dohc-relay-exchange-key"),
          hashRelayExchangeKey(EXCHANGE_KEY),
        ),
    },
  });
  /** The phone's openPage, as `user:session:kind`, answered with its status and body. */
  async function open(path: string, as = "owner-1:phone-1:phone") {
    const response = await route(
      new Request(`http://relay.test/sync/${scope.workspaceId}/ops/openPage`, {
        method: "POST",
        headers: { authorization: `Bearer session:${as}`, "content-type": "application/json" },
        body: JSON.stringify({ path }),
      }),
      { route: "account-operation", workspaceId: scope.workspaceId, operation: "openPage" },
    ).catch((error: unknown) => errorResponse(error));
    return { status: response.status, body: (await response.json()) as unknown };
  }
  /** The owner's browser's openPage as share-web forwards it. An empty header in `headers` is left out. */
  async function browserOpen(path: string, headers: Record<string, string> = {}) {
    const sent = {
      cookie: "account=owner-1:browser-1:browser",
      origin: SHARE_WEB,
      "x-dohc-relay-exchange-key": EXCHANGE_KEY,
      "content-type": "application/json",
      ...headers,
    };
    const response = await route(
      new Request(`http://relay.test/sync/${scope.workspaceId}/ops/openPage`, {
        method: "POST",
        headers: Object.fromEntries(Object.entries(sent).filter(([, value]) => value !== "")),
        body: JSON.stringify({ path }),
      }),
      { route: "account-operation", workspaceId: scope.workspaceId, operation: "openPage" },
    ).catch((error: unknown) => errorResponse(error));
    return { status: response.status, body: (await response.json()) as unknown };
  }
  return { ...f, open, browserOpen, mint, sessions, stored, publish, reconcile };
}

const answer = (result: unknown) => ({ status: 200, body: { ok: true, result } });
const preparing = answer({ status: "preparing" });
const refused = (reason: string) => answer({ status: "refused", reason });
const notFound = { status: 404, body: expect.objectContaining({ ok: false, code: "not_found" }) };
const ready = answer({
  status: "ready",
  objectId: binding.objectId,
  lineageClaimId: binding.lineageClaimId,
  ticket: "ticket-token",
  expiresAtMs: 2_020,
  // The phone's editor takes its bounds from the answer, so they never drift from the relay's.
  editorLimits,
});

it("answers a secret file's page exactly as a missing page, and enrolls nothing", async () => {
  const f = await phone();
  f.seed("a/.env/b.md", "secret-object");
  f.publish("secret-object");
  const missing = await f.open("docs/missing.md");
  expect(missing).toEqual(refused("missing"));
  for (const path of ["a/.env/b.md", ".env", "docs/.env.local"])
    expect(await f.open(path), path).toEqual(missing);
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId)).toEqual([]);
});

it("refuses a desktop sign-in, another account, and a workspace hidden from the phone alike, and enrolls nothing", async () => {
  const f = await phone();
  f.ready();
  expect(await f.open(binding.currentPath, "owner-1:desktop-1:desktop")).toEqual(notFound);
  expect(await f.open(binding.currentPath, "owner-2:phone-2:phone")).toEqual(notFound);
  f.storage.setShowOnPhone({
    ownerUserId: "owner-1",
    workspaceId: scope.workspaceId,
    showOnPhone: false,
  });
  expect(await f.open(binding.currentPath)).toEqual(notFound);
  expect(f.read()).toBeNull();
  expect(f.mint).not.toHaveBeenCalled();
});

it("refuses a page no computer opened live, as agents hear it, and enrolls nothing", async () => {
  const f = await phone();
  f.seed("docs/b.md", "object-b");
  expect(await f.open("docs/b.md")).toEqual(refused("live-document-without-lineage"));
  // A lineage in another version is not one the live host hosts.
  f.publish("object-b", "side-version");
  expect(await f.open("docs/b.md")).toEqual(refused("live-document-without-lineage"));
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId)).toEqual([]);
  expect(f.reconcile).not.toHaveBeenCalled();
  // One whose lineage is on the relay but which the live host still finds without one hears the same.
  f.blocked.set(binding.objectId, "without-lineage");
  expect(await f.open(binding.currentPath)).toEqual(refused("live-document-without-lineage"));
});

it("enrolls a page with live history as the owner's open, and answers preparing until the host activates it", async () => {
  const f = await phone();
  expect(await f.open(binding.currentPath)).toEqual(preparing);
  // The owner's demand, so the page never counts against the agent-only caps.
  expect(f.read()).toMatchObject({
    enabled: true,
    shareId: null,
    ownerDemand: true,
    demandAtMs: 2_000,
  });
  expect(f.reconcile).toHaveBeenCalledTimes(1);
  expect(f.mint).not.toHaveBeenCalled();
  f.ready();
  expect(await f.open(binding.currentPath)).toEqual(ready);
});

it("mints a ticket from a fresh read of the phone's sign-in, ending with it", async () => {
  const f = await phone();
  f.ready();
  expect(await f.open(binding.currentPath)).toEqual(ready);
  expect(f.sessions.read).toHaveBeenCalledWith(["phone-1"]);
  expect(f.mint).toHaveBeenCalledWith(
    { objectId: binding.objectId },
    {
      kind: "owner",
      workspaceId: scope.workspaceId,
      userId: "owner-1",
      sessionId: "phone-1",
      sessionExpiresAtMs: 2_020,
    },
    expect.any(AbortSignal),
  );
  // The resolver still admits the sign-in, but the session table no longer holds it as a current phone.
  f.stored.set("phone-1", { userId: "owner-1", expiresAtMs: 2_020, clientKind: "desktop" });
  expect(await f.open(binding.currentPath)).toEqual(notFound);
  f.stored.set("phone-1", { userId: "owner-1", expiresAtMs: 2_000, clientKind: "phone" });
  expect(await f.open(binding.currentPath)).toEqual(notFound);
  f.stored.delete("phone-1");
  expect(await f.open(binding.currentPath)).toEqual(notFound);
  expect(f.mint).toHaveBeenCalledTimes(1);
});

it("answers preparing, not ready, when the page's binding changes while its ticket is minted", async () => {
  const f = await phone();
  f.ready();
  // The host stops holding the activation the open read, as a restore that replaces it does.
  f.mint.mockImplementationOnce(async () => {
    f.host.ready.mockReturnValue(false);
    return { token: "ticket-token", expiresAtMs: 2_020 };
  });
  expect(await f.open(binding.currentPath)).toEqual(preparing);
  // A mint that fails as the host changes asks again too.
  f.host.ready.mockReturnValue(true);
  f.mint.mockRejectedValueOnce(new Error("Live-ticket operation failed."));
  expect(await f.open(binding.currentPath)).toEqual(preparing);
  expect(await f.open(binding.currentPath)).toEqual(ready);
});

it("answers a page moved to a secret path while its ticket is minted exactly as a missing page", async () => {
  const f = await phone();
  f.ready();
  f.mint.mockImplementationOnce(async () => {
    f.raw
      .prepare("INSERT INTO sync_relay_current_files VALUES (?,'main','a/.env/b.md',?,'text',1)")
      .run(scope.workspaceId, "b".repeat(64));
    f.raw
      .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES (?,?,60,'moment-hidden','main','a/.env/b.md',?,'text',1,1)`)
      .run(scope.workspaceId, binding.objectId, "b".repeat(64));
    return { token: "ticket-token", expiresAtMs: 2_020 };
  });
  expect(await f.open(binding.currentPath)).toEqual(refused("missing"));
  // The path it left now holds no page, and the open answers the same.
  expect(await f.open(binding.currentPath)).toEqual(refused("missing"));
  expect(f.mint).toHaveBeenCalledTimes(1);
});

it("ends a session read past its wait as busy, and mints nothing", async () => {
  const f = await phone({ waitMs: 10 });
  f.ready();
  f.sessions.read.mockImplementationOnce(() => new Promise(() => {}));
  expect(await f.open(binding.currentPath)).toMatchObject({
    status: 503,
    body: { ok: false, code: "server_busy" },
  });
  expect(f.mint).not.toHaveBeenCalled();
});

it("never resumes a Pause or Stop, and answers a page retained at its old path as unavailable", async () => {
  const f = await phone();
  f.storage.ensureOwnedLiveDocument({ intent: "share", ...f.input });
  f.storage.setServiceHostEnrollmentEnabled({ ...f.input, enabled: false, nowMs: 20 });
  // A Pause stays enabled until the host unloads the page. The open refuses it and changes nothing.
  const paused = f.read();
  expect(paused).toMatchObject({ enabled: true, ownerStop: "pause" });
  expect(await f.open(binding.currentPath)).toEqual(refused("paused"));
  expect(f.read()).toEqual(paused);
  f.storage.setServiceHostEnrollmentEnabled({
    ...f.input,
    enabled: false,
    retire: true,
    nowMs: 30,
  });
  const stopped = f.read();
  expect(stopped).toMatchObject({ enabled: false, retired: true, ownerStop: "retire" });
  expect(await f.open(binding.currentPath)).toEqual(refused("paused"));
  expect(f.read()).toEqual(stopped);

  // The enrolled page moves; its row stays at the old path, and is never rebound.
  f.raw
    .prepare("INSERT INTO sync_relay_current_files VALUES (?,'main','docs/moved.md',?,'text',1)")
    .run(scope.workspaceId, "b".repeat(64));
  f.raw
    .prepare(`INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
    VALUES (?,?,50,'moment-moved','main','docs/moved.md',?,'text',1,1)`)
    .run(scope.workspaceId, binding.objectId, "b".repeat(64));
  expect(await f.open("docs/moved.md")).toEqual(refused("document-unavailable"));
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/moved.md")).toBeNull();
});

it("admits an owner's open as the 64th document and in the 16th workspace, and refuses the 65th and the 17th", async () => {
  // 63 rows only agents keep, past the agent-only cap of 48, which an owner's open is not under.
  const documents = await phone();
  for (let index = 0; index < 63; index++)
    documents.agentOnly(scope.workspaceId, `held-${index}`, `notes/${index}.md`);
  expect(await documents.open(binding.currentPath)).toEqual(preparing);
  expect(documents.read()).toMatchObject({ enabled: true, ownerDemand: true });
  const full = await phone();
  for (let index = 0; index < 64; index++)
    full.agentOnly(scope.workspaceId, `held-${index}`, `notes/${index}.md`);
  expect(await full.open(binding.currentPath)).toEqual(refused("live_host_full"));
  expect(full.read()).toBeNull();

  const workspaces = await phone();
  for (let index = 0; index < 15; index++)
    workspaces.agentOnly(`other-${index}`, "held", "notes/a.md");
  expect(await workspaces.open(binding.currentPath)).toEqual(preparing);
  const crowded = await phone();
  for (let index = 0; index < 16; index++)
    crowded.agentOnly(`other-${index}`, "held", "notes/a.md");
  expect(await crowded.open(binding.currentPath)).toEqual(refused("live_host_full"));
  expect(crowded.read()).toBeNull();
});

it("enrolls no page past the account's bound on its owner's documents, and still opens one already enrolled", async () => {
  const f = await phone();
  for (let index = 0; index < PHONE_OWNER_DOCUMENTS_PER_ACCOUNT - 1; index++)
    f.agentOnly(scope.workspaceId, `owned-${index}`, `notes/${index}.md`);
  f.raw.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_demand=1`).run();
  // The bound's last place.
  expect(await f.open(binding.currentPath)).toEqual(preparing);
  f.seed("docs/b.md", "object-b");
  f.publish("object-b");
  expect(await f.open("docs/b.md")).toEqual(refused("live_host_full"));
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/b.md")).toBeNull();
  expect(await f.open(binding.currentPath)).toEqual(preparing);
});

it("opens a page for the owner's browser through share-web, whatever Show on phone says, with a ticket for its sign-in", async () => {
  const f = await phone();
  f.ready();
  f.storage.setShowOnPhone({
    ownerUserId: "owner-1",
    workspaceId: scope.workspaceId,
    showOnPhone: false,
  });
  expect(await f.browserOpen(binding.currentPath)).toEqual(ready);
  expect(f.mint).toHaveBeenCalledWith(
    { objectId: binding.objectId },
    expect.objectContaining({ kind: "owner", userId: "owner-1", sessionId: "browser-1" }),
    expect.any(AbortSignal),
  );
  // The phone still needs Show on phone.
  expect(await f.open(binding.currentPath)).toEqual(notFound);
});

it("answers another account, a member, a fenced owner, and a browser share-web did not send exactly as a missing workspace", async () => {
  const f = await phone();
  f.ready();
  // member-1 is an Edit member of the workspace.
  f.raw
    .prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?")
    .run(JSON.stringify({ kind: "workspace" }), scope.shareId);
  f.raw
    .prepare(
      "INSERT INTO sync_relay_workspace_memberships (workspace_id,share_id,member_level,workspace_name,created_at_ms) VALUES (?,?,'edit','Workspace',0)",
    )
    .run(scope.workspaceId, scope.shareId);
  f.raw
    .prepare(`INSERT INTO sync_relay_workspace_members (member_id,workspace_id,grant_id,user_id,email,role,state,invited_at_ms,joined_at_ms)
    VALUES ('member',?,?,'member-1',NULL,'member','active',0,0)`)
    .run(scope.workspaceId, scope.grantId);
  for (const headers of <Record<string, string>[]>[
    { cookie: "account=owner-2:browser-2:browser" },
    { cookie: "account=member-1:browser-3:browser" },
    // A phone's or a desktop's sign-in never opens through share-web.
    { cookie: "account=owner-1:phone-1:phone" },
    { cookie: "account=owner-1:desktop-1:desktop" },
    { cookie: "" },
    { cookie: "account=unknown" },
    { origin: "https://elsewhere.test" },
    { origin: "" },
    { "x-dohc-relay-exchange-key": "x".repeat(43) },
    { "x-dohc-relay-exchange-key": "" },
  ])
    expect(await f.browserOpen(binding.currentPath, headers), JSON.stringify(headers)).toEqual(
      notFound,
    );
  // A browser's sign-in presented as a Bearer, as a phone's is, is refused too.
  expect(await f.open(binding.currentPath, "owner-1:browser-1:browser")).toEqual(notFound);
  const context = f.storage as StorageContext;
  initializeAccountDeletion(context, "deletion-key");
  fenceAccount(context, "deletion-key", "owner-1", "owner-1@dohc.test");
  expect(await f.browserOpen(binding.currentPath)).toEqual(notFound);
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.read()).toBeNull();
});

it("answers the owner's browser a secret file as a missing page, and a page no computer opened live with its reason", async () => {
  const f = await phone();
  f.seed("a/.env/b.md", "secret-object");
  f.publish("secret-object");
  expect(await f.browserOpen("docs/missing.md")).toEqual(refused("missing"));
  expect(await f.browserOpen("a/.env/b.md")).toEqual(refused("missing"));
  f.seed("docs/b.md", "object-b");
  expect(await f.browserOpen("docs/b.md")).toEqual(refused("live-document-without-lineage"));
  expect(f.storage.listServiceHostEnrollments(scope.workspaceId)).toEqual([]);
});

it("holds the account's bound on its owner's documents across its phone and its browser", async () => {
  const f = await phone();
  for (let index = 0; index < PHONE_OWNER_DOCUMENTS_PER_ACCOUNT - 1; index++)
    f.agentOnly(scope.workspaceId, `owned-${index}`, `notes/${index}.md`);
  f.raw.prepare(`UPDATE ${SERVICE_HOST_ENROLLMENTS} SET owner_demand=1`).run();
  // The phone takes the bound's last place, so the browser enrolls no more, and still opens the phone's page.
  expect(await f.open(binding.currentPath)).toEqual(preparing);
  f.seed("docs/b.md", "object-b");
  f.publish("object-b");
  expect(await f.browserOpen("docs/b.md")).toEqual(refused("live_host_full"));
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, "docs/b.md")).toBeNull();
  expect(await f.browserOpen(binding.currentPath)).toEqual(preparing);
});

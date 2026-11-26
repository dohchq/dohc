import type { EmailMessage } from "@dohc/workspace-auth/smtp";
import { afterEach, expect, it, vi } from "vitest";
import {
  createShareInvitationEmailer,
  SHARE_INVITATION_EMAIL_DAILY_LIMIT,
  SHARE_INVITATION_EMAIL_WINDOW_HOURS,
} from "./shareInvitationEmail";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { SHARE_INVITATION_EMAILS } from "./storage/shareInvitationEmails";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  json,
  jsonBody,
  reopenTestStorage,
  request,
  storagePath,
  testHandler,
  testStorage,
  RELAY_EXCHANGE_KEY,
  SHARE_WEB_ORIGIN,
  type HandlerOverrides,
} from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
  closeTestStorages();
});

const RELAY_ORIGIN = "https://relay.example.test";
const WINDOW_MS = SHARE_INVITATION_EMAIL_WINDOW_HOURS * 60 * 60 * 1000;
const LIMIT = { limit: 50, windowHours: 24, sent: 50 };
const browserSessions = {
  maxSessions: 8,
  retentionMs: 30000,
  maxPendingRequests: 4,
  maxRequestBytes: 16384,
  maxResponseBytes: 16384,
  timeoutMs: 1000,
};

function attempts(storage: SyncRelayStorage, inviter: string): number {
  return Number(
    (storage as StorageContext).db
      .prepare(`SELECT count(*) AS n FROM ${SHARE_INVITATION_EMAILS} WHERE inviter_user_id = ?`)
      .get(inviter)!.n,
  );
}

async function fixture(overrides: HandlerOverrides = {}) {
  const storage = await testStorage();
  const sent: EmailMessage[] = [];
  const clock = { nowMs: 1_000_000 };
  const handler = testHandler(storage, {
    nowMs: () => clock.nowMs,
    sendShareInvitationEmail: async (message) => {
      sent.push(message);
    },
    relayPublicOrigin: RELAY_ORIGIN,
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: browserSessions,
    ...overrides,
  });
  await claimWorkspace(handler, "owner", "workspace");
  const invite = async (
    body: Record<string, unknown>,
    inviter = "owner",
    workspace = "workspace",
  ) =>
    json(
      await handler(
        request(
          inviter,
          `/sync/${workspace}/shares`,
          jsonBody({ paths: ["docs"], access: "edit", subjectName: "Trip plan", ...body }),
        ),
      ),
    );
  return { storage, handler, sent, clock, invite };
}

it("emails the typed address the same way whether or not it has an account", async () => {
  const { storage, sent, invite } = await fixture({
    lookupUserDisplayName: (userId) => (userId === "owner" ? "Sam Rivera" : null),
  });

  const account = await invite({ recipientEmail: "friend@dohc.test" });
  const pending = await invite({ recipientEmail: "pending@example.test" });

  expect(storage.getShareGrant("grant-0")).toMatchObject({
    principalKind: "user",
    principalUserId: "friend",
    status: "active",
  });
  expect(storage.getShareGrant("grant-1")).toMatchObject({
    principalKind: "email",
    principalEmail: "pending@example.test",
    status: "active",
  });
  expect(account).toMatchObject({ ok: true, shareId: "share-0", invitationEmail: "sent" });
  expect(pending).toMatchObject({ ok: true, shareId: "share-1", invitationEmail: "sent" });
  expect(Object.keys(account)).toEqual(Object.keys(pending));
  expect(account).not.toHaveProperty("invitationEmailLimit");
  expect(account).not.toHaveProperty("recipientUserId");

  expect(sent).toHaveLength(2);
  const { html, ...first } = sent[0]!;
  expect(first).toEqual({
    to: "friend@dohc.test",
    subject: 'Sam Rivera shared "Trip plan" with you',
    fromName: "Sam Rivera",
    text: [
      'Sam Rivera (owner@dohc.test) shared "Trip plan" with you. You can edit it.',
      "",
      "Open in browser:",
      `${SHARE_WEB_ORIGIN}/s/edit/grant-0`,
      "Sign in or create an account with friend@dohc.test.",
      "",
      "Using the dohc app? Sign in with friend@dohc.test. Choose Sharing, then Shared with me. Or choose Open a share and paste this code:",
      `dohc-share:share-0:${RELAY_ORIGIN}`,
      "",
      "You got this because Sam Rivera (owner@dohc.test) invited friend@dohc.test. If you do not know them, ignore this email. Nothing happens if you do.",
      "",
    ].join("\n"),
  });
  expect(html).toContain(`href="${SHARE_WEB_ORIGIN}/s/edit/grant-0"`);
  expect(sent[1]).toMatchObject({
    to: "pending@example.test",
    subject: first.subject,
    fromName: "Sam Rivera",
    text: first.text
      .replaceAll("friend@dohc.test", "pending@example.test")
      .replace("grant-0", "grant-1")
      .replace("share-0", "share-1"),
  });
});

it("leaves the browser link and the code out when the relay can give neither", async () => {
  const { sent, invite } = await fixture({
    relayPublicOrigin: undefined,
    relayExchangeKey: undefined,
    namedBrowserSessionLimits: undefined,
  });

  const reply = await invite({ recipientEmail: "friend@dohc.test", access: "view" });

  expect(reply).toMatchObject({ invitationEmail: "sent" });
  expect(sent[0]!.text).toBe(
    [
      'owner@dohc.test shared "Trip plan" with you. You can view it.',
      "",
      "Open in the dohc app: Sign in with friend@dohc.test. Choose Sharing, then Shared with me.",
      "",
      "You got this because owner@dohc.test invited friend@dohc.test. If you do not know them, ignore this email. Nothing happens if you do.",
      "",
    ].join("\n"),
  );
  expect(sent[0]).not.toHaveProperty("fromName");
});

it("sends nothing and counts nothing for an inviter whose own address is not verified", async () => {
  const { storage, sent, invite } = await fixture({ lookupVerifiedUserEmail: () => null });

  const reply = await invite({ recipientEmail: "friend@dohc.test" });

  expect(reply).toMatchObject({ ok: true, invitationEmail: "unavailable" });
  expect(sent).toHaveLength(0);
  expect(attempts(storage, "owner")).toBe(0);
});

it("answers failed, sends nothing and keeps the invite when the inviter's address cannot be read", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { storage, sent, invite } = await fixture({
    lookupVerifiedUserEmail: () => {
      throw new Error("database is down");
    },
  });

  const reply = await invite({ recipientEmail: "friend@dohc.test" });

  expect(reply).toMatchObject({ ok: true, invitationEmail: "failed" });
  expect(sent).toHaveLength(0);
  expect(attempts(storage, "owner")).toBe(0);
});

it("answers unavailable and keeps the invite when the relay has no mail server", async () => {
  const { storage, invite } = await fixture({ sendShareInvitationEmail: undefined });

  const account = await invite({ recipientEmail: "friend@dohc.test" });
  const pending = await invite({ recipientEmail: "pending@example.test" });

  expect(account).toMatchObject({ ok: true, invitationEmail: "unavailable" });
  expect(pending).toMatchObject({ ok: true, invitationEmail: "unavailable" });
  expect(Object.keys(account)).toEqual(Object.keys(pending));
  expect(storage.getShareGrant("grant-0")).toMatchObject({ status: "active" });
  expect(storage.getShareGrant("grant-1")).toMatchObject({ status: "active" });
  expect(attempts(storage, "owner")).toBe(0);
});

it("answers failed, keeps the invite, and logs only the share id when the send throws", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { storage, invite } = await fixture({
    sendShareInvitationEmail: async (message) => {
      throw new Error(`could not send ${message.subject} to ${message.to}: ${message.text}`);
    },
  });

  const reply = await invite({ recipientEmail: "pending@example.test" });

  expect(reply).toMatchObject({ ok: true, shareId: "share-0", invitationEmail: "failed" });
  expect(reply).not.toHaveProperty("invitationEmailLimit");
  expect(storage.getShareGrant("grant-0")).toMatchObject({
    principalKind: "email",
    status: "active",
  });
  expect(logged.mock.calls).toEqual([
    ["[sync-relay] share invitation email failed for share share-0"],
  ]);
});

it("answers failed at the deadline when the mail server never answers", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const storage = await testStorage();
  const email = createShareInvitationEmailer({
    storage,
    nowMs: () => 1_000_000,
    sendEmail: () => new Promise(() => undefined),
    lookupVerifiedUserEmail: () => "owner@dohc.test",
    relayPublicOrigin: RELAY_ORIGIN,
    timeoutMs: 20,
  });

  const answer = await email({
    inviterUserId: "owner",
    recipientEmail: "friend@dohc.test",
    shareId: "share-0",
    grantId: "grant-0",
    subjectName: "Trip plan",
    access: "edit",
    browserInvitationUrl: null,
  });

  expect(answer).toEqual({ invitationEmail: "failed" });
});

it("starts no send, and counts nothing, when the inviter's address arrives after the deadline", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const storage = await testStorage();
  const sendEmail = vi.fn(async () => undefined);
  let answerLookup: (email: string) => void = () => undefined;
  const email = createShareInvitationEmailer({
    storage,
    nowMs: () => 1_000_000,
    sendEmail,
    lookupVerifiedUserEmail: () =>
      new Promise<string>((resolve) => {
        answerLookup = resolve;
      }),
    relayPublicOrigin: RELAY_ORIGIN,
    timeoutMs: 20,
  });

  const answer = await email({
    inviterUserId: "owner",
    recipientEmail: "friend@dohc.test",
    shareId: "share-0",
    grantId: "grant-0",
    subjectName: "Trip plan",
    access: "edit",
    browserInvitationUrl: null,
  });
  answerLookup("owner@dohc.test");
  await new Promise((resolve) => setImmediate(resolve));

  expect(answer).toEqual({ invitationEmail: "failed" });
  expect(sendEmail).not.toHaveBeenCalled();
  expect(attempts(storage, "owner")).toBe(0);
});

it("starts no send when counting the attempt runs past the deadline", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const storage = await testStorage();
  const sendEmail = vi.fn(async () => undefined);
  const email = createShareInvitationEmailer({
    storage,
    nowMs: () => {
      const until = performance.now() + 40;
      while (performance.now() < until);
      return 1_000_000;
    },
    sendEmail,
    lookupVerifiedUserEmail: () => "owner@dohc.test",
    relayPublicOrigin: RELAY_ORIGIN,
    timeoutMs: 20,
  });

  const answer = await email({
    inviterUserId: "owner",
    recipientEmail: "friend@dohc.test",
    shareId: "share-0",
    grantId: "grant-0",
    subjectName: "Trip plan",
    access: "edit",
    browserInvitationUrl: null,
  });

  expect(answer).toEqual({ invitationEmail: "failed" });
  expect(sendEmail).not.toHaveBeenCalled();
  expect(attempts(storage, "owner")).toBe(1);
});

it("sends to the address the invite holds", async () => {
  const { storage, sent, invite } = await fixture();

  await invite({ recipientEmail: "Friend@Example.TEST" });

  expect(sent.map((message) => message.to)).toEqual(["friend@example.test"]);
  expect(storage.getShareGrant("grant-0")).toMatchObject({
    principalEmail: "friend@example.test",
  });
});

it.each([
  "first@example.test, second@example.test",
  "Friend <friend@example.test>",
  "fri\u00adend@example.test",
  "friend\u200b@example.test",
  "friend(x)@example.test",
  "a(b)c@example.test",
  "friend@example.test(x)",
])("sends nothing to an address that is not one plain mailbox: %s", async (recipientEmail) => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { storage, sent, invite } = await fixture();

  const reply = await invite({ recipientEmail });

  expect(reply).toMatchObject({ ok: true, invitationEmail: "failed" });
  expect(sent).toEqual([]);
  expect(storage.getShareGrant("grant-0")).toMatchObject({ status: "active" });
});

it("stops emailing at 50 invitations in 24 hours, and deleting shares gives none back", async () => {
  const f = await fixture();
  const start = f.clock.nowMs;
  for (let index = 0; index < SHARE_INVITATION_EMAIL_DAILY_LIMIT; index += 1) {
    f.clock.nowMs = start + index * 1000;
    const reply = await f.invite({ recipientEmail: `guest-${index}@example.test` });
    expect(reply).toMatchObject({ invitationEmail: "sent" });
  }
  expect(f.sent).toHaveLength(50);

  f.clock.nowMs = start + 50_000;
  const refused = await f.invite({ recipientEmail: "guest-50@example.test" });
  expect(refused).toMatchObject({
    ok: true,
    shareId: "share-50",
    invitationEmail: "limit",
    invitationEmailLimit: LIMIT,
  });
  expect(f.storage.getShareGrant("grant-50")).toMatchObject({
    principalKind: "email",
    principalEmail: "guest-50@example.test",
    status: "active",
  });
  const withAccount = await f.invite({ recipientEmail: "friend@dohc.test" });
  expect(withAccount).toMatchObject({ invitationEmail: "limit", invitationEmailLimit: LIMIT });
  expect(Object.keys(withAccount)).toEqual(Object.keys(refused));

  for (const shareId of ["share-0", "share-1", "share-2", "share-50"]) {
    const removed = await f.handler(
      request("owner", `/sync/shares/${shareId}/revoke`, { method: "POST" }),
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
  }
  expect(f.storage.getShareGrant("grant-0")).toMatchObject({ status: "revoked" });
  expect(await f.invite({ recipientEmail: "guest-51@example.test" })).toMatchObject({
    invitationEmail: "limit",
    invitationEmailLimit: LIMIT,
  });
  expect(f.sent).toHaveLength(50);
  expect(attempts(f.storage, "owner")).toBe(50);

  await claimWorkspace(f.handler, "neighbor", "other-workspace");
  expect(
    await f.invite({ recipientEmail: "guest-0@example.test" }, "neighbor", "other-workspace"),
  ).toMatchObject({ invitationEmail: "sent" });
  expect(f.sent).toHaveLength(51);

  f.clock.nowMs = start + WINDOW_MS - 1;
  expect(await f.invite({ recipientEmail: "guest-52@example.test" })).toMatchObject({
    invitationEmail: "limit",
    invitationEmailLimit: LIMIT,
  });

  f.clock.nowMs = start + WINDOW_MS;
  expect(await f.invite({ recipientEmail: "guest-53@example.test" })).toMatchObject({
    invitationEmail: "sent",
  });
  expect(f.sent).toHaveLength(52);
  expect(f.sent.at(-1)!.to).toBe("guest-53@example.test");
  expect(await f.invite({ recipientEmail: "guest-54@example.test" })).toMatchObject({
    invitationEmail: "limit",
    invitationEmailLimit: LIMIT,
  });
});

it("counts a send that failed, so a failing mail server is tried 50 times and no more", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let tries = 0;
  const f = await fixture({
    sendShareInvitationEmail: async () => {
      tries += 1;
      throw new Error("mail server is down");
    },
  });
  for (let index = 0; index < SHARE_INVITATION_EMAIL_DAILY_LIMIT; index += 1) {
    const reply = await f.invite({ recipientEmail: `guest-${index}@example.test` });
    expect(reply).toMatchObject({ invitationEmail: "failed" });
  }

  expect(await f.invite({ recipientEmail: "guest-50@example.test" })).toMatchObject({
    invitationEmail: "limit",
    invitationEmailLimit: LIMIT,
  });
  expect(tries).toBe(50);
});

it("drops every inviter's attempts older than the window when one is written", async () => {
  const f = await fixture();
  await claimWorkspace(f.handler, "neighbor", "other-workspace");
  await f.invite({ recipientEmail: "guest-0@example.test" }, "neighbor", "other-workspace");
  expect(attempts(f.storage, "neighbor")).toBe(1);

  f.clock.nowMs += WINDOW_MS;
  await f.invite({ recipientEmail: "guest-1@example.test" });

  expect(attempts(f.storage, "neighbor")).toBe(0);
  expect(attempts(f.storage, "owner")).toBe(1);
});

it("sends nothing for a chat started by email, and counts nothing", async () => {
  const { storage, sent, invite } = await fixture();

  const reply = await invite({
    recipientEmail: "friend@dohc.test",
    channelWireId: "dm-wire-1",
    access: "read-write",
    paths: undefined,
    subjectName: undefined,
  });

  expect(reply).toMatchObject({ ok: true });
  expect(reply).not.toHaveProperty("invitationEmail");
  expect(sent).toHaveLength(0);
  expect(attempts(storage, "owner")).toBe(0);
});

it("answers failed and keeps the invite when the count cannot be written", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { storage, sent, invite } = await fixture();
  (storage as StorageContext).db.exec(`DROP TABLE ${SHARE_INVITATION_EMAILS}`);

  const reply = await invite({ recipientEmail: "friend@dohc.test" });

  expect(reply).toMatchObject({ ok: true, shareId: "share-0", invitationEmail: "failed" });
  expect(storage.getShareGrant("grant-0")).toMatchObject({ status: "active" });
  expect(sent).toEqual([]);
  expect(logged.mock.calls).toEqual([
    ["[sync-relay] share invitation email failed for share share-0"],
  ]);
});

it("sends nothing for a self-invite or an invite by user id", async () => {
  const { storage, sent, invite } = await fixture();

  const self = await invite({ recipientEmail: "owner@dohc.test" });
  const byUserId = await invite({ recipientUserId: "friend" });

  expect(self).toMatchObject({ code: "self_share" });
  expect(self).not.toHaveProperty("invitationEmail");
  expect(byUserId).toMatchObject({ ok: true, recipientUserId: "friend" });
  expect(byUserId).not.toHaveProperty("invitationEmail");
  expect(storage.getShareGrant(String(byUserId.grantId))).toMatchObject({
    principalUserId: "friend",
    status: "active",
  });
  expect(sent).toEqual([]);
  expect(attempts(storage, "owner")).toBe(0);
});

it("keeps the count when the relay opens its database again", async () => {
  const f = await fixture();
  await f.invite({ recipientEmail: "guest-0@example.test" });
  const path = storagePath(f.storage);
  closeTestStorage(f.storage);

  const reopened = reopenTestStorage(path);

  expect(attempts(reopened, "owner")).toBe(1);
});

async function memberFixture(overrides: HandlerOverrides = {}) {
  const f = await fixture({
    lookupUserDisplayName: (userId) => (userId === "owner" ? "Sam Rivera" : null),
    ...overrides,
  });
  const inviteMember = async (email: string, inviter = "owner") => {
    const response = await f.handler(
      request(
        inviter,
        "/sync/workspace/members/invites",
        jsonBody({ email, workspaceName: "Community" }),
      ),
    );
    return { status: response.status, body: await json(response) };
  };
  return { ...f, inviteMember };
}

it("emails a member invite the way a share's invite is emailed, and opens the person's workspaces", async () => {
  const { sent, inviteMember } = await memberFixture();

  const account = await inviteMember("friend@dohc.test");
  const pending = await inviteMember("Pending@Example.TEST");

  expect(account).toMatchObject({ status: 200, body: { invitationEmail: "sent" } });
  expect(pending).toMatchObject({ status: 200, body: { invitationEmail: "sent" } });
  expect(pending.body).toHaveProperty("people");

  expect(sent.map((message) => message.to)).toEqual(["friend@dohc.test", "pending@example.test"]);
  const { html, ...first } = sent[0]!;
  expect(first).toEqual({
    to: "friend@dohc.test",
    subject: 'Sam Rivera invited you to "Community"',
    fromName: "Sam Rivera",
    text: [
      'Sam Rivera (owner@dohc.test) invited you to "Community". You can comment on it.',
      "",
      "Open in browser:",
      `${SHARE_WEB_ORIGIN}/workspaces`,
      "Sign in or create an account with friend@dohc.test.",
      "",
      "Using the dohc app? Sign in with friend@dohc.test. Choose Sharing, then Shared with me. Or choose Open a share and paste this code:",
      `dohc-share:share-0:${RELAY_ORIGIN}`,
      "",
      "You got this because Sam Rivera (owner@dohc.test) invited friend@dohc.test. If you do not know them, ignore this email. Nothing happens if you do.",
      "",
    ].join("\n"),
  });
  expect(html).toContain(`href="${SHARE_WEB_ORIGIN}/workspaces"`);
  // Only the inviter's address and the recipient's own appear; no other member's.
  expect(sent[1]!.text).not.toContain("friend@dohc.test");
  expect(sent[1]!.html).not.toContain("friend@dohc.test");
});

it("emails an invite again when the same address is invited again, once a minute at most", async () => {
  const { sent, clock, inviteMember } = await memberFixture();

  expect((await inviteMember("pending@example.test")).body).toMatchObject({
    invitationEmail: "sent",
  });
  expect((await inviteMember("pending@example.test")).body).toMatchObject({
    invitationEmail: "recent",
  });
  clock.nowMs += 61_000;
  const again = await inviteMember("PENDING@example.test");
  expect(again.body).toMatchObject({ invitationEmail: "sent" });
  expect(
    (again.body as { people: Array<{ state: string }> }).people.filter(
      (person) => person.state === "invited",
    ),
  ).toHaveLength(1);
  expect(sent.map((message) => message.to)).toEqual([
    "pending@example.test",
    "pending@example.test",
  ]);

  // An account is in the workspace at once, and inviting it again emails it again.
  expect((await inviteMember("friend@dohc.test")).body).toMatchObject({ invitationEmail: "sent" });
  expect((await inviteMember("friend@dohc.test")).body).toMatchObject({
    invitationEmail: "recent",
  });
  clock.nowMs += 61_000;
  const member = await inviteMember("friend@dohc.test");
  expect(member.body).toMatchObject({ invitationEmail: "sent" });
  expect(
    (member.body as { people: Array<{ state: string }> }).people.filter(
      (person) => person.state === "active",
    ),
  ).toHaveLength(2);
  expect(sent).toHaveLength(4);
});

it("tells an admin invited again what an admin can do", async () => {
  const { handler, sent, clock, inviteMember } = await memberFixture();
  const joined = await inviteMember("friend@dohc.test");
  const friend = (
    joined.body as { people: Array<{ memberId: string; email: string | null }> }
  ).people.find((person) => person.email === "friend@dohc.test")!.memberId;
  const promoted = await handler(
    request("owner", `/sync/workspace/members/${friend}/role`, jsonBody({ role: "admin" })),
  );
  expect(promoted.status).toBe(200);
  clock.nowMs += 61_000;

  expect((await inviteMember("friend@dohc.test")).body).toMatchObject({ invitationEmail: "sent" });
  expect(sent[0]!.text).toContain("You can comment on it.");
  expect(sent[1]!.text).toContain("You can edit it.");
});

it("emails the same invite again once the address has an account it hasn't used yet", async () => {
  const accounts = new Map<string, string>();
  const { sent, clock, inviteMember } = await memberFixture({
    resolveUserIdByEmail: async (email) => accounts.get(email) ?? null,
  });

  await inviteMember("new@example.test");
  accounts.set("new@example.test", "new-account");
  clock.nowMs += 61_000;
  const again = await inviteMember("new@example.test");

  expect(again.body).toMatchObject({ invitationEmail: "sent" });
  expect(
    (again.body as { people: Array<{ state: string }> }).people.map((person) => person.state),
  ).toEqual(["active", "invited"]);
  expect(sent.map((message) => message.to)).toEqual(["new@example.test", "new@example.test"]);
});

it("keeps a member invite and says so when the relay has no mail server", async () => {
  const { storage, inviteMember } = await memberFixture({ sendShareInvitationEmail: undefined });

  const reply = await inviteMember("pending@example.test");

  expect(reply).toMatchObject({ status: 200, body: { invitationEmail: "unavailable" } });
  expect(
    (reply.body as { people: Array<{ state: string; email: string | null }> }).people.find(
      (person) => person.state === "invited",
    )?.email,
  ).toBe("pending@example.test");
  expect(storage.hasPendingInvite("pending@example.test")).toBe(true);
  expect(attempts(storage, "owner")).toBe(0);
});

it("leaves the browser link out of a member invite when people can't sign in on the share site", async () => {
  const { sent, inviteMember } = await memberFixture({ namedBrowserSessionLimits: undefined });

  await inviteMember("pending@example.test");

  expect(sent[0]!.text).not.toContain("Open in browser");
  expect(sent[0]!.text).toContain("Open in the dohc app:");
});

it("counts member invites in the inviter's 50 a day, with share invites", async () => {
  const { storage, invite, inviteMember } = await memberFixture();
  for (let index = 0; index < SHARE_INVITATION_EMAIL_DAILY_LIMIT - 1; index++)
    await invite({ recipientEmail: `person-${index}@example.test` });

  expect((await inviteMember("member-0@example.test")).body).toMatchObject({
    invitationEmail: "sent",
  });
  expect((await inviteMember("member-1@example.test")).body).toMatchObject({
    invitationEmail: "limit",
    invitationEmailLimit: LIMIT,
  });
  expect(storage.hasPendingInvite("member-1@example.test")).toBe(true);
});

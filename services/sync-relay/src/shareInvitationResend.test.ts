import type { EmailMessage } from "@dohc/workspace-auth/smtp";
import { afterEach, expect, it, vi } from "vitest";
import { hashLinkBearer } from "./linkSecurity";
import {
  createShareInvitationEmailer,
  SHARE_INVITATION_EMAIL_DAILY_LIMIT,
  SHARE_INVITATION_EMAIL_GRANT_INTERVAL_SECONDS,
} from "./shareInvitationEmail";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import {
  admitShareInvitationEmail,
  forgetShareInvitationEmailGrant,
  SHARE_INVITATION_EMAILS,
} from "./storage/shareInvitationEmails";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  json,
  jsonBody,
  LINK_KEY,
  reopenTestStorage,
  request,
  seedDependentGrant,
  seedLinkGrant,
  storagePath,
  testHandler,
  testStorage,
  RELAY_EXCHANGE_KEY,
  type HandlerOverrides,
} from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
  closeTestStorages();
});

const INTERVAL_MS = SHARE_INVITATION_EMAIL_GRANT_INTERVAL_SECONDS * 1000;
const browserSessions = {
  maxSessions: 8,
  retentionMs: 30000,
  maxPendingRequests: 4,
  maxRequestBytes: 16384,
  maxResponseBytes: 16384,
  timeoutMs: 1000,
};

function attempts(storage: SyncRelayStorage, inviter = "owner"): number {
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
    relayPublicOrigin: "https://relay.example.test",
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    namedBrowserSessionLimits: browserSessions,
    ...overrides,
  });
  await claimWorkspace(handler, "owner", "workspace");
  const invite = async (recipientEmail: string, body: Record<string, unknown> = {}) =>
    json(
      await handler(
        request(
          "owner",
          "/sync/workspace/shares",
          jsonBody({
            paths: ["docs"],
            access: "edit",
            subjectName: "Trip plan",
            recipientEmail,
            ...body,
          }),
        ),
      ),
    );
  const resendTo = (
    userId: string | null,
    grantId: string,
    shareId: string,
    body: unknown = { workspaceId: "workspace" },
  ) =>
    handler(
      request(userId, `/sync/shares/${shareId}/grants/${grantId}/invitation-email`, jsonBody(body)),
    );
  const resend = async (grantId: string, shareId: string) =>
    json(await resendTo("owner", grantId, shareId));
  return { storage, handler, sent, clock, invite, resendTo, resend };
}

async function invited(overrides: HandlerOverrides = {}) {
  const f = await fixture(overrides);
  await f.invite("friend@dohc.test");
  await f.invite("pending@example.test");
  expect(f.storage.getShareGrant("grant-0")).toMatchObject({ principalUserId: "friend" });
  expect(f.storage.getShareGrant("grant-1")).toMatchObject({
    principalKind: "email",
    principalEmail: "pending@example.test",
  });
  f.clock.nowMs += INTERVAL_MS;
  return f;
}

it("sends a signed-in person and a pending address the message their first invite was", async () => {
  const f = await invited();
  const [first, second] = f.sent;
  const before = [f.storage.getShareGrant("grant-0"), f.storage.getShareGrant("grant-1")];

  const account = await f.resend("grant-0", "share-0");
  const pending = await f.resend("grant-1", "share-1");

  expect(account).toEqual({ ok: true, invitationEmail: "sent" });
  expect(pending).toEqual(account);
  expect(first!.to).toBe("friend@dohc.test");
  expect(second!.to).toBe("pending@example.test");
  expect(f.sent.slice(2)).toEqual([first, second]);
  expect(attempts(f.storage)).toBe(4);
  expect([f.storage.getShareGrant("grant-0"), f.storage.getShareGrant("grant-1")]).toEqual(before);
});

it("names the access the person has now", async () => {
  const f = await invited();
  const changed = await f.handler(
    request(
      "owner",
      "/sync/shares/share-1/grants/grant-1/retune",
      jsonBody({ workspaceId: "workspace", access: "view" }),
    ),
  );
  expect(changed.status).toBe(200);

  expect(await f.resend("grant-1", "share-1")).toEqual({ ok: true, invitationEmail: "sent" });

  expect(f.sent.at(-1)!.text).toContain("You can view it.");
  expect(f.sent.at(-1)!.text).not.toContain("Open it in your browser:");
});

it("sends one email a minute to one person, counting from their invite", async () => {
  const f = await fixture();
  await f.invite("friend@dohc.test");
  await f.invite("pending@example.test");

  f.clock.nowMs += INTERVAL_MS - 1;
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "recent" });
  expect(f.sent).toHaveLength(2);
  expect(attempts(f.storage)).toBe(2);

  f.clock.nowMs += 1;
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "sent" });
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "recent" });
  expect(await f.resend("grant-1", "share-1")).toEqual({ ok: true, invitationEmail: "sent" });
  expect(f.sent.map((message) => message.to)).toEqual([
    "friend@dohc.test",
    "pending@example.test",
    "friend@dohc.test",
    "pending@example.test",
  ]);
  expect(attempts(f.storage)).toBe(4);

  f.clock.nowMs += INTERVAL_MS;
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "sent" });
  expect(f.sent).toHaveLength(5);
});

it("counts each resend toward the inviter's 50 emails in 24 hours", async () => {
  const f = await fixture();
  await f.invite("pending@example.test");
  for (let index = 1; index < SHARE_INVITATION_EMAIL_DAILY_LIMIT; index += 1) {
    f.clock.nowMs += INTERVAL_MS;
    expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "sent" });
  }
  expect(f.sent).toHaveLength(50);

  f.clock.nowMs += INTERVAL_MS;
  expect(await f.resend("grant-0", "share-0")).toEqual({
    ok: true,
    invitationEmail: "limit",
    invitationEmailLimit: { limit: 50, windowHours: 24, sent: 50 },
  });
  expect(await f.invite("guest@example.test")).toMatchObject({ invitationEmail: "limit" });
  expect(f.sent).toHaveLength(50);
  expect(attempts(f.storage)).toBe(50);
});

it("refuses everyone but the owner, and every grant that is not an invited person's, as a level change is refused", async () => {
  const f = await invited();
  await claimWorkspace(f.handler, "owner", "second-workspace");
  await claimWorkspace(f.handler, "neighbor", "other-workspace");
  seedLinkGrant(f.storage, {
    shareId: "share-0",
    grantId: "link",
    secretHash: hashLinkBearer("a".repeat(43), LINK_KEY),
    access: "edit",
  });
  expect(
    seedDependentGrant(f.storage, {
      shareId: "share-0",
      parentGrantId: "link",
      grantId: "joined",
      principalUserId: "holder",
      createdAtMs: 3,
    }).ok,
  ).toBe(true);
  f.storage.createShare({
    share: {
      ...f.storage.getShare("share-0")!,
      shareId: "chat",
      selectorJson: JSON.stringify({ kind: "chat", channelWireId: "channel_wire_team" }),
    },
    grant: {
      ...f.storage.getShareGrant("grant-0")!,
      shareId: "chat",
      grantId: "chatter",
      access: "read-only",
    },
  });
  const revoked = await f.handler(
    request(
      "owner",
      "/sync/shares/share-1/grants/grant-1/revoke",
      jsonBody({ workspaceId: "workspace" }),
    ),
  );
  expect(revoked.status).toBe(200);
  const counted = attempts(f.storage);
  const here = { workspaceId: "workspace" };
  const refused: Array<[string | null, string, string, unknown, number]> = [
    ["stranger", "grant-0", "share-0", here, 404],
    ["friend", "grant-0", "share-0", here, 404],
    ["neighbor", "grant-0", "share-0", { workspaceId: "other-workspace" }, 404],
    [null, "grant-0", "share-0", here, 401],
    ["owner", "grant-0", "share-0", { workspaceId: "second-workspace" }, 404],
    ["owner", "grant-0", "share-1", here, 404],
    ["owner", "missing", "share-0", here, 404],
    ["owner", "link", "share-0", here, 404],
    ["owner", "joined", "share-0", here, 404],
    ["owner", "grant-1", "share-1", here, 404],
    ["owner", "chatter", "chat", here, 404],
    ["owner", "grant-0", "share-0", { ...here, recipientEmail: "other@example.test" }, 400],
    ["owner", "grant-0", "share-0", {}, 400],
  ];
  for (const [userId, grantId, shareId, body, status] of refused) {
    const label = `${userId} ${shareId} ${grantId} ${JSON.stringify(body)}`;
    const response = await f.resendTo(userId, grantId, shareId, body);
    expect(response.status, label).toBe(status);
    if (status !== 404) continue;
    const levelChange = await f.handler(
      request(
        "stranger",
        "/sync/shares/share-0/grants/grant-0/retune",
        jsonBody({ workspaceId: "workspace", access: "view" }),
      ),
    );
    expect(await response.text(), label).toBe(await levelChange.text());
  }
  const read = await f.handler(
    request("owner", "/sync/shares/share-0/grants/grant-0/invitation-email"),
  );
  expect(read.status).toBe(405);

  expect(f.sent).toHaveLength(2);
  expect(attempts(f.storage)).toBe(counted);
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "sent" });
});

it("answers unavailable, and counts nothing, for an inviter whose own address is not verified", async () => {
  const f = await invited({ lookupVerifiedUserEmail: () => null });

  expect(await f.resend("grant-0", "share-0")).toEqual({
    ok: true,
    invitationEmail: "unavailable",
  });
  expect(await f.resend("grant-1", "share-1")).toEqual({
    ok: true,
    invitationEmail: "unavailable",
  });
  expect(f.sent).toEqual([]);
  expect(attempts(f.storage)).toBe(0);
});

it("answers unavailable, and counts nothing, when the relay has no mail server", async () => {
  const f = await invited({ sendShareInvitationEmail: undefined });

  expect(await f.resend("grant-0", "share-0")).toEqual({
    ok: true,
    invitationEmail: "unavailable",
  });
  expect(await f.resend("grant-1", "share-1")).toEqual({
    ok: true,
    invitationEmail: "unavailable",
  });
  expect(attempts(f.storage)).toBe(0);
});

it("answers failed for a signed-in person with no verified address, and may be tried again at once", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const verified = new Map([
    ["owner", "owner@dohc.test"],
    ["friend", "friend@dohc.test"],
  ]);
  const f = await invited({ lookupVerifiedUserEmail: (userId) => verified.get(userId) ?? null });
  verified.delete("friend");

  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "failed" });
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "failed" });
  expect(f.sent).toHaveLength(2);
  expect(attempts(f.storage)).toBe(4);

  verified.set("friend", "Friend@Example.TEST");
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "sent" });
  expect(f.sent.at(-1)!.to).toBe("friend@example.test");
});

it("paces a send the mail server refused, since it may still have delivered, and sends again after the minute", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const sent: string[] = [];
  let down = false;
  const f = await invited({
    sendShareInvitationEmail: async (message) => {
      if (down) throw new Error("mail server is down");
      sent.push(message.to);
    },
  });

  down = true;
  expect(await f.resend("grant-1", "share-1")).toEqual({ ok: true, invitationEmail: "failed" });
  down = false;
  expect(await f.resend("grant-1", "share-1")).toEqual({ ok: true, invitationEmail: "recent" });
  f.clock.nowMs += INTERVAL_MS;
  expect(await f.resend("grant-1", "share-1")).toEqual({ ok: true, invitationEmail: "sent" });

  expect(sent).toEqual(["friend@dohc.test", "pending@example.test", "pending@example.test"]);
  expect(attempts(f.storage)).toBe(4);
});

it("paces a database that counted invitations before it knew their grants", async () => {
  const storage = await testStorage();
  const db = (storage as StorageContext).db;
  db.exec(`DROP INDEX idx_${SHARE_INVITATION_EMAILS}_grant;
    ALTER TABLE ${SHARE_INVITATION_EMAILS} DROP COLUMN grant_id;
    DELETE FROM sync_relay_migrations WHERE migration_id = 'share-invitation-email-grants-v1';
    INSERT INTO ${SHARE_INVITATION_EMAILS} (inviter_user_id, attempted_at_ms) VALUES ('owner', 1000)`);
  const path = storagePath(storage);
  closeTestStorage(storage);

  const reopened = reopenTestStorage(path);
  const admit = (nowMs: number) =>
    admitShareInvitationEmail(reopened, {
      inviterUserId: "owner",
      grantId: "grant-0",
      nowMs,
      limit: 2,
      windowMs: 86_400_000,
      grantIntervalMs: INTERVAL_MS,
    });

  expect(admit(2000)).toMatchObject({ admitted: true });
  expect(admit(2001)).toEqual({ admitted: false, refused: "recent" });
  expect(admit(2000 + INTERVAL_MS)).toEqual({ admitted: false, refused: "limit", sent: 2 });
});

it("sends nothing, counts nothing and answers as a level change does when the person is removed while their address is read", async () => {
  let held = false;
  let waiting: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let answerLookup: (email: string) => void = () => undefined;
  const f = await invited({
    lookupVerifiedUserEmail: (userId) => {
      if (!held || userId !== "friend") return `${userId}@dohc.test`;
      waiting();
      return new Promise<string>((resolve) => {
        answerLookup = resolve;
      });
    },
  });
  const counted = attempts(f.storage);

  held = true;
  const resending = f.resendTo("owner", "grant-0", "share-0");
  await reading;
  held = false;
  const removed = await f.handler(
    request(
      "owner",
      "/sync/shares/share-0/grants/grant-0/revoke",
      jsonBody({ workspaceId: "workspace" }),
    ),
  );
  expect(removed.status).toBe(200);
  answerLookup("friend@dohc.test");
  const response = await resending;

  const levelChange = await f.handler(
    request(
      "owner",
      "/sync/shares/share-0/grants/grant-0/retune",
      jsonBody({ workspaceId: "workspace", access: "view" }),
    ),
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toBe(await levelChange.text());
  expect(f.sent).toHaveLength(2);
  expect(attempts(f.storage)).toBe(counted);
});

it("names the access the person has when the email goes, after a change made while their address was read", async () => {
  let held = false;
  let waiting: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  let answerLookup: (email: string) => void = () => undefined;
  const f = await invited({
    lookupVerifiedUserEmail: (userId) => {
      if (!held || userId !== "friend") return `${userId}@dohc.test`;
      waiting();
      return new Promise<string>((resolve) => {
        answerLookup = resolve;
      });
    },
  });

  held = true;
  const resending = f.resendTo("owner", "grant-0", "share-0");
  await reading;
  held = false;
  const lowered = await f.handler(
    request(
      "owner",
      "/sync/shares/share-0/grants/grant-0/retune",
      jsonBody({ workspaceId: "workspace", access: "view" }),
    ),
  );
  expect(lowered.status).toBe(200);
  answerLookup("friend@dohc.test");

  expect(await json(await resending)).toEqual({ ok: true, invitationEmail: "sent" });
  expect(f.sent.at(-1)!.text).toContain("You can view it.");
  expect(f.sent.at(-1)!.text).not.toContain("Open it in your browser:");
});

it("keeps the minute once a send began, whether the deadline passed or the mail server refused", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const storage = await testStorage();
  let refuse: (error: Error) => void = () => undefined;
  const sendEmail = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        refuse = reject;
      }),
  );
  const email = createShareInvitationEmailer({
    storage,
    nowMs: () => 1_000_000,
    sendEmail,
    lookupVerifiedUserEmail: () => "owner@dohc.test",
    relayPublicOrigin: "https://relay.example.test",
    timeoutMs: 20,
  });
  const resend = {
    inviterUserId: "owner",
    recipientEmail: "friend@dohc.test",
    shareId: "share-0",
    grantId: "grant-0",
    subjectName: "Trip plan",
    access: "edit",
    browserInvitationUrl: null,
    beforeResend: () => ({ access: "edit", browserInvitationUrl: null }),
  };

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const pastTheDeadline = async (sends: number) => {
      const answer = email(resend);
      await vi.advanceTimersByTimeAsync(0);
      expect(sendEmail).toHaveBeenCalledTimes(sends);
      await vi.advanceTimersByTimeAsync(20);
      return answer;
    };

    expect(await pastTheDeadline(1)).toEqual({ invitationEmail: "failed" });
    expect(await email(resend)).toEqual({ invitationEmail: "recent" });
    expect(sendEmail).toHaveBeenCalledOnce();

    refuse(new Error("mail server refused"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await email(resend)).toEqual({ invitationEmail: "recent" });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(attempts(storage)).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("frees only its own try's minute when another try took the same row number since", async () => {
  const storage = await testStorage();
  const admit = (inviterUserId: string, grantId: string) =>
    admitShareInvitationEmail(storage, {
      inviterUserId,
      grantId,
      nowMs: 2000,
      limit: 50,
      windowMs: 86_400_000,
      grantIntervalMs: INTERVAL_MS,
    });
  const first = admit("owner", "grant-0");
  if (!first.admitted) throw new Error("the first try was refused");
  (storage as StorageContext).db.exec(`DELETE FROM ${SHARE_INVITATION_EMAILS}`);
  expect(admit("neighbor", "grant-9")).toEqual(first);

  forgetShareInvitationEmailGrant(storage, {
    attemptId: first.attemptId,
    inviterUserId: "owner",
    grantId: "grant-0",
  });

  expect(admit("neighbor", "grant-9")).toEqual({ admitted: false, refused: "recent" });
});

it("sends a first invite whatever was already recorded for its new grant, and paces the resend after it", async () => {
  const f = await fixture();
  expect(
    admitShareInvitationEmail(f.storage, {
      inviterUserId: "owner",
      grantId: "grant-0",
      nowMs: f.clock.nowMs,
      limit: 50,
      windowMs: 86_400_000,
      grantIntervalMs: INTERVAL_MS,
    }),
  ).toMatchObject({ admitted: true });

  expect(await f.invite("pending@example.test")).toMatchObject({
    grantId: "grant-0",
    invitationEmail: "sent",
  });
  expect(f.sent).toHaveLength(1);
  expect(await f.resend("grant-0", "share-0")).toEqual({ ok: true, invitationEmail: "recent" });
  expect(f.sent).toHaveLength(1);
});

it("emails a person who joined through a link once the owner has made them independent", async () => {
  const f = await invited();
  seedLinkGrant(f.storage, {
    shareId: "share-0",
    grantId: "link",
    secretHash: hashLinkBearer("a".repeat(43), LINK_KEY),
    access: "edit",
  });
  expect(
    seedDependentGrant(f.storage, {
      shareId: "share-0",
      parentGrantId: "link",
      grantId: "joined",
      principalUserId: "holder",
      createdAtMs: 3,
    }).ok,
  ).toBe(true);
  expect((await f.resendTo("owner", "joined", "share-0")).status).toBe(404);

  const promoted = await f.handler(
    request(
      "owner",
      "/sync/shares/share-0/grants/joined/promote",
      jsonBody({
        workspaceId: "workspace",
        expectedParentGrantId: "link",
        expectedParentGeneration: 1,
      }),
    ),
  );
  expect(promoted.status).toBe(200);
  expect(f.storage.getShareGrant("joined")).toMatchObject({ parentGrantId: null });

  expect(await f.resend("joined", "share-0")).toEqual({ ok: true, invitationEmail: "sent" });
  expect(f.sent).toHaveLength(3);
  expect(f.sent[2]).toMatchObject({
    to: "holder@dohc.test",
    subject: 'owner@dohc.test shared "Trip plan" with you',
  });
  expect(f.sent[2]!.text).toContain("1. Sign in to dohc as holder@dohc.test.");
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  appendLog,
  claimWorkspace,
  closeTestStorages,
  countStorageCalls,
  createShare as mint,
  denialBytes,
  interceptStorage,
  json,
  jsonBody,
  moment,
  nextOpSeq,
  putBlob as upload,
  request,
  resetOpSeq,
  sha256,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

function handler(
  storage: SyncRelayStorage,
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null,
  lookupVerifiedUserEmail?: (userId: string) => Promise<string | null> | string | null,
): SyncRelayHandler {
  return testHandler(storage, { nowMs: () => 5555, ...(lookupUserEmail ? { lookupUserEmail } : {}),
    ...(lookupVerifiedUserEmail ? { lookupVerifiedUserEmail } : {}) });
}

function countActiveRecipientGrantScans(storage: SyncRelayStorage): {
  storage: SyncRelayStorage;
  scansForShare: (shareId: string) => number;
} {
  const counted = countStorageCalls(storage, "listActiveShareGrantsForRecipient");
  return {
    storage: counted.storage,
    scansForShare: (shareId) => counted.calls.filter(([id]) => id === shareId).length,
  };
}

const GRANTER = "granter";
const RECIPIENT = "recipient";
const STRANGER = "stranger";
const WORKSPACE = "workspace-a";

async function createShare(
  h: SyncRelayHandler,
  body: Record<string, unknown> = { recipientEmail: `${RECIPIENT}@dohc.test`, paths: ["docs"] },
): Promise<string> {
  return mint(h, GRANTER, WORKSPACE, body);
}

async function createWorkspace(h: SyncRelayHandler): Promise<void> {
  await claimWorkspace(h, GRANTER, WORKSPACE);
}

function momentOp(path: string, content: string, payload: Record<string, unknown> = {}) {
  return moment(path, content, { objectId: `object-${path}`, payload });
}

async function appendOps(h: SyncRelayHandler, ops: unknown[]): Promise<void> {
  await appendLog(h, GRANTER, WORKSPACE, ops);
}

async function putBlob(h: SyncRelayHandler, content: string): Promise<string> {
  return upload(h, GRANTER, WORKSPACE, content);
}

function directShareInput(
  shareId: string,
  grantId = `grant-${shareId}`,
): Parameters<SyncRelayStorage["createShare"]>[0] {
  return {
    share: {
      shareId,
      workspaceId: WORKSPACE,
      granterUserId: GRANTER,
      selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
      createdAtMs: 1_000,
    },
    grant: {
      grantId,
      shareId,
      principalKind: "user",
      principalUserId: RECIPIENT,
      principalEmail: null,
      access: "view",
      generation: 1,
      status: "active",
      createdAtMs: 1_000,
      revokedAtMs: null,
      parentGrantId: null,
    },
  };
}

function claimStorageWorkspace(storage: SyncRelayStorage): void {
  expect(
    storage.claimWorkspace({
      workspaceId: WORKSPACE,
      ownerUserId: GRANTER,
      createdAtMs: 1_000,
    }),
  ).toBe("created");
}

describe("createShare storage boundary", () => {
  it("refuses mismatched share and grant ids without persisting either row", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    const input = directShareInput("share-mismatch", "grant-mismatch");
    input.grant.shareId = "share-other";

    expect(() => storage.createShare(input)).toThrow("share and grant ids do not match");
    expect(storage.getShare("share-mismatch")).toBeNull();
    expect(storage.getShareGrant("grant-mismatch")).toBeNull();
  });

  it("refuses a link grant without persisting either row", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    const input = directShareInput("share-link", "grant-link");
    input.grant.principalKind = "link";
    input.grant.principalUserId = null;

    expect(() => storage.createShare(input)).toThrow(
      "a link grant requires an existing share and a credential",
    );
    expect(storage.getShare("share-link")).toBeNull();
    expect(storage.getShareGrant("grant-link")).toBeNull();
  });

  it("persists the share and grant for valid input", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    storage.createShare(directShareInput("share-valid", "grant-valid"));

    expect(storage.getShare("share-valid")).toMatchObject({
      shareId: "share-valid",
      workspaceId: WORKSPACE,
      granterUserId: GRANTER,
    });
    expect(storage.getShareGrant("grant-valid")).toMatchObject({
      grantId: "grant-valid",
      shareId: "share-valid",
      principalKind: "user",
      principalUserId: RECIPIENT,
    });
  });

  it("rolls the share insert back when the grant insert fails", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    storage.createShare(directShareInput("share-seed", "grant-duplicate"));

    expect(() =>
      storage.createShare(directShareInput("share-rolled-back", "grant-duplicate")),
    ).toThrow();
    expect(storage.getShare("share-rolled-back")).toBeNull();
    expect(storage.getShareGrant("grant-duplicate")).toMatchObject({
      shareId: "share-seed",
    });
  });
});

describe("share grants", () => {
  beforeEach(() => {
    resetOpSeq();
  });

  it("scans active recipient grants once for one received-list row", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    storage.createShare(directShareInput("share-counted-list"));
    const counted = countActiveRecipientGrantScans(storage);
    const response = await json(
      await handler(counted.storage)(request(RECIPIENT, "/sync/shares")),
    );

    expect(response.received).toEqual([
      expect.objectContaining({
        shareId: "share-counted-list",
        genericChatWritable: false,
      }),
    ]);
    expect(counted.scansForShare("share-counted-list")).toBe(1);
  });

  it("scans active recipient grants once per distinct received share", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    for (const shareId of ["share-counted-a", "share-counted-b", "share-counted-c"]) {
      storage.createShare(directShareInput(shareId));
    }
    const counted = countActiveRecipientGrantScans(storage);
    const response = await json(
      await handler(counted.storage)(request(RECIPIENT, "/sync/shares")),
    );

    expect(response.received).toHaveLength(3);
    for (const shareId of ["share-counted-a", "share-counted-b", "share-counted-c"]) {
      expect(counted.scansForShare(shareId), shareId).toBe(1);
    }
  });

  it("uses an initial gate and one combined final scan for an exact received share", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    storage.createShare(directShareInput("share-counted-exact"));
    const counted = countActiveRecipientGrantScans(storage);
    const response = await json(
      await handler(counted.storage)(
        request(RECIPIENT, "/sync/shares/share-counted-exact"),
      ),
    );

    expect(response).toMatchObject({
      shareId: "share-counted-exact",
      genericChatWritable: false,
    });
    expect(counted.scansForShare("share-counted-exact")).toBe(2);
  });

  it("rechecks exact-share authority after the granter email lookup", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    storage.createShare(directShareInput("share-post-await"));
    const counted = countActiveRecipientGrantScans(storage);
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let granterLookups = 0;
    const h = handler(counted.storage, async (userId) => {
      if (userId !== GRANTER) return `${userId}@dohc.test`;
      granterLookups += 1;
      markLookupStarted();
      await lookupGate;
      return `${userId}@dohc.test`;
    });

    const pending = h(request(RECIPIENT, "/sync/shares/share-post-await"));
    await lookupStarted;
    expect(granterLookups).toBe(1);
    expect(storage.revokeShare("share-post-await", 2_000)).toBe(true);
    releaseLookup();

    const removed = await pending;
    expect(removed.status).toBe(404);
    expect(await removed.json()).toMatchObject({code: "share_access_removed", error: "The owner removed your access."});
    expect(counted.scansForShare("share-post-await")).toBe(3);
  });

  it("omits a received-list row revoked during the granter email lookup", async () => {
    const storage = await testStorage();
    claimStorageWorkspace(storage);
    storage.createShare(directShareInput("share-list-post-await"));
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const h = handler(storage, async (userId) => {
      if (userId !== GRANTER) return `${userId}@dohc.test`;
      markLookupStarted();
      await lookupGate;
      return `${userId}@dohc.test`;
    });

    const pending = h(request(RECIPIENT, "/sync/shares"));
    await lookupStarted;
    expect(storage.revokeShare("share-list-post-await", 2_000)).toBe(true);
    releaseLookup();

    expect((await json(await pending)).received).toEqual([]);
  });

  it("creates a share by recipient email and lists it on both sides", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const create = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: `${RECIPIENT}@dohc.test`, paths: ["docs", "notes.md"], access: "view" }),
      ),
    );
    expect(create.status).toBe(200);
    const created = await json(create);
    // The email-create response deliberately omits recipientUserId so it
    // cannot be used as an account-enumeration oracle (see the pending-invite
    // test below): the reply is identical for known and unknown emails.
    expect(created).toMatchObject({
      ok: true,
      shareId: "share-0",
      workspaceId: WORKSPACE,
      selector: { paths: ["docs", "notes.md"], versionId: null },
      access: "view",
      grantId: expect.any(String),
      generation: 1,
      createdAtMs: 5555,
    });
    expect(created.selector).not.toHaveProperty("access");
    expect(created).not.toHaveProperty("recipientUserId");

    const granterList = await json(await h(request(GRANTER, "/sync/shares")));
    expect(granterList.granted).toEqual([
      {
        subjectName: null, sharerName: null,
        shareId: "share-0",
        workspaceId: WORKSPACE,
        recipientUserId: RECIPIENT,
        recipientEmail: `${RECIPIENT}@dohc.test`,
        selector: { paths: ["docs", "notes.md"], versionId: null },
        access: "view",
        grantId: expect.any(String),
        principalKind: "user",
        generation: 1,
        createdAtMs: 5555,
        revokedAtMs: null,
      },
    ]);
    expect(granterList.received).toEqual([]);

    const recipientList = await json(await h(request(RECIPIENT, "/sync/shares")));
    expect(recipientList.granted).toEqual([]);
    const received = recipientList.received as Array<Record<string, unknown>>;
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      shareId: "share-0",
      granterUserId: GRANTER,
      granterEmail: `${GRANTER}@dohc.test`,
      selector: { paths: ["docs", "notes.md"], versionId: null },
      access: "view",
      grantId: expect.any(String),
      principalKind: "user",
      generation: 1,
    });
    // The recipient never learns the granter's workspace id.
    expect(received[0]).not.toHaveProperty("workspaceId");

    const metadata = await json(await h(request(RECIPIENT, "/sync/shares/share-0")));
    expect(metadata).toMatchObject({
      ok: true,
      shareId: "share-0",
      granterUserId: GRANTER,
      selector: { paths: ["docs", "notes.md"], versionId: null },
      access: "view",
      grantId: expect.any(String),
      principalKind: "user",
      generation: 1,
    });
  });

  it("marks a file selector with chat access as damaged and keeps the share revocable", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    storage.createShare({
      share: {
        shareId: "share-damaged-file-access",
        workspaceId: WORKSPACE,
        granterUserId: GRANTER,
        selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
        createdAtMs: 1000,
      },
      grant: {
        grantId: "grant-damaged-file-access",
        shareId: "share-damaged-file-access",
        principalKind: "user",
        principalUserId: RECIPIENT,
        principalEmail: null,
        access: "read-write",
        generation: 1,
        status: "active",
        createdAtMs: 1000,
        revokedAtMs: null,
        parentGrantId: null,
      },
    });

    const granted = (await json(await h(request(GRANTER, "/sync/shares")))).granted as Array<
      Record<string, unknown>
    >;
    expect(granted).toContainEqual(
      expect.objectContaining({
        shareId: "share-damaged-file-access",
        selector: null,
        access: "read-write",
        damaged: true,
        revokedAtMs: null,
      }),
    );

    const received = (await json(await h(request(RECIPIENT, "/sync/shares")))).received as Array<
      Record<string, unknown>
    >;
    expect(received).toContainEqual(
      expect.objectContaining({
        shareId: "share-damaged-file-access",
        selector: null,
        access: "read-write",
        damaged: true,
      }),
    );
    expect(received[0]).not.toHaveProperty("workspaceId");

    const revoke = await h(
      request(GRANTER, "/sync/shares/share-damaged-file-access/revoke", { method: "POST" }),
    );
    expect(revoke.status).toBe(200);
    expect((await json(await h(request(RECIPIENT, "/sync/shares")))).received).toEqual([]);
    expect(
      ((await json(await h(request(GRANTER, "/sync/shares")))).granted as Array<
        Record<string, unknown>
      >)[0],
    ).toMatchObject({
      shareId: "share-damaged-file-access",
      selector: null,
      access: "read-write",
      damaged: true,
      generation: 2,
      revokedAtMs: 5555,
    });
  });

  it("creates a share at each level and carries it on the summary rows on both sides", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);

    for (const access of ["view", "comment", "edit"] as const) {
      const create = await h(
        request(
          GRANTER,
          `/sync/${WORKSPACE}/shares`,
          jsonBody({ recipientUserId: RECIPIENT, paths: [`docs-${access}`], access }),
        ),
      );
      expect(create.status, access).toBe(200);
      const created = await json(create);
      expect(created.access, access).toBe(access);
      expect(created.selector, access).not.toHaveProperty("access");
    }

    const granterList = await json(await h(request(GRANTER, "/sync/shares")));
    const granted = granterList.granted as Array<{ access: string; selector: object }>;
    expect(granted.map((row) => row.access)).toEqual(["view", "comment", "edit"]);
    expect(granted.every((row) => !("access" in row.selector))).toBe(true);

    const recipientList = await json(await h(request(RECIPIENT, "/sync/shares")));
    const received = recipientList.received as Array<{ access: string; selector: object }>;
    expect(received.map((row) => row.access)).toEqual(["view", "comment", "edit"]);
    expect(received.every((row) => !("access" in row.selector))).toBe(true);
  });

  it("refuses an unrecognized access value at grant time", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const response = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"], access: "Edit" }),
      ),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).code).toBe("invalid_access");
  });

  // #646 PR2 opens the append route to comment and edit file shares. What
  // must not change is the refusal a VIEW share gets: one code, and a body
  // byte-identical to the one a read-only chat grant gets. A refusal
  // that differed by selector kind or by level would let a probing recipient
  // read the grant it was refused. Byte-identical bodies are the
  // anti-fingerprinting property itself, not a proxy for it.
  it("refuses a view share's append with a body byte-identical to a read-only channel grant's", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);

    const viewShare = await json(
      await h(
        request(
          GRANTER,
          `/sync/${WORKSPACE}/shares`,
          jsonBody({ recipientUserId: RECIPIENT, paths: ["docs-view"], access: "view" }),
        ),
      ),
    );
    const channelShare = await json(
      await h(
        request(
          GRANTER,
          `/sync/${WORKSPACE}/shares`,
          jsonBody({
            recipientUserId: RECIPIENT,
            channelWireId: "wire-broadcast",
            access: "read-only",
          }),
        ),
      ),
    );
    const bodies: string[] = [];
    for (const shareId of [viewShare.shareId as string, channelShare.shareId as string]) {
      const append = await h(
        request(RECIPIENT, `/sync/shares/${shareId}/log`, jsonBody({ originId: "o", ops: [] })),
      );
      expect(append.status, shareId).toBe(403);
      const body = await append.text();
      expect(JSON.parse(body).code, shareId).toBe("share_read_only");
      bodies.push(body);
    }
    expect(
      bodies[0],
      "a view share's refusal must not be distinguishable from a read-only channel's",
    ).toBe(bodies[1]);
  });

  // The other half of the same gate: comment and edit are past it in PR2. An
  // empty batch is the smallest thing that proves the LEVEL decided, with no
  // per-op filtering in the way.
  it("accepts an empty append batch on a comment or edit file share", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    for (const access of ["comment", "edit"] as const) {
      const created = await json(
        await h(
          request(
            GRANTER,
            `/sync/${WORKSPACE}/shares`,
            jsonBody({ recipientUserId: RECIPIENT, paths: [`docs-${access}`], access }),
          ),
        ),
      );
      const append = await h(
        request(
          RECIPIENT,
          `/sync/shares/${created.shareId as string}/log`,
          jsonBody({ originId: "o", ops: [] }),
        ),
      );
      expect(append.status, access).toBe(200);
    }
  });

  it("refuses secret paths, traversal, empty selectors, and self-shares at grant time", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);

    const secret = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: RECIPIENT, paths: [".env"], access: "view" })),
    );
    expect(secret.status).toBe(400);
    expect((await json(secret)).code).toBe("secret_path");

    const encodedSecret = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({
          recipientUserId: RECIPIENT,
          paths: ["config/secrets%2eenv"],
          access: "view",
        }),
      ),
    );
    expect(encodedSecret.status).toBe(400);
    expect((await json(encodedSecret)).code).toBe("secret_path");

    const traversal = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({
          recipientUserId: RECIPIENT,
          paths: ["../other-workspace/file.md"],
          access: "view",
        }),
      ),
    );
    expect(traversal.status).toBe(400);
    expect((await json(traversal)).code).toBe("invalid_path");

    const empty = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: RECIPIENT, paths: [], access: "view" })),
    );
    expect(empty.status).toBe(400);
    expect((await json(empty)).code).toBe("empty_selector");

    const self = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: GRANTER, paths: ["docs"], access: "view" })),
    );
    expect(self.status).toBe(400);
    expect((await json(self)).code).toBe("self_share");

    // A self-share addressed by the granter's own email is refused with the
    // same code (the email resolves to the granter's account).
    const selfByEmail = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: `${GRANTER}@dohc.test`, paths: ["docs"], access: "view" }),
      ),
    );
    expect(selfByEmail.status).toBe(400);
    expect((await json(selfByEmail)).code).toBe("self_share");
  });

  it("does not reveal whether an email has an account: known and unknown emails create indistinguishable pending/real invites", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);

    const known = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: `${RECIPIENT}@dohc.test`, paths: ["docs"], access: "view" }),
      ),
    );
    const unknown = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: "nobody@elsewhere.example", paths: ["docs"], access: "view" }),
      ),
    );
    expect(known.status).toBe(unknown.status);
    expect(known.status).toBe(200);
    const knownBody = await json(known);
    const unknownBody = await json(unknown);
    // Neither reply leaks the recipient's account existence: same shape, same
    // keys, and neither carries a recipientUserId.
    expect(knownBody).not.toHaveProperty("recipientUserId");
    expect(unknownBody).not.toHaveProperty("recipientUserId");
    expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());

    // The unknown email is recorded as a pending invite: unclaimed, it is not
    // yet readable by anyone, but it survives as an honest grant.
    const pendingShareId = unknownBody.shareId as string;
    const beforeClaim = await h(request(RECIPIENT, `/sync/shares/${pendingShareId}/log?since=0`));
    expect(beforeClaim.status).toBe(404);
  });

  it("claims a pending email invite only for the account whose session email matches", async () => {
    const storage = await testStorage();
    // LATE_EMAIL has no @dohc.test account, so it is stored as a pending
    // invite. The reverse lookup maps the late user id to that address, so its
    // first authenticated request claims the invite — but RECIPIENT's does not.
    const LATE = "late-user";
    const LATE_EMAIL = "late@corp.example";
    const h = handler(storage, undefined, (userId) => (userId === LATE ? LATE_EMAIL : `${userId}@dohc.test`));
    await createWorkspace(h);
    await putBlob(h, "shared body");
    await appendOps(h, [momentOp("docs/shared.md", "shared body")]);

    // Grant to an address with no account yet: a pending invite.
    const create = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientEmail: LATE_EMAIL, paths: ["docs"], access: "view" })),
    );
    expect(create.status).toBe(200);
    const shareId = (await json(create)).shareId as string;

    // A different account (wrong session email) cannot claim or read it.
    expect((await h(request(RECIPIENT, `/sync/shares/${shareId}/log?since=0`))).status).toBe(404);

    // The invited account's first recipient request claims the invite.
    const page = await json(await h(request(LATE, `/sync/shares/${shareId}/log?since=0`)));
    const ops = page.ops as Array<{ opKind: string; payload: { path?: string } }>;
    expect(ops.map((op) => op.payload.path ?? null)).toEqual(["docs/shared.md"]);

    // It now appears in the claimant's received list.
    const received = (await json(await h(request(LATE, "/sync/shares")))).received as unknown[];
    expect(received).toHaveLength(1);
  });

  it("refuses share creation on a workspace the caller does not own, byte-identically to no workspace", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const foreign = await denialBytes(
      await h(request(STRANGER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"], access: "view" }))),
    );
    const missing = await denialBytes(
      await h(request(STRANGER, "/sync/no-such-workspace/shares", jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"], access: "view" }))),
    );
    expect(foreign).toBe(missing);
  });

  it("serves the recipient only ops inside the selector and denies everyone else byte-identically", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    // The append validates that every referenced blob is stored, so upload the
    // content behind each op first (the granter legitimately holds it). The
    // recipient-side redaction below is independent of blob presence: the
    // filter drops out-of-selector and secret ops from the RECIPIENT's view
    // whether or not the granter uploaded their content.
    await putBlob(h, "shared body");
    await putBlob(h, "hidden body");
    await putBlob(h, "deep body");
    await putBlob(h, "ciphertext");
    await appendOps(h, [
      { originSeq: nextOpSeq(), opKind: "workspace.init", payload: { note: "init" }, recordedAtMs: 999 },
      momentOp("docs/shared.md", "shared body"),
      momentOp("private/hidden.md", "hidden body"),
      momentOp("docs/nested/deep.md", "deep body"),
      {
        originSeq: nextOpSeq(),
        opKind: "secret.file.put",
        payload: {
          versionId: "main",
          path: "docs/.env",
          metadata: { origin: "user" },
          ivBase64: "AA==",
          authTagBase64: "AA==",
          ciphertextSha256: sha256("ciphertext"),
          byteLength: 10,
        },
        recordedAtMs: 1100,
      },
      {
        originSeq: nextOpSeq(),
        opKind: "chat.message.append",
        payload: {
          messageId: "m1",
          threadId: "t1",
          authorKind: "user",
          authorDisplayName: "G",
          authorUserId: GRANTER,
          body: "secret chat",
          createdAtMs: 1,
        },
        recordedAtMs: 1200,
      },
    ]);
    await createShare(h);

    const page = await json(await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=100")));
    expect(page.ok).toBe(true);
    const ops = page.ops as Array<{ opKind: string; payload: { path?: string } }>;
    expect(ops.map((op) => [op.opKind, op.payload.path ?? null])).toEqual([
      ["workspace.init", null],
      ["moment.append", "docs/shared.md"],
      ["moment.append", "docs/nested/deep.md"],
    ]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("private/hidden.md");
    expect(serialized).not.toContain("secret chat");
    expect(serialized).not.toContain(sha256("ciphertext"));
    // workspace.init's stored payload is served as an empty object — nothing
    // from the granter's payload rides along.
    expect((ops[0] as unknown as { payload: unknown }).payload).toEqual({});

    // Non-recipient users (including the granter on the recipient route and
    // a stranger) are indistinguishable from a nonexistent share.
    const missing = await denialBytes(await h(request(STRANGER, "/sync/shares/share-404/log?since=0")));
    expect(await denialBytes(await h(request(STRANGER, "/sync/shares/share-0/log?since=0")))).toBe(missing);
    expect(await denialBytes(await h(request(GRANTER, "/sync/shares/share-0/log?since=0")))).toBe(missing);
    expect(await denialBytes(await h(request(STRANGER, "/sync/shares/share-0")))).toBe(missing);

    // Unauthenticated probes stay 401 (auth precedes share lookups).
    expect((await h(request(null, "/sync/shares/share-0/log?since=0"))).status).toBe(401);
  });

  it("serves shared blobs and denies unshared or secret blob hashes byte-identically to unknown hashes", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const sharedSha = await putBlob(h, "shared body");
    const hiddenSha = await putBlob(h, "hidden body");
    const cipherSha = await putBlob(h, "ciphertext-bytes");
    await appendOps(h, [
      momentOp("docs/shared.md", "shared body"),
      momentOp("private/hidden.md", "hidden body"),
      {
        originSeq: nextOpSeq(),
        opKind: "secret.file.put",
        payload: {
          versionId: "main",
          path: "notes/.env.local",
          metadata: { origin: "user" },
          ivBase64: "AA==",
          authTagBase64: "AA==",
          ciphertextSha256: cipherSha,
          byteLength: 16,
        },
        recordedAtMs: 1300,
      },
    ]);
    await createShare(h);

    const allowed = await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${sharedSha}`));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("shared body");

    const unknownHash = sha256("never uploaded");
    const unknown = await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${unknownHash}`)));
    expect(await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${hiddenSha}`)))).toBe(unknown);
    expect(await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${cipherSha}`)))).toBe(unknown);
    // A stranger probing an allowed hash gets the same denial too.
    expect(await denialBytes(await h(request(STRANGER, `/sync/shares/share-0/blobs/${sharedSha}`)))).toBe(unknown);
  });

  it("serves an earlier write's blob to an authenticated recipient replaying share history", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const earlierContent = "earlier body";
    const replacementContent = "replacement body";
    const earlierSha = await putBlob(h, earlierContent);
    await putBlob(h, replacementContent);
    await appendOps(h, [
      momentOp("docs/shared.md", earlierContent),
      momentOp("docs/shared.md", replacementContent, {
        payloadBeforeBlobSha256: earlierSha,
        payloadBeforePath: "docs/shared.md",
        beforePresent: "present",
      }),
    ]);
    await createShare(h);

    const earlier = await h(
      request(RECIPIENT, `/sync/shares/share-0/blobs/${earlierSha}`),
    );
    expect(earlier.status, await earlier.clone().text()).toBe(200);
    expect(await earlier.text()).toBe(earlierContent);
  });

  it("serves a deleted file's blob to an authenticated recipient replaying share history", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const deletedContent = "deleted body";
    const deletedSha = await putBlob(h, deletedContent);
    await appendOps(h, [
      momentOp("docs/shared.md", deletedContent),
      momentOp("docs/shared.md", deletedContent, {
        operation: "delete",
        payloadBeforeBlobSha256: deletedSha,
        payloadBeforePath: "docs/shared.md",
        payloadAfterBlobSha256: null,
        payloadAfterPath: null,
        beforePresent: "present",
      }),
    ]);
    await createShare(h);

    const deleted = await h(
      request(RECIPIENT, `/sync/shares/share-0/blobs/${deletedSha}`),
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.text()).toBe(deletedContent);
  });

  it("stops serving a revoked share and explains the removal only to its named recipient", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const sharedSha = await putBlob(h, "shared body");
    await appendOps(h, [momentOp("docs/shared.md", "shared body")]);
    await createShare(h);

    expect((await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0"))).status).toBe(200);
    expect(storage.listSharesGrantedBy(GRANTER)[0]?.grant).toMatchObject({
      generation: 1,
      status: "active",
      revokedAtMs: null,
    });

    // The recipient cannot revoke; only the granter can.
    const recipientRevoke = await h(request(RECIPIENT, "/sync/shares/share-0/revoke", { method: "POST" }));
    expect(recipientRevoke.status).toBe(404);

    const revoke = await h(request(GRANTER, "/sync/shares/share-0/revoke", { method: "POST" }));
    expect(revoke.status).toBe(200);
    // Idempotent for the granter.
    expect((await h(request(GRANTER, "/sync/shares/share-0/revoke", { method: "POST" }))).status).toBe(200);
    expect(storage.listSharesGrantedBy(GRANTER)[0]?.grant).toMatchObject({
      generation: 2,
      status: "revoked",
      revokedAtMs: 5555,
    });

    for (const path of ["/sync/shares/share-0/log?since=0", "/sync/shares/share-0", `/sync/shares/share-0/blobs/${sharedSha}`]) {
      const response = await h(request(RECIPIENT, path));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({code: "share_access_removed"});
      expect(await denialBytes(await h(request(STRANGER, path)))).toContain('"code":"not_found"');
    }

    // Revoked shares vanish from the recipient's list but stay (stamped) in
    // the granter's management list.
    const recipientList = await json(await h(request(RECIPIENT, "/sync/shares")));
    expect(recipientList.received).toEqual([]);
    const granterList = await json(await h(request(GRANTER, "/sync/shares")));
    expect((granterList.granted as Array<Record<string, unknown>>)[0]).toMatchObject({
      shareId: "share-0",
      revokedAtMs: 5555,
    });
  });

  it("redacts version.create fork snapshots for version shares", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const keepSha = await putBlob(h, "kept snapshot");
    const dropSha = await putBlob(h, "dropped snapshot");
    await appendOps(h, [
      {
        originSeq: nextOpSeq(),
        opKind: "version.create",
        payload: {
          versionId: "version-1",
          name: "review",
          kind: "named",
          createdAtMs: 1,
          forkSnapshots: [
            { objectId: "o1", path: "docs/a.md", blobSha256: keepSha, updatedAtMs: 1, latestMomentId: "m1", metadata: {} },
            { objectId: "o2", path: "private/b.md", blobSha256: dropSha, updatedAtMs: 1, latestMomentId: "m2", metadata: {} },
          ],
        },
        recordedAtMs: 900,
      },
      momentOp("docs/a.md", "kept snapshot", { versionId: "version-1" }),
      momentOp("private/b.md", "dropped snapshot", { versionId: "version-1" }),
    ]);
    await createShare(h, { recipientUserId: RECIPIENT, paths: ["docs"], versionId: "version-1" });

    const page = await json(await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0")));
    const serialized = JSON.stringify(page);
    expect(serialized).toContain("docs/a.md");
    expect(serialized).not.toContain("private/b.md");
    expect(serialized).not.toContain(dropSha);
    const ops = page.ops as Array<{ opKind: string }>;
    expect(ops.map((op) => op.opKind)).toEqual(["version.create", "moment.append"]);

    expect((await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${keepSha}`))).status).toBe(200);
    const unknown = await denialBytes(
      await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${sha256("never uploaded")}`)),
    );
    expect(await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${dropSha}`)))).toBe(unknown);
  });

  it("excludes an allowed path recorded under a different version from a version share (version filtering)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    await putBlob(h, "v1 body");
    await putBlob(h, "main body");
    await appendOps(h, [
      // Same in-selector path (docs/a.md) written on two versions: only the
      // version-1 moment belongs to a version-1 share. A regression that
      // ignored the versionId selector (path-only filtering) would leak the
      // main-version moment.
      momentOp("docs/a.md", "v1 body", { versionId: "version-1" }),
      momentOp("docs/a.md", "main body", { versionId: "main" }),
    ]);
    await createShare(h, { recipientUserId: RECIPIENT, paths: ["docs"], versionId: "version-1" });

    const page = await json(await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0")));
    const ops = page.ops as Array<{ opKind: string; payload: { path?: string } }>;
    // Exactly one moment.append survives — the version-1 one. The main-version
    // write of the same path is excluded.
    expect(ops).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(sha256("main body"));
  });

  it("aborts an in-flight shared-log read when the share is revoked mid-request (revocation race)", async () => {
    const storage = await testStorage();
    // Wrap the storage so fetchLogPage revokes the share as a side effect:
    // this lands after the route's entry check but before the body is
    // returned, exactly the race the immediate re-check must catch.
    const racing = interceptStorage(storage, {
      fetchLogPage: (target, input) => {
        const page = target.fetchLogPage(input);
        target.revokeShare("share-0", 6000);
        return page;
      },
    });
    const h = handler(racing);
    await createWorkspace(h);
    await putBlob(h, "shared body");
    await appendOps(h, [momentOp("docs/shared.md", "shared body")]);
    await createShare(h);

    // The entry check sees a live share, but the revoke fires while the page
    // is assembled; the re-check before returning turns it into the generic
    // 404 rather than serving one last filtered page.
    const raced = await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0"));
    expect(raced.status).toBe(404);
    expect(await raced.json()).toMatchObject({code: "share_access_removed"});
  });

  it("aborts an in-flight shared-blob read when the share is revoked mid-request (revocation race)", async () => {
    const storage = await testStorage();
    const racing = interceptStorage(storage, {
      getBlob: (target, workspaceId, sha256) => {
        const blob = target.getBlob(workspaceId, sha256);
        target.revokeShare("share-0", 6000);
        return blob;
      },
    });
    const h = handler(racing);
    await createWorkspace(h);
    const sharedSha = await putBlob(h, "shared body");
    await appendOps(h, [momentOp("docs/shared.md", "shared body")]);
    await createShare(h);

    const raced = await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${sharedSha}`));
    expect(raced.status).toBe(404);
    expect(await raced.json()).toMatchObject({code: "share_access_removed"});
  });

  it("advances the shared-log cursor across filtered-out rows so pagination cannot stall", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const ops = [] as unknown[];
    for (let index = 0; index < 5; index += 1) {
      // Upload the referenced blob first so the append validates; the point of
      // this test is cursor advancement across FILTERED-OUT (out-of-selector)
      // rows, which is unaffected by whether the granter's blobs exist.
      await putBlob(h, `hidden ${index}`);
      ops.push(momentOp(`private/file-${index}.md`, `hidden ${index}`));
    }
    await putBlob(h, "visible");
    ops.push(momentOp("docs/last.md", "visible"));
    await appendOps(h, ops);
    await createShare(h);

    // Page size 2: first pages are all filtered out but nextCursor advances.
    let cursor = 0;
    const collected: string[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await json(
        await h(request(RECIPIENT, `/sync/shares/share-0/log?since=${cursor}&limit=2`)),
      );
      for (const op of page.ops as Array<{ payload: { path: string } }>) {
        collected.push(op.payload.path);
      }
      expect(page.nextCursor as number).toBeGreaterThan(cursor);
      cursor = page.nextCursor as number;
      if (!(page.hasMore as boolean)) break;
    }
    expect(collected).toEqual(["docs/last.md"]);
  });

  it("reserves the 'shares' workspace id so the namespace cannot be shadowed", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    const response = await h(request(GRANTER, "/sync/workspaces", jsonBody({ workspaceId: "shares" })));
    expect(response.status).toBe(400);
  });
});

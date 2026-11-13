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
  return testHandler(storage, {
    nowMs: () => 5555,
    ...(lookupUserEmail ? { lookupUserEmail } : {}),
    ...(lookupVerifiedUserEmail ? { lookupVerifiedUserEmail } : {}),
  });
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
    expect(await removed.json()).toMatchObject({
      code: "share_access_removed",
      error: "The owner removed your access.",
    });
    expect(counted.scansForShare("share-post-await")).toBe(3);
  });

  it("creates a share by recipient email and lists it on both sides", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const create = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({
          recipientEmail: `${RECIPIENT}@dohc.test`,
          paths: ["docs", "notes.md"],
          access: "view",
        }),
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
        subjectName: null,
        sharerName: null,
        shareId: "share-0",
        workspaceId: WORKSPACE,
        recipientUserId: RECIPIENT,
        recipientEmail: `${RECIPIENT}@dohc.test`,
        selector: { paths: ["docs", "notes.md"], versionId: null },
        access: "view",
        grantId: expect.any(String),
        principalKind: "user",
        generation: 1,
        automationsGeneration: null,
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

  it("refuses secret paths, traversal, empty selectors, and self-shares at grant time", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);

    const secret = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: RECIPIENT, paths: [".env"], access: "view" }),
      ),
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
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: RECIPIENT, paths: [], access: "view" }),
      ),
    );
    expect(empty.status).toBe(400);
    expect((await json(empty)).code).toBe("empty_selector");

    const self = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: GRANTER, paths: ["docs"], access: "view" }),
      ),
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

  it("refuses share creation on a workspace the caller does not own, byte-identically to no workspace", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const foreign = await denialBytes(
      await h(
        request(
          STRANGER,
          `/sync/${WORKSPACE}/shares`,
          jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"], access: "view" }),
        ),
      ),
    );
    const missing = await denialBytes(
      await h(
        request(
          STRANGER,
          "/sync/no-such-workspace/shares",
          jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"], access: "view" }),
        ),
      ),
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
      {
        originSeq: nextOpSeq(),
        opKind: "workspace.init",
        payload: { note: "init" },
        recordedAtMs: 999,
      },
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

    const page = await json(
      await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=100")),
    );
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
    const missing = await denialBytes(
      await h(request(STRANGER, "/sync/shares/share-404/log?since=0")),
    );
    expect(await denialBytes(await h(request(STRANGER, "/sync/shares/share-0/log?since=0")))).toBe(
      missing,
    );
    expect(await denialBytes(await h(request(GRANTER, "/sync/shares/share-0/log?since=0")))).toBe(
      missing,
    );
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
    const unknown = await denialBytes(
      await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${unknownHash}`)),
    );
    expect(
      await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${hiddenSha}`))),
    ).toBe(unknown);
    expect(
      await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${cipherSha}`))),
    ).toBe(unknown);
    // A stranger probing an allowed hash gets the same denial too.
    expect(
      await denialBytes(await h(request(STRANGER, `/sync/shares/share-0/blobs/${sharedSha}`))),
    ).toBe(unknown);
  });

  it("keeps selected ordinary declarations unattributed for the current authenticated recipient", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    await putBlob(h, "shared declaration");
    await putBlob(h, "hidden declaration");
    await appendOps(h, [
      momentOp("docs/plan.md", "shared declaration", {
        authors: [
          {
            kind: "agent",
            agentId: "trip-agent-hosted",
            onBehalfOf: "opaque-owner",
            depth: 0,
            agentRunId: "private-run",
            principalId: "fabricated-authority",
          },
          { kind: "automation", automationId: "private-automation", depth: 1 },
        ],
        metadata: {
          origin: "user",
          summary: "private-summary",
          correlationId: "private-correlation",
        },
      }),
      momentOp("private/hidden.md", "hidden declaration", {
        authors: [{ kind: "agent", agentId: "hidden-agent" }],
      }),
      momentOp("docs/version.md", "shared declaration", {
        versionId: "other-version",
        authors: [{ kind: "agent", agentId: "other-version-agent" }],
      }),
    ]);
    const shareId = await createShare(h);
    const response = await h(request(RECIPIENT, `/sync/shares/${shareId}/log?since=0`));
    expect(response.status).toBe(200);
    const page = await json(response);
    const ops = page.ops as Array<{ payload: Record<string, unknown> }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.payload.authors).toEqual([{ kind: "unattributed" }]);
    for (const excluded of [
      "private-",
      "fabricated-authority",
      "hidden-agent",
      "other-version-agent",
      "agentRunId",
      "principalId",
      "onBehalfOf",
      "opaque-owner",
      "trip-agent-hosted",
    ]) {
      expect(JSON.stringify(page)).not.toContain(excluded);
    }
    expect((await h(request(STRANGER, `/sync/shares/${shareId}/log?since=0`))).status).toBe(404);
    expect((await h(request(null, `/sync/shares/${shareId}/log?since=0`))).status).toBe(401);
    storage.revokeShare(shareId, 6000);
    expect((await h(request(RECIPIENT, `/sync/shares/${shareId}/log?since=0`))).status).toBe(404);
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

    const earlier = await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${earlierSha}`));
    expect(earlier.status, await earlier.clone().text()).toBe(200);
    expect(await earlier.text()).toBe(earlierContent);
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
    const recipientRevoke = await h(
      request(RECIPIENT, "/sync/shares/share-0/revoke", { method: "POST" }),
    );
    expect(recipientRevoke.status).toBe(404);

    const revoke = await h(request(GRANTER, "/sync/shares/share-0/revoke", { method: "POST" }));
    expect(revoke.status).toBe(200);
    // Idempotent for the granter.
    expect(
      (await h(request(GRANTER, "/sync/shares/share-0/revoke", { method: "POST" }))).status,
    ).toBe(200);
    expect(storage.listSharesGrantedBy(GRANTER)[0]?.grant).toMatchObject({
      generation: 2,
      status: "revoked",
      revokedAtMs: 5555,
    });

    for (const path of [
      "/sync/shares/share-0/log?since=0",
      "/sync/shares/share-0",
      `/sync/shares/share-0/blobs/${sharedSha}`,
    ]) {
      const response = await h(request(RECIPIENT, path));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "share_access_removed" });
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
            {
              objectId: "o1",
              path: "docs/a.md",
              blobSha256: keepSha,
              updatedAtMs: 1,
              latestMomentId: "m1",
              metadata: {},
            },
            {
              objectId: "o2",
              path: "private/b.md",
              blobSha256: dropSha,
              updatedAtMs: 1,
              latestMomentId: "m2",
              metadata: {},
            },
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
    expect(
      await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${dropSha}`))),
    ).toBe(unknown);
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
    const refusedPage = await json(
      await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=2")),
    );
    expect(refusedPage).toMatchObject({ ops: [], nextCursor: 2, hasMore: true });
    let cursor = refusedPage.nextCursor as number;
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

    await putBlob(h, "later publication");
    await appendOps(h, [momentOp("docs/later.md", "later publication")]);
    const later = await json(
      await h(request(RECIPIENT, `/sync/shares/share-0/log?since=${cursor}&limit=2`)),
    );
    expect(later.ops).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ path: "docs/later.md" }) }),
    ]);
    expect(later.nextCursor).toBeGreaterThan(cursor);
    expect(later.hasMore).toBe(false);
  });
});

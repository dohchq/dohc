import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function testStorage(): Promise<SyncRelayStorage> {
  const root = await mkdtemp(join(tmpdir(), "dohc-sync-relay-shares-"));
  roots.push(root);
  return openSyncRelayStorage(join(root, "relay.sqlite"));
}

// Mirrors the relay's test-auth seam: user identity from the bearer token,
// emails resolvable as "<userId>@dohc.test".
function handler(storage: SyncRelayStorage): SyncRelayHandler {
  const resolveActor: ResolveActor = (request, workspaceId) => {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
    return { userId: auth.slice("Bearer user:".length), workspaceId };
  };
  let nextShare = 0;
  return createSyncRelayHandler({
    storage,
    resolveActor,
    nowMs: () => 5555,
    resolveUserIdByEmail: (email) =>
      email.endsWith("@dohc.test") ? email.slice(0, -"@dohc.test".length) : null,
    lookupUserEmail: (userId) => `${userId}@dohc.test`,
    newShareId: () => `share-${nextShare++}`,
  });
}

function request(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("authorization", `Bearer user:${userId}`);
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const GRANTER = "granter";
const RECIPIENT = "recipient";
const STRANGER = "stranger";
const WORKSPACE = "workspace-a";

async function createWorkspace(h: SyncRelayHandler): Promise<void> {
  const response = await h(request(GRANTER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })));
  expect(response.status).toBe(200);
}

let opSeq = 0;

function momentOp(
  path: string,
  content: string,
  overrides: Record<string, unknown> = {},
): { originSeq: number; opKind: string; payload: Record<string, unknown>; recordedAtMs: number } {
  const originSeq = opSeq++;
  return {
    originSeq,
    opKind: "moment.append",
    payload: {
      momentId: `moment-${originSeq}`,
      versionId: "main",
      objectId: `object-${path}`,
      path,
      recordedAtMs: 1000 + originSeq,
      operation: "write",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      payloadAfterBlobSha256: sha256(content),
      payloadAfterPath: path,
      metadata: { origin: "user" },
      beforePresent: "null",
      ...overrides,
    },
    recordedAtMs: 1000 + originSeq,
  };
}

async function appendOps(h: SyncRelayHandler, ops: unknown[]): Promise<void> {
  const response = await h(
    request(GRANTER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-a", ops })),
  );
  expect(response.status).toBe(200);
}

async function putBlob(h: SyncRelayHandler, content: string): Promise<string> {
  const sha = sha256(content);
  const response = await h(
    request(GRANTER, `/sync/${WORKSPACE}/blobs/${sha}`, { method: "PUT", body: content }),
  );
  expect(response.status).toBe(200);
  return sha;
}

async function createShare(
  h: SyncRelayHandler,
  body: Record<string, unknown> = { recipientEmail: `${RECIPIENT}@dohc.test`, paths: ["docs"] },
): Promise<string> {
  const response = await h(request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody(body)));
  expect(response.status).toBe(200);
  return (await json(response)).shareId as string;
}

// Captures a denial as comparable bytes: unauthorized probes of every kind
// must be indistinguishable from a share that never existed.
async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

describe("share grants", () => {
  beforeEach(() => {
    opSeq = 0;
  });

  it("creates a share by recipient email and lists it on both sides", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const create = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: `${RECIPIENT}@dohc.test`, paths: ["docs", "notes.md"] }),
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
      createdAtMs: 5555,
    });
    expect(created).not.toHaveProperty("recipientUserId");

    const granterList = await json(await h(request(GRANTER, "/sync/shares")));
    expect(granterList.granted).toEqual([
      {
        shareId: "share-0",
        workspaceId: WORKSPACE,
        recipientUserId: RECIPIENT,
        recipientEmail: `${RECIPIENT}@dohc.test`,
        selector: { paths: ["docs", "notes.md"], versionId: null },
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
    });
    // The recipient never learns the granter's workspace id.
    expect(received[0]).not.toHaveProperty("workspaceId");

    const metadata = await json(await h(request(RECIPIENT, "/sync/shares/share-0")));
    expect(metadata).toMatchObject({
      ok: true,
      shareId: "share-0",
      granterUserId: GRANTER,
      selector: { paths: ["docs", "notes.md"], versionId: null },
    });
  });

  it("refuses secret paths, traversal, empty selectors, and self-shares at grant time", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);

    const secret = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: RECIPIENT, paths: [".env"] })),
    );
    expect(secret.status).toBe(400);
    expect((await json(secret)).code).toBe("secret_path");

    const encodedSecret = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: RECIPIENT, paths: ["config/secrets%2eenv"] }),
      ),
    );
    expect(encodedSecret.status).toBe(400);
    expect((await json(encodedSecret)).code).toBe("secret_path");

    const traversal = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: RECIPIENT, paths: ["../other-workspace/file.md"] }),
      ),
    );
    expect(traversal.status).toBe(400);
    expect((await json(traversal)).code).toBe("invalid_path");

    const empty = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: RECIPIENT, paths: [] })),
    );
    expect(empty.status).toBe(400);
    expect((await json(empty)).code).toBe("empty_selector");

    const self = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: GRANTER, paths: ["docs"] })),
    );
    expect(self.status).toBe(400);
    expect((await json(self)).code).toBe("self_share");

    // A self-share addressed by the granter's OWN email is refused with the
    // same code (the email resolves to the granter's account).
    const selfByEmail = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: `${GRANTER}@dohc.test`, paths: ["docs"] }),
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
        jsonBody({ recipientEmail: `${RECIPIENT}@dohc.test`, paths: ["docs"] }),
      ),
    );
    const unknown = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientEmail: "nobody@elsewhere.example", paths: ["docs"] }),
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

    // The unknown email is recorded as a PENDING invite: unclaimed, it is not
    // yet readable by anyone, but it survives as an honest grant.
    const pendingShareId = unknownBody.shareId as string;
    const beforeClaim = await h(request(RECIPIENT, `/sync/shares/${pendingShareId}/log?since=0`));
    expect(beforeClaim.status).toBe(404);
  });

  it("claims a pending email invite only for the account whose session email matches", async () => {
    const storage = await testStorage();
    // LATE_EMAIL has no @dohc.test account, so it is stored as a pending
    // invite. The reverse lookup maps the LATE user id to that address, so its
    // first authenticated request claims the invite — but RECIPIENT's does not.
    const LATE = "late-user";
    const LATE_EMAIL = "late@corp.example";
    let nextShare = 0;
    const h = createSyncRelayHandler({
      storage,
      resolveActor: (request, workspaceId) => {
        const auth = request.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
        return { userId: auth.slice("Bearer user:".length), workspaceId };
      },
      nowMs: () => 5555,
      resolveUserIdByEmail: (email) =>
        email.endsWith("@dohc.test") ? email.slice(0, -"@dohc.test".length) : null,
      lookupUserEmail: (userId) => (userId === LATE ? LATE_EMAIL : `${userId}@dohc.test`),
      newShareId: () => `share-${nextShare++}`,
    });
    await createWorkspace(h);
    await putBlob(h, "shared body");
    await appendOps(h, [momentOp("docs/shared.md", "shared body")]);

    // Grant to an address with no account yet: a pending invite.
    const create = await h(
      request(GRANTER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientEmail: LATE_EMAIL, paths: ["docs"] })),
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
      await h(request(STRANGER, `/sync/${WORKSPACE}/shares`, jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"] }))),
    );
    const missing = await denialBytes(
      await h(request(STRANGER, "/sync/no-such-workspace/shares", jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"] }))),
    );
    expect(foreign).toBe(missing);
  });

  it("serves the recipient ONLY ops inside the selector and denies everyone else byte-identically", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    await appendOps(h, [
      { originSeq: opSeq++, opKind: "workspace.init", payload: { note: "init" }, recordedAtMs: 999 },
      momentOp("docs/shared.md", "shared body"),
      momentOp("private/hidden.md", "hidden body"),
      momentOp("docs/nested/deep.md", "deep body"),
      {
        originSeq: opSeq++,
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
        originSeq: opSeq++,
        opKind: "chat.message.append",
        payload: { messageId: "m1", threadId: "t1", authorKind: "user", authorDisplayName: "G", body: "secret chat", createdAtMs: 1 },
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
        originSeq: opSeq++,
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

  it("stops serving a revoked share on the next fetch, byte-identically to one that never existed", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const sharedSha = await putBlob(h, "shared body");
    await appendOps(h, [momentOp("docs/shared.md", "shared body")]);
    await createShare(h);

    expect((await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0"))).status).toBe(200);

    // The recipient cannot revoke; only the granter can.
    const recipientRevoke = await h(request(RECIPIENT, "/sync/shares/share-0/revoke", { method: "POST" }));
    expect(recipientRevoke.status).toBe(404);

    const revoke = await h(request(GRANTER, "/sync/shares/share-0/revoke", { method: "POST" }));
    expect(revoke.status).toBe(200);
    // Idempotent for the granter.
    expect((await h(request(GRANTER, "/sync/shares/share-0/revoke", { method: "POST" }))).status).toBe(200);

    const missing = await denialBytes(await h(request(RECIPIENT, "/sync/shares/share-404/log?since=0")));
    expect(await denialBytes(await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0")))).toBe(missing);
    expect(await denialBytes(await h(request(RECIPIENT, "/sync/shares/share-0")))).toBe(missing);
    expect(await denialBytes(await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${sharedSha}`)))).toBe(missing);

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
        originSeq: opSeq++,
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
    // write of the SAME path is excluded.
    expect(ops).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(sha256("main body"));
  });

  it("aborts an in-flight shared-log read when the share is revoked mid-request (revocation race)", async () => {
    const storage = await testStorage();
    // Wrap the storage so fetchLogPage revokes the share as a side effect:
    // this lands AFTER the route's entry check but BEFORE the body is
    // returned, exactly the race the immediate re-check must catch.
    const racing = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "fetchLogPage") {
          return (input: Parameters<SyncRelayStorage["fetchLogPage"]>[0]) => {
            const page = target.fetchLogPage(input);
            target.revokeShare("share-0", 6000);
            return page;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
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
  });

  it("aborts an in-flight shared-blob read when the share is revoked mid-request (revocation race)", async () => {
    const storage = await testStorage();
    const racing = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "getBlob") {
          return (workspaceId: string, sha256: string) => {
            const blob = target.getBlob(workspaceId, sha256);
            target.revokeShare("share-0", 6000);
            return blob;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const h = handler(racing);
    await createWorkspace(h);
    const sharedSha = await putBlob(h, "shared body");
    await appendOps(h, [momentOp("docs/shared.md", "shared body")]);
    await createShare(h);

    const raced = await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${sharedSha}`));
    expect(raced.status).toBe(404);
  });

  it("advances the shared-log cursor across filtered-out rows so pagination cannot stall", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const ops = [] as unknown[];
    for (let index = 0; index < 5; index += 1) {
      ops.push(momentOp(`private/file-${index}.md`, `hidden ${index}`));
    }
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

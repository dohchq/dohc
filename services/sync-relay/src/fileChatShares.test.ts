import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

// #646 PR2 — chat follows the file share, driven through the REAL routes.
//
// Everything here goes through HTTP: the granter appends real moments and real
// chat ops to its own log, the recipient reads and writes through its share,
// and the assertions are on response bodies. A test that faked the resolving
// would prove nothing — the resolvers ARE the boundary, and the log is the
// only thing that knows where a file is now.
//
// The file layout every case is built on:
//   docs/in.md    -> object-in    INSIDE the selector ["docs"]
//   notes/out.md  -> object-out   OUTSIDE it
// and two threads, one on each.

let roots: string[] = [];
let storages: SyncRelayStorage[] = [];

beforeEach(() => {
  roots = [];
  storages = [];
});

afterEach(async () => {
  // Close sqlite handles before removing temp dirs (Windows EBUSY otherwise).
  for (const storage of storages) storage.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function testStorage(): Promise<{ storage: SyncRelayStorage; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "dohc-relay-filechat-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  const storage = openSyncRelayStorage(dbPath);
  storages.push(storage);
  return { storage, dbPath };
}

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
    nowMs: () => 4242,
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const GRANTER = "granter";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-a";

interface OwnerOp {
  originSeq: number;
  opKind: string;
  payload: Record<string, unknown>;
  recordedAtMs: number;
}

// The granter's own log, appended through the owner route in order. One
// counter per test run keeps origin_seq dense, which the append route requires.
class OwnerLog {
  private seq = 0;

  constructor(private readonly h: SyncRelayHandler) {}

  private op(opKind: string, payload: Record<string, unknown>): OwnerOp {
    const originSeq = this.seq++;
    return { originSeq, opKind, payload, recordedAtMs: 1000 + originSeq };
  }

  moment(objectId: string, path: string, overrides: Record<string, unknown> = {}): OwnerOp {
    return this.op("moment.append", {
      momentId: `moment-${objectId}-${this.seq}`,
      versionId: "main",
      objectId,
      path,
      recordedAtMs: 1000 + this.seq,
      operation: "write",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      // No blob: the relay validates every referenced sha against its own
      // store, and none of these cases is about content. The one case that IS
      // about a blob uploads a real one.
      payloadAfterBlobSha256: null,
      payloadAfterPath: path,
      metadata: { origin: "user" },
      beforePresent: "null",
      ...overrides,
    });
  }

  // A rename carries BOTH ends and keeps the object id, which is exactly why
  // the relay can follow a file without a new op kind.
  rename(objectId: string, before: string, after: string): OwnerOp {
    return this.moment(objectId, after, {
      operation: "rename",
      payloadBeforePath: before,
      beforePath: before,
      payloadAfterPath: after,
    });
  }

  delete(objectId: string, path: string): OwnerOp {
    return this.moment(objectId, path, {
      operation: "delete",
      payloadAfterBlobSha256: null,
      payloadAfterPath: null,
    });
  }

  threadCreate(threadId: string, objectId: string, title: string): OwnerOp {
    return this.op("chat.thread.create", {
      threadId,
      title,
      createdAtMs: 100,
      linkedAtMs: 101,
      linkedObjectId: objectId,
      linkedPathHint: "docs/hint-captured-once.md",
    });
  }

  message(messageId: string, threadId: string, body: string): OwnerOp {
    return this.op("chat.message.append", {
      messageId,
      threadId,
      authorKind: "human",
      authorDisplayName: "Granter",
      authorUserId: GRANTER,
      body,
      createdAtMs: 200,
    });
  }

  async append(...ops: OwnerOp[]): Promise<void> {
    const response = await this.h(
      request(GRANTER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-a", ops })),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
}

async function claimWorkspace(h: SyncRelayHandler): Promise<void> {
  const response = await h(
    request(GRANTER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })),
  );
  expect(response.status).toBe(200);
}

async function createShare(
  h: SyncRelayHandler,
  access: "view" | "comment" | "edit",
  paths: string[] = ["docs"],
): Promise<string> {
  const response = await h(
    request(
      GRANTER,
      `/sync/${WORKSPACE}/shares`,
      jsonBody({ recipientUserId: RECIPIENT, paths, access }),
    ),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).shareId as string;
}

async function readShareLog(
  h: SyncRelayHandler,
  shareId: string,
): Promise<Array<{ opKind: string; payload: Record<string, unknown> }>> {
  const response = await h(request(RECIPIENT, `/sync/shares/${shareId}/log?since=0&limit=500`));
  expect(response.status).toBe(200);
  const body = await json(response);
  return body.ops as Array<{ opKind: string; payload: Record<string, unknown> }>;
}

function chatOps(
  ops: Array<{ opKind: string; payload: Record<string, unknown> }>,
): Array<{ opKind: string; payload: Record<string, unknown> }> {
  return ops.filter((op) => op.opKind.startsWith("chat."));
}

// The whole world every serving case reads from: two files, one thread on
// each, one message on each.
async function seedWorkspace(h: SyncRelayHandler): Promise<OwnerLog> {
  await claimWorkspace(h);
  const log = new OwnerLog(h);
  await log.append(
    log.moment("object-in", "docs/in.md"),
    log.moment("object-out", "notes/out.md"),
    log.threadCreate("thread-in", "object-in", "About the shared file"),
    log.threadCreate("thread-out", "object-out", "SENTINEL-OUT-OF-SELECTOR"),
    log.message("m-in", "thread-in", "inside"),
    log.message("m-out", "thread-out", "SENTINEL-OUT-OF-SELECTOR-BODY"),
  );
  return log;
}

describe("chat over a file share (#646 PR2)", () => {
  it("serves the in-selector thread as a path and leaks no sentinel from the outside one", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await seedWorkspace(h);
    const shareId = await createShare(h, "view");

    const response = await h(request(RECIPIENT, `/sync/shares/${shareId}/log?since=0&limit=500`));
    expect(response.status).toBe(200);
    const body = await response.text();
    // The leak shape, stated literally: nothing about the outside file may
    // appear anywhere in the response bytes.
    for (const sentinel of [
      "SENTINEL-OUT-OF-SELECTOR",
      "SENTINEL-OUT-OF-SELECTOR-BODY",
      "notes/out.md",
      "thread-out",
      // The granter's object id and the display-only hint never cross.
      "object-in",
      "docs/hint-captured-once.md",
    ]) {
      expect(body, sentinel).not.toContain(sentinel);
    }

    const served = chatOps(JSON.parse(body).ops);
    expect(served.map((op) => op.opKind)).toEqual([
      "chat.thread.create",
      "chat.message.append",
    ]);
    expect(served[0]?.payload).toEqual({
      threadId: "thread-in",
      title: "About the shared file",
      createdAtMs: 100,
      linkedAtMs: 101,
      linkedPath: "docs/in.md",
    });
  });

  it("stops serving a file's threads the moment it is renamed OUT of the selector", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    const log = await seedWorkspace(h);
    const shareId = await createShare(h, "view");
    expect(chatOps(await readShareLog(h, shareId))).toHaveLength(2);

    await log.append(log.rename("object-in", "docs/in.md", "notes/moved.md"));

    const after = await readShareLog(h, shareId);
    expect(
      chatOps(after),
      "MUTATION: a file renamed out of the selector must stop serving its threads",
    ).toHaveLength(0);
  });

  it("starts serving a file's threads when it is renamed INTO the selector, history included", async () => {
    // objectCurrentPath is a PRESENT-TENSE answer, so a thread created before
    // the rename starts serving with the file. Stated on purpose: this is the
    // same rule the moment lane already follows, read forwards.
    const { storage } = await testStorage();
    const h = handler(storage);
    const log = await seedWorkspace(h);
    const shareId = await createShare(h, "view");

    await log.append(log.rename("object-out", "notes/out.md", "docs/arrived.md"));

    const served = chatOps(await readShareLog(h, shareId));
    expect(served.map((op) => op.opKind)).toEqual([
      "chat.thread.create",
      "chat.thread.create",
      "chat.message.append",
      "chat.message.append",
    ]);
    expect(
      served
        .filter((op) => op.opKind === "chat.thread.create")
        .map((op) => op.payload.linkedPath),
    ).toEqual(["docs/in.md", "docs/arrived.md"]);
  });

  it("hides a deleted file's discussion", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    const log = await seedWorkspace(h);
    const shareId = await createShare(h, "view");

    await log.append(log.delete("object-in", "docs/in.md"));

    expect(
      chatOps(await readShareLog(h, shareId)),
      "MUTATION: a delete must deny, not fall through to the last known path",
    ).toHaveLength(0);
  });

  it("accepts a comment recipient's own thread and message, and serves them back", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await seedWorkspace(h);
    const shareId = await createShare(h, "comment");

    // A recipient names the file by PATH: its own object ids are local and
    // mean nothing to the granter.
    const push = await h(
      request(
        RECIPIENT,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "recipient-origin",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.thread.create",
              recordedAtMs: 5000,
              payload: {
                threadId: "thread-recipient",
                title: "A question",
                createdAtMs: 5000,
                linkedAtMs: 5000,
                linkedPath: "docs/in.md",
              },
            },
            {
              originSeq: 1,
              opKind: "chat.message.append",
              recordedAtMs: 5001,
              payload: {
                messageId: "m-recipient",
                threadId: "thread-recipient",
                authorKind: "human",
                authorDisplayName: "Recipient",
                authorUserId: RECIPIENT,
                body: "why this line?",
                createdAtMs: 5001,
              },
            },
          ],
        }),
      ),
    );
    expect(push.status, await push.clone().text()).toBe(200);
    expect(await json(push)).toMatchObject({ ok: true, accepted: 2, inserted: 2 });

    // A LATER batch on the same thread, resolved from the log rather than from
    // the batch: without the path binding this is where a recipient's own
    // thread would go dead.
    const second = await h(
      request(
        RECIPIENT,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "recipient-origin",
          ops: [
            {
              originSeq: 2,
              opKind: "chat.message.append",
              recordedAtMs: 5002,
              payload: {
                messageId: "m-recipient-2",
                threadId: "thread-recipient",
                authorKind: "human",
                authorDisplayName: "Recipient",
                authorUserId: RECIPIENT,
                body: "and this one",
                createdAtMs: 5002,
              },
            },
          ],
        }),
      ),
    );
    expect(
      second.status,
      "MUTATION: a recipient's own thread must still resolve in a later batch",
    ).toBe(200);

    const served = chatOps(await readShareLog(h, shareId));
    expect(served.map((op) => op.payload.messageId).filter(Boolean)).toContain("m-recipient");
    expect(served.map((op) => op.payload.messageId).filter(Boolean)).toContain("m-recipient-2");
  });

  it("rejects the WHOLE batch when one op names a thread outside the selector", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await seedWorkspace(h);
    const shareId = await createShare(h, "comment");

    const push = await h(
      request(
        RECIPIENT,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "recipient-origin",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.message.append",
              recordedAtMs: 5000,
              payload: {
                messageId: "m-ok",
                threadId: "thread-in",
                authorKind: "human",
                authorDisplayName: "Recipient",
                authorUserId: RECIPIENT,
                body: "fine",
                createdAtMs: 5000,
              },
            },
            {
              originSeq: 1,
              opKind: "chat.message.append",
              recordedAtMs: 5001,
              payload: {
                messageId: "m-bad",
                threadId: "thread-out",
                authorKind: "human",
                authorDisplayName: "Recipient",
                authorUserId: RECIPIENT,
                body: "should never land",
                createdAtMs: 5001,
              },
            },
          ],
        }),
      ),
    );
    expect(push.status).toBe(403);
    expect((await json(push)).code).toBe("share_op_rejected");
    // Atomic: the acceptable op did not land either.
    const served = chatOps(await readShareLog(h, shareId));
    expect(served.map((op) => op.payload.messageId)).not.toContain("m-ok");
  });

  it("refuses a view recipient's append and lands nothing", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await seedWorkspace(h);
    const shareId = await createShare(h, "view");

    const push = await h(
      request(
        RECIPIENT,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "recipient-origin",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.message.append",
              recordedAtMs: 5000,
              payload: {
                messageId: "m-view",
                threadId: "thread-in",
                authorKind: "human",
                authorDisplayName: "Recipient",
                authorUserId: RECIPIENT,
                body: "not allowed",
                createdAtMs: 5000,
              },
            },
          ],
        }),
      ),
    );
    expect(push.status).toBe(403);
    expect((await json(push)).code).toBe("share_read_only");
    const served = chatOps(await readShareLog(h, shareId));
    expect(served.map((op) => op.payload.messageId)).not.toContain("m-view");
  });

  it("loses the revoke race inside the transaction, as the same generic 404", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    await seedWorkspace(h);
    const shareId = await createShare(h, "comment");

    // Revoke lands between the route's entry check and the insert: the guard
    // runs inside the append's own BEGIN IMMEDIATE, so there is no window.
    const raced = { revoked: false };
    const original = storage.appendLogBatch.bind(storage);
    storage.appendLogBatch = (input) => {
      if (!raced.revoked) {
        raced.revoked = true;
        storage.revokeShare(shareId, 9999);
      }
      return original(input);
    };

    const push = await h(
      request(
        RECIPIENT,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "recipient-origin",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.message.append",
              recordedAtMs: 5000,
              payload: {
                messageId: "m-raced",
                threadId: "thread-in",
                authorKind: "human",
                authorDisplayName: "Recipient",
                authorUserId: RECIPIENT,
                body: "too late",
                createdAtMs: 5000,
              },
            },
          ],
        }),
      ),
    );
    expect(raced.revoked).toBe(true);
    expect(push.status).toBe(404);
  });

  it("re-reads the LEVEL inside the write transaction, not just the entry check", async () => {
    // The entry check reads the selector once. The guard re-reads it under the
    // write lock, so a row that stops admitting appends between the two loses
    // the race — the same way a revoke does. Nothing in the relay narrows a
    // level today, so the case is reached the only way it can be: by tampering
    // with the stored row, which is the shape this defence exists for.
    const { storage, dbPath } = await testStorage();
    const h = handler(storage);
    await seedWorkspace(h);
    const shareId = await createShare(h, "comment");

    const requireModule = createRequire(import.meta.url);
    const { DatabaseSync } = requireModule("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };
    let tampered = false;
    const original = storage.appendLogBatch.bind(storage);
    storage.appendLogBatch = (input) => {
      if (!tampered) {
        tampered = true;
        const raw = new DatabaseSync(dbPath);
        raw
          .prepare("UPDATE sync_relay_shares SET selector_json = ? WHERE share_id = ?")
          .run(JSON.stringify({ paths: ["docs"], versionId: null, access: "view" }), shareId);
        raw.close();
      }
      return original(input);
    };

    const push = await h(
      request(
        RECIPIENT,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "recipient-origin",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.message.append",
              recordedAtMs: 5000,
              payload: {
                messageId: "m-tampered",
                threadId: "thread-in",
                authorKind: "human",
                authorDisplayName: "Recipient",
                authorUserId: RECIPIENT,
                body: "should not land",
                createdAtMs: 5000,
              },
            },
          ],
        }),
      ),
    );
    expect(tampered).toBe(true);
    expect(
      push.status,
      "MUTATION: without the guard's level re-check this append lands after the downgrade",
    ).toBe(403);
    expect((await json(push)).code).toBe("share_read_only");
    const served = chatOps(await readShareLog(h, shareId));
    expect(served.map((op) => op.payload.messageId)).not.toContain("m-tampered");
  });

  it("makes no blob reachable through a chat op", async () => {
    // Chat decisions carry `blobSha256s: []`, and the share-blob route reads
    // exactly that to decide reachability. The outside file has a REAL blob on
    // the relay and a thread of its own; a chat branch that exposed a hash
    // would make that blob fetchable through a share that covers neither.
    const { storage } = await testStorage();
    const h = handler(storage);
    const log = await seedWorkspace(h);
    const content = "the outside file's content";
    const sha = sha256(content);
    const upload = await h(
      request(GRANTER, `/sync/${WORKSPACE}/blobs/${sha}`, { method: "PUT", body: content }),
    );
    expect(upload.status).toBe(200);
    await log.append(
      log.moment("object-out", "notes/out.md", { payloadAfterBlobSha256: sha }),
    );
    const shareId = await createShare(h, "comment");
    const response = await h(request(RECIPIENT, `/sync/shares/${shareId}/blobs/${sha}`));
    expect(response.status).toBe(404);
  });
});

describe("sync_relay_object_paths seeding (#646 PR2, addendum A)", () => {
  it("seeds itself from the existing log, so chat does not depend on deployment history", async () => {
    // Every moment already in a relay's log predates this table. Without the
    // one-time scan, objectCurrentPath answers "never seen" for every file
    // shared before the deploy and the filter denies its chat forever.
    const { storage, dbPath } = await testStorage();
    const h = handler(storage);
    await seedWorkspace(h);
    expect(storage.objectCurrentPath(WORKSPACE, "object-in")).toBe("docs/in.md");

    // Put the database back into its pre-#646 shape: the table gone and the
    // migration unrecorded, with the log untouched.
    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const requireModule = createRequire(import.meta.url);
    const { DatabaseSync } = requireModule("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE sync_relay_object_paths");
    raw.exec("DELETE FROM sync_relay_migrations WHERE migration_id = 'object-paths-seed-v1'");
    raw.close();

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    expect(
      reopened.objectCurrentPath(WORKSPACE, "object-in"),
      "MUTATION: without the seed, every file shared before this deploy denies its chat forever",
    ).toBe("docs/in.md");
    expect(reopened.objectCurrentPath(WORKSPACE, "object-out")).toBe("notes/out.md");
    expect(reopened.objectCurrentPath(WORKSPACE, "object-never-seen")).toBeUndefined();

    // And the seeded rows still serve: the whole point is that a share opened
    // before the deploy carries its chat after it.
    const reopenedHandler = handler(reopened);
    const shareId = await createShare(reopenedHandler, "view");
    expect(chatOps(await readShareLog(reopenedHandler, shareId))).toHaveLength(2);
  });

  it("lets the LATEST moment win, and never lets an older one move a path back", async () => {
    const { storage } = await testStorage();
    const h = handler(storage);
    const log = await seedWorkspace(h);
    await log.append(log.rename("object-in", "docs/in.md", "docs/renamed.md"));
    expect(storage.objectCurrentPath(WORKSPACE, "object-in")).toBe("docs/renamed.md");

    // The seed replays the same log and must land on the same answer: it
    // applies the same latest-wins rule the insert-time upsert does.
    await log.append(log.delete("object-in", "docs/renamed.md"));
    expect(storage.objectCurrentPath(WORKSPACE, "object-in")).toBeNull();
  });
});

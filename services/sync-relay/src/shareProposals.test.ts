import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BLOB_BYTES, MAX_OPS_PER_REQUEST, createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

// #646 PR3a — the proposal lane, driven through the REAL routes.
//
// Every case here is HTTP: the granter appends real moments and real blobs to
// its own log, the recipient uploads and submits through its share, and the
// granter accepts or declines through its workspace. The assertions are on
// response bodies and on the granter's OWN log, because that log is the only
// thing that can say whether a recipient's change reached the granter.
//
// The layout every case is built on:
//   docs/in.md    -> object-in    INSIDE the selector ["docs"]
//   notes/out.md  -> object-out   OUTSIDE it

let roots: string[] = [];
let storages: SyncRelayStorage[] = [];

beforeEach(() => {
  roots = [];
  storages = [];
});

afterEach(async () => {
  for (const storage of storages) storage.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function testStorage(): Promise<SyncRelayStorage> {
  const root = await mkdtemp(join(tmpdir(), "dohc-relay-proposals-"));
  roots.push(root);
  const storage = openSyncRelayStorage(join(root, "relay.sqlite"));
  storages.push(storage);
  return storage;
}

function handler(storage: SyncRelayStorage): SyncRelayHandler {
  const resolveActor: ResolveActor = (request, workspaceId) => {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
    return { userId: auth.slice("Bearer user:".length), workspaceId };
  };
  let nextShare = 0;
  let nextId = 0;
  return createSyncRelayHandler({
    storage,
    resolveActor,
    nowMs: () => 4242,
    resolveUserIdByEmail: (email) =>
      email.endsWith("@dohc.test") ? email.slice(0, -"@dohc.test".length) : null,
    lookupUserEmail: (userId) => `${userId}@dohc.test`,
    newShareId: () => `share-${nextShare++}`,
    // Deterministic minted ids, so a test can name the moment the relay wrote.
    newId: () => `id-${nextId++}`,
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
const OTHER = "other";
const WORKSPACE = "workspace-a";

interface OwnerOp {
  originSeq: number;
  opKind: string;
  payload: Record<string, unknown>;
  recordedAtMs: number;
}

// The granter's own log and blob store. Content is REAL: the base rewrite
// resolves a recipient's base by content hash, so a test with fake hashes
// would prove nothing about the mechanism it exists to prove.
class Granter {
  private seq = 0;

  constructor(private readonly h: SyncRelayHandler) {}

  async putBlob(text: string): Promise<string> {
    const digest = sha256(text);
    const response = await this.h(
      request(GRANTER, `/sync/${WORKSPACE}/blobs/${digest}`, {
        method: "PUT",
        body: new TextEncoder().encode(text),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return digest;
  }

  // One write to one file, with real content, returning the moment id the
  // granter's log now holds for it.
  async write(
    objectId: string,
    path: string,
    text: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ momentId: string; blobSha256: string }> {
    const blobSha256 = await this.putBlob(text);
    const originSeq = this.seq++;
    const momentId = `granter-moment-${originSeq}`;
    const payload: Record<string, unknown> = {
      momentId,
      versionId: "main",
      objectId,
      path,
      recordedAtMs: 1000 + originSeq,
      operation: "write",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      payloadAfterBlobSha256: blobSha256,
      payloadAfterPath: path,
      payloadAfterContentKind: "text",
      payloadAfterByteLength: text.length,
      metadata: { origin: "user" },
      beforePresent: "null",
      ...overrides,
    };
    await this.append({
      originSeq,
      opKind: "moment.append",
      payload,
      recordedAtMs: 1000 + originSeq,
    });
    return { momentId, blobSha256 };
  }

  private async append(...ops: OwnerOp[]): Promise<void> {
    const response = await this.h(
      request(GRANTER, `/sync/${WORKSPACE}/log`, jsonBody({ originId: "origin-a", ops })),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async log(): Promise<Array<{ originId: string; opKind: string; payload: Record<string, unknown> }>> {
    const response = await this.h(request(GRANTER, `/sync/${WORKSPACE}/log?since=0&limit=500`));
    expect(response.status).toBe(200);
    const body = await json(response);
    return body.ops as Array<{
      originId: string;
      opKind: string;
      payload: Record<string, unknown>;
    }>;
  }

  // Only what a share put there. The granter's own ops are noise for every
  // assertion about what a recipient's change became.
  async sharedMoments(shareId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.log())
      .filter((op) => op.originId.startsWith(`share:${shareId}:`) && op.opKind === "moment.append")
      .map((op) => op.payload);
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
  options: { paths?: string[]; versionId?: string; recipient?: string } = {},
): Promise<string> {
  const response = await h(
    request(
      GRANTER,
      `/sync/${WORKSPACE}/shares`,
      jsonBody({
        recipientUserId: options.recipient ?? RECIPIENT,
        paths: options.paths ?? ["docs"],
        access,
        versionId: options.versionId,
      }),
    ),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).shareId as string;
}

interface ProposedChange {
  basedOnPath: string | null;
  basedOnBlobSha256: string | null;
  operation: "write" | "delete";
  afterPath?: string | null;
  afterBlobSha256?: string | null;
  afterContentKind?: string | null;
  afterByteLength?: number | null;
  recordedAtMs: number;
}

function change(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    basedOnPath: "docs/in.md",
    basedOnBlobSha256: sha256("granter one"),
    operation: "write",
    afterPath: "docs/in.md",
    afterBlobSha256: sha256("recipient two"),
    afterContentKind: "text",
    afterByteLength: "recipient two".length,
    recordedAtMs: 9000,
    ...overrides,
  };
}

// The recipient's blob upload, through its OWN route. A change cannot be
// accepted until the granter's workspace holds its content.
async function uploadShareBlob(
  h: SyncRelayHandler,
  shareId: string,
  text: string,
  as = RECIPIENT,
): Promise<Response> {
  return await h(
    request(as, `/sync/shares/${shareId}/blobs/${sha256(text)}`, {
      method: "PUT",
      body: new TextEncoder().encode(text),
    }),
  );
}

async function submit(
  h: SyncRelayHandler,
  shareId: string,
  ops: ProposedChange[],
  options: { submitId?: string; originId?: string; as?: string } = {},
): Promise<Response> {
  return await h(
    request(
      options.as ?? RECIPIENT,
      `/sync/shares/${shareId}/proposals`,
      jsonBody({
        submitId: options.submitId ?? "submit-1",
        originId: options.originId ?? "origin-recipient",
        ops,
      }),
    ),
  );
}

async function settle(
  h: SyncRelayHandler,
  proposalId: string,
  decision: "accept" | "decline",
  as = GRANTER,
): Promise<Response> {
  return await h(
    request(as, `/sync/${WORKSPACE}/proposals/${proposalId}/${decision}`, { method: "POST" }),
  );
}

async function reviewRows(h: SyncRelayHandler): Promise<Array<Record<string, unknown>>> {
  const response = await h(request(GRANTER, `/sync/${WORKSPACE}/proposals`));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).proposals as Array<Record<string, unknown>>;
}

// The whole response, byte for byte. Anti-fingerprinting is a claim about
// BYTES, so comparing status codes alone would not test it.
async function denialBytes(response: Response): Promise<string> {
  return `${response.status} ${await response.text()}`;
}

describe("the proposal route's level gate", () => {
  it("accepts a submit at edit and refuses every other level with the SAME bytes", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    await granter.write("object-in", "docs/in.md", "granter one");

    const view = await createShare(h, "view");
    const comment = await createShare(h, "comment");
    const version = await createShare(h, "edit", { paths: [], versionId: "v1" });
    const edit = await createShare(h, "edit");

    const refusals = await Promise.all(
      [view, comment, version].map(async (shareId) =>
        await denialBytes(await submit(h, shareId, [change()])),
      ),
    );
    expect(
      new Set(refusals).size,
      "MUTATION: a level-specific refusal would tell a probing recipient the level",
    ).toBe(1);
    expect(refusals[0], "MUTATION: the refusal must be the shared read-only code").toContain(
      "share_read_only",
    );
    expect(refusals[0]).toContain("403");

    await uploadShareBlob(h, edit, "recipient two");
    const accepted = await submit(h, edit, [change()]);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
  });

  it("refuses a chat-channel grant's submit with the same bytes", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const created = await h(
      request(
        GRANTER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: RECIPIENT, channelWireId: "wire-1", access: "read-write" }),
      ),
    );
    expect(created.status).toBe(200);
    const shareId = (await json(created)).shareId as string;
    const refused = await submit(h, shareId, [change()]);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("share_read_only");
  });

  it("holds the two write routes apart: the append route still refuses moments", async () => {
    // #646 PR3-0 closed the append gate, and PR3a must not reopen it by giving
    // the append route a moment-shaped arm. The proposal route is the ONLY way
    // a file change crosses, and it never reaches the log without an accept.
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");

    const appended = await h(
      request(
        RECIPIENT,
        `/sync/shares/${shareId}/log`,
        jsonBody({
          originId: "origin-recipient",
          ops: [
            {
              originSeq: 0,
              opKind: "moment.append",
              payload: { momentId: "m", versionId: "main", objectId: "o", path: "docs/in.md" },
              recordedAtMs: 5,
            },
          ],
        }),
      ),
    );
    expect(
      appended.status,
      "MUTATION: the append route must never gain moment acceptance",
    ).toBe(403);
    expect(
      (await granter.sharedMoments(shareId)).length,
      "MUTATION: a refused append must leave the granter's log untouched",
    ).toBe(0);
  });
});

describe("what a proposal may name", () => {
  it("refuses a change whose base or destination leaves the selector", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    await granter.write("object-in", "docs/in.md", "granter one");
    await granter.write("object-out", "notes/out.md", "outside");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");

    for (const [label, op] of [
      ["base outside", change({ basedOnPath: "notes/out.md" })],
      ["destination outside", change({ afterPath: "notes/out.md" })],
      [
        "escaping destination",
        change({ afterPath: "docs/../notes/out.md" }),
      ],
    ] as const) {
      const refused = await submit(h, shareId, [op], { submitId: `s-${label}` });
      expect(refused.status, `MUTATION: ${label} must be refused`).toBe(403);
      expect(await refused.text()).toContain("share_op_rejected");
    }
    expect((await reviewRows(h)).length, "MUTATION: nothing may be stored").toBe(0);
  });

  it("refuses two changes to one file in one submit", async () => {
    // One net change per file is what makes the base rewrite sound: two
    // changes for one file would be given the SAME rewritten base and would
    // then conflict with each other at accept. The recipient consolidates, and
    // this is where that stops being a promise and starts being a rule.
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    await uploadShareBlob(h, shareId, "recipient three");

    const sameBase = await submit(h, shareId, [
      change(),
      change({ afterPath: "docs/other.md", afterBlobSha256: sha256("recipient three") }),
    ]);
    expect(sameBase.status, "MUTATION: two changes may not share one base file").toBe(403);

    const sameDestination = await submit(
      h,
      shareId,
      [
        change(),
        change({ basedOnPath: null, basedOnBlobSha256: null, afterBlobSha256: sha256("recipient three") }),
      ],
      { submitId: "s-2" },
    );
    expect(sameDestination.status, "MUTATION: two changes may not land on one path").toBe(403);
    expect((await reviewRows(h)).length).toBe(0);
  });

  it("refuses a half-stated base and a malformed change", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");

    const malformed: Array<[string, unknown]> = [
      ["base path without a hash", change({ basedOnBlobSha256: null })],
      ["base hash without a path", change({ basedOnPath: null })],
      ["a hash that is not a hash", change({ afterBlobSha256: "not-a-sha" })],
      ["an unknown operation", { ...change(), operation: "rename" }],
      ["a delete that names content", change({ operation: "delete" })],
      ["a delete of a file the granter never had", { ...change(), operation: "delete", basedOnPath: null, basedOnBlobSha256: null, afterPath: null, afterBlobSha256: null, afterContentKind: null, afterByteLength: null }],
      ["a write with no destination", change({ afterPath: null })],
      ["a negative byte length", change({ afterByteLength: -1 })],
      ["a fractional timestamp", change({ recordedAtMs: 1.5 })],
      ["not an object", "docs/in.md"],
    ];
    for (const [label, op] of malformed) {
      const refused = await submit(h, shareId, [op as ProposedChange], { submitId: `s-${label}` });
      expect(refused.status, `MUTATION: ${label} must be refused`).toBe(403);
    }
    expect((await reviewRows(h)).length).toBe(0);
  });

  it("refuses a submit whose content the relay does not hold", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");

    const refused = await submit(h, shareId, [change()]);
    expect(
      refused.status,
      "MUTATION: a change whose blob is absent must be refused at submit",
    ).toBe(422);
    expect(await refused.text()).toContain("blob_missing");
  });
});

describe("the base rewrite", () => {
  it("gives a CURRENT change the granter's own head moment as its base", async () => {
    // The mechanism that makes accept free. A recipient's own moment ids mean
    // nothing here, so the relay states the base itself — and when the
    // recipient was current, that base IS the granter's head, which is what
    // lets the granter's engine fast-forward instead of opening a conflict.
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");

    const submitted = await submit(h, shareId, [
      change({ basedOnBlobSha256: head.blobSha256 }),
    ]);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const proposalId = (await json(submitted)).proposalId as string;

    expect(
      (await granter.sharedMoments(shareId)).length,
      "MUTATION: an open proposal must not be in the granter's log",
    ).toBe(0);

    const accepted = await settle(h, proposalId, "accept");
    expect(accepted.status, await accepted.clone().text()).toBe(200);

    const moments = await granter.sharedMoments(shareId);
    expect(moments.length).toBe(1);
    const moment = moments[0]!;
    expect(
      moment.beforeLatestMomentId,
      "MUTATION: the base must be the granter's OWN head moment, or every accept opens a spurious conflict",
    ).toBe(head.momentId);
    expect(
      moment.objectId,
      "MUTATION: the moment must name the GRANTER's object, not a recipient id",
    ).toBe("object-in");
    expect(moment.beforePresent).toBe("present");
    expect(moment.beforePath).toBe("docs/in.md");
    expect(moment.beforeBlobSha256).toBe(head.blobSha256);
    expect(moment.payloadBeforePath).toBe("docs/in.md");
    expect(moment.payloadBeforeBlobSha256).toBe(head.blobSha256);
    expect(moment.payloadAfterBlobSha256).toBe(sha256("recipient two"));
    expect(moment.payloadAfterPath).toBe("docs/in.md");
    expect(moment.operation).toBe("write");
    expect(moment.versionId).toBe("main");
    // A moment cannot name a human author; the summary is what History shows.
    expect(moment.author).toBeUndefined();
    expect((moment.metadata as Record<string, unknown>).summary).toBe(
      `Accepted changes from ${RECIPIENT}@dohc.test`,
    );
  });

  it("gives a DRIFTED change the granter's own EARLIER moment as its base", async () => {
    // The second correct outcome. The granter wrote again after the recipient
    // read the file, so the rewritten base is a real, older granter moment —
    // which is what makes the conflict the engine then opens a correct
    // three-way one rather than an arbitrary pair.
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const readByRecipient = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    // The granter moves on while the recipient is editing.
    const head = await granter.write("object-in", "docs/in.md", "granter two");
    expect(head.momentId).not.toBe(readByRecipient.momentId);
    await uploadShareBlob(h, shareId, "recipient two");

    const submitted = await submit(h, shareId, [
      change({ basedOnBlobSha256: readByRecipient.blobSha256 }),
    ]);
    expect(submitted.status).toBe(200);
    const proposalId = (await json(submitted)).proposalId as string;

    const rows = await reviewRows(h);
    expect(
      (rows[0]!.ops as Array<Record<string, unknown>>)[0]!.drifted,
      "MUTATION: the review surface must say this file changed since they sent it",
    ).toBe(true);

    expect((await settle(h, proposalId, "accept")).status).toBe(200);
    const moment = (await granter.sharedMoments(shareId))[0]!;
    expect(
      moment.beforeLatestMomentId,
      "MUTATION: a drifted change must name the moment it was BUILT ON, not the granter's head",
    ).toBe(readByRecipient.momentId);
    expect(moment.beforeLatestMomentId).not.toBe(head.momentId);
    expect(moment.beforeBlobSha256).toBe(readByRecipient.blobSha256);
  });

  it("states no base when the content the recipient read is unknown here", async () => {
    // Fail closed. An unresolvable base must never borrow the granter's
    // current head: that would claim the recipient had read content it never
    // saw, and the granter's newer work would be overwritten without a
    // conflict.
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    // A hash of content this workspace has never held.
    await granter.putBlob("a stranger");

    const submitted = await submit(h, shareId, [
      change({ basedOnBlobSha256: sha256("a stranger") }),
    ]);
    expect(submitted.status).toBe(200);
    const proposalId = (await json(submitted)).proposalId as string;
    expect((await settle(h, proposalId, "accept")).status).toBe(200);

    const moment = (await granter.sharedMoments(shareId))[0]!;
    expect(
      moment.beforePresent,
      "MUTATION: an unknown base must state NO base, so the granter's engine opens a conflict",
    ).toBe("null");
    expect(moment.beforeLatestMomentId).toBeUndefined();
    expect(moment.payloadBeforePath).toBeNull();
    // The object is still the granter's own: only the LINEAGE is unknown.
    expect(moment.objectId).toBe("object-in");
  });

  it("reads a change that moves a file as a rename, and mints a new object for a new file", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    await uploadShareBlob(h, shareId, "brand new");

    const submitted = await submit(h, shareId, [
      change({ basedOnBlobSha256: head.blobSha256, afterPath: "docs/moved.md" }),
      change({
        basedOnPath: null,
        basedOnBlobSha256: null,
        afterPath: "docs/new.md",
        afterBlobSha256: sha256("brand new"),
        afterByteLength: "brand new".length,
      }),
    ]);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect((await settle(h, (await json(submitted)).proposalId as string, "accept")).status).toBe(
      200,
    );

    const moments = await granter.sharedMoments(shareId);
    expect(moments.length).toBe(2);
    const moved = moments.find((moment) => moment.payloadAfterPath === "docs/moved.md")!;
    expect(
      moved.operation,
      "MUTATION: a change that lands somewhere else is a rename, or the old path keeps an alias",
    ).toBe("rename");
    expect(moved.payloadBeforePath).toBe("docs/in.md");
    expect(moved.objectId).toBe("object-in");

    const created = moments.find((moment) => moment.payloadAfterPath === "docs/new.md")!;
    expect(created.operation).toBe("write");
    expect(created.beforePresent).toBe("null");
    expect(
      created.objectId,
      "MUTATION: a file the granter never had needs an object id the relay mints",
    ).toMatch(/^id-/u);
    expect(created.objectId).not.toBe("object-in");
  });

  it("carries the content a delete removes on both sides of the moment", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");

    const submitted = await submit(h, shareId, [
      change({
        basedOnBlobSha256: head.blobSha256,
        operation: "delete",
        afterPath: null,
        afterBlobSha256: null,
        afterContentKind: null,
        afterByteLength: null,
      }),
    ]);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect((await settle(h, (await json(submitted)).proposalId as string, "accept")).status).toBe(
      200,
    );

    const moment = (await granter.sharedMoments(shareId))[0]!;
    expect(moment.operation).toBe("delete");
    expect(moment.path).toBe("docs/in.md");
    expect(moment.payloadAfterPath).toBe("docs/in.md");
    expect(
      moment.payloadAfterBlobSha256,
      "MUTATION: the domain's own delete carries the removed content on both sides",
    ).toBe(head.blobSha256);
    expect(moment.beforeLatestMomentId).toBe(head.momentId);
  });
});

describe("accept, decline, and withdraw", () => {
  it("declines without moving anything into the granter's log", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    const submitted = await submit(h, shareId, [change({ basedOnBlobSha256: head.blobSha256 })]);
    const proposalId = (await json(submitted)).proposalId as string;

    const declined = await settle(h, proposalId, "decline");
    expect(declined.status).toBe(200);
    expect((await json(declined)).state).toBe("declined");
    expect(
      (await granter.sharedMoments(shareId)).length,
      "MUTATION: decline must never move the changes",
    ).toBe(0);
    // And the recipient can see what happened to them.
    const mine = await h(request(RECIPIENT, `/sync/shares/${shareId}/proposals`));
    expect(((await json(mine)).proposals as Array<Record<string, unknown>>)[0]!.state).toBe(
      "declined",
    );
  });

  it("settles exactly once, whichever mover arrives second", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    const submitted = await submit(h, shareId, [change({ basedOnBlobSha256: head.blobSha256 })]);
    const proposalId = (await json(submitted)).proposalId as string;

    expect((await settle(h, proposalId, "accept")).status).toBe(200);
    const twice = await settle(h, proposalId, "accept");
    expect(twice.status, "MUTATION: a second accept must not release the changes again").toBe(409);
    expect((await settle(h, proposalId, "decline")).status).toBe(409);
    const withdrawn = await h(
      request(RECIPIENT, `/sync/shares/${shareId}/proposals/${proposalId}/withdraw`, {
        method: "POST",
      }),
    );
    expect(withdrawn.status).toBe(409);
    expect(
      (await granter.sharedMoments(shareId)).length,
      "MUTATION: the changes must be in the log exactly once",
    ).toBe(1);
  });

  it("lets a recipient take its changes back while they are open", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    const submitted = await submit(h, shareId, [change({ basedOnBlobSha256: head.blobSha256 })]);
    const proposalId = (await json(submitted)).proposalId as string;

    const withdrawn = await h(
      request(RECIPIENT, `/sync/shares/${shareId}/proposals/${proposalId}/withdraw`, {
        method: "POST",
      }),
    );
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    expect(
      (await reviewRows(h)).length,
      "MUTATION: withdrawn changes must leave the granter's review surface",
    ).toBe(0);
    expect((await settle(h, proposalId, "accept")).status).toBe(409);
  });

  it("returns the same proposal when a submit is retried", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    const ops = [change({ basedOnBlobSha256: head.blobSha256 })];

    const first = await json(await submit(h, shareId, ops, { submitId: "retried" }));
    const second = await json(await submit(h, shareId, ops, { submitId: "retried" }));
    expect(second.proposalId, "MUTATION: a lost response must not become a second proposal").toBe(
      first.proposalId,
    );
    expect(second.created).toBe(false);
    expect((await reviewRows(h)).length).toBe(1);
  });
});

describe("who may do what", () => {
  it("never lets a recipient accept its own changes", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    const submitted = await submit(h, shareId, [change({ basedOnBlobSha256: head.blobSha256 })]);
    const proposalId = (await json(submitted)).proposalId as string;

    for (const [label, response] of [
      ["accept", await settle(h, proposalId, "accept", RECIPIENT)],
      ["decline", await settle(h, proposalId, "decline", RECIPIENT)],
      ["review", await h(request(RECIPIENT, `/sync/${WORKSPACE}/proposals`))],
    ] as const) {
      expect(
        response.status,
        `MUTATION: a recipient must never ${label} — ownership decides, not the share`,
      ).toBe(404);
    }
    expect((await granter.sharedMoments(shareId)).length).toBe(0);
  });

  it("keeps one recipient's changes invisible to another recipient", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const mine = await createShare(h, "edit");
    const theirs = await createShare(h, "edit", { recipient: OTHER });
    await uploadShareBlob(h, mine, "recipient two");
    const submitted = await submit(h, mine, [change({ basedOnBlobSha256: head.blobSha256 })]);
    const proposalId = (await json(submitted)).proposalId as string;

    const listed = await h(request(OTHER, `/sync/shares/${theirs}/proposals`));
    expect(listed.status).toBe(200);
    expect(
      ((await json(listed)).proposals as unknown[]).length,
      "MUTATION: an overlapping share must not surface another recipient's changes",
    ).toBe(0);

    const stolen = await h(
      request(OTHER, `/sync/shares/${theirs}/proposals/${proposalId}/withdraw`, {
        method: "POST",
      }),
    );
    expect(stolen.status, "MUTATION: a proposal of another share is the generic 404").toBe(404);
  });

  it("refuses a submit on a share already revoked or already narrowed", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");

    const revoked = await createShare(h, "edit");
    await uploadShareBlob(h, revoked, "recipient two");
    expect(
      (await h(request(GRANTER, `/sync/shares/${revoked}/revoke`, { method: "POST" }))).status,
    ).toBe(200);
    const afterRevoke = await submit(h, revoked, [change({ basedOnBlobSha256: head.blobSha256 })]);
    expect(afterRevoke.status, "MUTATION: a revoked share accepts no submit").toBe(404);

    const downgraded = await createShare(h, "edit");
    narrowToComment(storage, downgraded);
    const afterDowngrade = await submit(h, downgraded, [
      change({ basedOnBlobSha256: head.blobSha256 }),
    ]);
    expect(afterDowngrade.status, "MUTATION: a narrowed level accepts no submit").toBe(403);
    expect((await reviewRows(h)).length).toBe(0);
  });

  it("loses a submit to a revoke or a downgrade that lands at the LAST instant", async () => {
    // The TOCTOU window the entry checks cannot cover: the grant changes after
    // every route-level check and immediately before the transactional insert.
    // Only the guard running inside the insert's own BEGIN IMMEDIATE can still
    // stop it, so this is the only case that drives the guard itself.
    for (const [label, sabotage, expected] of [
      ["revoke", (storage: SyncRelayStorage) => storage.revokeShare("share-0", 6000), 404],
      ["downgrade", (storage: SyncRelayStorage) => narrowToComment(storage, "share-0"), 403],
    ] as const) {
      const storage = await testStorage();
      const raced = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop === "insertShareProposal") {
            return (input: Parameters<SyncRelayStorage["insertShareProposal"]>[0]) => {
              sabotage(target);
              return target.insertShareProposal(input);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const h = handler(raced);
      await claimWorkspace(h);
      const granter = new Granter(h);
      const head = await granter.write("object-in", "docs/in.md", "granter one");
      const shareId = await createShare(h, "edit");
      expect(shareId).toBe("share-0");
      await uploadShareBlob(h, shareId, "recipient two");

      const raced2 = await submit(h, shareId, [change({ basedOnBlobSha256: head.blobSha256 })]);
      expect(
        raced2.status,
        `MUTATION: a ${label} landing inside the write lock must roll the submit back`,
      ).toBe(expected);
      expect(
        storage.listShareProposalsForShare(shareId).length,
        `MUTATION: a lost ${label} race must store nothing`,
      ).toBe(0);
    }
  });
});

// A downgrade the way one would leave the stored row. There is no downgrade
// route yet, so the selector is narrowed directly and the gates must read the
// CURRENT level rather than the one the request started with.
function narrowToComment(storage: SyncRelayStorage, shareId: string): void {
  const row = storage.getShare(shareId);
  if (!row) throw new Error(`no share ${shareId}`);
  const selector = JSON.parse(row.selectorJson) as Record<string, unknown>;
  selector.access = "comment";
  (
    storage as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }
  ).db
    .prepare("UPDATE sync_relay_shares SET selector_json = ? WHERE share_id = ?")
    .run(JSON.stringify(selector), shareId);
}

describe("the recipient's blob route", () => {
  it("refuses an upload below edit level with the same bytes as every other refusal", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const view = await createShare(h, "view");
    const comment = await createShare(h, "comment");
    const refusals = await Promise.all(
      [view, comment].map(async (shareId) =>
        await denialBytes(await uploadShareBlob(h, shareId, "recipient two")),
      ),
    );
    expect(new Set(refusals).size, "MUTATION: the level must not be readable from the bytes").toBe(
      1,
    );
    expect(refusals[0]).toContain("share_read_only");
  });

  it("refuses a blob over the transport cap and one whose bytes do not match its name", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const shareId = await createShare(h, "edit");

    const oversize = await h(
      request(RECIPIENT, `/sync/shares/${shareId}/blobs/${sha256("x")}`, {
        method: "PUT",
        body: new Uint8Array(MAX_BLOB_BYTES + 1),
      }),
    );
    expect(oversize.status).toBe(413);

    const mismatched = await h(
      request(RECIPIENT, `/sync/shares/${shareId}/blobs/${sha256("one thing")}`, {
        method: "PUT",
        body: new TextEncoder().encode("another thing"),
      }),
    );
    expect(mismatched.status, "MUTATION: a blob must be what its name says it is").toBe(400);
  });

  it("bounds the blobs a share may hold that no change claims, and names the limit", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const shareId = await createShare(h, "edit");
    // Fill the budget directly: uploading 500 real blobs through HTTP would
    // measure the harness, not the bound.
    for (let index = 0; index < MAX_OPS_PER_REQUEST; index += 1) {
      storage.recordShareBlobUpload(shareId, sha256(`filler-${index}`), 1);
    }
    const refused = await uploadShareBlob(h, shareId, "one more");
    expect(refused.status).toBe(413);
    const body = await refused.text();
    expect(body).toContain("quota_exceeded");
    expect(body, "the refusal must name the observed count").toContain(
      String(MAX_OPS_PER_REQUEST),
    );
  });

  it("stops counting a blob once a change claims it", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await claimWorkspace(h);
    const granter = new Granter(h);
    const head = await granter.write("object-in", "docs/in.md", "granter one");
    const shareId = await createShare(h, "edit");
    await uploadShareBlob(h, shareId, "recipient two");
    expect(storage.unclaimedShareBlobUploads(shareId)).toBe(1);
    expect(
      (await submit(h, shareId, [change({ basedOnBlobSha256: head.blobSha256 })])).status,
    ).toBe(200);
    expect(
      storage.unclaimedShareBlobUploads(shareId),
      "MUTATION: a submitted blob is no longer in flight",
    ).toBe(0);
  });
});

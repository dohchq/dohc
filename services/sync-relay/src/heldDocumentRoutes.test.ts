import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import type {ServerResponse} from "node:http";
import {afterEach, describe, expect, it, vi} from "vitest";
import {DRAIN_TIMEOUT_HEADER, DRAIN_TIMEOUT_MS, pipeResponseBody} from "@dohc/service-http";
import {UnauthorizedError} from "@dohc/workspace-auth/session";
import {fixture as ticketFixture, scope} from "./liveTickets.test-helper";
import {createSyncRelayHandler} from "./server";
import {releasedLineageBindingDigest, type ReleasedLineageBinding} from "@dohc/workspace-engine-client/relay-wire";
import {heldBodySendDeadlineMs, MAX_HELD_BODY_BYTES, MAX_HELD_DOCUMENTS_PAGE, withStreamedContributions, withStreamedMarkdown, type HeldContributionsRead,
  type HeldDocumentHost, type HeldDocumentInspection, type HeldDocumentsPage, type StreamedBlob} from "./heldDocumentRoutes";
import {HeldReadBusyError, HeldReadTooLargeError} from "./liveHostRequests";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});

const binding: ReleasedLineageBinding = {version: 3, workspaceId: scope.workspaceId, mainVersionId: "main", objectId: "object-1",
  lineageClaimId: "a".repeat(64), currentPath: "docs/a.md", restoreGeneration: 0,
  incoming: {relayNamespace: "relay", replicationEpoch: "epoch", streamIdentity: "stream", originId: "desktop", originSeq: 1, relaySeq: 3},
  headDigest: "b".repeat(64),
  tails: [{namespace: "relay", activationId: "activation", release: {path: "docs/a.md", restoreGeneration: 0},
    unproven: {count: 1, digest: "c".repeat(64)}}]};
const held: HeldDocumentsPage["documents"][number] = {objectId: binding.objectId, path: binding.currentPath!,
  bindingDigest: releasedLineageBindingDigest(binding), continuation: "frozen", bindingStale: false};
const page: HeldDocumentsPage = {documents: [held], hasMore: false};
const inspection: HeldDocumentInspection = {...held, status: "stale", preservation: null, resolution: null};
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// A blob as the engine client hands it over, after checking it against what it announced.
const blob = (bytes: Uint8Array, announced: {sha256?: string; totalBytes?: number} = {}): StreamedBlob =>
  ({bytes, sha256: sha256(bytes), totalBytes: bytes.length, ...announced});
// Preserved text past the engine's in-band limit, as the session host answers it whole.
const markdown = "# Plan\n\n" + "Kept paragraph with ünïcode.\n\n".repeat(4096);
// The binding and the work it covers, as the engine streams them; the details name them by digest.
const contributions = Buffer.from(JSON.stringify({binding, coveredContributions: [], mergedContributionIds: [], version: 1}));
const preserved: HeldDocumentInspection = {...held, status: "current", resolution: null, preservation: {status: "complete",
  reasons: [], mergedContributions: {count: 0, digest: "e".repeat(64)}, contributionsSha256: sha256(contributions),
  contributionsByteLength: contributions.length, contributionsTooLarge: false, markdown, markdownSha256: sha256(markdown),
  markdownByteLength: Buffer.byteLength(markdown), inbandLimitBytes: 48 * 1024}};
// The same preservation, its artifact past what the engine streams: only the artifact is refused, and its
// merged commitment still answers.
const tooLarge: HeldDocumentInspection = {...preserved, preservation: {...preserved.preservation!,
  contributionsSha256: null, contributionsByteLength: null, contributionsTooLarge: true}};
const markdownPath = `${scope.workspaceId}/held-documents/${held.objectId}/markdown` +
  `?bindingDigest=${held.bindingDigest}&sha256=${sha256(markdown)}`;
const contributionsPath = `${scope.workspaceId}/held-documents/${held.objectId}/contributions` +
  `?bindingDigest=${held.bindingDigest}&sha256=${sha256(contributions)}`;

// Each bearer names one account: the owner, a named Edit recipient, a View
// recipient, and the owners of two other workspaces.
const accounts: Record<string, string> = {"Bearer owner": "owner-1", "Bearer editor": scope.userId,
  "Bearer viewer": "viewer-1", "Bearer stranger": "owner-2", "Bearer third": "owner-3"};

async function relay(host: HeldDocumentHost | undefined) {
  const f = await ticketFixture(); cleanups.push(f.close);
  f.raw.prepare(`INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('view-1', ?, 'user', 'viewer-1', NULL, 'view', 1, 'active', 0, NULL, NULL)`).run(scope.shareId);
  f.raw.prepare("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES ('workspace-2', 'owner-2', 0)").run();
  const resolveActor = vi.fn(async (request: Request, workspaceId: string) => {
    const userId = accounts[request.headers.get("authorization") ?? ""];
    if (!userId) throw new UnauthorizedError();
    return {userId, workspaceId};
  });
  let current = host;
  const handler = createSyncRelayHandler({storage: f.storage, resolveActor, heldDocumentHost: () => current});
  const get = (path: string, headers: Record<string, string> = {authorization: "Bearer owner"}, method = "GET", signal?: AbortSignal) =>
    handler(new Request(`http://relay.test/sync/${path}`, {method, headers, signal}));
  return {...f, get, resolveActor, replaceHost(next: HeldDocumentHost | undefined) {current = next;}};
}

function fakeHost(overrides: Partial<HeldDocumentHost> = {}): HeldDocumentHost & {calls: unknown[][]} {
  const calls: unknown[][] = [];
  return {calls,
    heldDocuments: overrides.heldDocuments ?? (async (...args) => {calls.push(["list", ...args.slice(0, 2)]); return page;}),
    heldDocument: overrides.heldDocument ?? (async (...args) => {calls.push(["one", ...args.slice(0, 3)]); return inspection;}),
    heldContributions: overrides.heldContributions ?? (async (...args) => {
      calls.push(["contributions", ...args.slice(0, 2)]);
      return {inspected: inspection, contributions: null};
    })};
}

/** A host answering `inspected` with the artifact the engine streams for it, as the session host does. */
function streaming(inspected: HeldDocumentInspection, asked: string[] = []): HeldDocumentHost["heldContributions"] {
  return async () => {
    asked.push("contributions");
    return withStreamedContributions(inspected, inspected.preservation ? blob(contributions) : undefined);
  };
}

/** A host answering `inspected` as the session host does: text above the in-band limit only when asked for. */
function answering(inspected: HeldDocumentInspection, asked: boolean[] = []): HeldDocumentHost["heldDocument"] {
  return async (_workspaceId, _objectId, read) => {
    asked.push(read.markdown);
    const preservation = inspected.preservation;
    if (read.markdown || preservation?.markdown == null || preservation.markdownByteLength! <= preservation.inbandLimitBytes) return inspected;
    return {...inspected, preservation: {...preservation, markdown: null}};
  };
}

describe("held document routes", () => {
  it("answer the workspace's owner, and an agent with the owner's credential, from the host", async () => {
    const host = fakeHost(), f = await relay(host);
    const list = await f.get(`${scope.workspaceId}/held-documents?after=a&limit=2`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(await list.json()).toEqual(page);
    const one = await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(inspection);
    expect(await (await f.get(`${scope.workspaceId}/held-documents`)).json()).toEqual(page);
    expect(host.calls).toEqual([
      ["list", scope.workspaceId, {afterObjectId: "a", limit: 2}],
      ["one", scope.workspaceId, held.objectId, {markdown: false}],
      ["list", scope.workspaceId, {limit: 50}],
    ]);
  });

  it.each([
    ["a named Edit recipient", {authorization: "Bearer editor"}, 404],
    ["a View recipient", {authorization: "Bearer viewer"}, 404],
    ["another workspace's owner", {authorization: "Bearer stranger"}, 404],
    ["an unauthenticated caller", {}, 404],
    ["an ambient browser cookie", {authorization: "Bearer owner", cookie: "session=owner"}, 404],
    ["an unknown credential", {authorization: "Bearer forged"}, new UnauthorizedError().statusCode],
  ])("refuse %s as they refuse elsewhere, naming nothing, and never ask the host", async (_case, headers, status) => {
    const host = fakeHost(), f = await relay(host);
    for (const path of [`${scope.workspaceId}/held-documents`, `${scope.workspaceId}/held-documents/${held.objectId}`, markdownPath,
      contributionsPath]) {
      const refused = await f.get(path, headers);
      expect(refused.status).toBe(status);
      expect(JSON.stringify(await refused.json())).not.toContain(held.objectId);
    }
    expect(host.calls).toEqual([]);
  });

  it("refuse the owner of one workspace reading another's held documents", async () => {
    const host = fakeHost(), f = await relay(host);
    expect((await f.get("workspace-2/held-documents")).status).toBe(404);
    expect(host.calls).toEqual([]);
  });

  /** A host whose reads wait until `release`, and `asked` once one began. */
  function waitingHost() {
    let release!: () => void, began!: () => void;
    const answered = new Promise<void>(resolve => {release = resolve;});
    const asked = new Promise<void>(resolve => {began = resolve;});
    const host = fakeHost({
      heldDocument: async () => {began(); await answered; return inspection;},
      heldDocuments: async () => {began(); await answered; return page;},
    });
    return {host, asked, release};
  }

  it("recheck ownership and the answering host after the host's read", async () => {
    const owned = waitingHost(), f = await relay(owned.host);
    const transferred = f.get(`${scope.workspaceId}/held-documents/${held.objectId}`);
    await owned.asked;
    f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id=?").run(scope.workspaceId);
    owned.release();
    const refused = await transferred;
    expect(refused.status).toBe(404);
    expect(JSON.stringify(await refused.json())).not.toContain(held.objectId);

    const answering = waitingHost(), g = await relay(answering.host);
    const replaced = g.get(`${scope.workspaceId}/held-documents`);
    await answering.asked;
    g.replaceHost(fakeHost());
    answering.release();
    expect((await replaced).status).toBe(404);
  });

  it("answer nothing held, and no host, as a missing document", async () => {
    const f = await relay(fakeHost({heldDocument: async () => null, heldDocuments: async () => null}));
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`)).status).toBe(404);
    expect((await f.get(`${scope.workspaceId}/held-documents`)).status).toBe(404);
    const g = await relay(undefined);
    expect((await g.get(`${scope.workspaceId}/held-documents`)).status, "no session host").toBe(404);
  });

  it.each(["registration", "attachment"] as const)("answer a read its host's %s overtook as a missing document", async ended => {
    const f = await relay(fakeHost({heldDocument: async () => ({invalidated: ended}), heldDocuments: async () => ({invalidated: ended}),
      heldContributions: async () => ({invalidated: ended})}));
    for (const path of [`${scope.workspaceId}/held-documents`, `${scope.workspaceId}/held-documents/${held.objectId}`, markdownPath,
      contributionsPath]) {
      const refused = await f.get(path);
      expect(refused.status, path).toBe(404);
      expect(await refused.json()).toMatchObject({code: "not_found"});
    }
  });

  it("answer a host that failed as a failure while ownership and the host stand, and as nothing once either moved", async () => {
    const failing = () => {
      let release!: () => void, began!: () => void;
      const answered = new Promise<void>(resolve => {release = resolve;});
      const asked = new Promise<void>(resolve => {began = resolve;});
      const fail = async (): Promise<never> => {began(); await answered; throw new Error("engine transport failed");};
      return {host: fakeHost({heldDocument: fail, heldDocuments: fail}), asked, release};
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const standing = failing(), f = await relay(standing.host);
      standing.release();
      expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`)).status).toBe(500);

      const transferred = failing(), g = await relay(transferred.host);
      const read = g.get(`${scope.workspaceId}/held-documents/${held.objectId}`);
      await transferred.asked;
      g.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id=?").run(scope.workspaceId);
      transferred.release();
      const refused = await read;
      expect(refused.status).toBe(404);
      expect(JSON.stringify(await refused.json())).not.toContain("engine transport failed");

      const replaced = failing(), h = await relay(replaced.host);
      const listed = h.get(`${scope.workspaceId}/held-documents`);
      await replaced.asked;
      h.replaceHost(fakeHost());
      replaced.release();
      expect((await listed).status).toBe(404);
    } finally {log.mockRestore();}
  });

  it.each([
    "limit=0", `limit=${MAX_HELD_DOCUMENTS_PAGE + 1}`, "limit=1.5", "limit=01", "limit=two",
    "after=", "limit=1&limit=2", "other=1",
  ])("refuse a bad page query, %s, before asking the host", async query => {
    const host = fakeHost(), f = await relay(host);
    expect((await f.get(`${scope.workspaceId}/held-documents?${query}`)).status).toBe(400);
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}?${query}`)).status).toBe(400);
    expect(host.calls).toEqual([]);
  });

  it("are read only", async () => {
    const host = fakeHost(), f = await relay(host);
    expect((await f.get(`${scope.workspaceId}/held-documents`, {authorization: "Bearer owner"}, "POST")).status).toBe(405);
    expect((await f.get(markdownPath, {authorization: "Bearer owner"}, "POST")).status).toBe(405);
    expect((await f.get(contributionsPath, {authorization: "Bearer owner"}, "POST")).status).toBe(405);
    expect(host.calls).toEqual([]);
  });

  it("answer preserved text past the in-band limit whole from its own route, and ask for it only there", async () => {
    const asked: boolean[] = [];
    const host = fakeHost({heldDocument: answering(preserved, asked)}), f = await relay(host);
    const details = await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`);
    expect(details.status).toBe(200);
    const body = await details.json() as HeldDocumentInspection;
    expect(body.preservation).toMatchObject({markdown: null, markdownSha256: sha256(markdown), markdownByteLength: Buffer.byteLength(markdown)});

    const text = await f.get(markdownPath);
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(text.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await text.arrayBuffer());
    expect(sha256(bytes)).toBe(sha256(markdown));
    expect(new TextDecoder().decode(bytes)).toBe(markdown);
    expect(asked).toEqual([false, true]);
  });

  it("keep preserved text within the in-band limit in the details", async () => {
    const short = "# Plan\n\nKept.\n";
    const inband: HeldDocumentInspection = {...preserved, preservation: {...preserved.preservation!, markdown: short,
      markdownSha256: sha256(short), markdownByteLength: Buffer.byteLength(short)}};
    const f = await relay(fakeHost({heldDocument: answering(inband)}));
    expect(((await (await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`)).json()) as HeldDocumentInspection)
      .preservation?.markdown).toBe(short);
  });

  it.each([
    ["another binding", {bindingDigest: "e".repeat(64)}],
    ["other text", {sha256: "e".repeat(64)}],
  ])("answer no text inspected under %s, as a missing document", async (_case, query) => {
    const f = await relay(fakeHost({heldDocument: answering(preserved)}));
    const params = new URLSearchParams({bindingDigest: held.bindingDigest, sha256: sha256(markdown), ...query});
    const refused = await f.get(`${scope.workspaceId}/held-documents/${held.objectId}/markdown?${params}`);
    expect(refused.status).toBe(404);
  });

  it("answer no text for a stale binding or an incomplete preservation", async () => {
    const stale = await relay(fakeHost({heldDocument: async () => inspection}));
    expect((await stale.get(markdownPath)).status).toBe(404);
    const incomplete: HeldDocumentInspection = {...preserved, preservation: {...preserved.preservation!, status: "missing-evidence",
      reasons: [{reason: "source-missing", status: "missing-evidence", total: 1, omitted: 0, examples: [{namespace: "relay", contribution: null}]}],
      markdown: null, markdownSha256: null, markdownByteLength: null}};
    const missing = await relay(fakeHost({heldDocument: async () => incomplete}));
    expect((await missing.get(markdownPath)).status).toBe(404);
  });

  it.each([
    "", "?bindingDigest=" + "a".repeat(64), `?sha256=${"a".repeat(64)}`,
    `?bindingDigest=${"A".repeat(64)}&sha256=${"a".repeat(64)}`,
    `?bindingDigest=${"a".repeat(64)}&sha256=${"a".repeat(64)}&other=1`,
    `?bindingDigest=${"a".repeat(64)}&bindingDigest=${"a".repeat(64)}&sha256=${"a".repeat(64)}`,
  ])("refuse a bad Markdown or contributions query, %s, before asking the host", async query => {
    const host = fakeHost(), f = await relay(host);
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}/markdown${query}`)).status).toBe(400);
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}/contributions${query}`)).status).toBe(400);
    expect(host.calls).toEqual([]);
  });

  it("recheck ownership after the host's read before answering text", async () => {
    let release!: () => void, began!: () => void;
    const answered = new Promise<void>(resolve => {release = resolve;});
    const asked = new Promise<void>(resolve => {began = resolve;});
    const f = await relay(fakeHost({heldDocument: async () => {began(); await answered; return preserved;}}));
    const transferred = f.get(markdownPath);
    await asked;
    f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id=?").run(scope.workspaceId);
    release();
    const refused = await transferred;
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain("Kept paragraph");
  });

  it("answer the contribution artifact whole from its own route, streaming only it there", async () => {
    const markdownAsked: boolean[] = [], contributionsAsked: string[] = [];
    const f = await relay(fakeHost({heldDocument: answering(preserved, markdownAsked), heldContributions: streaming(preserved, contributionsAsked)}));
    const artifact = await f.get(contributionsPath);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-type")).toBe("application/json");
    expect(artifact.headers.get("cache-control")).toBe("private, no-store");
    expect(artifact.headers.get("content-length")).toBe(String(contributions.length));
    expect(artifact.headers.has(DRAIN_TIMEOUT_HEADER), "a client that stops taking it loses it").toBe(true);
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(contributions);
    expect([markdownAsked, contributionsAsked]).toEqual([[], ["contributions"]]);
    // The Markdown route asks for the text alone, and the details for neither.
    const text = await f.get(markdownPath);
    expect(text.status).toBe(200);
    await text.arrayBuffer();
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`)).status).toBe(200);
    expect([markdownAsked, contributionsAsked]).toEqual([[true, false], ["contributions"]]);
  });

  it("answer the artifact of an incomplete preservation too, since it names the work that is missing", async () => {
    const incomplete: HeldDocumentInspection = {...preserved, preservation: {...preserved.preservation!, status: "missing-evidence",
      reasons: [{reason: "source-missing", status: "missing-evidence", total: 1, omitted: 0, examples: [{namespace: "relay", contribution: null}]}],
      markdown: null, markdownSha256: null, markdownByteLength: null}};
    const f = await relay(fakeHost({heldContributions: streaming(incomplete)}));
    const artifact = await f.get(contributionsPath);
    expect(artifact.status).toBe(200);
    expect(sha256(new Uint8Array(await artifact.arrayBuffer()))).toBe(sha256(contributions));
  });

  it.each([
    ["another binding", {bindingDigest: "e".repeat(64)}],
    ["another artifact", {sha256: "e".repeat(64)}],
  ])("answer no artifact inspected under %s, as a missing document", async (_case, query) => {
    const f = await relay(fakeHost({heldContributions: streaming(preserved)}));
    const params = new URLSearchParams({bindingDigest: held.bindingDigest, sha256: sha256(contributions), ...query});
    const refused = await f.get(`${scope.workspaceId}/held-documents/${held.objectId}/contributions?${params}`);
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain("coveredContributions");
  });

  it("answer an artifact too large to stream 413 under the binding inspected, while its details and text still answer", async () => {
    const f = await relay(fakeHost({heldDocument: answering(tooLarge), heldContributions: streaming(tooLarge)}));
    const refused = await f.get(contributionsPath);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({code: "payload_too_large"});
    const details = await f.get(`${scope.workspaceId}/held-documents/${held.objectId}`);
    expect(details.status).toBe(200);
    expect((await details.json()).preservation).toMatchObject({status: "complete", contributionsTooLarge: true, contributionsSha256: null,
      mergedContributions: tooLarge.preservation!.mergedContributions});
    const text = await f.get(markdownPath);
    expect(text.status).toBe(200);
    expect(await text.text()).toBe(markdown);
    const params = new URLSearchParams({bindingDigest: "e".repeat(64), sha256: sha256(contributions)});
    expect((await f.get(`${scope.workspaceId}/held-documents/${held.objectId}/contributions?${params}`)).status,
      "under another binding").toBe(404);
  });

  it("answer no artifact for a stale binding, or a document no longer held, as a missing document", async () => {
    const stale = await relay(fakeHost({heldContributions: streaming(inspection)}));
    expect((await stale.get(contributionsPath)).status).toBe(404);
    const gone = await relay(fakeHost({heldContributions: async () => null}));
    expect((await gone.get(contributionsPath)).status).toBe(404);
  });

  it("recheck ownership after the host's read before answering the artifact", async () => {
    let release!: () => void, began!: () => void;
    const answered = new Promise<void>(resolve => {release = resolve;});
    const asked = new Promise<void>(resolve => {began = resolve;});
    const read: HeldContributionsRead = {inspected: preserved, contributions};
    const f = await relay(fakeHost({heldContributions: async () => {began(); await answered; return read;}}));
    const transferred = f.get(contributionsPath);
    await asked;
    f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id=?").run(scope.workspaceId);
    release();
    const refused = await transferred;
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain("coveredContributions");
  });
});

describe("streamed held document contributions", () => {
  it("keeps the artifact the engine streamed when it is exactly what the inspection names", () => {
    expect(withStreamedContributions(preserved, blob(contributions))).toEqual({inspected: preserved, contributions});
  });

  it("refuses a stream that is missing or not the artifact the inspection names", () => {
    expect(() => withStreamedContributions(preserved, undefined)).toThrow();
    expect(() => withStreamedContributions(preserved, blob(Buffer.concat([contributions, Buffer.from(" ")])))).toThrow();
    const swapped = Buffer.from(contributions);
    swapped[swapped.length - 2] = 0x21;
    expect(() => withStreamedContributions(preserved, blob(swapped))).toThrow();
  });

  it("compares what the stream announced with the inspection, and never hashes it again", () => {
    expect(() => withStreamedContributions(preserved, blob(contributions, {sha256: "e".repeat(64)})), "another SHA-256").toThrow();
    expect(() => withStreamedContributions(preserved, blob(contributions, {totalBytes: contributions.length + 1})), "another length").toThrow();
    expect(() => withStreamedContributions(preserved, {bytes: contributions}), "nothing announced").toThrow();
    // The engine client already refused bytes unlike their announcement, so the relay takes the announcement.
    const unhashed = Buffer.alloc(contributions.length);
    expect(withStreamedContributions(preserved, blob(unhashed, {sha256: sha256(contributions)})).contributions).toBe(unhashed);
  });

  it("names no artifact for an inspection that is not current, or whose artifact is too large", () => {
    expect(withStreamedContributions(inspection, undefined)).toEqual({inspected: inspection, contributions: null});
    expect(withStreamedContributions(tooLarge, undefined)).toEqual({inspected: tooLarge, contributions: null});
  });
});

describe("held document read admission", () => {
  const details = `${scope.workspaceId}/held-documents/${held.objectId}`;
  /** A host whose reads wait until the test answers or fails each one, and end at once when their signal aborts. */
  function heldReads() {
    const reads: {signal?: AbortSignal; answer(): void; fail(error: Error): void}[] = [];
    const read = <T>(value: T, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {once: true});
      reads.push({signal, answer: () => resolve(value), fail: reject});
    });
    const host = fakeHost({heldDocument: (_workspaceId, _objectId, _read, signal) => read(inspection, signal),
      heldDocuments: (_workspaceId, _page, signal) => read(page, signal)});
    return {host, reads, asked: (count: number) => vi.waitFor(() => expect(reads).toHaveLength(count))};
  }

  it("answer a second read by the same owner of the same workspace 429 while one runs, without asking the host", async () => {
    const h = heldReads(), f = await relay(h.host);
    const first = f.get(details);
    await h.asked(1);
    const refused: Response[] = [];
    for (const path of [`${scope.workspaceId}/held-documents`, details, markdownPath]) void f.get(path).then(response => refused.push(response));
    await vi.waitFor(() => expect(refused).toHaveLength(3));
    for (const response of refused) {
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({code: "held_read_busy"});
    }
    expect(h.reads).toHaveLength(1);
    // Another owner reading their own workspace is admitted beside it.
    const other = f.get("workspace-2/held-documents", {authorization: "Bearer stranger"});
    await h.asked(2);
    h.reads[1]!.answer();
    expect((await other).status).toBe(200);
    h.reads[0]!.answer();
    const answered = await first;
    expect(answered.status).toBe(200);
    // Reading the answer frees the slot.
    await answered.json();
    const next = f.get(details);
    await h.asked(3);
    h.reads[2]!.answer();
    expect((await next).status).toBe(200);
  });

  it("answer a caller who lost ownership while their read runs as a missing document, not 429", async () => {
    const h = heldReads(), f = await relay(h.host);
    const first = f.get(details);
    await h.asked(1);
    f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id=?").run(scope.workspaceId);
    const refused = await f.get(details);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({code: "not_found"});
    h.reads[0]!.answer();
    expect((await first).status).toBe(404);
    expect(h.reads).toHaveLength(1);
  });

  it("free the slot after a failed read, the host's deadline, and a client that disconnected", async () => {
    const h = heldReads(), f = await relay(h.host), log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = f.get(details);
      await h.asked(1);
      h.reads[0]!.fail(new Error("engine transport failed"));
      expect((await failed).status).toBe(500);

      const expired = f.get(details);
      await h.asked(2);
      h.reads[1]!.fail(new Error("Held read deadline exceeded."));
      expect((await expired).status).toBe(500);

      const disconnect = new AbortController();
      const left = f.get(details, {authorization: "Bearer owner"}, "GET", disconnect.signal);
      await h.asked(3);
      disconnect.abort(new Error("client disconnected"));
      await left;
      expect(h.reads[2]!.signal?.aborted).toBe(true);

      const next = f.get(details);
      await h.asked(4);
      h.reads[3]!.answer();
      expect((await next).status).toBe(200);
    } finally {log.mockRestore();}
  });

  it("answer the host refusing a different read for the workspace as 429 while ownership stands", async () => {
    const f = await relay(fakeHost({heldDocument: async () => {throw new HeldReadBusyError();}}));
    const refused = await f.get(details);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({code: "held_read_busy"});
  });

  it("answer the host refusing an answer too large to keep as 413 while ownership stands, and as a missing document once it does not", async () => {
    let lose = () => {};
    const f = await relay(fakeHost({heldDocument: async () => {lose(); throw new HeldReadTooLargeError();}}));
    const refused = await f.get(details);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({code: "payload_too_large"});
    lose = () => {f.raw.prepare("UPDATE sync_relay_workspaces SET owner_user_id='owner-2' WHERE workspace_id=?").run(scope.workspaceId);};
    const lost = await f.get(details);
    expect(lost.status).toBe(404);
    expect(await lost.json()).toMatchObject({code: "not_found"});
  });

  it("hold the slot until the answer's body is read or cancelled", async () => {
    const f = await relay(fakeHost({heldContributions: streaming(preserved)}));
    const unread = await f.get(contributionsPath);
    expect(unread.status).toBe(200);
    expect((await f.get(contributionsPath)).status, "a body nobody read").toBe(429);
    expect(Buffer.from(await unread.arrayBuffer())).toEqual(contributions);
    const cancelled = await f.get(contributionsPath);
    expect(cancelled.status).toBe(200);
    expect((await f.get(details)).status).toBe(429);
    await cancelled.body!.cancel();
    const next = await f.get(details);
    expect(next.status).toBe(200);
    await next.json();
  });

  /** The details paths of more workspaces `ownerUserId` owns, beside the fixture's. */
  function owned(f: Awaited<ReturnType<typeof relay>>, ownerUserId: string, ...workspaceIds: string[]) {
    for (const workspaceId of workspaceIds) {
      f.raw.prepare("INSERT INTO sync_relay_workspaces (workspace_id, owner_user_id, created_at_ms) VALUES (?, ?, 0)").run(workspaceId, ownerUserId);
    }
    return workspaceIds.map(workspaceId => `${workspaceId}/held-documents/${held.objectId}`);
  }

  it("answer an owner's third held read across their workspaces 429, and admit another owner", async () => {
    const h = heldReads(), f = await relay(h.host);
    const [second, third] = owned(f, "owner-1", "workspace-3", "workspace-4");
    const reading = [f.get(details), f.get(second!)];
    await h.asked(2);
    let refused: Response | undefined;
    void f.get(third!).then(response => {refused = response;});
    await vi.waitFor(() => {expect(h.reads).toHaveLength(2); expect(refused?.status).toBe(429);});
    expect(await refused!.json()).toMatchObject({code: "held_read_busy"});
    expect((await f.get("workspace-2/held-documents")).status, "a workspace they don't own").toBe(404);
    expect(h.reads).toHaveLength(2);
    const other = f.get("workspace-2/held-documents", {authorization: "Bearer stranger"});
    await h.asked(3);
    for (const read of h.reads) read.answer();
    for (const response of [...await Promise.all(reading), await other]) {
      expect(response.status).toBe(200);
      await response.json();
    }
    const freed = f.get(third!);
    await h.asked(4);
    h.reads[3]!.answer();
    expect((await freed).status).toBe(200);
  });

  it("answer held bodies past the relay's byte budget 429 until earlier ones finish, after the ownership recheck", async () => {
    // Three artifacts that each fit, but not all at once.
    const large = Buffer.alloc(Math.floor(MAX_HELD_BODY_BYTES / 2.5));
    const f = await relay(fakeHost({heldContributions: async () => ({inspected: preserved, contributions: large})}));
    const [second] = owned(f, "owner-3", "workspace-3");
    const artifact = (path: string) => `${path}/contributions?bindingDigest=${held.bindingDigest}&sha256=${sha256(contributions)}`;
    const answered = [await f.get(contributionsPath), await f.get(artifact(second!), {authorization: "Bearer third"})];
    expect(answered.map(response => response.status)).toEqual([200, 200]);
    const refused = await f.get(artifact(`workspace-2/held-documents/${held.objectId}`), {authorization: "Bearer stranger"});
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({code: "held_read_busy"});
    // A caller who doesn't own the workspace learns nothing about the budget.
    expect((await f.get(contributionsPath, {authorization: "Bearer editor"})).status).toBe(404);
    expect((await answered[0]!.arrayBuffer()).byteLength).toBe(large.length);
    await answered[1]!.body!.cancel();
    const admitted = await f.get(artifact(`workspace-2/held-documents/${held.objectId}`), {authorization: "Bearer stranger"});
    expect(admitted.status).toBe(200);
    await admitted.body!.cancel();
  });

  /**
   * Two owners' artifacts answered that together leave too little of the byte budget for another, and the
   * paths that read them. `asked` lists each workspace the host read held work for.
   */
  async function fullBudget(asked: string[] = []) {
    const large = Buffer.alloc(Math.floor(MAX_HELD_BODY_BYTES / 2.2));
    const f = await relay(fakeHost({
      heldContributions: async workspaceId => {asked.push(workspaceId); return {inspected: preserved, contributions: large};},
      heldDocument: async workspaceId => {asked.push(workspaceId); return preserved;},
    }));
    owned(f, "owner-3", "workspace-3");
    const artifact = (workspaceId: string) =>
      `${workspaceId}/held-documents/${held.objectId}/contributions?bindingDigest=${held.bindingDigest}&sha256=${sha256(contributions)}`;
    const answered = [await f.get(artifact(scope.workspaceId)), await f.get(artifact("workspace-3"), {authorization: "Bearer third"})];
    expect(answered.map(response => response.status)).toEqual([200, 200]);
    const strangers = () => f.get(artifact("workspace-2"), {authorization: "Bearer stranger"});
    return {f, answered, artifact, strangers, large};
  }

  it("answer an owner's held bodies past half the byte budget 429, after the ownership check, and admit another owner", async () => {
    // Two artifacts that fit the budget together, but not one owner's share of it.
    const large = Buffer.alloc(Math.floor(MAX_HELD_BODY_BYTES / 3));
    const asked: string[] = [];
    let answer!: () => void;
    const answering = new Promise<void>(resolve => {answer = resolve;});
    const f = await relay(fakeHost({heldContributions: async workspaceId => {
      asked.push(workspaceId); await answering; return {inspected: preserved, contributions: large};
    }}));
    owned(f, "owner-1", "workspace-3", "workspace-4");
    const artifact = (workspaceId: string, authorization = "Bearer owner") => f.get(
      `${workspaceId}/held-documents/${held.objectId}/contributions?bindingDigest=${held.bindingDigest}&sha256=${sha256(contributions)}`,
      {authorization});
    // Both reads fit before the host answers; the second answered is refused on its actual bytes.
    const both = [artifact(scope.workspaceId), artifact("workspace-3")];
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    answer();
    const [answered, refused] = (await Promise.all(both)).sort((a, b) => a.status - b.status);
    expect([answered!.status, refused!.status]).toEqual([200, 429]);
    expect(await refused!.json()).toMatchObject({code: "held_read_busy"});
    // While the owner's answer holds its bytes, another artifact read is refused before the host reads it.
    const early = await artifact("workspace-4");
    expect(early.status).toBe(429);
    expect(await early.json()).toMatchObject({code: "held_read_busy"});
    expect(asked).toHaveLength(2);
    // A caller who doesn't own the workspace learns nothing about the owner's share.
    expect((await artifact("workspace-4", "Bearer editor")).status).toBe(404);
    // Another owner fits beside it.
    const other = await artifact("workspace-2", "Bearer stranger");
    expect(other.status).toBe(200);
    await other.body!.cancel();
    expect((await answered!.arrayBuffer()).byteLength).toBe(large.length);
    const freed = await artifact("workspace-4");
    expect(freed.status).toBe(200);
    await freed.body!.cancel();
  });

  it("give a body a minute to send, and about a second more for each 64 KB", () => {
    expect(heldBodySendDeadlineMs(1024)).toBe(60_016);
    expect(heldBodySendDeadlineMs(64 * 1024 * 1024)).toBe(60_000 + 1_048_576);
  });

  it("answer an artifact or Markdown read 429 without asking the host while the byte budget can't fit one, after the ownership check", async () => {
    const asked: string[] = [];
    const {f, answered, artifact} = await fullBudget(asked);
    const other = `workspace-2/held-documents/${held.objectId}`;
    for (const path of [artifact("workspace-2"), `${other}/markdown?bindingDigest=${held.bindingDigest}&sha256=${sha256(markdown)}`]) {
      const refused = await f.get(path, {authorization: "Bearer stranger"});
      expect(refused.status, path).toBe(429);
      expect(await refused.json()).toMatchObject({code: "held_read_busy"});
    }
    expect(asked, "the host read nothing for them").toEqual([scope.workspaceId, "workspace-3"]);
    // A caller who doesn't own the workspace learns nothing about the budget.
    expect((await f.get(artifact(scope.workspaceId), {authorization: "Bearer editor"})).status).toBe(404);
    // The details hold no body, so they are still answered.
    const details = await f.get(other, {authorization: "Bearer stranger"});
    expect(details.status).toBe(200);
    await details.json();
    for (const response of answered) await response.body!.cancel();
  });

  /** A response whose client takes a write only when the test drains it, as node:http reports one. */
  class SlowResponse extends EventEmitter {
    destroyed = false;
    writableFinished = false;
    written = 0;
    write(chunk: Uint8Array): boolean {this.written += chunk.length; return false;}
    end(): void {this.writableFinished = true;}
    destroy(): this {this.destroyed = true; queueMicrotask(() => this.emit("close")); return this;}
  }
  const sending = (response: Response) => {
    const outgoing = new SlowResponse();
    return {outgoing, piping: pipeResponseBody(response, outgoing as unknown as ServerResponse)};
  };

  it("free an unread body's slot and bytes after the drain timeout, and a slow body's at the send deadline", async () => {
    const {answered, strangers, large} = await fullBudget();
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    try {
      // Both clients read the headers, then take nothing.
      const stalled = answered.map(sending);
      await vi.waitFor(() => {for (const {outgoing} of stalled) expect(outgoing.written).toBeGreaterThan(0);});
      expect((await strangers()).status, "the budget is full").toBe(429);
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);
      expect(stalled.map(({outgoing}) => outgoing.destroyed)).toEqual([true, true]);
      await Promise.all(stalled.map(({piping}) => piping));
      const slow = await strangers();
      expect(slow.status, "their slots and bytes are free").toBe(200);

      // This client takes a view every 30 s, never slow enough for the drain timeout.
      const {outgoing, piping} = sending(slow);
      const step = 30_000;
      for (let elapsed = step; elapsed < heldBodySendDeadlineMs(large.length); elapsed += step) {
        await vi.advanceTimersByTimeAsync(step);
        outgoing.emit("drain");
      }
      expect((await strangers()).status, "its slot holds until the deadline").toBe(429);
      await vi.advanceTimersByTimeAsync(step);
      const again = await strangers();
      expect(again.status, "the deadline frees it").toBe(200);
      outgoing.emit("drain");
      await piping;
      expect(outgoing.destroyed, "the unfinished body fails").toBe(true);
      expect(outgoing.written).toBeLessThan(large.length);
      await again.body!.cancel();
    } finally {vi.useRealTimers();}
  });
});

describe("streamed held document Markdown", () => {
  const streamedOut: HeldDocumentInspection = {...preserved, preservation: {...preserved.preservation!, markdown: null}};

  it("restores the text the engine streamed in place of the in-band text", () => {
    expect(withStreamedMarkdown(streamedOut, blob(Buffer.from(markdown)))).toEqual(preserved);
  });

  it("refuses a stream that is missing or not the text the result names", () => {
    expect(() => withStreamedMarkdown(streamedOut, undefined)).toThrow();
    expect(() => withStreamedMarkdown(streamedOut, blob(Buffer.from(markdown + "x")))).toThrow();
    const swapped = Buffer.from(markdown);
    swapped[swapped.length - 1] = 0x21;
    expect(() => withStreamedMarkdown(streamedOut, blob(swapped))).toThrow();
    expect(() => withStreamedMarkdown(streamedOut, blob(Buffer.from(markdown), {sha256: "e".repeat(64)})), "another SHA-256").toThrow();
    expect(() => withStreamedMarkdown(streamedOut, blob(Buffer.from(markdown), {totalBytes: 1})), "another length").toThrow();
  });

  it("leaves inspections without streamed text as they are", () => {
    expect(withStreamedMarkdown(inspection, undefined)).toBe(inspection);
    expect(withStreamedMarkdown(preserved, undefined)).toBe(preserved);
  });
});

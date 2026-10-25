import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  VERSIONED_METHOD,
  YDOC_METHOD,
  YdocOwnerDraftPendingError,
  openEngineYdocProviderSession,
  type EngineTransport,
  type Event,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  VersionedLoopbackEngine,
  YdocLoopbackEngine,
} from "@dohc/workspace-engine-client/testing";
import {
  createEngineYDocSaveSeqState,
  noteLocalEdit,
  noteSettleOutcome,
  noteSettleStart,
} from "./engineYDocSaveSeq";
import {
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import {
  createWorkspaceEngineCapture,
  isYDocPathNotInVersionError,
  YDocPathNotInVersionError,
  YDocUncapturedArtifactError,
} from "./workspaceEngineCapture";
import { workspaceSyncPauseStatus } from "@dohc/workspace-contracts/workspace-sync";
import { createWorkspaceSyncStop } from "./stopWorkspaceSync";
import { createRegistryStore } from "./registryStore";
import { createTestScratch } from "./testTemp";
import { createEngineYDocSessionIpc, DOCUMENT_EDIT_SHARED_WARNING } from "./engineYDocSessionIpc";
import { CHANNELS } from "../ipc/channels";
import { documentEditUpdate, documentMarkdown } from "@dohc/ydoc-projection";
import {
  createFakeDaemonCapture,
  type FakeDaemonCapture,
} from "../testing/fakeDaemonCapture";
import { daemonCaptureLifecycleAnswer } from "../testing/liveEngineSessions";
import { desktopRecordEditContext } from "./desktopRecordEdits";
import { deleteWorkspacePathByHand } from "./workspaceFileMoves";
import { EngineYDocSessionOwner } from "./engineYDocSessionOwner";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { setCollectionRecordFields } from "@dohc/automation-executor/collection-record-edits";
import { WILL_QUIT_BUDGET_MS } from "../shutdownBudgets";
import { bindEngineYDoc, EngineYDocDeliveryRefusedError, type EngineYDocTransport } from "../renderer/collab/engineYDocProvider";
import { flushTypingCheckpoints } from "./outageTypingRecovery";
import { openedLocalState } from "../testing/preparedLocalState";

const WORKSPACE_ID = "engine-ydoc-session-test";
const ATTACHMENT_ID = Symbol("test-workspace-attachment");
const PATH = "notes/solo.md";
const INITIAL_MARKDOWN = "# Solo\n\nStart here.\n";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});
// Reads one `lstat` of `path`, then holds its answer until the test releases it.
const lstatGate = vi.hoisted(() => ({ held: null as { path: string; entered: () => void; release: Promise<void> } | null }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const lstat: typeof fs.lstat = (async (path: Parameters<typeof fs.lstat>[0], ...rest: unknown[]) => {
    const held = lstatGate.held;
    const answer = (fs.lstat as (...args: unknown[]) => ReturnType<typeof fs.lstat>)(path, ...rest);
    if (held && String(path) === held.path) {
      lstatGate.held = null;
      await answer.catch(() => undefined);
      held.entered();
      await held.release;
    }
    return await answer;
  }) as typeof fs.lstat;
  return { ...fs, lstat };
});

let root = "";
// Milliseconds the loopback daemon takes to answer one journal RPC. A busy
// machine is what makes the session's update queue back up behind the settle
// debounce; this is that machine, made deterministic.
let recordUpdateDelayMs = 0;
let requests: Request[] = [];
// Armed by a test to make the next ydoc.settle requests refuse. The loopback
// engine cannot refuse a settle, and it should not learn to: this is what the
// DAEMON does — reject the request over the wire — so it belongs at the
// transport, where the real client turns the envelope into the refusal the
// close path reads.
let settleRefusal: unknown = null;
let claimedLineage = false;
let blockedMaterialization = false;
// The same, for the RELEASE. The daemon refuses a local-only prune-close with
// `unsettled-close` when the CRDT projection no longer matches
// `last_settled_sha` (crates/dohc-engine-collab/src/durable.rs) and reinserts
// the session entry, so the doc stays reserved.
let closeRefusal: unknown = null;
let beforeRecordUpdate: (() => Promise<void>) | null = null;
let beforeClose: (() => Promise<void>) | null = null;
let beforeSettle: (() => Promise<void>) | null = null;
let enforceRecordOwner = false;
// Refuses the next journal write once, the way the daemon refuses it on the
// wire, then lets later writes (the adapter's recovery included) through.
let nextRecordRefusal: unknown = null;
let nextOpenRefusal: unknown = null;
let busyRecordAttempts = 0;
// Records the next journal write, then loses its answer with the connection;
// the resync that recovery sends next is lost the same way.
let loseNextRecordAnswer = false;
let loseNextResync = false;
// The claim a claimed lineage answers under. A restore gives it another one.
let servedClaim = "owner-claim";
// Resyncs counted from zero, and which of them lose their answer.
let resyncCount = 0;
let lostResyncs = new Set<number>();
let heldResync: { at: number; entered: PromiseWithResolvers<void>; release: Promise<void> } | null = null;
function transportLost(): Error {
  return Object.assign(new Error("The engine client is closed: transport closed."), {
    code: "transport-error",
  });
}
let captureErrors: string[] = [];
let versioned: VersionedLoopbackEngine;
let ydoc: YdocLoopbackEngine;
// The daemon's disk side: ingests the folder on `capture.flush`, rewrites it
// on a version switch, and skips a path while a `ydoc.open` lease holds it.
let daemon: FakeDaemonCapture;
let sessions: EngineWorkspaceSessions;
let capture: ReturnType<typeof createWorkspaceEngineCapture>;

function daemonSessions(): EngineWorkspaceSessions {
  const client: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    get helloAck() {
      return ydoc.helloAck;
    },
    onBlob(handler) {
      return ydoc.onBlob(handler);
    },
    onEvent(handler: (event: Event) => void) {
      return ydoc.onEvent(handler);
    },
    async sendRequest(request: Request): Promise<Response> {
      requests.push(request);
      if (request.method === YDOC_METHOD.recordUpdate && beforeRecordUpdate) {
        const hook = beforeRecordUpdate;
        beforeRecordUpdate = null;
        await hook();
      }
      if (request.method === YDOC_METHOD.close && beforeClose) {
        const hook = beforeClose;
        beforeClose = null;
        await hook();
      }
      const params = request.params as Record<string, JsonValue | undefined>;
      // The packaged daemon refuses a second owner. The generic loopback
      // also supports replica tests, so enforce that rule for record writes.
      if (enforceRecordOwner && request.method === YDOC_METHOD.open &&
          [...daemon.leases.values()].includes(String(params.path))) {
        throw wireRefusal("ydoc-session-busy");
      }
      if (request.method === "workspace.open") {
        return {
          id: request.id,
          result: { workspace: String(params.workspaceId) },
        };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      if (request.method === YDOC_METHOD.settle && beforeSettle) {
        const hook = beforeSettle;
        beforeSettle = null;
        await hook();
      }
      if (request.method === "ydoc.settle" && settleRefusal !== null) {
        throw settleRefusal;
      }
      if (claimedLineage && request.method === YDOC_METHOD.close && params.settle === true && settleRefusal !== null) {
        throw settleRefusal;
      }
      if (request.method === "ydoc.close" && closeRefusal !== null) {
        throw closeRefusal;
      }
      if (request.method === YDOC_METHOD.open && nextOpenRefusal !== null) {
        const refusal = nextOpenRefusal;
        nextOpenRefusal = null;
        throw refusal;
      }
      if (request.method === YDOC_METHOD.recordUpdate && busyRecordAttempts > 0) {
        busyRecordAttempts -= 1;
        throw wireRefusal("engine-store-busy", "OVERLOADED");
      }
      if (
        request.method === YDOC_METHOD.recordUpdate &&
        nextRecordRefusal !== null
      ) {
        const refusal = nextRecordRefusal;
        nextRecordRefusal = null;
        throw refusal;
      }
      if (request.method === YDOC_METHOD.resync && loseNextResync) {
        loseNextResync = false;
        throw transportLost();
      }
      if (request.method === YDOC_METHOD.resync) {
        const count = ++resyncCount;
        if (lostResyncs.has(count)) throw transportLost();
        if (heldResync?.at === count) {
          heldResync.entered.resolve();
          await heldResync.release;
        }
      }
      if (request.method === YDOC_METHOD.recordUpdate && loseNextRecordAnswer) {
        loseNextRecordAnswer = false;
        await ydoc.sendRequest(request);
        throw transportLost();
      }
      if (
        recordUpdateDelayMs > 0 &&
        request.method === YDOC_METHOD.recordUpdate
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, recordUpdateDelayMs),
        );
      }
      // A claimed lineage is this fixture's; the loopback keeps no claims. It
      // refuses an edit made against any other claim, as the engine does.
      if (claimedLineage && request.method === YDOC_METHOD.recordUpdate &&
          params.expectedLineageClaimId !== servedClaim) {
        throw wireRefusal("ydoc-lineage-stale");
      }
      const answered = await daemon.sendRequest(
        claimedLineage && request.method === YDOC_METHOD.recordUpdate
          ? { ...request, params: { ...params, expectedLineageClaimId: null } }
          : request,
      );
      if (answered) {
        if (claimedLineage && (request.method === YDOC_METHOD.open || request.method === YDOC_METHOD.resync || request.method === YDOC_METHOD.recordUpdate)) {
          return { ...answered, result: { ...(answered.result as Record<string, JsonValue>),
            lineageClaimId: servedClaim, lineageOriginatedHere: true } };
        }
        if (request.method === YDOC_METHOD.settle && blockedMaterialization) {
          return { ...answered, result: { ...(answered.result as Record<string, JsonValue>), materialized: false } };
        }
        return answered;
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await versioned.sendRequest(request);
    },
  };
  return new EngineWorkspaceSessions({ currentClient: () => client });
}

function seedYdoc(versionId: string, content = INITIAL_MARKDOWN): void {
  ydoc.seedFile({
    workspace: WORKSPACE_ID,
    versionId,
    path: PATH,
    content,
    contentKind: "richdoc",
  });
}

function mirrorEditor(
  session: Awaited<ReturnType<typeof capture.openYDocSession>>,
): Y.Doc {
  const doc = new Y.Doc();
  const remoteOrigin = Symbol("renderer-remote");
  Y.applyUpdate(doc, session.initialUpdate, remoteOrigin);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== remoteOrigin) session.applyLocalUpdate(update);
  });
  return doc;
}

function typeIntoBody(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    const body = new Y.XmlText();
    body.insert(0, text);
    paragraph.insert(0, [body]);
    const fragment = doc.getXmlFragment("body");
    fragment.insert(fragment.length, [paragraph]);
  });
}

function methodCount(method: string): number {
  return requests.filter((request) => request.method === method).length;
}

// Writes the daemon's own capture made into its store. They never cross the
// desktop transport, so `requests` cannot see them.
function daemonWriteCount(): number {
  return versioned.requests.filter(
    (request) => request.method === VERSIONED_METHOD.textWrite,
  ).length;
}


// The envelope EngineClient rejects a refused request with. DaemonLiveAdapter
// re-throws it as DaemonRefusalError, which is the shape the close path's
// discriminator reads; a bare Error never reaches that path.
function wireRefusal(
  message: string,
  code: "INVALID_PARAMS" | "INTERNAL" | "OVERLOADED" = "INVALID_PARAMS",
): Error {
  return Object.assign(new Error(message), {
    wireError: { code, message, retry: code === "OVERLOADED" ? "afterBackoff" : "no" },
  });
}

beforeEach(async () => {
  root = await createTestScratch("dohc-engine-ydoc-session-");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, PATH), INITIAL_MARKDOWN, "utf8");
  requests = [];
  settleRefusal = null;
  claimedLineage = false;
  blockedMaterialization = false;
  closeRefusal = null;
  beforeRecordUpdate = null;
  beforeClose = null;
  beforeSettle = null;
  enforceRecordOwner = false;
  nextRecordRefusal = null;
  nextOpenRefusal = null;
  busyRecordAttempts = 0;
  loseNextRecordAnswer = false;
  loseNextResync = false;
  servedClaim = "owner-claim";
  resyncCount = 0;
  lostResyncs = new Set();
  heldResync = null;
  captureErrors = [];
  recordUpdateDelayMs = 0;
  versioned = new VersionedLoopbackEngine();
  versioned.seedTextFile({
    workspace: WORKSPACE_ID,
    versionId: "main",
    path: PATH,
    text: INITIAL_MARKDOWN,
  });
  // The daemon materializes a settle to the workspace file itself, and the
  // desktop no longer mirrors settled bytes over a file that holds something
  // else. A loopback that reports `materialized: true` while writing
  // nothing would leave every file below unchanged, so it materializes too.
  ydoc = new YdocLoopbackEngine({
    projectRichdoc: doc => documentMarkdown(Y.encodeStateAsUpdate(doc)),
    materialize: ({ path, content }) => {
      if (!blockedMaterialization) writeFileSync(join(root, path), content, "utf8");
    },
  });
  seedYdoc("main");
  daemon = createFakeDaemonCapture({
    rootPath: root,
    workspaceId: WORKSPACE_ID,
    loopback: versioned,
    ydoc,
  });
  sessions = daemonSessions();
  capture = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    attachmentId: ATTACHMENT_ID,
    rustEngineSessions: sessions,
    onError: (context) => captureErrors.push(context),
  });
});

afterEach(async () => {
  await capture?.stop().catch(() => undefined);
  await sessions?.closeAll().catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
});

const recordAutomation = {
  kind: "automation", automationId: "collection:tasks#finish", onBehalfOf: "person", depth: 1,
  run: { claimId: "finish-run", automationName: "Finish" },
} as const;

// Main's record edit context for the person main read when the write was requested.
function recordContext(personId = "person") {
  return desktopRecordEditContext({
    capture, workspaceRoot: root, signal: new AbortController().signal,
    person: { kind: "human", humanId: personId },
    withAdapter: async () => null, onCaptureSettled: () => () => undefined,
  });
}

function writeFinished(expectedBefore: Record<string, unknown> = { "Finished on": null }) {
  enforceRecordOwner = true;
  return setCollectionRecordFields(recordContext(), {
    recordPath: PATH, fields: { "Finished on": "2026-10-01" },
    expectedBefore, author: recordAutomation, idempotencyKeyPrefix: "finish-run/set",
  });
}

it("settles and digests an automation record once before closing it", async () => {
  const context = recordContext();
  await setCollectionRecordFields({ ...context, async openRecord(path) {
    const session = await context.openRecord(path);
    // The open-time drift check is separate from settlement verification.
    vi.mocked(createReadStream).mockClear();
    return session;
  } }, { recordPath: PATH, fields: { "Finished on": "2026-10-01" }, author: recordAutomation });
  expect(methodCount(YDOC_METHOD.settle)).toBe(1);
  expect(methodCount(YDOC_METHOD.close)).toBe(1);
  expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => path === join(root, PATH))).toHaveLength(1);
  expect(await readFile(join(root, PATH), "utf8")).toContain("2026-10-01");
});

it("settles and digests later editor changes when closing after an automation write", async () => {
  const { owner, editor } = await openRecordEditor();
  vi.mocked(createReadStream).mockClear();
  await writeFinished();
  expect(methodCount(YDOC_METHOD.settle)).toBe(1);
  typeIntoBody(editor, "Changed after the automation settled.");
  await owner.close();
  expect(methodCount(YDOC_METHOD.settle)).toBe(2);
  expect(vi.mocked(createReadStream).mock.calls.filter(([path]) => path === join(root, PATH))).toHaveLength(2);
  expect(await readFile(join(root, PATH), "utf8")).toContain("Changed after the automation settled.");
  editor.destroy();
});

it.each(["delayed notice", "pending resync", "unchanged"] as const)("settles replicated lineage on close with %s", async mode => {
  let suppressRemote = false;
  const resyncEntered = Promise.withResolvers<void>();
  const finishResync = Promise.withResolvers<void>();
  const onSettled = vi.fn();
  const teardownEntered = Promise.withResolvers<void>();
  const finishTeardown = Promise.withResolvers<void>();
  let holdJournal = false;
  const transport: EngineTransport = {
    get helloAck() { return ydoc.helloAck; },
    onBlob: handler => ydoc.onBlob(handler),
    onEvent: handler => ydoc.onEvent(event => {
      if (!suppressRemote) handler(event);
    }),
    async sendRequest(request) {
      if (request.method === YDOC_METHOD.recordUpdate && holdJournal) {
        teardownEntered.resolve();
        await finishTeardown.promise;
      }
      if (request.method === YDOC_METHOD.resync && mode === "pending resync") {
        resyncEntered.resolve();
        await finishResync.promise;
      }
      if (request.method === YDOC_METHOD.recordUpdate) {
        // The claim is this fixture's; the loopback keeps none.
        const params = request.params as Record<string, JsonValue>;
        if (params.expectedLineageClaimId !== "owner-claim") throw wireRefusal("ydoc-lineage-stale");
        const response = await ydoc.sendRequest({ ...request, params: { ...params, expectedLineageClaimId: null } });
        return { ...response, result: { ...(response.result as Record<string, JsonValue>),
          lineageClaimId: "owner-claim", lineageOriginatedHere: true } };
      }
      const response = await ydoc.sendRequest(request);
      if (request.method === YDOC_METHOD.open || request.method === YDOC_METHOD.resync) {
        return { ...response, result: { ...(response.result as Record<string, JsonValue>),
          lineageClaimId: "owner-claim", lineageOriginatedHere: true } };
      }
      return response;
    },
  };
  const provider = await openEngineYdocProviderSession({
    transport, workspace: WORKSPACE_ID, versionId: "main", path: PATH,
    contentKind: "richdoc", onRemoteUpdate: () => undefined,
    scheduleSettle: () => () => undefined, onSettled,
  });
  await provider.settleNow();
  expect(provider.lineageClaimId).toBe("owner-claim");
  const sessionId = provider.nativeOwner!.sessionId;
  ydoc.markSessionReplicated(sessionId);
  if (mode !== "unchanged") {
    suppressRemote = true;
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(provider.doc));
    typeIntoBody(remote, "Frame only the engine has seen.");
    ydoc.applyRemoteUpdate(sessionId, Y.encodeStateAsUpdate(remote));
    remote.destroy();
    suppressRemote = false;
    expect(documentMarkdown(Y.encodeStateAsUpdate(provider.doc))).not.toContain("Frame only the engine has seen.");
    expect(await readFile(join(root, PATH), "utf8")).not.toContain("Frame only the engine has seen.");
    if (mode === "pending resync") {
      holdJournal = true;
      // A duplicate update queues a journal without invalidating verified bytes.
      void provider.applyLocalUpdate(Y.encodeStateAsUpdate(provider.doc), { armSettle: false });
      await teardownEntered.promise;
    }
  }
  const closing = provider.close();
  if (mode === "pending resync") {
    // close has unsubscribed its provider observers and is draining the journal.
    ydoc.emitEvent({ name: "ydoc.remoteUpdate", seq: 1000, sessionGeneration: 1,
      payload: { sessionId, resyncRequired: true } });
    finishTeardown.resolve();
    await resyncEntered.promise;
  }
  finishResync.resolve();
  await closing;
  expect(await readFile(join(root, PATH), "utf8")).toContain(
    mode === "unchanged" ? "Start here." : "Frame only the engine has seen.",
  );
  expect(onSettled).toHaveBeenCalledTimes(mode === "pending resync" ? 2 : 1);
  expect(ydoc.activeSessionIds()).toHaveLength(0);
  const closes = ydoc.requests.filter(request => request.method === YDOC_METHOD.close);
  expect(closes).toHaveLength(1);
  expect(closes[0]!.params).toMatchObject({ settle: false });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function openRecordEditor(assertRecordWritable?: () => void) {
  const editor = new Y.Doc();
  const remoteOrigin = Symbol("record-remote");
  const owner = await capture.openYDocSession({ path: PATH, contentKind: "richdoc",
    assertRecordWritable,
    onRemoteUpdate: update => Y.applyUpdate(editor, update, remoteOrigin),
  });
  Y.applyUpdate(editor, owner.initialUpdate, remoteOrigin);
  editor.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== remoteOrigin) owner.applyLocalUpdate(update);
  });
  return { owner, editor };
}

it("writes automation fields through an open session and updates its editor once", async () => {
  const { owner, editor } = await openRecordEditor();
  const before = ydoc.recordedUpdates.length;
  await expect(writeFinished()).resolves.toMatchObject({ replaced: { "Finished on": null } });
  expect(owner.doc.getMap("frontmatter").get("Finished on")).toBe("2026-10-01");
  expect(editor.getMap("frontmatter").get("Finished on")).toBe("2026-10-01");
  expect(methodCount(YDOC_METHOD.open)).toBe(1);
  expect(methodCount(YDOC_METHOD.close)).toBe(0);
  expect(ydoc.recordedUpdates).toHaveLength(before + 1);
  const fieldRequest = requests.filter(request => request.method === YDOC_METHOD.recordUpdate).at(-1);
  expect(fieldRequest?.params).toMatchObject({ actorOriginId: recordAutomation.automationId,
    attribution: { actorKind: "automation", onBehalfOf: "person", depth: 1, run: recordAutomation.run },
  });
  expect(fieldRequest?.idempotencyKey).toBe("finish-run/set/Finished on");
  await writeFinished();
  expect(ydoc.recordedUpdates).toHaveLength(before + 1);
  typeIntoBody(editor, "Still editable.");
  await owner.settleNow();
  expect(await readFile(join(root, PATH), "utf8")).toContain("Still editable.");
  await owner.close();
  editor.destroy();
});

it.each(["borrowed", "opened"])("names the person who asked for a %s record write, and an automation's run person", async mode => {
  const opened = mode === "borrowed" ? await openRecordEditor() : null;
  const context = recordContext("account-alice");
  await expect(setCollectionRecordFields(context, {
    recordPath: PATH, fields: { Owner: "Alice" }, author: createLocalChangeAuthor("Alice"),
  })).resolves.toMatchObject({ replaced: { Owner: null } });
  // A run Bob's synced edit started works for Bob, whoever is signed in here.
  await expect(setCollectionRecordFields(context, {
    recordPath: PATH, fields: { "Finished on": "2026-10-01" }, author: { ...recordAutomation, onBehalfOf: "bob" },
  })).resolves.toMatchObject({ replaced: { "Finished on": null } });
  // A closed record reopens with a seed, which names nobody, before each write.
  const fieldWrites = requests.filter(request => request.method === YDOC_METHOD.recordUpdate &&
    (request.params as { seed?: boolean }).seed !== true).slice(-2);
  // A generated key still names each write, so a refusal reaches only its caller.
  for (const request of fieldWrites) expect(request.idempotencyKey).toEqual(expect.any(String));
  const params = (request: Request) => request.params as { actorOriginId?: string; attribution?: unknown };
  expect(fieldWrites.map(request => ({ actorOriginId: params(request).actorOriginId, attribution: params(request).attribution }))).toEqual([
    { actorOriginId: "account-alice", attribution: { actorKind: "human", onBehalfOf: "account-alice", depth: 0 } },
    { actorOriginId: recordAutomation.automationId,
      attribution: { actorKind: "automation", onBehalfOf: "bob", depth: 1, run: recordAutomation.run } },
  ]);
  if (opened) {
    expect(opened.editor.getMap("frontmatter").get("Owner")).toBe("Alice");
    await opened.owner.close();
    opened.editor.destroy();
  }
});

it.each(["update-too-large", "pending-edits-limit"])("refuses an unkeyed agent write without losing queued typing (%s)", async refusal => {
  const { owner, editor } = await openRecordEditor();
  const entered = deferred();
  const release = deferred();
  beforeRecordUpdate = async () => { entered.resolve(); await release.promise; };
  nextRecordRefusal = wireRefusal(refusal);
  const write = setCollectionRecordFields(recordContext(), { recordPath: PATH, fields: { "Finished on": "2026-10-01" },
    author: { kind: "agent", agentId: "cli-agent", onBehalfOf: "person", depth: 1 } });
  const refused = expect(write).rejects.toThrow(refusal);
  await entered.promise;
  typeIntoBody(editor, "Typing queued behind the refused agent write.");
  release.resolve();
  await refused;
  await owner.settleNow();
  expect(editor.getMap("frontmatter").get("Finished on")).toBeUndefined();
  expect(documentMarkdown(Y.encodeStateAsUpdate(owner.doc))).toContain("Typing queued behind the refused agent write.");
  expect(captureErrors).toEqual([]);
  expect(await readFile(join(root, PATH), "utf8")).toContain("Typing queued behind the refused agent write.");
  await owner.close(); editor.destroy();
});

it("refuses a borrowed record write during an owner handoff and permits retry", async () => {
  let held = false;
  const { owner, editor } = await openRecordEditor(() => {
    if (held) throw new Error("Owner handoff active. Try again.");
  });
  const borrow = await capture.openRecordSession(PATH);
  held = true;
  const decide = vi.fn(() => null);
  await expect(borrow.applyDecidedLocalUpdate(decide, () => {}, {})).rejects.toThrow("Try again");
  expect(decide).not.toHaveBeenCalled();
  await borrow.close();
  held = false;
  await writeFinished();
  expect(editor.getMap("frontmatter").get("Finished on")).toBe("2026-10-01");
  await owner.close(); editor.destroy();
});

it("keeps typing concurrent with an automation write and waits before owner teardown", async () => {
  const { owner, editor } = await openRecordEditor();
  const entered = deferred();
  const release = deferred();
  beforeRecordUpdate = async () => { entered.resolve(); await release.promise; };
  const write = writeFinished();
  await entered.promise;
  typeIntoBody(editor, "Typed during the field write.");
  const close = owner.close();
  release.resolve();
  await write;
  await close;
  const markdown = await readFile(join(root, PATH), "utf8");
  expect(markdown).toContain("Typed during the field write.");
  expect(markdown).toContain("2026-10-01");
  expect(editor.getMap("frontmatter").get("Finished on")).toBe("2026-10-01");
  expect(ydoc.recordedUpdates).toHaveLength(3);
  const typing = requests.filter(request => request.method === YDOC_METHOD.recordUpdate).at(-1);
  expect(typing?.params).not.toHaveProperty("actorOriginId");
  expect(typing?.params).not.toHaveProperty("attribution");
  editor.destroy();
});

it("finishes a borrowed record write before a capture-chain teardown sweep", async () => {
  const { editor } = await openRecordEditor();
  const entered = deferred();
  const release = deferred();
  beforeRecordUpdate = async () => { entered.resolve(); await release.promise; };
  const write = writeFinished();
  await entered.promise;
  typeIntoBody(editor, "Typed before the lifecycle sweep.");
  const sweep = capture.settleAndCloseLiveSessionsForPath(PATH);
  release.resolve();
  await write;
  const finishRemoval = await sweep;
  finishRemoval(false);
  const markdown = await readFile(join(root, PATH), "utf8");
  expect(markdown).toContain("Typed before the lifecycle sweep.");
  expect(markdown).toContain("2026-10-01");
  expect(methodCount(YDOC_METHOD.close)).toBe(1);
  expect(ydoc.recordedUpdates).toHaveLength(3);
  editor.destroy();
});

it("keeps typing and attribution when a borrowed keyed write meets a busy store", async () => {
  const { owner, editor } = await openRecordEditor();
  const entered = deferred();
  const release = deferred();
  beforeRecordUpdate = async () => { entered.resolve(); await release.promise; };
  nextRecordRefusal = wireRefusal("engine-store-busy", "OVERLOADED");
  const write = writeFinished();
  await entered.promise;
  typeIntoBody(editor, "Typed while the keyed write recovered.");
  release.resolve();
  await write;
  await owner.settleNow();
  expect(editor.getMap("frontmatter").get("Finished on")).toBe("2026-10-01");
  expect(documentMarkdown(Y.encodeStateAsUpdate(owner.doc))).toContain("Typed while the keyed write recovered.");
  const fieldWrites = requests.filter(request => request.idempotencyKey === "finish-run/set/Finished on");
  expect(fieldWrites.length).toBeGreaterThan(1);
  for (const request of fieldWrites) {
    expect(request.params).toMatchObject({ actorOriginId: recordAutomation.automationId,
      attribution: { actorKind: "automation", onBehalfOf: "person", depth: 1, run: recordAutomation.run },
    });
  }
  expect(ydoc.recordedUpdates).toHaveLength(3);
  await owner.close();
  expect(await readFile(join(root, PATH), "utf8")).toContain("Typed while the keyed write recovered.");
  editor.destroy();
});

it("keeps the open editor's changes when a borrowed write's key is refused", async () => {
  const { owner, editor } = await openRecordEditor();
  await writeFinished();
  editor.getMap("frontmatter").set("Finished on", "2026-09-30");
  typeIntoBody(editor, "Kept after the key refusal.");
  await expect(writeFinished({ "Finished on": "2026-09-30" })).rejects.toThrow("idempotency-key-reuse-mismatch");
  expect(owner.doc.getMap("frontmatter").get("Finished on")).toBe("2026-09-30");
  expect(editor.getMap("frontmatter").get("Finished on")).toBe("2026-09-30");
  expect(ydoc.recordedUpdates).toHaveLength(4);
  typeIntoBody(editor, "Still editable after recovery.");
  await owner.settleNow();
  const markdown = await readFile(join(root, PATH), "utf8");
  expect(markdown).toContain("Kept after the key refusal.");
  expect(markdown).toContain("Still editable after recovery.");
  expect(markdown).toContain("2026-09-30");
  await owner.close();
  editor.destroy();
});

it("checks expected-before against the open session instead of the settled artifact", async () => {
  const owner = await capture.openYDocSession({ path: PATH, contentKind: "richdoc", onRemoteUpdate: () => undefined });
  const editor = mirrorEditor(owner);
  editor.getMap("frontmatter").set("Finished on", "2026-09-30");
  const result = await writeFinished();
  expect(result).toMatchObject({ replaced: {}, kept: { "Finished on": "2026-09-30" } });
  expect(owner.doc.getMap("frontmatter").get("Finished on")).toBe("2026-09-30");
  await owner.close();
  editor.destroy();
});

it("refuses a record write truthfully while its owner is tearing down, then permits retry", async () => {
  const owner = await capture.openYDocSession({ path: PATH, contentKind: "richdoc", onRemoteUpdate: () => undefined });
  const entered = deferred();
  const release = deferred();
  beforeClose = async () => { entered.resolve(); await release.promise; };
  const close = owner.close();
  await entered.promise;
  try {
    await expect(writeFinished()).rejects.toThrow("The record is closing. Try again after it closes.");
    expect(methodCount(YDOC_METHOD.open)).toBe(1);
  } finally {
    release.resolve();
    await close;
  }
  await expect(writeFinished()).resolves.toMatchObject({ replaced: { "Finished on": null } });
});

it("keeps the closed-record open, journal, settle and close path", async () => {
  await expect(writeFinished()).resolves.toMatchObject({ replaced: { "Finished on": null } });
  expect(methodCount(YDOC_METHOD.open)).toBe(1);
  expect(methodCount(YDOC_METHOD.close)).toBe(1);
  expect(ydoc.recordedUpdates).toHaveLength(2);
  expect(await readFile(join(root, PATH), "utf8")).toContain("2026-10-01");
});

it("settles an open record before a person's delete and credits the person in History", async () => {
  await mkdir(join(root, ".dohc"), { recursive: true });
  await openedLocalState({ workspaceId: "record-delete", rootPath: root });
  const { editor } = await openRecordEditor();
  typeIntoBody(editor, "Typed before the delete.");
  let trashedText = "";
  const trashed: Array<{ target: string; requestsBefore: number }> = [];
  await expect(deleteWorkspacePathByHand(
    { workspace: { workspaceId: "record-delete", rootPath: root }, assertCurrent: () => undefined }, PATH,
    { kind: "human", humanId: "person" },
    { capture, requestId: "hand-delete", markDeleted: () => undefined,
      trashItem: async target => {
        trashed.push({ target, requestsBefore: requests.length });
        trashedText = await readFile(target, "utf8");
        await rm(target);
      } },
  )).resolves.toMatchObject({ trashed: true, operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true } });
  // The system trash takes it from its own place, so its Restore returns it there.
  expect(trashed.map(entry => entry.target)).toEqual([join(root, PATH)]);
  const methods = requests.map(request => request.method);
  // Settled and closed, then trashed, then recorded as deleted.
  expect(methods.lastIndexOf(YDOC_METHOD.close)).toBeLessThan(trashed[0]!.requestsBefore);
  expect(methods.indexOf(VERSIONED_METHOD.textDelete)).toBeGreaterThanOrEqual(trashed[0]!.requestsBefore);
  // The trash holds the settled document, not the artifact from before the typing.
  expect(trashedText).toContain("Typed before the delete.");
  const deleted = (await capture.listMoments()).moments.filter(row => row.operation === "delete" && row.path === PATH);
  expect(deleted).toMatchObject([{ metadata: { origin: "local-file" }, authors: [{ kind: "human", humanId: "person" }] }]);
  editor.destroy();
});

it("settles live edits into Markdown before stopping sync and permits local editing afterward", async () => {
  const remote = { serverUrl: "https://server.test", ownerUserId: "owner" };
  const credentials = { serverUrl: remote.serverUrl, userId: "owner", email: "owner@test", token: "token" };
  const registry = createRegistryStore(join(root, "registry.json"));
  registry.register({ workspaceId: WORKSPACE_ID, rootPath: root, kind: "personal", mode: "local-first", remote });
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed immediately before stopping sync.");
  const closeRelay = vi.fn(async () => {
    const settledMarkdown = await readFile(join(root, PATH), "utf8");
    expect(settledMarkdown).toContain("Typed immediately before stopping sync.");
    // The loopback's file map must observe the artifact written by settlement.
    seedYdoc("main", settledMarkdown);
    expect(daemon.leases.size).toBe(0);
    expect(registry.find(WORKSPACE_ID)?.remote).toBeUndefined();
    await sessions.closeWorkspace({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: ATTACHMENT_ID });
  });
  const stop = createWorkspaceSyncStop({
    person: async () => ({ kind: "person", personId: "local" }), cleanupFailed: vi.fn(), reopenFailed: vi.fn(),
    pauseStatus: pause => workspaceSyncPauseStatus(pause, "local"),
    withOwnerHostPaused: work => work(), prepare: () => capture.settleAndCloseLiveSessionsForSyncPause(), resume: async () => {},
    pauseRemote: (id, pause) => registry.pauseRemote(id, pause), closeActivity: async () => {
      await expect(capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined })).rejects.toThrow();
      await capture.settleAndCloseAllLiveSessions();
      await capture.stop();
    }, closeRelay,
    openActivity: async () => {
      capture = createWorkspaceEngineCapture({ workspaceId: WORKSPACE_ID, rootPath: root,
        attachmentId: ATTACHMENT_ID, rustEngineSessions: sessions, onError: context => captureErrors.push(context) });
    }, collectionsWaiting: async () => false, notify: () => {},
    status: () => ({ state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null,
      historyRecordingUnavailable: false, historyShareView: false, liveSessionsGeneration: 1,
      ...(registry.find(WORKSPACE_ID)?.syncPause ? { syncPause: workspaceSyncPauseStatus(registry.find(WORKSPACE_ID)!.syncPause!, "local") } : {}) }),
  });
  await expect(stop({ workspace: registry.find(WORKSPACE_ID)!, assertCurrent: () => {} })).resolves.toMatchObject({ workspaceSynced: false, syncPause: { author: { kind: "person", personId: "local", self: true } } });
  expect(registry.find(WORKSPACE_ID)?.syncPause?.author).toEqual({ kind: "person", personId: "local" });
  expect(closeRelay).toHaveBeenCalledOnce();
  const methods = requests.map(request => request.method);
  expect(methods.indexOf(YDOC_METHOD.settle)).toBeLessThan(methods.indexOf(YDOC_METHOD.close));
  const local = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  const localEditor = mirrorEditor(local);
  typeIntoBody(localEditor, "Edited after stopping sync.");
  await local.settleNow();
  const localText = await readFile(join(root, PATH), "utf8");
  expect(localText).toContain("Edited after stopping sync.");
  expect(localText).toContain("Typed immediately before stopping sync.");
  await local.close(); editor.destroy(); localEditor.destroy();
});

it("keeps unsettled live edits available when stopping sync cannot settle them", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Do not drop this unsettled edit.");
  settleRefusal = wireRefusal("persist-failed", "INTERNAL");
  await expect(capture.settleAndCloseLiveSessionsForSyncPause()).rejects.toThrow();
  expect(methodCount(YDOC_METHOD.close)).toBe(0);
  settleRefusal = null;
  const resumeAdmission = await capture.settleAndCloseLiveSessionsForSyncPause();
  expect(await readFile(join(root, PATH), "utf8")).toContain("Do not drop this unsettled edit.");
  await expect(capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined })).rejects.toThrow();
  resumeAdmission();
  const local = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  await local.close(); editor.destroy();
});

it("journals a live editor update through the Rust Y.Doc provider and suppresses its mirror write", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const editor = mirrorEditor(session);

  typeIntoBody(editor, "Typed with no collaboration server.");
  await session.settleNow();

  // 2, not 1: the head-present open's own seed (`INITIAL_MARKDOWN`) now
  // journals through a real recordUpdate ahead of this typed edit's
  // (#721/#728, `ydoc_open_state_on_store`'s `seedContent`).
  expect(ydoc.recordedUpdates).toHaveLength(2);
  expect(await readFile(join(root, PATH), "utf8")).toContain(
    "Typed with no collaboration server.",
  );
  const writesBeforeWatcher = daemonWriteCount();

  capture.observeFileEvents([{ path: PATH, operation: "update" }]);
  await capture.flush();

  expect(daemonWriteCount()).toBe(writesBeforeWatcher);
  await session.close({ settle: false });
});

it("decides a local update at its turn, against the canonical doc as it stands then", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const seen: unknown[] = [];
  const skipped = session.applyDecidedLocalUpdate((doc) => {
    seen.push(doc.getMap("frontmatter").get("Note"));
    return null;
  });
  // A remote update lands on the canonical doc before that update's turn.
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.doc));
  remote.getMap("frontmatter").set("Note", "theirs");
  Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(session.doc)));
  await expect(skipped).resolves.toBe(false);
  expect(seen).toEqual(["theirs"]);

  const journaledBefore = ydoc.recordedUpdates.length;
  const written = session.applyDecidedLocalUpdate((doc) => {
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(scratch);
    scratch.getMap("frontmatter").set("Note", "mine");
    return Y.encodeStateAsUpdate(scratch, before);
  });
  await expect(written).resolves.toBe(true);
  await session.settleNow();
  expect(ydoc.recordedUpdates.length).toBe(journaledBefore + 1);
  expect(session.doc.getMap("frontmatter").get("Note")).toBe("mine");
  await session.close({ settle: false });
});

it("refuses a new live session before it can recreate a path inside a removal window", async () => {
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath(PATH);
  await rm(join(root, PATH));
  const opensBeforeRace = methodCount(YDOC_METHOD.open);
  const settlesBeforeRace = methodCount(YDOC_METHOD.settle);

  const raced = await capture
    .openYDocSession({
      path: PATH,
      onRemoteUpdate: () => undefined,
    })
    .then(
      (session) => ({ kind: "opened" as const, session }),
      (error: unknown) => ({ kind: "refused" as const, error }),
    );
  if (raced.kind === "opened") {
    const editor = mirrorEditor(raced.session);
    typeIntoBody(editor, "Typed while delete was on disk.");
    await raced.session.settleNow().catch(() => undefined);
  }

  await expect(readFile(join(root, PATH), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(raced.kind).toBe("refused");
  if (raced.kind === "refused") {
    expect(raced.error).toMatchObject({
      name: "YDocRemovalInProgressError",
      code: "removal-in-progress",
      workspacePath: PATH,
    });
  }
  expect(methodCount(YDOC_METHOD.open)).toBe(opensBeforeRace);
  expect(methodCount(YDOC_METHOD.settle)).toBe(settlesBeforeRace);
  finishDelete(true);
});

it("keeps a completed delete absent after a live-session race and closes its removal window", async () => {
  const first = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const editor = mirrorEditor(first);
  typeIntoBody(editor, "Typed before delete.");
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath(PATH);
  await rm(join(root, PATH));
  const settlesAfterVacate = methodCount(YDOC_METHOD.settle);

  const raced = await capture
    .openYDocSession({
      path: PATH,
      onRemoteUpdate: () => undefined,
    })
    .then(
      (session) => ({ kind: "opened" as const, session }),
      (error: unknown) => ({ kind: "refused" as const, error }),
    );
  if (raced.kind === "opened") {
    const racedEditor = mirrorEditor(raced.session);
    typeIntoBody(racedEditor, "Typed during delete.");
    await raced.session.settleNow().catch(() => undefined);
  }
  finishDelete(true);

  await expect(readFile(join(root, PATH), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(raced.kind).toBe("refused");
  expect(methodCount(YDOC_METHOD.settle)).toBe(settlesAfterVacate);

  // A successful open after the finisher proves the removal window closed.
  await writeFile(join(root, PATH), "", "utf8");
  const reopened = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  await reopened.close({ settle: false });
});

it("settles and closes the Rust Y.Doc session before a version switch", async () => {
  const draft = await capture.createVersion("Draft");
  seedYdoc(draft.activeVersionId);
  requests = [];

  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Unsaved draft edit.");

  await capture.switchVersion("main");

  const methods = requests.map((request) => request.method);
  const settleIndex = methods.indexOf("ydoc.settle");
  const closeIndex = methods.indexOf("ydoc.close");
  const switchIndex = methods.indexOf(VERSIONED_METHOD.versionsSetActive);
  expect(settleIndex).toBeGreaterThan(-1);
  expect(closeIndex).toBeGreaterThan(settleIndex);
  expect(switchIndex).toBeGreaterThan(closeIndex);
  expect(await readFile(join(root, PATH), "utf8")).toBe(INITIAL_MARKDOWN);

  await capture.switchVersion(draft.activeVersionId);
  expect(await readFile(join(root, PATH), "utf8")).toContain(
    "Unsaved draft edit.",
  );
  await session.close();
});

it("releases a verified local-only save without settling over an outside write", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH, onRemoteUpdate: () => undefined,
    onSaveState: state => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];
  vi.mocked(createReadStream).mockClear();
  const outside = "# Solo\n\nEdited in another app.\n";
  await writeFile(join(root, PATH), outside, "utf8");
  await expect(session.close()).resolves.toBeUndefined();
  expect(methodCount(YDOC_METHOD.settle)).toBe(1);
  expect(methodCount(YDOC_METHOD.close)).toBe(1);
  expect(daemon.leases.size).toBe(0);
  expect(states).toEqual([]);
  expect(captureErrors).toEqual([]);
  expect(vi.mocked(createReadStream)).not.toHaveBeenCalled();
  expect(await readFile(join(root, PATH), "utf8")).toBe(outside);
  const writesBeforeWatcher = daemonWriteCount();
  capture.observeFileEvents([{ path: PATH, operation: "update" }]);
  await capture.flush();
  expect(daemonWriteCount()).toBeGreaterThan(writesBeforeWatcher);
  expect(await readFile(join(root, PATH), "utf8")).toBe(outside);
  editor.destroy();
});

it("releases a verified synced document and reports changed-on-disk after a terminal close settle refusal", async () => {
  claimedLineage = true;
  const states: string[] = [];
  const tokens: number[] = [];
  const session = await capture.openYDocSession({
    path: PATH, onRemoteUpdate: () => undefined,
    onSaveState: (state, token) => { states.push(state); tokens.push(token); },
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  ydoc.markSessionReplicated(ydoc.activeSessionIds()[0]!);
  states.length = 0;
  tokens.length = 0;
  captureErrors = [];
  const outside = "# Solo\n\nEdited in another app.\n";
  await writeFile(join(root, PATH), outside, "utf8");
  // Daemon capture can move the durable head while the desktop lease is live.
  await versioned.sendRequest({ id: 5_000_001, workspace: WORKSPACE_ID, method: VERSIONED_METHOD.textWrite,
    params: { versionId: "main", path: PATH, text: outside, origin: "local-file" } });
  settleRefusal = wireRefusal("conflict-stale-target");
  await expect(session.close()).resolves.toBeUndefined();
  expect(states).toEqual(["settling", "error", "changed-on-disk"]);
  expect(tokens[0]).toBeGreaterThan(0);
  expect(tokens).toEqual([tokens[0], tokens[0], tokens[0]]);
  expect(methodCount(YDOC_METHOD.settle)).toBe(2);
  expect(requests.filter(request => request.method === YDOC_METHOD.close).map(request => request.params)).toEqual([
    expect.objectContaining({ settle: false }),
  ]);
  expect(ydoc.activeSessionIds()).toHaveLength(0);
  expect(daemon.leases.size).toBe(0);
  expect(await readFile(join(root, PATH), "utf8")).toBe(outside);
  settleRefusal = null;
  const writesBefore = daemonWriteCount();
  await writeFile(join(root, PATH), "# Solo\n\nAnother outside edit.\n", "utf8");
  capture.observeFileEvents([{ path: PATH, operation: "update" }]);
  await capture.flush();
  expect(daemonWriteCount()).toBeGreaterThan(writesBefore);
  editor.destroy();
});

it.each(["persist-failed", "blocked target"] as const)("releases a verified synced document and reports %s at close", async failure => {
  claimedLineage = true;
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH, onRemoteUpdate: () => undefined,
    onSaveState: state => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  ydoc.markSessionReplicated(ydoc.activeSessionIds()[0]!);
  states.length = 0;
  captureErrors = [];
  if (failure === "persist-failed") settleRefusal = wireRefusal(failure, "INTERNAL");
  else blockedMaterialization = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);
  expect(states).toEqual(["settling", "error"]);
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
  expect(ydoc.activeSessionIds()).toHaveLength(0);
  expect(daemon.leases.size).toBe(0);
  expect(requests.filter(request => request.method === YDOC_METHOD.close)).toHaveLength(1);
  expect(requests.find(request => request.method === YDOC_METHOD.close)!.params).toMatchObject({ settle: false });
  editor.destroy();
});

// The daemon's own capture ingests an edit made outside dohc, which
// moves the path's head; the close-settle that follows meets that moved head
// and the engine refuses ConflictStaleTarget. The RELEASE then succeeds, which
// is what makes the refusal benign: the outside author's file is intact, and a
// release that prunes proves this document's text is a settled moment in
// History. So the close must end as quiet as the close that wins the race.
it("closes clean and reports changed-on-disk when the close settle meets a moved head", async () => {
  const states: string[] = [];
  const tokens: number[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state, token) => {
      states.push(state);
      tokens.push(token);
    },
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  // Flush first, so the debounced settle cannot fire against the refusal
  // armed below and make this a NON-close settle failure by accident.
  await session.settleNow();
  states.length = 0;
  tokens.length = 0;
  captureErrors = [];

  // The outside writer, on disk. The refusal alone does not make this state
  // true — `changed-on-disk` says the FILE is not this document's, so the file
  // has to actually hold someone else's bytes for the close to say it.
  await writeFile(join(root, PATH), "# Solo\n\nEdited in another app.\n", "utf8");
  settleRefusal = wireRefusal("conflict-stale-target");
  await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
  states.length = 0;
  tokens.length = 0;
  captureErrors = [];
  await expect(session.close()).resolves.toBeUndefined();

  // The refusal is reported the moment it happens and WITHDRAWN once the
  // release proves it benign. The editor's last word is what it acts on.
  expect(states).toEqual(["settling", "error", "changed-on-disk"]);
  expect(tokens[0]).toBeGreaterThan(0);
  expect(tokens).toEqual([tokens[0], tokens[0], tokens[0]]);
  // The daemon session was released exactly as a clean close releases it.
  expect(methodCount("ydoc.close")).toBe(1);

  // And the path's lease lifted with it: the daemon captures the next disk
  // edit instead of deferring it behind a session it still holds.
  settleRefusal = null;
  const writesBeforeWatcher = daemonWriteCount();
  await writeFile(join(root, PATH), "# Solo\n\nWritten outside dohc.\n", "utf8");
  capture.observeFileEvents([{ path: PATH, operation: "update" }]);
  await capture.flush();
  expect(daemonWriteCount()).toBeGreaterThan(writesBeforeWatcher);
});

// dohc#2366. History holds all of the document, so a close over its deleted
// file has nothing to save. A settle would be refused and read as a failed save.
it.each(["local-only", "synced"] as const)(
  "releases a %s document with nothing new over a file deleted outside dohc, without a save",
  async (regime) => {
    claimedLineage = regime === "synced";
    const states: string[] = [];
    const session = await capture.openYDocSession({
      path: PATH, onRemoteUpdate: () => undefined, onSaveState: state => states.push(state),
    });
    if (regime === "synced") ydoc.markSessionReplicated(ydoc.activeSessionIds()[0]!);
    states.length = 0;
    await rm(join(root, PATH));
    settleRefusal = wireRefusal("conflict-stale-target");
    await expect(session.close()).resolves.toBeUndefined();
    expect(states).toEqual([]);
    expect(captureErrors).toEqual([]);
    expect(methodCount(YDOC_METHOD.settle)).toBe(0);
    expect(requests.filter(request => request.method === YDOC_METHOD.close).map(request => request.params)).toEqual([
      expect.objectContaining({ settle: false }),
    ]);
    expect(daemon.leases.size).toBe(0);
  },
);

// A synced engine releases over unsettled text, so an edit made while the
// close reads the disk must keep the ordinary close and its failed save.
async function captureKeepingDrafts(): Promise<string[]> {
  const drafts: string[] = [];
  await capture.stop();
  capture = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: ATTACHMENT_ID, rustEngineSessions: sessions,
    onError: (context) => captureErrors.push(context),
    preserveUnsentState: async ({ doc }) => { drafts.push(documentMarkdown(Y.encodeStateAsUpdate(doc))); return "draft"; },
    discardUnsentState: async () => undefined,
  });
  return drafts;
}

it("keeps a synced document's edit made while its close checks the deleted file", async () => {
  claimedLineage = true;
  const drafts = await captureKeepingDrafts();
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH, onRemoteUpdate: () => undefined, onSaveState: state => states.push(state),
  });
  ydoc.markSessionReplicated(ydoc.activeSessionIds()[0]!);
  const editor = mirrorEditor(session);
  states.length = 0;
  await rm(join(root, PATH));
  settleRefusal = wireRefusal("conflict-stale-target");
  const checking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  lstatGate.held = { path: join(root, PATH), entered: checking.resolve, release: release.promise };
  const closing = session.close();
  await checking.promise;
  typeIntoBody(editor, "Typed during the close.");
  release.resolve();
  await expect(closing).rejects.toThrow(/released, but its pre-close settle failed/);
  expect(states).toEqual(["settling", "error"]);
  expect(methodCount(YDOC_METHOD.settle)).toBe(1);
  await vi.waitFor(() => expect(drafts).toEqual([expect.stringContaining("Typed during the close.")]));
  editor.destroy();
});

// The close can wait behind other work on the session after its disk check.
// A peer update counted there must still keep the ordinary close.
it("keeps a peer update that arrives while a synced document's close waits its turn", async () => {
  claimedLineage = true;
  const drafts = await captureKeepingDrafts();
  const states: string[] = [];
  const delivered = Promise.withResolvers<void>();
  const session = await capture.openYDocSession({
    path: PATH, onRemoteUpdate: () => delivered.resolve(), onSaveState: state => states.push(state),
  });
  const sessionId = ydoc.activeSessionIds()[0]!;
  ydoc.markSessionReplicated(sessionId);
  const peer = new Y.Doc();
  Y.applyUpdate(peer, session.initialUpdate);
  const before = Y.encodeStateVector(peer);
  typeIntoBody(peer, "From a peer.");
  await rm(join(root, PATH));
  settleRefusal = wireRefusal("conflict-stale-target");

  // Other work holds the session: a settle the engine has not answered yet.
  const settling = Promise.withResolvers<void>();
  const answerSettle = Promise.withResolvers<void>();
  beforeSettle = async () => { settling.resolve(); await answerSettle.promise; };
  const earlierSettle = session.settleNow().catch(() => undefined);
  await settling.promise;

  // The close finds the file gone and queues behind that settle.
  const checked = Promise.withResolvers<void>();
  const answerCheck = Promise.withResolvers<void>();
  lstatGate.held = { path: join(root, PATH), entered: checked.resolve, release: answerCheck.promise };
  const closing = session.close();
  await checked.promise;
  answerCheck.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  ydoc.applyRemoteUpdate(sessionId, Y.encodeStateAsUpdate(peer, before));
  await delivered.promise;
  answerSettle.resolve();
  await earlierSettle;
  await expect(closing).rejects.toThrow(/released, but its pre-close settle failed/);
  expect(methodCount(YDOC_METHOD.settle)).toBe(2);
  expect(states.at(-1)).toBe("error");
  await vi.waitFor(() => expect(drafts.at(-1)).toContain("From a peer."));
  peer.destroy();
});

// The engine refuses that release while it holds text History lacks. Then the
// ordinary close runs, and its refused settle is the failed save it reports.
it("closes as before when the engine refuses to release a deleted file's document without a save", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH, onRemoteUpdate: () => undefined, onSaveState: state => states.push(state),
  });
  states.length = 0;
  await rm(join(root, PATH));
  settleRefusal = wireRefusal("conflict-stale-target");
  beforeClose = async () => { throw wireRefusal("ydoc-unsettled-close"); };
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);
  expect(states).toEqual(["settling", "error"]);
  expect(methodCount(YDOC_METHOD.settle)).toBe(1);
  expect(methodCount(YDOC_METHOD.close)).toBe(2);
  expect(daemon.leases.size).toBe(0);
});

// The narrowness guard for the downgrade above. Any other refusal means the
// user's edits did not reach the engine, which is what the thrown settle
// failure and the retryable `error` state exist to say.
it("still throws when an ordinary settle failure fails the close", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  settleRefusal = wireRefusal("persist-failed", "INTERNAL");
  await expect(session.settleNow()).rejects.toThrow("persist-failed");
  states.length = 0;
  captureErrors = [];
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  expect(states.at(-1)).toBe("error");
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
});

// The other half of the narrowness: the same refusal outside a close keeps
// reporting `error`. That document stays open, so its retry advice is real.
it("still reports an error for a stale-target settle while the document stays open", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  settleRefusal = wireRefusal("conflict-stale-target");
  await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");

  expect(states.at(-1)).toBe("error");
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
  settleRefusal = null;
  await session.close({ settle: false });
});

// The transient lock gets its own state: the engine keeps the write
// durably pending and the provider retries by itself, so "error"'s advice
// (try another edit) would be noise and "saved" a lie about the disk. The
// surface needs to know which one it is showing.
it("reports file-locked, not error, for a lock refusal", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  settleRefusal = wireRefusal("file-locked", "OVERLOADED");
  await expect(session.settleNow()).rejects.toThrow("file-locked");

  expect(states).toContain("file-locked");
  expect(states).not.toContain("error");
  // Still loud in the log: the retry does not replace the report.
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
  settleRefusal = null;
  await session.close({ settle: false });
});

it.each([
  [0, "active", 1, "saved-to-host"],
  [0, null, 1, "saved-to-host"],
  [1, "active", 1, "pending-share"],
  [0, "active", 0, "pending-share"],
  [0, "quarantined", 1, "pending-share"],
  [0, "sealed", 1, "pending-share"],
] as const)("reports owner pending=%s state=%s cursor=%s as %s", async (pendingBytes, state, acceptedCursor, expected) => {
  const states: string[] = [];
  const session = await capture.openYDocSession({path: PATH, onRemoteUpdate: () => undefined, onSaveState: value => states.push(value)});
  settleRefusal = new YdocOwnerDraftPendingError({
    binding: {workspaceId: WORKSPACE_ID, mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64), currentPath: PATH, selectorPaths: [PATH], restoreFenceGeneration: 0},
    relayDatabaseNamespace: "relay", revision: 1, acceptedCursor, nativeHeadSequence: 1, nativeUnsettled: false,
    outboxId: state === null ? null : "outbox", pendingBytes, state,
  });
  await expect(session.settleNow()).rejects.toBe(settleRefusal);
  expect(states.at(-1)).toBe(expected);
  expect(captureErrors).not.toContain(`ydoc settle of ${PATH}`);
  settleRefusal = null;
  await session.close({settle: false});
});

// A close reads the disk before its first retry, so real I/O gets a turn
// between steps of the faked retry delays.
const realSetImmediate = setImmediate;
async function expectBusyBudgetFailure(operation: () => Promise<unknown>, message: string | RegExp = "engine-store-busy") {
  vi.useFakeTimers();
  try {
    let settled = false;
    const assertion = expect(operation().finally(() => { settled = true; })).rejects.toThrow(message);
    // 200 steps of 100 ms: twice the 10 s busy budget.
    for (let step = 0; !settled; step += 1) {
      if (step === 200) throw new Error("The busy-store operation did not finish within 20 s of faked retry delays.");
      await new Promise((resolve) => realSetImmediate(resolve));
      await vi.advanceTimersByTimeAsync(100);
    }
    await assertion;
  } finally { vi.useRealTimers(); }
}

// The other busy thing needs the other answer. A busy engine database
// is dohc's own writers meeting inside SQLite: nothing of the user's is held,
// nobody can act, and the provider retries by itself. So the surface stays
// quiet and keeps saying what is true — dohc is still saving. `file-locked`
// copy would name a program that does not exist, and "Couldn't save" would
// report a failure that has not happened.
it("stays on settling for a busy engine store, because the retry is coming", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  settleRefusal = wireRefusal("engine-store-busy", "OVERLOADED");
  await expectBusyBudgetFailure(() => session.settleNow());

  expect(states.at(-1)).toBe("settling");
  expect(states).not.toContain("error");
  expect(states).not.toContain("file-locked");
  // Still loud in the log: staying quiet on the chip is not going quiet.
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
  settleRefusal = null;
  await session.close({ settle: false });
});

it("retires capture settle bookkeeping after repeated busy-store failures", async () => {
  const reports: Array<{ state: string; token: number; event: string }> = [];
  const saveSeq = createEngineYDocSaveSeqState();
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state, token, event) => {
      reports.push({ state, token, event });
      if (event === "start") noteSettleStart(saveSeq, token);
      else if (event === "outcome") noteSettleOutcome(saveSeq, token);
    },
  });
  const ledgers = new Set<Map<unknown, unknown>>();
  const mapSet = Map.prototype.set;
  // Observe the private generation/token ledgers without exposing capture
  // internals. Every completed settle must retire its entry in each ledger.
  const setSpy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>, key: unknown, value: unknown,
  ) {
    if (typeof key === "string" && /^1:\d+$/.test(key)) ledgers.add(this);
    return mapSet.call(this, key, value);
  });
  try {
    settleRefusal = wireRefusal("engine-store-busy", "OVERLOADED");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expectBusyBudgetFailure(() => session.settleNow());
      expect.soft([...saveSeq.inFlight.keys()]).toEqual([]);
    }
    expect(reports).toEqual([
      { state: "saved", token: 0, event: "status" },
      { state: "settling", token: 1, event: "start" }, { state: "settling", token: 1, event: "outcome" },
      { state: "settling", token: 2, event: "start" }, { state: "settling", token: 2, event: "outcome" },
      { state: "settling", token: 3, event: "start" }, { state: "settling", token: 3, event: "outcome" },
    ]);
    expect(ledgers.size).toBeGreaterThan(0);
    expect([...ledgers].map((ledger) => ledger.size)).toEqual(
      [...ledgers].map(() => 0),
    );
  } finally {
    setSpy.mockRestore();
    settleRefusal = null;
    await session.close({ settle: false });
  }
});

// A close is no longer the exception it once was. It used to release the
// session and leave nothing to retry, so a busy pre-close settle really did
// end the save. Now a teardown that meets a transient blocker either keeps
// the session — when the engine is still missing text, so the close ladder
// retries it — or releases only once the engine has the text and hands the
// artifact to the detached debt. Here the journal landed and only the settle
// was refused, so it takes the second path: the session goes, the debt owns
// the write, and `settling` is what is true of the document.
it("keeps saying settling when a busy store fails a close's settle", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  settleRefusal = wireRefusal("engine-store-busy", "OVERLOADED");
  await expectBusyBudgetFailure(() => session.settleNow());
  states.length = 0;
  captureErrors = [];
  await expectBusyBudgetFailure(() => session.close(), /released, but its pre-close settle failed/);

  // A retry is coming, so no word but `settling` is honest — and `error`
  // would send the user to try another edit for a database that is merely
  // busy.
  expect(states.at(-1)).toBe("settling");
  expect(states).not.toContain("error");
  // Still loud in the log: staying quiet on the chip is not going quiet.
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
});

// `changed-on-disk` promises the file is not this document's. The refusal does
// not prove that: the engine raises ConflictStaleTarget for any divergence of
// the head — a path rebound to another object, or a settle whose
// materialization was blocked or superseded — and in those the durable head
// moved while the disk still holds our own settled bytes.
it("keeps the close loud when the file still holds this document's bytes", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  // No outside writer: the file is left exactly as the settle wrote it.
  settleRefusal = wireRefusal("conflict-stale-target");
  await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
  states.length = 0;
  captureErrors = [];
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  expect(states).toEqual(["settling", "error"]);
});

// A RELEASE is not proof of settlement, and this is the lineage that shows it.
// `close_session` checks `last_settled_sha` only before a local-only prune; a
// replicated lineage — any doc in a synced workspace, promoted by `claim_base`
// on the first pulled `ydoc.update` — compacts instead and never prunes, so its
// release succeeds with the typed text still unsettled
// (crates/dohc-engine-collab/src/durable.rs). Staged here by letting the
// release succeed while the close-settle refuses, which is exactly what that
// lineage does. Reporting `changed-on-disk` over it would send the user to a
// file and a History that hold their last save, not their last edit.
it("keeps the close loud when a released lineage never settled the edits", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  // Typed after the last settle: this text is in no moment.
  typeIntoBody(editor, "Typed again, never settled.");
  // And the outside writer, so the drift proof PASSES. Without it that proof
  // alone makes this close loud and the settled-coverage check below is never
  // the reason — the test would hold with the counter deleted.
  await writeFile(join(root, PATH), "# Solo\n\nEdited in another app.\n", "utf8");
  settleRefusal = wireRefusal("conflict-stale-target");
  // The release is left to succeed — the replicated close.
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  expect(states).toEqual(["settling", "error"]);
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
});

// The P1 the first version of #496 shipped: the refusal is not the outcome.
// With unsettled edits, the release that follows the refused close-settle
// refuses too — the projection no longer matches `last_settled_sha`, so the
// daemon refuses the prune and reinserts the session entry. The doc is still
// reserved, still live, and its text is not on disk. A close that reported
// "changed on disk" here would be telling the user to go read a file that does
// not hold their work, about a session nobody released.
it("keeps a stale-target close loud when the release fails too", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  settleRefusal = wireRefusal("conflict-stale-target");
  closeRefusal = wireRefusal("unsettled-close");
  await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
  states.length = 0;
  captureErrors = [];
  await expect(session.close()).rejects.toThrow(/unsettled-close/);

  // Loud, and it stays loud: no correction may follow a release that failed.
  expect(states).toEqual(["settling", "error"]);
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
  // And the path keeps its lease, because the reservation was never
  // released: the daemon defers the next disk edit behind the session.
  settleRefusal = null;
  closeRefusal = null;
  const writesBeforeWatcher = daemonWriteCount();
  await writeFile(join(root, PATH), "# Solo\n\nWritten outside dohc.\n", "utf8");
  capture.observeFileEvents([{ path: PATH, operation: "update" }]);
  await capture.flush();
  expect(daemonWriteCount()).toBe(writesBeforeWatcher);
});

// AUDIT-SILENTSAVE. The save indicator's whole job is to not lie, and
// the seq is how it keeps that promise: a settle may only vouch for edits it
// actually carried. This drives the same wiring main.ts's IPC handlers use —
// noteLocalEdit on the way in, noteSettleStart/noteSettleOutcome on the way
// out — against a daemon slow enough for the update queue to back up behind
// the settle debounce, which is what a loaded machine produces.
//
// Before the fix, main counted an edit when the IPC arrived rather than when
// the session handed it to the settle, so a settle carrying 3 of 12 edits
// reported all 12 and the editor read "Saved" over a third of the document.
it("never reports a save seq the settled file does not back", async () => {
  // Short enough that the queue cannot drain between settles; the delay below
  // makes every journal RPC outlast it.
  const settleDebounceMs = 5;
  recordUpdateDelayMs = 25;
  const honest = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    attachmentId: ATTACHMENT_ID,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) =>
      await openEngineYdocProviderSession({ ...options, settleDebounceMs }),
  });
  const saveSeq = createEngineYDocSaveSeqState();
  const vouched: Array<{ seq: number; markdown: string }> = [];
  const session = await honest.openYDocSession({
    path: PATH,
    contentKind: "richdoc",
    onRemoteUpdate: () => undefined,
    onSaveState: (state, token, event) => {
      if (event === "start") {
        noteSettleStart(saveSeq, token);
        return;
      }
      const seq = event === "outcome" ? noteSettleOutcome(saveSeq, token) : 0;
      if (state === "saved") {
        vouched.push({ seq, markdown: readFileSync(join(root, PATH), "utf8") });
      }
    },
  });

  // One edit per seq, each carrying its own marker, exactly as the renderer
  // ships them: a local Y.Doc update per transaction, counted on the way out.
  const editor = new Y.Doc();
  const remoteOrigin = Symbol("renderer-remote");
  Y.applyUpdate(editor, session.initialUpdate, remoteOrigin);
  let seq = 0;
  editor.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === remoteOrigin) return;
    seq += 1;
    const edited = seq;
    session.applyLocalUpdate(update, () => noteLocalEdit(saveSeq, edited));
  });
  const EDITS = 12;
  for (let at = 1; at <= EDITS; at += 1) typeIntoBody(editor, `EDIT-${at}.`);
  expect(seq).toBe(EDITS);

  await session.close();
  expect(vouched.length).toBeGreaterThan(1);

  // THE INVARIANT: whatever seq a save vouched for, the file it left behind
  // holds every edit up to that seq.
  for (const claim of vouched) {
    for (let at = 1; at <= claim.seq; at += 1) {
      expect(
        claim.markdown,
        `a save vouching for seq ${claim.seq} left a file without EDIT-${at}`,
      ).toContain(`EDIT-${at}.`);
    }
  }
  // And the last one covers the whole document — the indicator does reach
  // "Saved" rather than staying honest by never clearing.
  expect(vouched.at(-1)?.seq).toBe(EDITS);
  expect(await readFile(join(root, PATH), "utf8")).toContain(
    `EDIT-${EDITS}.`,
  );
  await honest.stop().catch(() => undefined);
});
// The absent-head contract stated on WorkspaceEngineCapture.openYDocSession.
//
// The daemon does not refuse an open for a path the entered version has no
// snapshot for: it derives an object id and binds an empty doc, which is the
// only reason a just-created file is editable before capture ingests it. Both
// halves of the contract are pinned here, because the guard is only correct if
// it separates them: refusing everything would break creation, and refusing
// nothing is the phantom file.
it("refuses a live session for a path the entered version does not have", async () => {
  // The interleaving, at the point it actually decides: the user clicked
  // draftOnly.md while switchVersion("main") was on the capture chain, so the
  // open runs after the switch — against a version with no snapshot for the
  // path, over a folder the switch already removed it from.
  const DRAFT_ONLY = "notes/draftOnly.md";

  const refusal = await capture
    .openYDocSession({
      path: DRAFT_ONLY,
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(refusal).toBeInstanceOf(YDocPathNotInVersionError);
  expect(isYDocPathNotInVersionError(refusal)).toBe(true);
  expect((refusal as YDocPathNotInVersionError).code).toBe("path-not-in-version");
  // The refusal names the file and the version it is not in.
  expect((refusal as Error).message).toContain(DRAFT_ONLY);
  // The daemon session the probe opened is released, not leaked: a retained
  // lease would refuse every later open of the same object as already-live.
  expect(methodCount("ydoc.close")).toBe(methodCount("ydoc.open"));
  // The whole point: nothing materialized. No phantom file in this version.
  await expect(readFile(join(root, DRAFT_ONLY), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["Reading notes.md", "notes/Trip plan.md"])("closes an untouched uncaptured file without settling (%s)", async path => {
  await writeFile(join(root, path), "", "utf8");
  const before = await readFile(join(root, path));
  const onSaveState = vi.fn();
  const session = await capture.openYDocSession({
    path,
    contentKind: "richdoc",
    onRemoteUpdate: () => undefined,
    onSaveState,
  });
  settleRefusal = wireRefusal("workspace operation failed");

  await expect(session.close()).resolves.toBeUndefined();

  expect(methodCount(YDOC_METHOD.settle)).toBe(0);
  expect(captureErrors).toEqual([]);
  expect(onSaveState.mock.calls.map(([state]) => state)).not.toContain("error");
  expect(await readFile(join(root, path))).toEqual(before);
  const reopened = await capture.openYDocSession({
    path,
    contentKind: "richdoc",
    onRemoteUpdate: () => undefined,
  });
  await expect(reopened.close()).resolves.toBeUndefined();
});

it("moves an untouched uncaptured file without settling", async () => {
  const path = "Reading notes.md";
  const destination = "notes/Trip plan.md";
  await writeFile(join(root, path), "", "utf8");
  await capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
  settleRefusal = wireRefusal("workspace operation failed");

  await capture.changePathsAs([path], {
    operation: "move",
    operationId: "dohc-operation:11111111-1111-4111-8111-111111111111",
    author: { kind: "human", humanId: "person" },
  }, async held => {
    await held.recordDisk(path, [path]);
    await rename(join(root, path), join(root, destination));
    await held.rename(path, destination);
  }, () => [path]);

  expect(methodCount(YDOC_METHOD.settle)).toBe(0);
  expect(methodCount(YDOC_METHOD.close)).toBe(1);
  expect(captureErrors).toEqual([]);
  expect(await readFile(join(root, destination), "utf8")).toBe("");
  await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
});

it("still opens a file the user just created that capture has not ingested", async () => {
  // Creation, verbatim: workspaceFiles.createFile writes the artifact to disk
  // with `wx` as an empty file and the editor opens it immediately. The version
  // has no snapshot yet (capture is asynchronous), so this open takes the same
  // absent-head branch the test above refuses. Only the artifact on disk
  // separates them.
  const CREATED = "notes/created.md";
  await writeFile(join(root, CREATED), "", "utf8");

  const session = await capture.openYDocSession({
    path: CREATED,
    contentKind: "richdoc",
    onRemoteUpdate: () => undefined,
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "First words in a brand new file.");
  await session.settleNow();

  expect(await readFile(join(root, CREATED), "utf8")).toContain(
    "First words in a brand new file.",
  );
  await session.close({ settle: false });
});

it("refuses an uncaptured artifact that has content, without calling it missing", async () => {
  // Head absent but the file is really on disk with bytes in it. The daemon
  // seeds an absent-head bind from the HEAD, so the doc comes up empty and the
  // first settle would erase the file. Refuse the session — but this is an
  // ordinary refusal: the file exists, so the caller keeps the plain editor and
  // must not tell the user the version does not have it.
  const UNCAPTURED = "notes/uncaptured.md";
  await writeFile(join(root, UNCAPTURED), "# Real content", "utf8");

  const refusal = await capture
    .openYDocSession({
      path: UNCAPTURED,
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(refusal).toBeInstanceOf(YDocUncapturedArtifactError);
  // The claim the user would see must not be made for a file that is right there.
  expect(isYDocPathNotInVersionError(refusal)).toBe(false);
  // The file the empty bind would have erased is untouched.
  expect(await readFile(join(root, UNCAPTURED), "utf8")).toBe("# Real content");
  expect(methodCount("ydoc.close")).toBe(methodCount("ydoc.open"));
});

// A crash between an edit and its settle leaves the edit only in the lineage,
// which `evict` stands in for here: it ends the session and writes nothing.
// `settle` first models a document whose edit reached the file before it
// closed.
async function retainLineage(
  edit: string | null,
  options: { path?: string; settle?: boolean } = {},
): Promise<void> {
  const previous = await openEngineYdocProviderSession({
    transport: ydoc, workspace: WORKSPACE_ID, versionId: "main", path: options.path ?? PATH,
    contentKind: "richdoc", onRemoteUpdate: () => undefined, scheduleSettle: () => () => undefined,
  });
  const editor = new Y.Doc();
  Y.applyUpdate(editor, previous.initialUpdate);
  const before = Y.encodeStateVector(editor);
  if (edit !== null) {
    typeIntoBody(editor, edit);
    await previous.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
  }
  if (options.settle) await previous.settleNow();
  await previous.evict();
  editor.destroy();
}

async function openRecordingStates(path = PATH) {
  const states: string[] = [];
  const saveSeq = createEngineYDocSaveSeqState();
  const events: Array<{ state: string; token: number; event: string }> = [];
  let reportSaved!: () => void;
  const saved = new Promise<void>((resolve) => { reportSaved = resolve; });
  const opened = await capture.openYDocSession({path, onRemoteUpdate: () => undefined,
    onSaveState: (state, token, event) => {
      states.push(state);
      events.push({ state, token, event });
      if (event === "start") noteSettleStart(saveSeq, token);
      else if (event === "outcome") noteSettleOutcome(saveSeq, token);
      if (state === "saved") reportSaved();
    }});
  return {opened, states, saved, saveSeq, events};
}

// A release that writes nothing, queued behind anything the open armed on the
// same session: a settle the open requested runs before it, so a count taken
// after it has seen that settle.
async function releaseWithoutSettling(
  session: Awaited<ReturnType<typeof capture.openYDocSession>>,
): Promise<void> {
  await session.close({ settle: false, settleOnRefusal: false }).catch(() => undefined);
}

it("writes nothing and reports the error when a retained document reopens over an outside edit", async () => {
  await retainLineage("Retained human edit.");
  await writeFile(join(root, PATH), "Outside edit.\n");
  const settlesBeforeOpen = methodCount("ydoc.settle");
  const {opened, states} = await openRecordingStates();
  expect(states).toEqual(["error"]);
  expect(opened.doc.getXmlFragment("body").toString()).toContain("Retained human edit.");
  await releaseWithoutSettling(opened);
  expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
  expect(await readFile(join(root, PATH), "utf8")).toBe("Outside edit.\n");
});

// The open seeds a fresh document from its file, so the file already has its
// text. Settling it would only cost a projection on every open.
it("settles nothing when a fresh document opens", async () => {
  const settlesBeforeOpen = methodCount("ydoc.settle");
  const {opened, states} = await openRecordingStates();
  await releaseWithoutSettling(opened);
  expect(states).toEqual(["saved"]);
  expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
});

// A synced workspace keeps every document's lineage after a clean close. Its
// reopen must not settle, or every open pays a projection and flashes Saving….
it("settles nothing when a document whose edits reached its file reopens", async () => {
  await retainLineage("Typed and saved.", { settle: true });
  expect(await readFile(join(root, PATH), "utf8")).toContain("Typed and saved.");
  // Capture records the settled file, as the engine's own settle does.
  capture.observeFileEvents([{ path: PATH, operation: "update" }]);
  await capture.flush();
  const settlesBeforeOpen = methodCount("ydoc.settle");
  const {opened, states} = await openRecordingStates();
  expect(opened.doc.getXmlFragment("body").toString()).toContain("Typed and saved.");
  await releaseWithoutSettling(opened);
  expect(states).toEqual(["saved"]);
  expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
});

it("settles nothing when a reopened document holds only its seed", async () => {
  await retainLineage(null);
  const settlesBeforeOpen = methodCount("ydoc.settle");
  const {opened, states} = await openRecordingStates();
  expect(opened.doc.getXmlFragment("body").toString()).toContain("Start here.");
  await releaseWithoutSettling(opened);
  expect(states).toEqual(["saved"]);
  expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
  expect(await readFile(join(root, PATH), "utf8")).toBe(INITIAL_MARKDOWN);
});

// edges-04: the document showed the retained edit as Saved while its file
// lacked it, and nothing wrote it until the next keystroke.
it("writes a retained edit when its document reopens, and says Saving… before the open returns", async () => {
  await retainLineage("Typed before the crash.");
  expect(await readFile(join(root, PATH), "utf8")).toBe(INITIAL_MARKDOWN);
  const {states, saved, saveSeq, events} = await openRecordingStates();
  // Reported on the open's own task, so main queues it ahead of the open's
  // answer and the editor never shows Saved first.
  expect(states[0]).toBe("settling");
  expect(states).not.toContain("saved");
  await saved;
  expect(events).toEqual([
    { state: "settling", token: 0, event: "status" },
    { state: "settling", token: 1, event: "start" },
    { state: "saved", token: 1, event: "outcome" },
  ]);
  expect([...saveSeq.inFlight.keys()]).toEqual([]);
  expect(states.filter((state) => state !== "settling")).toEqual(["saved"]);
  expect(await readFile(join(root, PATH), "utf8")).toContain("Typed before the crash.");
});

// Only the open is under test here. Startup capture reaching the empty file
// first, and folding it over the draft, is the capture-fold loss owned by
// #1232; nothing below covers it.
describe("a crash-kept draft of a file capture never recorded", () => {
  const DRAFT = "notes/draft.md";
  beforeEach(async () => {
    ydoc.seedFile({
      workspace: WORKSPACE_ID, versionId: "main", path: DRAFT, content: "",
      contentKind: "richdoc", head: "absent",
    });
    // New File leaves an empty file behind.
    await writeFile(join(root, DRAFT), "");
    await retainLineage("Typed into the new file.", { path: DRAFT });
  });

  it("writes the draft over the empty file New File left", async () => {
    const {states, saved} = await openRecordingStates(DRAFT);
    expect(states[0]).toBe("settling");
    expect(states).not.toContain("saved");
    await saved;
    expect(await readFile(join(root, DRAFT), "utf8")).toContain("Typed into the new file.");
  });

  it("says the draft is unsaved when its file is gone, and does not recreate it", async () => {
    await rm(join(root, DRAFT));
    const settlesBeforeOpen = methodCount("ydoc.settle");
    const {opened, states} = await openRecordingStates(DRAFT);
    expect(opened.doc.getXmlFragment("body").toString()).toContain("Typed into the new file.");
    await releaseWithoutSettling(opened);
    expect(states).toEqual(["error"]);
    expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
    await expect(readFile(join(root, DRAFT), "utf8")).rejects.toThrow();
  });
});

it("opens a crash-orphaned draft the daemon resurrects, head absent and all", async () => {
  // actor.rs keeps a never-settled local lineage alive: its CRDT rows are the
  // only copy of what the user typed before the crash, and the version has no
  // snapshot for the path. Refusing on `head` alone would strand those edits —
  // and the settle:false close of a dirty lineage is itself refused, wedging
  // the lease so the path could never be opened again.
  const ORPHANED = "notes/orphanedDraft.md";
  ydoc.seedFile({
    workspace: WORKSPACE_ID,
    versionId: "main",
    path: ORPHANED,
    content: "",
    contentKind: "richdoc",
    head: "absent",
  });
  const crashed = await openEngineYdocProviderSession({
    transport: ydoc,
    workspace: WORKSPACE_ID,
    versionId: "main",
    path: ORPHANED,
    contentKind: "richdoc",
    onRemoteUpdate: () => undefined,
    scheduleSettle: () => () => undefined,
  });
  // A head-absent open seeds nothing (there is no captured snapshot to seed
  // from — #721/#728), so the crash's own typed content has to arrive as a
  // real local edit, exactly as it would from a live editor.
  const crashEditor = new Y.Doc();
  Y.applyUpdate(crashEditor, crashed.initialUpdate);
  const beforeTyping = Y.encodeStateVector(crashEditor);
  typeIntoBody(crashEditor, "Typed before the crash.");
  await crashed.applyLocalUpdate(
    Y.encodeStateAsUpdate(crashEditor, beforeTyping),
  );
  const crashMarker = new Y.Doc();
  crashMarker.getMap("meta").set("crash-orphaned", true);
  await crashed.applyLocalUpdate(Y.encodeStateAsUpdate(crashMarker));
  await crashed.evict();

  const session = await capture.openYDocSession({
    path: ORPHANED,
    contentKind: "richdoc",
    onRemoteUpdate: () => undefined,
  });

  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, session.initialUpdate);
  expect(recovered.getXmlFragment("body").toString()).toContain(
    "Typed before the crash.",
  );
  await session.close({ settle: false });
});

it("merges an agent's edit with typing the editor had not sent yet, through a real provider", async () => {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    once() {
      return this;
    },
  };
  const workspace = { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: ATTACHMENT_ID };
  const ipc = createEngineYDocSessionIpc({
    localPersonId: () => "person-local",
    sessionFor: () => ({ workspaceId: WORKSPACE_ID, generation: 1, isCurrent: () => true }),
    acquireWorkspace: () => ({ workspace, assertCurrent: () => undefined, release: () => undefined }),
    captureFor: () => capture,
    ensureCaptureFor: async () => undefined,
    isSharedView: () => false,
    resolveDocumentPath: async (_workspace, path) => path,
    onError: (message) => captureErrors.push(message),
  });
  const opened = await ipc.open(sender, { workspaceId: WORKSPACE_ID, sessionId: "editor", path: PATH });
  if (!opened.available) throw new Error("The editor session did not open.");
  const editor = new Y.Doc();
  Y.applyUpdate(editor, opened.initialUpdate!);

  // The person types at the end of the paragraph. The editor holds the
  // update, as it does while its send batch is open.
  let typed: Uint8Array | null = null;
  editor.once("update", (update: Uint8Array) => {
    typed = update;
  });
  const paragraph = editor.getXmlFragment("body").get(1) as Y.XmlElement;
  const run = paragraph.get(0) as Y.XmlText;
  run.insert(run.length, " PERSON");

  // The agent edits that paragraph and adds a section, computed against the
  // provider's state, which does not have the typing yet.
  const origin = { actorOriginId: "claude-code", attribution: { actorKind: "agent" as const, onBehalfOf: "local", depth: 0 } };
  await expect(ipc.editDocument({
    workspaceId: WORKSPACE_ID,
    path: PATH,
    origin,
    assertEditable: async () => undefined,
    change: async (state, options) =>
      documentEditUpdate(state, { find: "Start here.", replacement: "Start over here.\n\n## Added" }, options),
  })).resolves.toEqual({ path: PATH, changed: true, warning: DOCUMENT_EDIT_SHARED_WARNING });

  // Now the editor sends its typing and takes the agent's edit.
  expect(ipc.applyUpdate(sender, { sessionId: "editor", update: typed!, seq: 1, lineageGeneration: 1, requestId: "11111111-1111-4111-8111-111111111111" }))
    .toEqual({ accepted: true });
  for (const { channel, payload } of sent) {
    if (channel === CHANNELS.engineYDocRemoteUpdate) {
      Y.applyUpdate(editor, (payload as { update: Uint8Array }).update);
    }
  }

  const expected = "# Solo\n\nStart over here. PERSON\n\n## Added";
  expect(documentMarkdown(Y.encodeStateAsUpdate(editor))).toBe(expected);
  await expect.poll(async () => {
    const read = await ipc.readDocument({ workspaceId: WORKSPACE_ID, path: PATH });
    return documentMarkdown(read.state!);
  }).toBe(expected);
  await ipc.close(sender, { sessionId: "editor" });
  expect(await readFile(join(root, PATH), "utf8")).toContain("Start over here. PERSON");
  // The engine journaled the agent's update under the agent's name.
  expect(requests.some((request) =>
    request.method === YDOC_METHOD.recordUpdate &&
    (request.params as { actorOriginId?: string }).actorOriginId === "claude-code")).toBe(true);
});

function keyedWrite(
  session: Awaited<ReturnType<typeof capture.openYDocSession>>,
  text: string,
  idempotencyKey = "claim/1/0",
): Promise<boolean> {
  return session.applyDecidedLocalUpdate(
    (doc) => {
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
      const before = Y.encodeStateVector(scratch);
      typeIntoBody(scratch, text);
      return Y.encodeStateAsUpdate(scratch, before);
    },
    undefined,
    { idempotencyKey },
  );
}

function journalMarkdown(): string {
  const journal = new Y.Doc();
  for (const update of ydoc.recordedUpdates) Y.applyUpdate(journal, update);
  return documentMarkdown(Y.encodeStateAsUpdate(journal));
}

it("refuses a reused idempotency key with other content, and none of that content lands", async () => {
  const notices = vi.fn();
  const replacements = vi.fn();
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onEditRefused: notices,
    onLineageReplaced: replacements,
  });
  await keyedWrite(session, "First attempt.");
  await session.settleNow();

  await Promise.all([
    expect(keyedWrite(session, "Changed retry.")).rejects.toThrow(
      "idempotency-key-reuse-mismatch",
    ),
    session.settleNow(),
  ]);

  expect(await readFile(join(root, PATH), "utf8")).not.toContain("Changed retry.");
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).not.toContain("Changed retry.");
  expect(journalMarkdown()).not.toContain("Changed retry.");
  expect(captureErrors).toEqual([]);
  expect(notices).not.toHaveBeenCalled();
  expect(replacements).not.toHaveBeenCalled();

  // The session still takes ordinary writes, and they land beside the first.
  session.applyLocalUpdate((() => {
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(session.doc));
    const before = Y.encodeStateVector(scratch);
    typeIntoBody(scratch, "Next edit.");
    return Y.encodeStateAsUpdate(scratch, before);
  })());
  await session.settleNow();
  const settled = await readFile(join(root, PATH), "utf8");
  expect(settled).toContain("First attempt.");
  expect(settled).toContain("Next edit.");
  expect(settled).not.toContain("Changed retry.");
  await session.close({ settle: false });
});

it("reports exactly one notice when local typing reuses a key with other content", async () => {
  const notices = vi.fn();
  const replacements = vi.fn();
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onEditRefused: notices,
    onLineageReplaced: replacements,
  });
  await keyedWrite(session, "First attempt.");
  await session.settleNow();

  const editor = new Y.Doc();
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(session.doc));
  const before = Y.encodeStateVector(editor);
  typeIntoBody(editor, "Refused typing.");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before), undefined, {
    idempotencyKey: "claim/1/0",
  });
  await session.settleNow();

  expect(captureErrors).toEqual([`Y.Doc local update of ${PATH}`]);
  expect(notices).toHaveBeenCalledTimes(1);
  expect(notices).toHaveBeenCalledWith("claim/1/0", expect.stringContaining("Use Save copy"));
  expect(replacements).toHaveBeenCalledTimes(1);
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).not.toContain("Refused typing.");
  expect(journalMarkdown()).not.toContain("Refused typing.");
  expect(await readFile(join(root, PATH), "utf8")).not.toContain("Refused typing.");
  await session.settleNow();
  await session.close({ settle: false });
  expect(captureErrors).toHaveLength(1);
  expect(notices).toHaveBeenCalledTimes(1);
  editor.destroy();
});

it("keeps typing queued in main when a keyed caller write is refused", async () => {
  const notices = vi.fn();
  const remoteOrigin = Symbol("renderer-remote");
  let editor = new Y.Doc();
  const replacements = vi.fn((update: Uint8Array) => {
    editor.destroy();
    editor = new Y.Doc();
    Y.applyUpdate(editor, update, remoteOrigin);
  });
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: update => Y.applyUpdate(editor, update, remoteOrigin),
    onEditRefused: notices,
    onLineageReplaced: replacements,
  });
  Y.applyUpdate(editor, session.initialUpdate, remoteOrigin);
  editor.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== remoteOrigin) session.applyLocalUpdate(update);
  });

  nextRecordRefusal = wireRefusal("attribution depth exceeds the supported chain bound");
  const refusedWrite = expect(keyedWrite(session, "Refused write.")).rejects.toThrow(
    "attribution depth exceeds the supported chain bound",
  );
  // The keyed write owns the next turn. Typing enters main's queue before
  // the refusal is answered, without depending on the caller's scratch doc.
  typeIntoBody(editor, "Queued typing.");
  await refusedWrite;
  await session.settleNow();

  for (const content of [
    documentMarkdown(Y.encodeStateAsUpdate(editor)),
    documentMarkdown(Y.encodeStateAsUpdate(session.doc)),
    journalMarkdown(),
    await readFile(join(root, PATH), "utf8"),
  ]) {
    expect(content).toContain("Queued typing.");
    expect(content).not.toContain("Refused write.");
  }
  expect(captureErrors).toEqual([]);
  expect(notices).not.toHaveBeenCalled();
  expect(replacements).not.toHaveBeenCalled();
  await session.close({ settle: false });
  editor.destroy();
});

it("refuses a reused key that a busy store first turned away, and never resends it without the key", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  await keyedWrite(session, "First attempt.");
  await session.settleNow();

  // The store is busy for the changed retry. The adapter's recovery then
  // resends it under the same key, and the key ledger refuses it.
  nextRecordRefusal = wireRefusal("engine-store-busy", "OVERLOADED");
  await expect(keyedWrite(session, "Changed retry.")).rejects.toThrow(
    "idempotency-key-reuse-mismatch",
  );
  await session.settleNow();
  await session.close();

  expect(journalMarkdown()).toContain("First attempt.");
  expect(journalMarkdown()).not.toContain("Changed retry.");
  expect(await readFile(join(root, PATH), "utf8")).not.toContain("Changed retry.");
});

it("retries a lost keyed acknowledgement with the original record and no second admission", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const opensBefore = methodCount(YDOC_METHOD.open);
  loseNextRecordAnswer = true;
  loseNextResync = true;
  await keyedWrite(session, "Recorded once.");

  // The replacement asks the durable ledger about the original record.
  expect(methodCount(YDOC_METHOD.open)).toBe(opensBefore + 1);
  const keyed = requests.filter(
    (request) =>
      request.method === YDOC_METHOD.recordUpdate &&
      request.idempotencyKey === "claim/1/0",
  );
  expect(keyed).toHaveLength(2);
  expect(keyed[1]?.params).toMatchObject({ ...(keyed[0]?.params as Record<string, JsonValue>), sessionId: expect.any(String) });
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toContain("Recorded once.");
  await session.settleNow();
  expect(await readFile(join(root, PATH), "utf8")).toContain("Recorded once.");
  await session.close({ settle: false });
});

it("drops a definitively refused caller-confirmed original so later typing can settle", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  nextRecordRefusal = wireRefusal("attribution depth exceeds the supported chain bound");
  await expect(keyedWrite(session, "Refused write.")).rejects.toThrow("attribution depth exceeds the supported chain bound");
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).not.toContain("Refused write.");
  expect(requests.filter(request => request.idempotencyKey === "claim/1/0")).toHaveLength(1);

  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Later typing.");
  await session.settleNow();
  const content = await readFile(join(root, PATH), "utf8");
  expect(content).toContain("Later typing.");
  expect(content).not.toContain("Refused write.");
  await session.close({ settle: false });
  editor.destroy();
});

it.each(["confirmed write", "typing"])("drops only the refused original during recovery triggered by %s", async trigger => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  // No answer proves whether the original reached the engine. A failed reopen
  // leaves it pending until a later operation revives the session.
  nextRecordRefusal = transportLost();
  loseNextResync = true;
  nextOpenRefusal = new Error("replacement unavailable");
  await expect(keyedWrite(session, "Uncertain original.", "uncertain-original"))
    .rejects.toThrow("may have been recorded");
  nextRecordRefusal = wireRefusal("attribution depth exceeds the supported chain bound");

  if (trigger === "confirmed write") {
    await expect(keyedWrite(session, "Later write.", "later-original")).resolves.toBe(true);
    expect(requests.filter(request => request.idempotencyKey === "later-original")).toHaveLength(1);
  } else {
    const editor = mirrorEditor(session);
    typeIntoBody(editor, "Later write.");
    await session.applyDecidedLocalUpdate(() => null);
    editor.destroy();
  }
  await session.settleNow();
  const original = requests.filter(request => request.idempotencyKey === "uncertain-original");
  expect(original).toHaveLength(2);
  expect(original[1]!.params).toEqual({
    ...(original[0]!.params as Record<string, JsonValue>), sessionId: expect.any(String),
  });
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toContain("Later write.");
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).not.toContain("Uncertain original.");
  expect(journalMarkdown()).not.toContain("Uncertain original.");
  const content = await readFile(join(root, PATH), "utf8");
  expect(content).toContain("Later write.");
  expect(content).not.toContain("Uncertain original.");
  await session.close({ settle: false });
});

it("records a keyed deletion with its original ID", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(session.doc));
  const before = Y.encodeStateVector(scratch);
  const body = scratch.getXmlFragment("body");
  body.delete(body.length - 1, 1);
  const recordsBefore = methodCount(YDOC_METHOD.recordUpdate);

  await expect(
    session.applyDecidedLocalUpdate(() => Y.encodeStateAsUpdate(scratch, before), undefined, {
      idempotencyKey: "claim/1/0",
    }),
  ).resolves.toBe(true);
  expect(methodCount(YDOC_METHOD.recordUpdate)).toBe(recordsBefore + 1);
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).not.toContain("Start here.");
  await session.close({ settle: false });
});

it("keeps typing records pending through a busy store without reopening or relabeling", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, session.initialUpdate);
  let original: Uint8Array | undefined;
  scratch.once("update", (update: Uint8Array) => { original = new Uint8Array(update); });
  typeIntoBody(scratch, "Busy typing.");
  const opens = methodCount(YDOC_METHOD.open);
  busyRecordAttempts = 2;
  // As main's IPC names the person when the update arrives.
  const attribution = { actorKind: "human" as const, onBehalfOf: "alice", depth: 0 };
  session.applyLocalUpdate(original!, undefined, { idempotencyKey: "renderer-busy", actorOriginId: "alice", attribution });
  attribution.onBehalfOf = "bob";
  // Drain main's queue. The provider still holds the two refused attempts.
  await session.applyDecidedLocalUpdate(() => null);
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toContain("Busy typing.");
  await session.settleNow();
  const records = requests.filter(request => request.idempotencyKey === "renderer-busy");
  expect(records).toHaveLength(3);
  expect(records.map(request => request.params)).toEqual([records[0]!.params, records[0]!.params, records[0]!.params]);
  expect(records[0]!.params).toMatchObject({ attribution: { onBehalfOf: "alice" } });
  expect(ydoc.recordedAuthors.at(-1)).toEqual({ actorOriginId: "alice",
    attribution: { actorKind: "human", onBehalfOf: "alice", depth: 0 } });
  expect(methodCount(YDOC_METHOD.open)).toBe(opens);
  expect(await readFile(join(root, PATH), "utf8")).toContain("Busy typing.");
  await session.close({ settle: false });
  scratch.destroy();
});

it("does not replay acknowledged agent originals when a later original loses its answer", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, session.initialUpdate);
  const originals: Uint8Array[] = [];
  scratch.on("update", (update: Uint8Array) => { originals.push(new Uint8Array(update)); });
  typeIntoBody(scratch, "Acknowledged agent.");
  await session.applyDecidedLocalUpdate(() => originals[0]!, undefined,
    { actorOriginId: "alice-agent", attribution: { actorKind: "agent", onBehalfOf: "alice", depth: 1 } });
  const admitted = ydoc.recordedUpdates.length;
  const opens = methodCount(YDOC_METHOD.open);
  typeIntoBody(scratch, "Lost answer.");
  loseNextRecordAnswer = true;
  loseNextResync = true;
  await session.applyDecidedLocalUpdate(() => originals[1]!, undefined,
    { actorOriginId: "bob-agent", attribution: { actorKind: "agent", onBehalfOf: "bob", depth: 3 } });
  const alice = requests.filter(request => request.method === YDOC_METHOD.recordUpdate &&
    (request.params as { actorOriginId?: string }).actorOriginId === "alice-agent");
  const bob = requests.filter(request => request.method === YDOC_METHOD.recordUpdate &&
    (request.params as { actorOriginId?: string }).actorOriginId === "bob-agent");
  expect(alice).toHaveLength(1);
  expect(bob).toHaveLength(2);
  expect(bob[1]!.idempotencyKey).toBe(bob[0]!.idempotencyKey);
  expect(bob[1]!.params).toEqual({ ...(bob[0]!.params as Record<string, JsonValue>), sessionId: expect.any(String) });
  expect(ydoc.recordedUpdates).toHaveLength(admitted + 1);
  expect(methodCount(YDOC_METHOD.open)).toBe(opens + 1);
  await session.settleNow();
  expect(await readFile(join(root, PATH), "utf8")).toContain("Lost answer.");
  await session.close({ settle: false });
  scratch.destroy();
});

it.each(["quit", "renderer retirement"] as const)("%s releases a refused settle without pruning the durable typing", async mode => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typing that must survive quit.");
  const outside = "# Outside\n\nAnother app wrote this.\n";
  await writeFile(join(root, PATH), outside);
  settleRefusal = wireRefusal("conflict-stale-target");
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
  const closeEntered = Promise.withResolvers<void>();
  const finishClose = Promise.withResolvers<void>();
  beforeClose = async () => { closeEntered.resolve(); await finishClose.promise; };
  const closing = session.close(mode === "quit" ? { shuttingDown: true } : undefined);
  await closeEntered.promise;
  capture.beginShutdown();
  sessions.beginShutdown();
  finishClose.resolve();
  try {
    await expect(closing).resolves.toBeUndefined();
    expect(methodCount(YDOC_METHOD.evict)).toBe(1);
    expect(daemon.leases.size).toBe(0);
    await expect(capture.settleAndCloseAllLiveSessions()).resolves.toBeUndefined();
    expect(await readFile(join(root, PATH), "utf8")).toBe(outside);
    settleRefusal = null;
    closeRefusal = null;
    const reopened = await openEngineYdocProviderSession({ transport: ydoc, workspace: WORKSPACE_ID, versionId: "main", path: PATH, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    const recovered = new Y.Doc();
    try {
      Y.applyUpdate(recovered, reopened.initialUpdate);
      expect(documentMarkdown(Y.encodeStateAsUpdate(recovered))).toContain("Typing that must survive quit.");
    } finally { recovered.destroy(); await reopened.close(); }
  } finally { editor.destroy(); }
});
it("keeps a permanent quit eviction failure cached for later callers", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  const send = ydoc.sendRequest.bind(ydoc);
  vi.spyOn(ydoc, "sendRequest").mockImplementation(async request => {
    if (request.method === YDOC_METHOD.evict) throw wireRefusal("permanent eviction failure");
    return send(request);
  });
  capture.beginShutdown();
  sessions.beginShutdown();
  await expect(session.close({ shuttingDown: true })).rejects.toThrow("ydoc-unsettled-close");
  expect(captureErrors).toContain(`ydoc evict of ${PATH}`);
  expect(methodCount(YDOC_METHOD.evict)).toBe(1);
  expect(daemon.leases.size).toBe(1);
  const closes = methodCount(YDOC_METHOD.close);
  const settles = methodCount(YDOC_METHOD.settle);
  await expect(session.close({ shuttingDown: true })).rejects.toThrow("ydoc-unsettled-close");
  await expect(capture.settleAndCloseAllLiveSessions()).rejects.toThrow("ydoc-unsettled-close");
  expect(methodCount(YDOC_METHOD.close)).toBe(closes);
  expect(methodCount(YDOC_METHOD.settle)).toBe(settles);
  expect(methodCount(YDOC_METHOD.evict)).toBe(1);
  expect(daemon.leases.size).toBe(1);
});

it("retries only eviction after a transient quit release failure", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate: () => undefined });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typing that must survive a failed eviction.");
  await writeFile(join(root, PATH), "Outside bytes.");
  settleRefusal = wireRefusal("conflict-stale-target");
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  const send = ydoc.sendRequest.bind(ydoc);
  let blockEvict = true;
  vi.spyOn(ydoc, "sendRequest").mockImplementation(async request => {
    if (blockEvict && request.method === YDOC_METHOD.evict) throw wireRefusal("engine-store-busy", "OVERLOADED");
    return send(request);
  });
  await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
  capture.beginShutdown();
  sessions.beginShutdown();
  try {
    await expect(session.close({ shuttingDown: true })).rejects.toThrow("ydoc-unsettled-close");
    expect(captureErrors).toContain(`ydoc evict of ${PATH}`);
    expect(methodCount(YDOC_METHOD.evict)).toBe(1);
    expect(daemon.leases.size).toBe(1);
    blockEvict = false;
    const closes = methodCount(YDOC_METHOD.close);
    await expect(capture.settleAndCloseAllLiveSessions()).resolves.toBeUndefined();
    expect(methodCount(YDOC_METHOD.close)).toBe(closes);
    expect(methodCount(YDOC_METHOD.evict)).toBe(2);
    expect(daemon.leases.size).toBe(0);
    expect(await readFile(join(root, PATH), "utf8")).toBe("Outside bytes.");
  } finally { editor.destroy(); }
});


it.each([
  ["file-locked", () => wireRefusal("file-locked", "INTERNAL")],
  ["engine-store-busy", () => wireRefusal("engine-store-busy", "OVERLOADED")],
  ["transport", transportLost],
] as const)("quit releases a %s close refusal once", async (_kind, refusal) => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  closeRefusal = refusal();
  enforceRecordOwner = true;
  capture.beginShutdown();
  sessions.beginShutdown();
  await expect(session.close({ shuttingDown: true })).resolves.toBeUndefined();
  expect(methodCount(YDOC_METHOD.evict)).toBe(1);
  expect(daemon.leases.size).toBe(0);
});

it("quit waits for typing still unacknowledged when close starts before eviction", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  const editor = mirrorEditor(session);
  const acknowledgedBefore = ydoc.recordedUpdates.length;
  const recording = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  beforeRecordUpdate = async () => { recording.resolve(); await acknowledge.promise; };
  typeIntoBody(editor, "Unacknowledged when quit starts.");
  typeIntoBody(editor, "Queued behind the unacknowledged write.");
  await recording.promise;
  expect(ydoc.recordedUpdates).toHaveLength(acknowledgedBefore);
  settleRefusal = wireRefusal("conflict-stale-target");
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  capture.beginShutdown();
  sessions.beginShutdown();
  const closing = session.close({ shuttingDown: true });
  try {
    expect(methodCount(YDOC_METHOD.evict)).toBe(0);
    acknowledge.resolve();
    await closing;
    expect(ydoc.recordedUpdates).toHaveLength(acknowledgedBefore + 2);
    expect(daemon.leases.size).toBe(0);
    expect(() => session.applyLocalUpdate(new Uint8Array())).toThrow("closed");
    settleRefusal = null;
    closeRefusal = null;
    const reopened = await openEngineYdocProviderSession({ transport: ydoc, workspace: WORKSPACE_ID,
      versionId: "main", path: PATH, contentKind: "richdoc", onRemoteUpdate() {} });
    expect(documentMarkdown(reopened.initialUpdate)).toContain("Unacknowledged when quit starts.");
    expect(documentMarkdown(reopened.initialUpdate)).toContain("Queued behind the unacknowledged write.");
    await reopened.close();
  } finally { acknowledge.resolve(); await closing.catch(() => undefined); editor.destroy(); }
});

it.each(["workspace close", "version switch", "stopped capture"] as const)(
  "%s retains refused typing for retry instead of evicting", async operation => {
    const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
    const editor = mirrorEditor(session);
    typeIntoBody(editor, "Typing kept during interactive teardown.");
    settleRefusal = wireRefusal("conflict-stale-target");
    closeRefusal = wireRefusal("ydoc-unsettled-close");
    await expect(session.close()).rejects.toThrow();
    if (operation === "stopped capture") await capture.stop();
    const closing = operation === "workspace close" ? capture.settleAndCloseAllLiveSessions()
      : operation === "version switch" ? capture.switchVersion("other") : session.close();
    try {
      await expect(closing).rejects.toThrow();
      expect(methodCount(YDOC_METHOD.evict)).toBe(0);
      expect(daemon.leases.size).toBe(1);
      settleRefusal = null;
      closeRefusal = null;
      await session.close();
      expect(await readFile(join(root, PATH), "utf8")).toContain("Typing kept during interactive teardown.");
    } finally { editor.destroy(); }
  },
);

it("quit removes repeated refused closes and leaves the remaining shutdown budget", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typing before the deadline.");
  settleRefusal = wireRefusal("conflict-stale-target");
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  await expect(session.settleNow()).rejects.toThrow();
  const owner = new EngineYDocSessionOwner({ onOutbound() {} });
  await owner.open({ sender: { id: 1 }, generation: 1, sessionId: "quit", workspaceId: WORKSPACE_ID,
    authorityId: ATTACHMENT_ID, path: PATH, openSession: async () => ({ session, value: null }) });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Gate 140 observed about 400 ms for two closes. Model each close as
  // 1/30 of the 6 s shutdown budget (200 ms), leaving 28/30 (5.6 s)
  // for other cleanup. This checks repeated calls, not gate 140 causality.
  const closeLatencyMs = WILL_QUIT_BUDGET_MS / 30;
  const remainingBudgetMs = WILL_QUIT_BUDGET_MS - 2 * closeLatencyMs;
  const start = Date.now();
  const trace: string[] = [];
  let step = "owner.shutdown";
  let rpcStarted = Promise.withResolvers<void>();
  beforeClose = async function delayClose() {
    beforeClose = delayClose;
    trace.push((Date.now() - start) + "ms " + step + ": ydoc.close");
    rpcStarted.resolve();
    await new Promise(resolve => setTimeout(resolve, closeLatencyMs));
  };
  capture.beginShutdown();
  sessions.beginShutdown();
  const teardown = (async () => {
    await owner.shutdown();
    step = "workspaceAuthorities.close: retireAuthority / activity close sweep";
    await Promise.allSettled([
      owner.retireAuthority(ATTACHMENT_ID).finally(() => {
        trace.push((Date.now() - start) + "ms retireAuthority completed");
      }),
      capture.settleAndCloseAllLiveSessions().finally(() => {
        trace.push((Date.now() - start) + "ms capture close sweep completed");
      }),
    ]);
  })();
  let timer: ReturnType<typeof setTimeout>;
  const result = Promise.race([
    teardown.then(() => "complete"),
    new Promise<string>(resolve => { timer = setTimeout(() => resolve("deadline at " + step), WILL_QUIT_BUDGET_MS); }),
  ]);
  let outcome: string | undefined;
  void result.then(value => { outcome = value; });
  try {
    while (outcome === undefined) {
      await Promise.race([rpcStarted.promise, result]);
      if (outcome !== undefined) break;
      rpcStarted = Promise.withResolvers<void>();
      await vi.advanceTimersByTimeAsync(closeLatencyMs);
    }
    expect(outcome, trace.join("\n")).toBe("complete");
    expect(methodCount(YDOC_METHOD.close)).toBe(2);
    expect(WILL_QUIT_BUDGET_MS - (Date.now() - start)).toBe(remainingBudgetMs);
    expect(daemon.leases.size).toBe(0);
  } finally {
    clearTimeout(timer!);
    await vi.advanceTimersByTimeAsync(WILL_QUIT_BUDGET_MS);
    await teardown;
    vi.useRealTimers();
    editor.destroy();
  }
});

it.each(["closed", "evicted"] as const)("preserves a renderer draft once after its capture session is %s", async mode => {
  const sender = { id: 1, isDestroyed: () => false, send() {}, once() { return this; } };
  const workspace = { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: ATTACHMENT_ID };
  let provider!: Awaited<ReturnType<typeof capture.openYDocSession>>;
  const ipc = createEngineYDocSessionIpc({
    localPersonId: () => "person-local",
    sessionFor: () => ({ workspaceId: WORKSPACE_ID, generation: 1, isCurrent: () => true }),
    acquireWorkspace: () => ({ workspace, assertCurrent() {}, release() {} }),
    captureFor: () => ({ openYDocSession: async input => provider = await capture.openYDocSession(input) }),
    ensureCaptureFor: async () => undefined, isSharedView: () => false,
    resolveDocumentPath: async (_workspace, path) => path, onError() {},
  });
  const apply = vi.fn(async (update: Uint8Array, seq: number, lineageGeneration: number, requestId: string) => {
    const result = ipc.applyUpdate(sender, { sessionId: "late-editor", update, seq, lineageGeneration, requestId });
    if (!result.accepted) throw new EngineYDocDeliveryRefusedError(result.reason);
  });
  let seq = 0;
  const transport: EngineYDocTransport = {
    open: () => ipc.open(sender, { workspaceId: WORKSPACE_ID, sessionId: "late-editor", path: PATH }),
    stageLocalUpdate: () => ++seq, applyLocalUpdate: apply,
    onRemoteUpdate: () => () => undefined, onLineageReplacement: () => () => undefined,
    acknowledgeLineageReplacement: async () => [], close: async () => undefined,
  };
  const recover = vi.fn();
  const binding = await bindEngineYDoc(transport, undefined, { onDeliveryFailure: recover });
  if (mode === "evicted") {
    closeRefusal = wireRefusal("ydoc-unsettled-close");
    capture.beginShutdown();
  }
  // The IPC owner remains open while capture independently retires its provider.
  await provider.close();
  expect(methodCount(YDOC_METHOD.evict)).toBe(mode === "evicted" ? 1 : 0);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    typeIntoBody(binding.doc!, "Keep this late typing as a draft.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).toHaveBeenCalledOnce();
    expect(documentMarkdown(recover.mock.calls[0]![0])).toContain("Keep this late typing as a draft.");
    expect(apply).toHaveBeenCalledOnce();
  } finally {
    const destroying = binding.destroy();
    await vi.advanceTimersByTimeAsync(1_000);
    await destroying;
    vi.useRealTimers();
    await ipc.shutdown();
  }
});

// A restore gave the open document another history while edits were on their
// way. Each refused write reaches the renderer as that history, never as a
// generic reconnect, and the renderer sets the refused typing aside first.
it.each([
  { writer: "renderer typing", lostResync: false },
  { writer: "keyed write", lostResync: false },
  { writer: "renderer typing", lostResync: true },
] as const)("hands a refused $writer to the renderer as the replaced history (lost resync answer: $lostResync)", async ({ writer, lostResync }) => {
  claimedLineage = true;
  type Replacement = Parameters<Parameters<EngineYDocTransport["onLineageReplacement"]>[0]>[0];
  let deliverReplacement: ((input: Replacement) => void | Promise<void>) | null = null;
  const announced: Replacement[] = [];
  const sender = {
    id: 1, isDestroyed: () => false, once() { return this; },
    send: (channel: string, payload: unknown) => {
      if (channel !== CHANNELS.engineYDocLineageReplacement) return;
      announced.push(payload as Replacement);
      queueMicrotask(() => void deliverReplacement?.(payload as Replacement));
    },
  };
  const workspace = { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: ATTACHMENT_ID };
  let provider!: Awaited<ReturnType<typeof capture.openYDocSession>>;
  const ipc = createEngineYDocSessionIpc({
    localPersonId: () => "person-local",
    sessionFor: () => ({ workspaceId: WORKSPACE_ID, generation: 1, isCurrent: () => true }),
    acquireWorkspace: () => ({ workspace, assertCurrent() {}, release() {} }),
    captureFor: () => ({ openYDocSession: async input => provider = await capture.openYDocSession(input) }),
    ensureCaptureFor: async () => undefined, isSharedView: () => false,
    resolveDocumentPath: async (_workspace, path) => path, onError() {},
  });
  let seq = 0;
  const transport: EngineYDocTransport = {
    open: () => ipc.open(sender, { workspaceId: WORKSPACE_ID, sessionId: "editor", path: PATH }),
    stageLocalUpdate: () => ++seq,
    async applyLocalUpdate(update, staged, lineageGeneration, requestId) {
      const result = ipc.applyUpdate(sender, { sessionId: "editor", update, seq: staged, lineageGeneration, requestId });
      if (!result.accepted) throw new EngineYDocDeliveryRefusedError(result.reason);
    },
    onRemoteUpdate: () => () => undefined,
    onLineageReplacement(listener) {
      deliverReplacement = listener;
      return () => { deliverReplacement = null; };
    },
    async acknowledgeLineageReplacement(lineageGeneration) {
      const result = ipc.acknowledgeLineageReplacement(sender, { sessionId: "editor", lineageGeneration });
      if (!result.accepted) throw new EngineYDocDeliveryRefusedError(result.reason);
      return result.updates;
    },
    close: async () => { await ipc.close(sender, { sessionId: "editor" }); },
  };
  const setAside: string[] = [];
  const installed = Promise.withResolvers<Y.Doc>();
  const binding = await bindEngineYDoc(transport, undefined, {
    onDocumentReplacing: retired => { setAside.push(documentMarkdown(Y.encodeStateAsUpdate(retired))); },
  });
  binding.onDocumentReplaced(doc => installed.resolve(doc));
  const losingDoc = binding.doc!;
  typeIntoBody(losingDoc, "Typed before the restore.");
  await binding.flushPendingLocalUpdates();
  await provider.settleNow();

  servedClaim = "restored-claim";
  resyncCount = 0;
  // The first resync after the restore is the record's own recovery, which
  // finds the new claim. The second carries the replacement and its recovered
  // paths.
  if (lostResync) lostResyncs = new Set([2]);
  if (writer === "keyed write") {
    // The caller hears the refusal only once main holds the replaced history.
    const release = Promise.withResolvers<void>();
    heldResync = { at: 2, entered: Promise.withResolvers<void>(), release: release.promise };
    const writing = keyedWrite(provider, "Written against the old history.");
    let answered = false;
    writing.then(() => { answered = true; }, () => { answered = true; });
    await heldResync.entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(answered).toBe(false);
    release.resolve();
    await expect(writing).rejects.toMatchObject({ code: "lineage-changed" });
    expect(announced).toHaveLength(1);
  } else {
    // Typing continues while the first refused edit is on its way.
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    beforeRecordUpdate = async () => { entered.resolve(); await release.promise; };
    typeIntoBody(losingDoc, "Typed against the old history.");
    await entered.promise;
    typeIntoBody(losingDoc, "Typed during the refusal.");
    await binding.flushPendingLocalUpdates();
    release.resolve();
  }
  // A lost answer leaves the replacement to the next settle's resync.
  if (lostResync) await provider.settleNow().catch(() => undefined);
  const winner = await installed.promise;

  expect(binding.doc).toBe(winner);
  expect(announced.map(replacement => replacement.recoveredPaths)).toEqual([[]]);
  const winnerText = documentMarkdown(Y.encodeStateAsUpdate(winner));
  expect(winnerText).toContain("Typed before the restore.");
  for (const refused of ["Written against the old history.", "Typed against the old history.", "Typed during the refusal."]) {
    expect(winnerText).not.toContain(refused);
    expect(journalMarkdown()).not.toContain(refused);
  }
  if (writer === "renderer typing") {
    expect(setAside).toHaveLength(1);
    expect(setAside[0]).toContain("Typed against the old history.");
    expect(setAside[0]).toContain("Typed during the refusal.");
  }
  // Neither a reconnect nor a refused-edit notice: the replacement is the answer.
  expect(captureErrors.filter(context => context.startsWith("Y.Doc local update") || context.startsWith("Y.Doc rebind"))).toEqual([]);

  typeIntoBody(winner, "Typed on the restored history.");
  await binding.flushPendingLocalUpdates();
  await provider.settleNow();
  expect(journalMarkdown()).toContain("Typed on the restored history.");
  expect(await readFile(join(root, PATH), "utf8")).toContain("Typed on the restored history.");
  await binding.destroy();
  await ipc.shutdown();
});

it("quit eviction waits for the active typing checkpoint writer and its queued retirement", async () => {
  await capture.stop();
  const writing = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  const retiring = Promise.withResolvers<void>();
  const finishRetirement = Promise.withResolvers<void>();
  let notifyDeath!: (error: unknown) => void;
  const writeCheckpoint = vi.fn(async () => { writing.resolve(); await finishWrite.promise; });
  capture = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: ATTACHMENT_ID, rustEngineSessions: sessions,
    openRustYDocProviderSession: async options => {
      notifyDeath = options.onSessionError!;
      return { ...await openEngineYdocProviderSession(options), objectId: "checkpoint-object", versionId: "main" };
    },
    writeTypingCheckpoint: writeCheckpoint,
    retireTypingCheckpoint: async () => { retiring.resolve(); await finishRetirement.promise; },
    onError: context => captureErrors.push(context),
  });
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  const editor = mirrorEditor(session);
  const recording = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  beforeRecordUpdate = async () => { recording.resolve(); await acknowledge.promise; };
  typeIntoBody(editor, "Checkpoint typing acknowledged before quit.");
  await recording.promise;
  notifyDeath(transportLost());
  await writing.promise;
  acknowledge.resolve();
  await session.settleNow();
  const acknowledged = ydoc.recordedUpdates.length;
  expect(acknowledged).toBeGreaterThan(0);
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  capture.beginShutdown();
  sessions.beginShutdown();
  let completed = false;
  const closing = session.close({ shuttingDown: true }).then(() => { completed = true; });
  try {
    await expect.poll(() => methodCount(YDOC_METHOD.evict)).toBe(1);
    // The event-loop turn drains the close continuations while disk stays gated.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    finishWrite.resolve();
    await retiring.promise;
    expect(completed).toBe(false);
    finishRetirement.resolve();
    await closing;
    expect(ydoc.recordedUpdates).toHaveLength(acknowledged);
    await flushTypingCheckpoints(WORKSPACE_ID);
  } finally {
    acknowledge.resolve(); finishWrite.resolve(); finishRetirement.resolve();
    await closing;
    editor.destroy();
  }
});

it("a later quit caller journals missing typing after transient resend refusals", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  const editor = mirrorEditor(session);
  const recorded = ydoc.recordedUpdates.length;
  busyRecordAttempts = 100;
  typeIntoBody(editor, "Only main holds this typing until quit retries.");
  await session.applyDecidedLocalUpdate(() => null);
  expect(ydoc.recordedUpdates).toHaveLength(recorded);
  capture.beginShutdown();
  sessions.beginShutdown();
  try {
    await expect(session.close({ shuttingDown: true })).rejects.toThrow("engine-store-busy");
    expect(ydoc.recordedUpdates).toHaveLength(recorded);
    expect(methodCount(YDOC_METHOD.evict)).toBe(0);
    expect(daemon.leases.size).toBe(1);
    busyRecordAttempts = 0;
    const closes = methodCount(YDOC_METHOD.close);
    const settles = methodCount(YDOC_METHOD.settle);
    await expect(capture.settleAndCloseAllLiveSessions()).resolves.toBeUndefined();
    expect(methodCount(YDOC_METHOD.close)).toBe(closes);
    expect(methodCount(YDOC_METHOD.settle)).toBe(settles);
    expect(methodCount(YDOC_METHOD.evict)).toBe(1);
    expect(daemon.leases.size).toBe(0);
    const reopened = await openEngineYdocProviderSession({ transport: ydoc, workspace: WORKSPACE_ID,
      versionId: "main", path: PATH, contentKind: "richdoc", onRemoteUpdate() {} });
    expect(documentMarkdown(reopened.initialUpdate)).toContain("Only main holds this typing until quit retries.");
    await reopened.close();
  } finally { busyRecordAttempts = 0; editor.destroy(); }
});

it("an interactive sweep makes its own close attempt after a renderer refusal", async () => {
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  await expect(session.close({ settle: false, settleOnRefusal: false })).rejects.toThrow();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeClose = async () => {
    entered.resolve();
    await release.promise;
    beforeClose = async () => { closeRefusal = null; };
  };
  const rendererClose = session.close({ settle: false, settleOnRefusal: false });
  const rendererRefused = expect(rendererClose).rejects.toThrow("ydoc-unsettled-close");
  await entered.promise;
  const joiningWriters = vi.spyOn(Promise, "all");
  const sweep = capture.settleAndCloseAllLiveSessions();
  const swept = expect(sweep).resolves.toBeUndefined();
  try {
    // closeEntry joins its record-writer Set before queueing the provider close.
    await expect.poll(() => joiningWriters.mock.calls.some(([values]) => values instanceof Set)).toBe(true);
    release.resolve();
    await rendererRefused;
    await swept;
    expect(daemon.leases.size).toBe(0);
  } finally {
    joiningWriters.mockRestore();
    release.resolve();
    await Promise.allSettled([rendererClose, sweep]);
  }
});

it("successful eviction stays closed when checkpoint retirement fails", async () => {
  await capture.stop();
  const writing = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  let notifyDeath!: (error: unknown) => void;
  let failRetirement = true;
  const retire = vi.fn(async () => { if (failRetirement) throw new Error("checkpoint disk failure"); });
  capture = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: ATTACHMENT_ID, rustEngineSessions: sessions,
    openRustYDocProviderSession: async options => {
      notifyDeath = options.onSessionError!;
      return { ...await openEngineYdocProviderSession(options), objectId: "checkpoint-object", versionId: "main" };
    },
    writeTypingCheckpoint: async () => { writing.resolve(); await finishWrite.promise; },
    retireTypingCheckpoint: retire,
    onError: context => captureErrors.push(context),
  });
  const session = await capture.openYDocSession({ path: PATH, onRemoteUpdate() {} });
  const editor = mirrorEditor(session);
  const recording = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  beforeRecordUpdate = async () => { recording.resolve(); await acknowledge.promise; };
  typeIntoBody(editor, "Typing durable before checkpoint retirement fails.");
  await recording.promise;
  notifyDeath(transportLost());
  await writing.promise;
  acknowledge.resolve();
  await session.settleNow();
  const leasesBeforeClose = daemon.leases.size;
  closeRefusal = wireRefusal("ydoc-unsettled-close");
  capture.beginShutdown();
  sessions.beginShutdown();
  const closing = session.close({ shuttingDown: true });
  const closed = expect(closing).resolves.toBeUndefined();
  try {
    await expect.poll(() => methodCount(YDOC_METHOD.evict)).toBe(1);
    finishWrite.resolve();
    await closed;
    expect(daemon.leases.size).toBe(leasesBeforeClose - 1);
    expect(() => session.applyLocalUpdate(new Uint8Array())).toThrow("closed");
    expect(captureErrors).toContain("Typing checkpoint");
    expect(captureErrors).not.toContain(`ydoc evict of ${PATH}`);
    await expect(capture.settleAndCloseAllLiveSessions()).resolves.toBeUndefined();
    const attempts = retire.mock.calls.length;
    failRetirement = false;
    await flushTypingCheckpoints(WORKSPACE_ID);
    expect(retire.mock.calls.length).toBeGreaterThan(attempts);
  } finally {
    acknowledge.resolve(); finishWrite.resolve(); failRetirement = false;
    await closing.catch(() => undefined);
    await flushTypingCheckpoints(WORKSPACE_ID);
    editor.destroy();
  }
});

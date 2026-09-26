import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { createTestScratch } from "./testTemp";
import { createEngineYDocSessionIpc, DOCUMENT_EDIT_SHARED_WARNING } from "./engineYDocSessionIpc";
import { CHANNELS } from "../ipc/channels";
import { documentEditUpdate, documentMarkdown } from "@dohc/ydoc-projection";
import {
  createFakeDaemonCapture,
  type FakeDaemonCapture,
} from "../testing/fakeDaemonCapture";
import { daemonCaptureLifecycleAnswer } from "../testing/liveEngineSessions";

const WORKSPACE_ID = "engine-ydoc-session-test";
const ATTACHMENT_ID = Symbol("test-workspace-attachment");
const PATH = "notes/solo.md";
const INITIAL_MARKDOWN = "# Solo\n\nStart here.\n";

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
// The same, for the RELEASE. The daemon refuses a local-only prune-close with
// `unsettled-close` when the CRDT projection no longer matches
// `last_settled_sha` (crates/dohc-engine-collab/src/durable.rs) and reinserts
// the session entry, so the doc stays reserved.
let closeRefusal: unknown = null;
// Refuses the next journal write once, the way the daemon refuses it on the
// wire, then lets later writes (the adapter's recovery included) through.
let nextRecordRefusal: unknown = null;
// Records the next journal write, then loses its answer with the connection;
// the resync that recovery sends next is lost the same way.
let loseNextRecordAnswer = false;
let loseNextResync = false;
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
      const params = request.params as Record<string, JsonValue | undefined>;
      if (request.method === "workspace.open") {
        return {
          id: request.id,
          result: { workspace: String(params.workspaceId) },
        };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      if (request.method === "ydoc.settle" && settleRefusal !== null) {
        throw settleRefusal;
      }
      if (request.method === "ydoc.close" && closeRefusal !== null) {
        throw closeRefusal;
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
      const answered = await daemon.sendRequest(request);
      if (answered) return answered;
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
  closeRefusal = null;
  nextRecordRefusal = null;
  loseNextRecordAnswer = false;
  loseNextResync = false;
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
    materialize: ({ path, content }) =>
      writeFileSync(join(root, path), content, "utf8"),
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

  capture.captureBatch([{ path: PATH, operation: "update" }]);
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

// The daemon's own capture ingests an edit made outside dohc, which
// moves the path's head; the close-settle that follows meets that moved head
// and the engine refuses ConflictStaleTarget. The RELEASE then succeeds, which
// is what makes the refusal benign: the outside author's file is intact, and a
// release that prunes proves this document's text is a settled moment in
// History. So the close must end as quiet as the close that wins the race.
it("closes clean and reports changed-on-disk when the close settle meets a moved head", async () => {
  const states: string[] = [];
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Typed in dohc.");
  // Flush first, so the debounced settle cannot fire against the refusal
  // armed below and make this a NON-close settle failure by accident.
  await session.settleNow();
  states.length = 0;
  captureErrors = [];

  // The outside writer, on disk. The refusal alone does not make this state
  // true — `changed-on-disk` says the FILE is not this document's, so the file
  // has to actually hold someone else's bytes for the close to say it.
  await writeFile(join(root, PATH), "# Solo\n\nEdited in another app.\n", "utf8");
  settleRefusal = wireRefusal("conflict-stale-target");
  await expect(session.close()).resolves.toBeUndefined();

  // The refusal is reported the moment it happens and WITHDRAWN once the
  // release proves it benign. The editor's last word is what it acts on.
  expect(states).toEqual(["settling", "error", "changed-on-disk"]);
  // The daemon session was released exactly as a clean close releases it.
  expect(methodCount("ydoc.close")).toBe(1);

  // And the path's lease lifted with it: the daemon captures the next disk
  // edit instead of deferring it behind a session it still holds.
  settleRefusal = null;
  const writesBeforeWatcher = daemonWriteCount();
  await writeFile(join(root, PATH), "# Solo\n\nWritten outside dohc.\n", "utf8");
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();
  expect(daemonWriteCount()).toBeGreaterThan(writesBeforeWatcher);
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
    relayDatabaseNamespace: "relay", revision: 1, acceptedCursor, nativeHeadSequence: 1,
    outboxId: state === null ? null : "outbox", pendingBytes, state,
  });
  await expect(session.settleNow()).rejects.toBe(settleRefusal);
  expect(states.at(-1)).toBe(expected);
  expect(captureErrors).not.toContain(`ydoc settle of ${PATH}`);
  settleRefusal = null;
  await session.close({settle: false});
});

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
  await expect(session.settleNow()).rejects.toThrow("engine-store-busy");

  expect(states.at(-1)).toBe("settling");
  expect(states).not.toContain("error");
  expect(states).not.toContain("file-locked");
  // Still loud in the log: staying quiet on the chip is not going quiet.
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
  settleRefusal = null;
  await session.close({ settle: false });
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
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

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
  capture.captureBatch([{ path: PATH, operation: "update" }]);
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
    onSaveState: (state, token) => {
      if (state === "settling") {
        noteSettleStart(saveSeq, token);
        return;
      }
      const seq = noteSettleOutcome(saveSeq, token);
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
  let reportSaved!: () => void;
  const saved = new Promise<void>((resolve) => { reportSaved = resolve; });
  const opened = await capture.openYDocSession({path, onRemoteUpdate: () => undefined,
    onSaveState: (state) => {
      states.push(state);
      if (state === "saved") reportSaved();
    }});
  return {opened, states, saved};
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
  expect(states).toEqual([]);
  expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
});

// A synced workspace keeps every document's lineage after a clean close. Its
// reopen must not settle, or every open pays a projection and flashes Saving….
it("settles nothing when a document whose edits reached its file reopens", async () => {
  await retainLineage("Typed and saved.", { settle: true });
  expect(await readFile(join(root, PATH), "utf8")).toContain("Typed and saved.");
  // Capture records the settled file, as the engine's own settle does.
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();
  const settlesBeforeOpen = methodCount("ydoc.settle");
  const {opened, states} = await openRecordingStates();
  expect(opened.doc.getXmlFragment("body").toString()).toContain("Typed and saved.");
  await releaseWithoutSettling(opened);
  expect(states).toEqual([]);
  expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
});

it("settles nothing when a reopened document holds only its seed", async () => {
  await retainLineage(null);
  const settlesBeforeOpen = methodCount("ydoc.settle");
  const {opened, states} = await openRecordingStates();
  expect(opened.doc.getXmlFragment("body").toString()).toContain("Start here.");
  await releaseWithoutSettling(opened);
  expect(states).toEqual([]);
  expect(methodCount("ydoc.settle")).toBe(settlesBeforeOpen);
  expect(await readFile(join(root, PATH), "utf8")).toBe(INITIAL_MARKDOWN);
});

// edges-04: the document showed the retained edit as Saved while its file
// lacked it, and nothing wrote it until the next keystroke.
it("writes a retained edit when its document reopens, and says Saving… before the open returns", async () => {
  await retainLineage("Typed before the crash.");
  expect(await readFile(join(root, PATH), "utf8")).toBe(INITIAL_MARKDOWN);
  const {states, saved} = await openRecordingStates();
  // Reported on the open's own task, so main queues it ahead of the open's
  // answer and the editor never shows Saved first.
  expect(states[0]).toBe("settling");
  expect(states).not.toContain("saved");
  await saved;
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
    change: async (state, options) =>
      documentEditUpdate(state, { find: "Start here.", replacement: "Start over here.\n\n## Added" }, options),
  })).resolves.toEqual({ path: PATH, changed: true, warning: DOCUMENT_EDIT_SHARED_WARNING });

  // Now the editor sends its typing and takes the agent's edit.
  expect(ipc.applyUpdate(sender, { sessionId: "editor", update: typed!, seq: 1, lineageGeneration: 1 }))
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
    { idempotencyKey: "claim/1/0" },
  );
}

function journalMarkdown(): string {
  const journal = new Y.Doc();
  for (const update of ydoc.recordedUpdates) Y.applyUpdate(journal, update);
  return documentMarkdown(Y.encodeStateAsUpdate(journal));
}

it("refuses a reused idempotency key with other content, and none of that content lands", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  await keyedWrite(session, "First attempt.");
  await session.settleNow();

  const refused = expect(keyedWrite(session, "Changed retry.")).rejects.toThrow(
    "idempotency-key-reuse-mismatch",
  );
  await session.settleNow();
  await refused;

  expect(await readFile(join(root, PATH), "utf8")).not.toContain("Changed retry.");
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).not.toContain("Changed retry.");
  expect(journalMarkdown()).not.toContain("Changed retry.");
  expect(captureErrors).toEqual([]);

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

it("answers success when a recorded keyed write's answer is lost, without resending what the engine holds", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const opensBefore = methodCount(YDOC_METHOD.open);
  loseNextRecordAnswer = true;
  loseNextResync = true;
  await keyedWrite(session, "Recorded once.");

  // Recovery lost its resync too, so the session was rebuilt. The rebuilt
  // session already holds the write, so the client's resend changes nothing
  // and sends nothing: the one keyed request is the first.
  expect(methodCount(YDOC_METHOD.open)).toBe(opensBefore + 1);
  const keyed = requests.filter(
    (request) =>
      request.method === YDOC_METHOD.recordUpdate &&
      request.idempotencyKey === "claim/1/0",
  );
  expect(keyed).toHaveLength(1);
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toContain("Recorded once.");
  await session.settleNow();
  expect(await readFile(join(root, PATH), "utf8")).toContain("Recorded once.");
  await session.close({ settle: false });
});

it("refuses a keyed update that only deletes, before sending it", async () => {
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
  ).rejects.toThrow("must insert content");
  expect(methodCount(YDOC_METHOD.recordUpdate)).toBe(recordsBefore);
  expect(documentMarkdown(Y.encodeStateAsUpdate(session.doc))).toContain("Start here.");
  await session.close({ settle: false });
});

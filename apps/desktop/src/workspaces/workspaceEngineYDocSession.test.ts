import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  YDOC_METHOD,
  YdocLoopbackEngine,
  openEngineYdocProviderSession,
  type EngineTransport,
  type Event,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
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

const WORKSPACE_ID = "engine-ydoc-session-test";
const PATH = "notes/solo.md";
const INITIAL_MARKDOWN = "# Solo\n\nStart here.\n";

let root = "";
// Milliseconds the loopback daemon takes to answer ONE journal RPC. A busy
// machine is what makes the session's update queue back up behind the settle
// debounce (#514); this is that machine, made deterministic.
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
// `last_settled_sha` (crates/dohc-engine-collab/src/durable.rs) and REINSERTS
// the session entry, so the doc stays reserved.
let closeRefusal: unknown = null;
let captureErrors: string[] = [];
let versioned: VersionedLoopbackEngine;
let ydoc: YdocLoopbackEngine;
let sessions: EngineWorkspaceSessions;
let capture: ReturnType<typeof createWorkspaceEngineCapture>;

function daemonSessions(): EngineWorkspaceSessions {
  const client: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
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
      if (request.method === "capture.flush") {
        return {
          id: request.id,
          result: { settled: true, running: true, degraded: false },
        };
      }
      if (request.method === "capture.setAuthor") {
        return { id: request.id, result: { updated: true } };
      }
      if (request.method === "watcher.status") {
        return {
          id: request.id,
          result: { running: true, degraded: false, terminal: false },
        };
      }
      if (request.method === "ydoc.settle" && settleRefusal !== null) {
        throw settleRefusal;
      }
      if (request.method === "ydoc.close" && closeRefusal !== null) {
        throw closeRefusal;
      }
      if (request.method.startsWith("ydoc.")) {
        if (
          recordUpdateDelayMs > 0 &&
          request.method === YDOC_METHOD.recordUpdate
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, recordUpdateDelayMs),
          );
        }
        return await ydoc.sendRequest(request);
      }
      return await versioned.sendRequest(request);
    },
  };
  return new EngineWorkspaceSessions({ currentClient: () => client });
}

function seedYdoc(versionId: string, markdown = INITIAL_MARKDOWN): void {
  ydoc.seedFile({
    workspace: WORKSPACE_ID,
    versionId,
    path: PATH,
    markdown,
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
  // else (#338). A loopback that reports `materialized: true` while writing
  // nothing would leave every file below unchanged, so it materializes too.
  ydoc = new YdocLoopbackEngine({
    materialize: ({ path, markdown }) =>
      writeFileSync(join(root, path), markdown, "utf8"),
  });
  seedYdoc("main");
  sessions = daemonSessions();
  capture = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
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
  // (#721/#728, `ydoc_open_state_on_store`'s `seedMarkdown`).
  expect(ydoc.recordedUpdates).toHaveLength(2);
  expect(await readFile(join(root, PATH), "utf8")).toContain(
    "Typed with no collaboration server.",
  );
  const writesBeforeWatcher = methodCount(VERSIONED_METHOD.textWrite);

  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  expect(methodCount(VERSIONED_METHOD.textWrite)).toBe(writesBeforeWatcher);
  await session.close({ settle: false });
});

it("refuses a stale live-session settle while a removal window is open", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath(PATH);
  const settlesBeforeRefusal = methodCount(YDOC_METHOD.settle);

  const refusal = await session.settleNow().then(
    () => null,
    (error: unknown) => error,
  );

  expect(refusal).toMatchObject({
    name: "YDocRemovalInProgressError",
    code: "removal-in-progress",
    workspacePath: PATH,
  });
  expect((refusal as Error).message).toContain(`dohc is still deleting ${PATH}.`);
  expect(methodCount(YDOC_METHOD.settle)).toBe(settlesBeforeRefusal);
  finishDelete(true);
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

it("captures a different disk edit while the Rust Y.Doc session is live", async () => {
  const session = await capture.openYDocSession({
    path: PATH,
    onRemoteUpdate: () => undefined,
  });
  const editor = mirrorEditor(session);
  typeIntoBody(editor, "Owner edit.");
  await session.settleNow();
  const writesBeforeExternalEdit = methodCount(VERSIONED_METHOD.textWrite);
  const beforeExternalEdit = await capture.listMoments({ limit: 100 });
  const priorMomentIds = new Set(
    beforeExternalEdit.moments.map((moment) => moment.id),
  );
  const externalMarkdown =
    "# Solo\n\nAn external agent changed this file.\n";

  await writeFile(join(root, PATH), externalMarkdown, "utf8");
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  expect(methodCount(VERSIONED_METHOD.textWrite)).toBeGreaterThan(
    writesBeforeExternalEdit,
  );
  const afterExternalEdit = await capture.listMoments({ limit: 100 });
  const externalMoment = afterExternalEdit.moments.find(
    (moment) => moment.path === PATH && !priorMomentIds.has(moment.id),
  );
  if (!externalMoment) {
    throw new Error("Expected the external disk edit to record a new moment.");
  }
  expect(await capture.readMoment(externalMoment.id)).toMatchObject({
    protected: false,
    moment: {
      payload: {
        after: {
          text: externalMarkdown,
        },
      },
    },
  });
  await session.close({ settle: false });
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

// #496. The daemon's own capture ingests an edit made outside dohc, which
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

  // And the path's guard lifted with it: a watcher event on this path is
  // captured, not deferred behind a retained failing-close entry.
  settleRefusal = null;
  const writesBeforeWatcher = methodCount(VERSIONED_METHOD.textWrite);
  await writeFile(join(root, PATH), "# Solo\n\nWritten outside dohc.\n", "utf8");
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();
  expect(methodCount(VERSIONED_METHOD.textWrite)).toBeGreaterThan(
    writesBeforeWatcher,
  );
});

// The narrowness guard for the downgrade above. Any other refusal means the
// user's edits did NOT reach the engine, which is what the thrown settle
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

// The other half of the narrowness: the SAME refusal outside a close keeps
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

// The transient lock gets its OWN state (#554): the engine keeps the write
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

// #658. The OTHER busy thing needs the other answer. A busy engine database
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
// retries it — or releases only once the engine HAS the text and hands the
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
// REPLICATED lineage — any doc in a synced workspace, promoted by `claim_base`
// on the first pulled `ydoc.update` — compacts instead and never prunes, so its
// release SUCCEEDS with the typed text still unsettled
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

  // Typed AFTER the last settle: this text is in no moment.
  typeIntoBody(editor, "Typed again, never settled.");
  // And the outside writer, so the drift proof PASSES. Without it that proof
  // alone makes this close loud and the settled-coverage check below is never
  // the reason — the test would hold with the counter deleted.
  await writeFile(join(root, PATH), "# Solo\n\nEdited in another app.\n", "utf8");
  settleRefusal = wireRefusal("conflict-stale-target");
  // The release is left to SUCCEED — the replicated close.
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  expect(states).toEqual(["settling", "error"]);
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
});

// The P1 the first version of #496 shipped: the refusal is NOT the outcome.
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

  // Loud, and it STAYS loud: no correction may follow a release that failed.
  expect(states).toEqual(["settling", "error"]);
  expect(captureErrors).toContain(`ydoc settle of ${PATH}`);
  // And the path keeps its guard, because the reservation was never released:
  // a watcher event stays deferred behind the failing-close entry.
  settleRefusal = null;
  closeRefusal = null;
  const writesBeforeWatcher = methodCount(VERSIONED_METHOD.textWrite);
  await writeFile(join(root, PATH), "# Solo\n\nWritten outside dohc.\n", "utf8");
  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();
  expect(methodCount(VERSIONED_METHOD.textWrite)).toBe(writesBeforeWatcher);
});

// AUDIT-SILENTSAVE, #514. The save indicator's whole job is to not lie, and
// the seq is how it keeps that promise: a settle may only vouch for edits it
// actually carried. This drives the SAME wiring main.ts's IPC handlers use —
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
// #534 — the absent-head contract stated on WorkspaceEngineCapture.openYDocSession.
//
// The daemon does NOT refuse an open for a path the entered version has no
// snapshot for: it derives an object id and binds an EMPTY doc, which is the
// only reason a just-created file is editable before capture ingests it. Both
// halves of the contract are pinned here, because the guard is only correct if
// it separates them: refusing everything would break creation, and refusing
// nothing is the phantom file.
it("refuses a live session for a path the entered version does not have", async () => {
  // The #534 interleaving, at the point it actually decides: the user clicked
  // draftOnly.md while switchVersion("main") was on the capture chain, so the
  // open runs AFTER the switch — against a version with no snapshot for the
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
  // with `wx` as an EMPTY file and the editor opens it immediately. The version
  // has no snapshot yet (capture is asynchronous), so this open takes the SAME
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

it("refuses an uncaptured artifact that HAS content, without calling it missing", async () => {
  // Head absent but the file is really on disk with bytes in it. The daemon
  // seeds an absent-head bind from the HEAD, so the doc comes up empty and the
  // first settle would erase the file. Refuse the session — but this is an
  // ordinary refusal: the file exists, so the caller keeps the plain editor and
  // must NOT tell the user the version does not have it.
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

it("opens a crash-orphaned draft the daemon resurrects, head absent and all", async () => {
  // actor.rs keeps a never-settled local lineage alive: its CRDT rows are the
  // ONLY copy of what the user typed before the crash, and the version has no
  // snapshot for the path. Refusing on `head` alone would strand those edits —
  // and the settle:false close of a dirty lineage is itself refused, wedging
  // the lease so the path could never be opened again.
  const ORPHANED = "notes/orphanedDraft.md";
  ydoc.seedFile({
    workspace: WORKSPACE_ID,
    versionId: "main",
    path: ORPHANED,
    markdown: "",
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

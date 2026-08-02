import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  YdocLoopbackEngine,
  type EngineTransport,
  type Event,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { nativeTmpdir } from "./testTemp";

const WORKSPACE_ID = "engine-ydoc-session-test";
const PATH = "notes/solo.md";
const INITIAL_MARKDOWN = "# Solo\n\nStart here.\n";

let root = "";
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
  code: "INVALID_PARAMS" | "INTERNAL" = "INVALID_PARAMS",
): Error {
  return Object.assign(new Error(message), {
    wireError: { code, message, retry: "no" },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-ydoc-session-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, PATH), INITIAL_MARKDOWN, "utf8");
  requests = [];
  settleRefusal = null;
  closeRefusal = null;
  captureErrors = [];
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

  expect(ydoc.recordedUpdates).toHaveLength(1);
  expect(await readFile(join(root, PATH), "utf8")).toContain(
    "Typed with no collaboration server.",
  );
  const writesBeforeWatcher = methodCount(VERSIONED_METHOD.textWrite);

  capture.captureBatch([{ path: PATH, operation: "update" }]);
  await capture.flush();

  expect(methodCount(VERSIONED_METHOD.textWrite)).toBe(writesBeforeWatcher);
  await session.close({ settle: false });
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

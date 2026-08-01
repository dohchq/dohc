import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

beforeEach(async () => {
  root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-ydoc-session-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, PATH), INITIAL_MARKDOWN, "utf8");
  requests = [];
  versioned = new VersionedLoopbackEngine();
  versioned.seedTextFile({
    workspace: WORKSPACE_ID,
    versionId: "main",
    path: PATH,
    text: INITIAL_MARKDOWN,
  });
  ydoc = new YdocLoopbackEngine();
  seedYdoc("main");
  sessions = daemonSessions();
  capture = createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    rustEngineSessions: sessions,
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

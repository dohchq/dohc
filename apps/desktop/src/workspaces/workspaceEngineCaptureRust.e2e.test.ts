import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { foldScene, insertElementRevision } from "@dohc/excalidraw-scene";
import pipelineFixture from "../../../../crates/dohc-engine-domain/tests/fixtures/collection-field-pipeline.json";
import { defaultWorkspaceMode, type WatcherEvent } from "@dohc/workspace-core";
import type {
  AttachedEngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import {
  VersionedLiveAdapter,
  isWorkspaceUpdatingRefusal,
  openEngineYdocProviderSession,
  type EngineTransport,
} from "@dohc/workspace-engine-client";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture,
  isYDocOutsideWriteWaitingError,
  isYDocPathNotInVersionError,
  type WorkspaceEngineCaptureFailure,
  type WorkspaceEngineCaptureOptions,
  YDocUncapturedArtifactError,
  DAEMON_CAPTURE_HEALTH_POLL_MS,
} from "./workspaceEngineCapture";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { createInMemoryWorkspaceActivity as createWorkspaceActivity } from "./workspaceActivity.testSupport";
import { startWorkspaceFileObservation } from "./workspaceFileObservation";
import { EngineFileObservation } from "@dohc/workspace-engine-client/daemon";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
  REAL_DAEMON_DEADLINE_MS,
} from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { listLiveDraftRecovery, workspaceDraftStore } from "./liveDraftRecovery";
import { waitForPathMoments } from "./waitForPathMoments";
import { encodeFixtureBigInts } from "@dohc/workspace-engine-client/testing";
import { decodeCollectionValue } from "../../../../packages/workspace-engine-client/src/workspace/workspaceWireContract";
import type { JsonValue } from "@dohc/workspace-engine-client";

// The person a restore names, as desktop main reads them.
const RESTORER = { kind: "human", humanId: "local-person" } as const;

function createWorkspaceEngineCapture(
  options: Omit<WorkspaceEngineCaptureOptions, "attachmentId">,
) {
  return createAttachedWorkspaceEngineCapture({
    ...options,
    attachmentId: Symbol(`test-workspace-attachment:${options.workspaceId}`),
  });
}

function decodePipelineFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodePipelineFixtureValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (
      entries.length === 1 &&
      entries[0]?.[0] === "$dohcInt64" &&
      typeof entries[0][1] === "string"
    ) {
      return BigInt(entries[0][1]);
    }
    return Object.fromEntries(
      entries.map(([key, child]) => [key, decodePipelineFixtureValue(child)]),
    );
  }
  return value;
}

// This suite looked only under the repo root, so it skipped everywhere from the
// day it was written and its coverage came and went with whoever last ran
// `cargo build`. The shared gate also checks apps/desktop/target/debug,
// which is where the app under test and the staged-binary harnesses put it.
const engine = requireEngineBinaryOrSkip();

it.skipIf(engine.missing)("does not reopen deferred records from the real pending query on health polls", async () => {
  const root = await createTestScratch("dohc-real-deferred-poll-");
  await mkdir(join(root, "tasks"), { recursive: true });
  await writeFile(join(root, "tasks/collection.yaml"), "fields: {}\n");
  await writeFile(join(root, "tasks/record.md"), "Body\n");
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const workspace = { workspaceId: "real-deferred-poll", rootPath: root, attachmentId: Symbol("deferred-poll") };
  const seedCapture = createAttachedWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions });
  let pollingCapture: ReturnType<typeof createAttachedWorkspaceEngineCapture> | undefined;
  await lifecycle.start();
  try {
    await waitForPathMoments(seedCapture, "tasks/record.md", 1);
    const session = await sessions.run(workspace, ({ client, workspace: handle }) => {
      if (typeof client.onEvent !== "function") throw new Error("Daemon fixture needs Y.Doc events");
      return openEngineYdocProviderSession({ transport: client as EngineTransport, workspace: handle,
        versionId: "main", path: "tasks/record.md", contentKind: "plaintext", onRemoteUpdate: () => undefined });
    });
    expect(session.contentKind).toBe("plaintext");
    await session.evict();
    await seedCapture.stop();
    await sessions.closeWorkspace(workspace);
    const adapter = await sessions.run(workspace, async ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId: workspace.workspaceId }));
    await adapter.reconcileCapture();
    expect((await adapter.queryCollectionRecords({ collectionPath: "tasks" })).records).toHaveLength(1);
    expect((await adapter.listPendingCollectionAdoptions()).adoptions).toEqual([]);

    const liveStore = createCaptureLiveStores(workspace, sessions).store;
    const pending = vi.spyOn(liveStore, "listPendingCollectionAdoptions");
    const reconcile = vi.spyOn(liveStore, "reconcileCapture");
    const open = vi.fn(async () => { throw new Error("deferred record must not open"); });
    const errors = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    pollingCapture = createAttachedWorkspaceEngineCapture({ ...workspace, store: liveStore,
      rustEngineSessions: sessions, openRustYDocProviderSession: open, onError: errors });
    pollingCapture.start();
    await pollingCapture.flush();
    const initialPolls = pending.mock.calls.length;
    const initialReconciles = reconcile.mock.calls.length;
    for (let poll = 0; poll < 3; poll++) {
      await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
      await pollingCapture.flush();
    }
    expect(pending.mock.calls.length).toBeGreaterThan(initialPolls);
    for (const result of pending.mock.results) {
      expect((await result.value).adoptions).toEqual([]);
    }
    expect(reconcile).toHaveBeenCalledTimes(initialReconciles);
    expect(open).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    await pollingCapture?.stop();
    await seedCapture.stop();
    await sessions.closeAll();
    await lifecycle.stop();
    vi.restoreAllMocks();
  }
}, 60_000);

async function waitForDaemonCaptureDeferral(
  sessions: EngineWorkspaceSessions,
  workspace: AttachedEngineWorkspace,
): Promise<void> {
  const deadline = performance.now() + REAL_DAEMON_DEADLINE_MS;
  while (performance.now() < deadline) {
    const status = await sessions.run(
      workspace,
      async ({ client, workspace: handle }) => {
        const engine = new VersionedLiveAdapter(client, handle, {
          workspaceId: workspace.workspaceId,
        });
        expect(await engine.flushCapture()).toMatchObject({ settled: true, degraded: false });
        return engine.watcherStatus();
      },
    );
    if (status.deferredWrites.length > 0) return;
    await delay(25);
  }
  throw new Error("Daemon capture did not report its live-session deferral.");
}

// The one `<stem> (recovered …).md` beside `<stem>.md` at the workspace root,
// once the reopened daemon has written it. Same bounded poll as the moment
// waits: the file lands after the open-time replay, not on a fixed clock.
async function waitForRecoveredSibling(root: string, stem: string): Promise<string> {
  const prefix = `${stem} (recovered `;
  let matches: string[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    matches = (await readdir(root)).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".md"),
    );
    if (matches.length === 1) return matches[0]!;
    await delay(25);
  }
  throw new Error(
    `Expected exactly one recovered sibling of ${stem}.md, found ${JSON.stringify(matches)}.`,
  );
}

async function listDaemonPathMoments(
  sessions: EngineWorkspaceSessions,
  workspace: AttachedEngineWorkspace,
  path: string,
) {
  const page = await sessions.run(
    workspace,
    async ({ client, workspace: handle }) =>
      await new VersionedLiveAdapter(client, handle, {
        workspaceId: workspace.workspaceId,
      }).listMoments({ workspaceId: workspace.workspaceId, limit: 100 }),
  );
  return page.moments.filter((moment) => moment.path === path);
}

it.skipIf(engine.missing).each([false, true])(
  "preserves hand-made Markdown opened before adoption (later edit=%s)",
  async laterEdit => {
    const root = await createTestScratch("dohc-open-lossless-adoption-");
    const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const workspace = { workspaceId: "open-lossless-adoption", rootPath: root, attachmentId: Symbol("lossless") };
    const errors: unknown[] = [];
    const capture = createAttachedWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions, settleDebounceMs: 60_000,
      onError: (_context, error) => { errors.push(error); } });
    const original = "A setext heading\n================\n\n* first\n* second\n";
    try {
      const adapter = await sessions.run(workspace, async ({ client, workspace: handle }) =>
        new VersionedLiveAdapter(client, handle, { workspaceId: workspace.workspaceId }));
      await adapter.ensureMainVersion({ workspaceId: workspace.workspaceId });
      for (const [path, text] of [["tasks/collection.yaml", "fields: {}\n"], ["tasks/record.md", original]]) {
        await adapter.writeTextFile({ workspaceId: workspace.workspaceId, versionId: "main", path: path!, text: text!, publish: true,
          metadata: { origin: "api" } });
      }
      await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length,
        { timeout: 60_000 }).toBe(1);
      const session = await capture.openYDocSession({ path: "tasks/record.md", contentKind: "richdoc", onRemoteUpdate: () => undefined });
      if (laterEdit) {
        await session.applyDecidedLocalUpdate(doc => {
          const scratch = new Y.Doc();
          try { Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
            patchFrontmatter(scratch, new Map([["Name", "Edited"]])); return Y.encodeStateAsUpdate(scratch, before);
          } finally { scratch.destroy(); }
        }, undefined, { idempotencyKey: "lossless-edit" });
      }
      await capture.flush();
      await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length,
        { timeout: 60_000 }).toBe(0);
      const adopted = await readFile(join(root, "tasks/record.md"), "utf8");
      if (laterEdit) {
        expect(adopted).toBe(original);
        expect(session.doc.getMap("frontmatter").get("id")).toBeUndefined();
        expect((await adapter.queryCollectionRecords({ collectionPath: "tasks" })).records).toEqual([]);
      } else {
        expect(adopted.replace(/^---\nid: [^\n]+\n---\n\n/, "")).toBe(original);
        expect(session.doc.getMap("frontmatter").get("id")).toBeTruthy();
        await session.settleNow();
        expect(await readFile(join(root, "tasks/record.md"), "utf8")).toBe(adopted);
      }
      expect(errors).toEqual([]);
      await session.close();
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll(); await lifecycle.stop();
    }
  }, 120_000,
);

it.skipIf(engine.missing)(
  "adopts rich collection Markdown through the shared Y.Doc importer without flattening it",
  async () => {
    const root = await createTestScratch("dohc-capture-rich-adoption-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await mkdir(join(root, "tasks"), { recursive: true });
    await writeFile(
      join(root, "tasks", "collection.yaml"),
      "name: Tasks\nfields:\n  status:\n    type: text\n",
      "utf8",
    );
    const body = [
      "| Metric | Value |",
      "| ------ | ----- |",
      "| apples | 10    |",
      "",
      "- parent",
      "  - nested with **bold** and [details](https://example.com)",
    ].join("\n");
    const original = `---\nstatus: open\n---\n\n${body}`;
    await writeFile(join(root, "tasks", "rich.md"), original, "utf8");
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const workspace = {
      workspaceId: "capture-rich-adoption",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment:capture-rich-adoption"),
    };
    const capture = createAttachedWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
    });
    try {
      // `capture.flush()` drains changes the OS watcher has already observed;
      // it deliberately cannot promise that the watcher's startup debounce
      // has seen these pre-existing files. Wait on the record's durable
      // capture moment, then flush the pending rich-document adoption.
      await waitForPathMoments(capture, "tasks/collection.yaml", 1);
      await waitForPathMoments(capture, "tasks/rich.md", 1);
      await capture.flush();
      const query = await sessions.run(
        workspace,
        async ({ client, workspace: handle }) =>
          await new VersionedLiveAdapter(client, handle, {
            workspaceId: workspace.workspaceId,
          }).queryCollectionRecords({ collectionPath: "tasks" }),
      );
      expect(query.records).toHaveLength(1);
      expect(query.records[0]?.path).toBe("tasks/rich.md");
      const recordId = query.records[0]?.id;
      expect(recordId).toBeTruthy();
      const settled = await readFile(join(root, "tasks", "rich.md"), "utf8");
      const prefix = `---\nid: ${recordId}\nstatus: open\n---\n\n`;
      expect(settled).toBe(`${prefix}${body}`);
      expect(settled.slice(prefix.length)).toBe(body);
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

it.skipIf(engine.missing)(
  "round-trips every v1 collection field type through the real daemon",
  async () => {
    const root = await createTestScratch("dohc-capture-field-pipeline-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await mkdir(join(root, "pipeline"), { recursive: true });
    await mkdir(join(root, "pipeline-targets"), { recursive: true });
    await writeFile(
      join(root, "pipeline", "collection.yaml"),
      pipelineFixture.schemaYaml,
      "utf8",
    );
    for (const support of pipelineFixture.supportFiles) {
      await writeFile(join(root, support.path), support.text, "utf8");
    }
    expect(
      createHash("sha256")
        .update(pipelineFixture.recordMarkdown, "utf8")
        .digest("hex"),
    ).toBe(pipelineFixture.recordMarkdownSha256);
    await writeFile(
      join(root, "pipeline", "imported.md"),
      pipelineFixture.recordMarkdown,
      "utf8",
    );
    await writeFile(
      join(root, "pipeline", "edited.md"),
      "---\n---\n\nUI-edited record",
      "utf8",
    );

    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const workspace = {
      workspaceId: "capture-field-pipeline",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment:capture-field-pipeline"),
    };
    const capture = createAttachedWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
    });
    const queryRecords = async () =>
      await sessions.run(
        workspace,
        async ({ client, workspace: handle }) =>
          await new VersionedLiveAdapter(client, handle, {
            workspaceId: workspace.workspaceId,
          }).queryCollectionRecords({ collectionPath: "pipeline" }),
      );

    try {
      for (const path of [
        "pipeline/collection.yaml",
        "pipeline/imported.md",
        "pipeline/edited.md",
        ...pipelineFixture.supportFiles.map((support) => support.path),
      ]) {
        await waitForPathMoments(capture, path, 1);
      }
      await capture.flush();

      const importedQuery = await queryRecords();
      const imported = importedQuery.records.find(
        (record) => record.path === "pipeline/imported.md",
      );
      const editedBefore = importedQuery.records.find(
        (record) => record.path === "pipeline/edited.md",
      );
      expect(imported).toBeDefined();
      expect(editedBefore).toBeDefined();
      expect(imported?.values).toHaveLength(pipelineFixture.vectors.length);
      expect(editedBefore?.values).toEqual([]);

      const session = await capture.openYDocSession({
        path: "pipeline/edited.md",
        contentKind: "richdoc",
        onRemoteUpdate: () => undefined,
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const before = Y.encodeStateVector(editor);
      const frontmatter = editor.getMap<unknown>("frontmatter");
      for (const vector of pipelineFixture.vectors) {
        frontmatter.set(
          vector.fieldName,
          decodePipelineFixtureValue(vector.expectedSemantic),
        );
      }
      const update = Y.encodeStateAsUpdate(editor, before);
      expect(update.byteLength).toBeGreaterThan(0);
      await session.applyLocalUpdate(update);
      await session.settleNow();
      await session.close();

      const finalQuery = await queryRecords();
      const finalImported = finalQuery.records.find(
        (record) => record.path === "pipeline/imported.md",
      );
      const finalEdited = finalQuery.records.find(
        (record) => record.path === "pipeline/edited.md",
      );
      expect(finalImported).toBeDefined();
      expect(finalEdited).toBeDefined();
      const importedValues = new Map(
        finalImported?.values.map((value) => [value.field, value]),
      );
      const editedValues = new Map(
        finalEdited?.values.map((value) => [value.field, value]),
      );
      for (const vector of pipelineFixture.vectors) {
        const importedValue = importedValues.get(vector.fieldName);
        const editedValue = editedValues.get(vector.fieldName);
        const expected = decodePipelineFixtureValue(vector.expectedSemantic);
        expect(importedValue?.value, `${vector.name} imported`).toEqual(expected);
        expect(editedValue?.value, `${vector.name} edited`).toEqual(expected);
        expect(importedValue?.validation, `${vector.name} imported`).toEqual(
          vector.expectedValidation,
        );
        expect(editedValue?.validation, `${vector.name} edited`).toEqual(
          vector.expectedValidation,
        );
        // The daemon escapes marker-spelled keys on the wire and the client
        // decode unescapes them, so the round-tripped value must match the
        // DECODED expected wire form, not the wire bytes themselves.
        expect(
          JSON.stringify(encodeFixtureBigInts(importedValue?.value)),
          `${vector.name} round-trip JSON`,
        ).toBe(
          JSON.stringify(
            encodeFixtureBigInts(
              decodeCollectionValue(vector.expectedWireValue as JsonValue),
            ),
          ),
        );
      }
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

it.skipIf(engine.missing)(
  "drives watcher-batch capture, readback, and version-switch materialization through the real daemon",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-e2e-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-e2e",
      rootPath: root,
      rustEngineSessions: sessions,
    });
    try {
      const mainText = `main\n${"m".repeat(64 * 1024)}`;
      const draftText = `draft\n${"d".repeat(64 * 1024)}`;
      await writeFile(join(root, "note.md"), mainText, "utf8");
      capture.observeFileEvents([{ path: "note.md", operation: "update" }]);
      await capture.flush();
      expect(await capture.fileObjectIdForPath("note.md")).toBeTruthy();

      const activeRun = {
        agentId: "dohc-e2e-agent",
        onBehalfOf: "local",
        agentRunId: "run-rust-capture-author",
        depth: 0,
      };
      await capture.setActiveAgentRun(activeRun);
      await writeFile(join(root, "agent-note.md"), "written by agent\n", "utf8");
      capture.observeFileEvents([{ path: "agent-note.md", operation: "update" }]);
      const [agentMoment] = await waitForPathMoments(
        capture,
        "agent-note.md",
        1,
      );
      await capture.setActiveAgentRun(null);
      // A run a person started names no depth: absent means 0.
      const { depth: _personDepth, ...personRun } = activeRun;
      expect(agentMoment?.authors).toEqual([{ kind: "agent", ...personRun }]);

      // A run an automation started names its depth, and history keeps it.
      const wokenRun = { ...activeRun, agentRunId: "run-rust-capture-woken", depth: 3 };
      await capture.setActiveAgentRun(wokenRun);
      await writeFile(join(root, "woken-note.md"), "written by a woken agent\n", "utf8");
      capture.observeFileEvents([{ path: "woken-note.md", operation: "update" }]);
      const [wokenMoment] = await waitForPathMoments(capture, "woken-note.md", 1);
      await capture.setActiveAgentRun(null);
      expect(wokenMoment?.authors).toEqual([{ kind: "agent", ...wokenRun }]);

      const draft = await capture.createVersion("Draft");
      await writeFile(join(root, "note.md"), draftText, "utf8");
      capture.observeFileEvents([{ path: "note.md", operation: "update" }]);
      await capture.flush();

      await capture.switchVersion("main");
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(mainText);
      await capture.switchVersion(draft.activeVersionId);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(draftText);

      const firstBinary = new Uint8Array(64 * 1024).fill(0x11);
      const secondBinary = new Uint8Array(64 * 1024).fill(0x22);
      await writeFile(join(root, "asset.bin"), firstBinary);
      await waitForPathMoments(capture, "asset.bin", 1);
      await writeFile(join(root, "asset.bin"), secondBinary);
      const binaryMoments = await waitForPathMoments(
        capture,
        "asset.bin",
        2,
      );
      const binaryEdit = binaryMoments[0];
      expect(binaryEdit).toBeTruthy();

      const { restoredMomentId } = await capture.restoreFileToBeforeMoment(binaryEdit!.id, RESTORER);
      expect(await readFile(join(root, "asset.bin"))).toEqual(
        Buffer.from(firstBinary),
      );
      const restored = (await capture.listMoments({ limit: 100 })).moments
        .find((moment) => moment.id === restoredMomentId);
      expect(restored?.authors).toEqual([RESTORER]);
    } finally {
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  60_000,
);

// Another app (Notepad, an agent, `>>`) writes the.md while the
// document is open in dohc. The session's close runs a pre-close settle; the
// engine answers it from the lineage's last settled content and never touches
// the drifted file, and the desktop then mirrored those bytes over it — the
// outside edit vanished from disk, recoverable only by knowing to open
// History. The mirror write is the clobber, so this test reads DISK.
it.skipIf(engine.missing)(
  "keeps an edit made outside dohc when the open document closes",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-drift-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-drift",
      rootPath: root,
      rustEngineSessions: sessions,
    });
    const outside = "written outside dohc\n";
    try {
      await writeFile(join(root, "note.md"), "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);

      const session = await capture.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const before = Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0, "typed in dohc\n");
      await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      const settled = await session.settleNow();
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(
        settled?.content,
      );

      // The outside writer replaces the file. Nothing is typed afterwards, so
      // the close settle has the same projection it already settled.
      await writeFile(join(root, "note.md"), outside, "utf8");
      // Whether the daemon's own capture reached the outside edit before this
      // close decides which answer the engine gives (a refused settle, or one
      // answered from the lineage). The FILE must survive either way, so the
      // close error — race-dependent, and its own issue — is not asserted.
      await session.close().catch(() => undefined);

      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // The other half of the promise: nothing the editor held is lost — the
      // typed text stays in History.
      const moments = await capture.listMoments({ limit: 100 });
      const texts = await Promise.all(
        moments.moments
          .filter((moment) => moment.path === "note.md")
          .map(async (moment) => {
            const detail = await capture.readMoment(moment.id);
            const payload = detail?.protected === false ? detail.moment.payload : undefined;
            return payload?.after.text ?? "";
          }),
      );
      expect(texts.some((text) => text.includes("typed in dohc"))).toBe(true);
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

it.skipIf(engine.missing)(
  "preserves a settled watcher capture across stopAll and a new daemon process",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-stop-");
    const workspace: CreatedWorkspace = {
      workspaceId: "capture-rust-stop",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const firstLifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await firstLifecycle.start();
    const firstSessions = createRealDaemonWorkspaceSessions(firstLifecycle);
    const openedState: {
      capture: ReturnType<typeof createWorkspaceEngineCapture> | null;
    } = { capture: null };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (openedWorkspace) => {
        const capture = createWorkspaceEngineCapture({
          workspaceId: openedWorkspace.workspaceId,
          rootPath: openedWorkspace.rootPath,
          rustEngineSessions: firstSessions,
        });
        openedState.capture = capture;
        return { capture, shareView: false };
      },
    });

    try {
      await activity.open(workspace);
      const capture = openedState.capture;
      if (!capture) throw new Error("workspace capture did not open");

      // Prove the daemon's startup baseline has finished before the write that
      // stopAll must drain. Otherwise the baseline scan can race that write and
      // make the shutdown assertion pass for the wrong reason.
      await writeFile(join(root, "baseline-ready.md"), "ready\n", "utf8");
      await waitForPathMoments(capture, "baseline-ready.md", 1);

      const finalText = "must survive shutdown\n";
      await writeFile(join(root, "final.md"), finalText, "utf8");
      // Prove the Rust watcher captured the settled write before shutdown. The
      // request-order unit test covers stopAll's flush-before-close contract;
      // this real-daemon test covers durable preservation across process exit.
      await waitForPathMoments(capture, "final.md", 1);

      // stopAll must not lose an already-settled durable capture.
      await activity.stopAll();
      await firstSessions.closeAll();
      await firstLifecycle.stop();

      // Remove the disk source while no daemon is running. A later scan can
      // record a delete, but it cannot recreate the persisted write moment.
      await rm(join(root, "final.md"));

      const secondLifecycle = createRealDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      await secondLifecycle.start();
      const secondSessions = createRealDaemonWorkspaceSessions(secondLifecycle);
      const reopened = createWorkspaceEngineCapture({
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        rustEngineSessions: secondSessions,
      });
      try {
        const moments = await waitForPathMoments(reopened, "final.md", 1);
        const persistedWrite = moments.find(
          (moment) => moment.operation === "write",
        );
        expect(persistedWrite).toBeTruthy();
        const detail = await reopened.readMoment(persistedWrite!.id);
        const payload = detail?.protected === false ? detail.moment.payload : undefined;
        expect(payload?.after.text).toBe(finalText);
      } finally {
        await reopened.stop().catch(() => undefined);
        await secondSessions.closeAll().catch(() => undefined);
        await secondLifecycle.stop().catch(() => undefined);
      }
    } finally {
      await activity.stopAll().catch(() => undefined);
      await firstSessions.closeAll().catch(() => undefined);
      await firstLifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

// The domain-code translation is asserted on the loopback in
// workspaceVersionOperations.test.ts. It is asserted here against the real
// daemon because the loopback is where those codes could quietly stop matching
// the engine's: the translation reads the refusal message, and a fixture is free
// to write any message it likes.
it.skipIf(engine.missing)(
  "reports refusals from the real daemon under their domain error codes",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-codes-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-codes",
      rootPath: root,
      rustEngineSessions: sessions,
    });
    try {
      await capture.createVersion("Draft");
      await expect(capture.createVersion("Draft")).rejects.toMatchObject({
        code: "version-name-conflict",
      });
      await expect(capture.switchVersion("no-such-version")).rejects.toMatchObject({
        code: "version-not-found",
      });
    } finally {
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  60_000,
);

// #496 under the live-session capture gate: the daemon observes the outside
// edit but cannot ingest it while the Y.Doc lease is live. The deferred path
// is the ordering proof. A clean close releases the lease, after which the
// queued disk edit becomes a capture moment.
it.skipIf(engine.missing)(
  "closes clean, then captures an outside edit deferred by its live lease",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-race-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const errors: string[] = [];
    const workspace = {
      workspaceId: "capture-rust-race",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment:capture-rust-race"),
    };
    const capture = createAttachedWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
      onError: (context) => errors.push(context),
    });
    const outside = "written outside dohc\n";
    try {
      await writeFile(join(root, "note.md"), "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);

      const states: string[] = [];
      const session = await capture.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
        onSaveState: (state) => states.push(state),
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const before = Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0, "typed in dohc\n");
      await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      await session.settleNow();
      const settledMoments = await listDaemonPathMoments(
        sessions,
        workspace,
        "note.md",
      );
      expect(settledMoments).toHaveLength(2);
      expect(
        settledMoments.some((moment) =>
          moment.afterText?.includes("typed in dohc"),
        ),
      ).toBe(true);

      // The outside writer replaces the file. Capture observes it, but the
      // live Y.Doc lease keeps the head at the last settled projection.
      await writeFile(join(root, "note.md"), outside, "utf8");
      await waitForDaemonCaptureDeferral(sessions, workspace);
      expect(
        await listDaemonPathMoments(sessions, workspace, "note.md"),
      ).toHaveLength(2);
      states.length = 0;
      errors.length = 0;

      // Nothing was typed since the verified settle. Close reuses that
      // settlement and releases the lease without settling or reporting save
      // states or errors. The outside author's bytes remain on disk.
      await expect(session.close()).resolves.toBeUndefined();
      expect(states).toEqual([]);
      expect(errors).toEqual([]);

      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // Reopening the workspace rebuilds the capture layer from its durable
      // manifest. That is the deterministic retry seam for the path the
      // live-lease refusal parked.
      await sessions.closeWorkspace(workspace);
      const capturedMoments = await waitForPathMoments(
        capture,
        "note.md",
        settledMoments.length + 1,
      );
      expect(capturedMoments).toHaveLength(3);
      expect(capturedMoments[0]?.id).not.toBe(settledMoments[0]?.momentId);
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

// dohchq/dohc#337 item 5, driven by its own mechanism: another app holds the
// `.md` open without FILE_SHARE_DELETE, so every attempt to replace it fails
// with a sharing violation. An ACL cannot model this — the workspace folder
// grants FILE_DELETE_CHILD, which lets the replace through a deny-write ACE on
// the file itself.
async function holdWithoutShareDelete(absolute: string): Promise<() => Promise<void>> {
  const script =
    `$f=[System.IO.File]::Open('${absolute.replace(/'/g, "''")}','Open','ReadWrite','Read');` +
    "Write-Output 'held';[Console]::In.ReadLine()|Out-Null;$f.Close()";
  const child = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes("held")) resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    child.on("exit", () => reject(new Error(`holder exited: ${seen}`)));
    child.on("error", reject);
  });
  return async () => {
    child.stdin.write("\n");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  };
}

// The journey behind #337 item 5, end to end through the real daemon. It was
// filed as "no retry OR error". PR #495 gave the save indicator honest
// states; #554 closes the retry half: a file-locked settle re-arms itself
// with backoff, so the write lands when the external handle releases — no
// further edit needed.
it.skipIf(engine.missing || process.platform !== "win32")(
  "surfaces a locked save and lands it by itself once the lock releases",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-lock-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const errors: string[] = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-lock",
      rootPath: root,
      rustEngineSessions: sessions,
      onError: (context) => errors.push(context),
    });
    const absolute = join(root, "note.md");
    let release: (() => Promise<void>) | null = null;
    try {
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);

      const states: string[] = [];
      const session = await capture.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
        onSaveState: (state) => states.push(state),
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const type = async (text: string) => {
        const before = Y.encodeStateVector(editor);
        editor.getText("plainText").insert(0, text);
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      };

      release = await holdWithoutShareDelete(absolute);
      await type("locked edit\n");

      // The item's first claim, refuted: the blocked save IS surfaced, and
      // named — the wire carries `file-locked` (Overloaded/afterBackoff), so
      // the editor gets its own state whose copy names the blocker instead
      // of advising another edit.
      await expect(session.settleNow()).rejects.toThrow();
      expect(states).toEqual(["saved", "settling", "file-locked"]);
      expect(errors).toEqual(["ydoc settle of note.md"]);
      expect(await readFile(absolute, "utf8")).toBe("base\n");

      // The retry can finish while the holder exits. Clear first so this test
      // does not erase the recovery state it is waiting for.
      states.length = 0;
      errors.length = 0;
      await release();
      release = null;

      // The item's second claim, closed: the provider retries the
      // settle on a doubling delay, so releasing the lock is followed by the
      // write landing BY ITSELF — no further edit. The retry replays the
      // durably pending materialization job through the idempotent settle.
      await expect.poll(() => states.includes("saved"), {timeout: 20_000}).toBe(true);
      expect(await readFile(absolute, "utf8")).toBe("locked edit\nbase\n");
      expect(states).toContain("saved");

      // And an ordinary settle keeps working after the recovery: both edits
      // stay in the file, so nothing the lock blocked was dropped.
      states.length = 0;
      await type("second edit\n");
      await session.settleNow();
      expect(states).toEqual(["settling", "saved"]);
      expect(await readFile(absolute, "utf8")).toBe(
        "second edit\nlocked edit\nbase\n",
      );

      await expect(session.close()).resolves.toBeUndefined();
    } finally {
      await release?.();
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  120_000,
);

// The half a refusal cannot answer, driven against the real daemon. Same
// deferred outside edit as above, but the user has unsettled edits when the
// close runs: the close-settle refuses ConflictStaleTarget, and then the
// release refuses too — a local-only prune needs the CRDT projection to equal
// `last_settled_sha` (crates/dohc-engine-collab/src/durable.rs). The outside
// edit waits for this session, so the close evicts it: the disk version
// stands and the unsettled text comes back as a recovered copy (#2463). The
// save refusal still reads as an error, never as "changed on disk".
it.skipIf(engine.missing)(
  "keeps unsettled edits in a recovered copy when their close meets a deferred outside edit",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-loud-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const errors: string[] = [];
    const workspace = {
      workspaceId: "capture-rust-loud",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment:capture-rust-loud"),
    };
    const capture = createAttachedWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
      onError: (context) => errors.push(context),
    });
    const outside = "written outside dohc\n";
    try {
      await writeFile(join(root, "note.md"), "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);

      const states: string[] = [];
      const session = await capture.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
        onSaveState: (state) => states.push(state),
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const type = async (text: string) => {
        const before = Y.encodeStateVector(editor);
        editor.getText("plainText").insert(0, text);
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      };
      await type("typed in dohc\n");
      await session.settleNow();
      const settledMoments = await listDaemonPathMoments(
        sessions,
        workspace,
        "note.md",
      );
      expect(settledMoments).toHaveLength(2);

      await writeFile(join(root, "note.md"), outside, "utf8");
      await waitForDaemonCaptureDeferral(sessions, workspace);
      expect(
        await listDaemonPathMoments(sessions, workspace, "note.md"),
      ).toHaveLength(2);

      // The difference from the clean case: text the engine has journaled but
      // never settled, so the projection no longer equals `last_settled_sha`
      // and the release cannot prune.
      await type("never settled\n");
      states.length = 0;
      errors.length = 0;

      await expect(session.close()).resolves.toBeUndefined();
      // The refused save reads as the change made outside dohc, which clears
      // its save-failure notice. No capture poll ran before this close.
      expect(states).toContain("error");
      expect(states.at(-1)).toBe("changed-on-disk");
      expect(errors).toContain("ydoc settle of note.md");

      // The close recorded the queued disk edit without letting the refused
      // Y.Doc save overwrite it.
      const capturedMoments = await waitForPathMoments(capture, "note.md", 4);
      expect(capturedMoments).toHaveLength(4);
      const recovery = capturedMoments.find(moment => moment.metadata.origin === "capture-recovery");
      expect(recovery).toBeDefined();
      const detail = await capture.readMoment(recovery!.id);
      if (!detail || detail.protected) throw new Error("recovery must have a readable History payload");
      expect(detail.moment.payload.before?.text).toBe("never settled\ntyped in dohc\nbase\n");
      expect(detail.moment.payload.after?.text).toBe(outside);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // The outside bytes became the file. The text the engine admitted but
      // never settled is not discarded with the lineage: it comes back as an
      // ordinary sibling file, complete, with its own History moment.
      const recovered = await waitForRecoveredSibling(root, "note");
      expect(await readFile(join(root, recovered), "utf8")).toBe(
        "never settled\ntyped in dohc\nbase\n",
      );
      const [recoveredMoment] = await waitForPathMoments(capture, recovered, 1);
      expect(recoveredMoment?.metadata.origin).toBe("ydoc");
      expect(recoveredMoment?.metadata.summary).toBe(
        "Recovered unsaved edits from note.md after a later write changed the file.",
      );
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

// #534 against the real daemon, which is the only place `head` actually
// crosses the wire. The loopback tests state what the daemon does; this proves
// the daemon does it — that an absent head really comes back absent, and that
// the three outcomes the contract distinguishes are the three that happen.
it.skipIf(engine.missing)(
  "refuses a live session for a path the version does not have, and still opens a new file",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-absent-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-absent-head",
      rootPath: root,
      rustEngineSessions: sessions,
    });
    try {
      // Nothing in the version, nothing on disk: the path is not here.
      const refusal = await capture
        .openYDocSession({ path: "gone.md", onRemoteUpdate: () => undefined })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isYDocPathNotInVersionError(refusal)).toBe(true);
      // The refusal wrote nothing. This is the phantom, at the real boundary.
      await expect(readFile(join(root, "gone.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      // On disk with content but not captured yet: refused, but not as missing.
      await writeFile(join(root, "uncaptured.md"), "real bytes", "utf8");
      const uncaptured = await capture
        .openYDocSession({
          path: "uncaptured.md",
          onRemoteUpdate: () => undefined,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(uncaptured).toBeInstanceOf(YDocUncapturedArtifactError);
      expect(await readFile(join(root, "uncaptured.md"), "utf8")).toBe(
        "real bytes",
      );

      // Creation, the case the daemon's absent-head bind exists for: an empty
      // artifact on disk, exactly what workspaceFiles.createFile leaves. The
      // open must be admitted — the guard above refused two paths in a row, and
      // a guard that refused this one too would look just as green.
      //
      // Deliberately stops at the open. Whether the daemon's own capture reaches
      // the new file before or after this runs is a race, and settling across it
      // is a separate, pre-existing conflict (the settle expects the head the
      // open saw). What is race-free, and what this proves, is that a
      // freshly-created empty artifact still opens against the real daemon.
      await writeFile(join(root, "created.md"), "", "utf8");
      const session = await capture.openYDocSession({
        path: "created.md",
        onRemoteUpdate: () => undefined,
      });
      expect(session.path).toBe("created.md");
      await session.close({ settle: false });
    } finally {
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  60_000,
);

// The engine's Markdown settlement rewrote unedited files on close —
// mangling CRLF and trailing newlines, churning mtimes, and feeding the
// watcher a settled write for content nobody changed. The engine now proves
// the session held nothing beyond the declared seed and skips the write. This
// drives the full desktop feed — real daemon, real capture, real fs watcher —
// and pins both halves: no edit means no watcher event; a real edit still
// produces one.
it.skipIf(engine.missing)(
  "a no-edit open and close of a README feeds the watcher nothing; a real edit still does",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-815-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const workspace = {
      workspaceId: "capture-rust-815", rootPath: root,
      attachmentId: Symbol("capture-rust-815"), kind: "personal", mode: defaultWorkspaceMode("personal"),
    } as const;
    const capture = createAttachedWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions });
    const readmePath = "notes/sample/README.md";
    // Both normalization victims at once: CRLF line endings and no trailing
    // newline. Any settle write would change these bytes.
    const readme = "# Sample\r\n\r\nOpened, never edited";
    const batches: WatcherEvent[][] = [];
    const readmeEvents = () =>
      batches.flat().filter((event) => event.path === readmePath);
    try {
      await mkdir(join(root, "notes", "sample"), { recursive: true });
      await writeFile(join(root, readmePath), readme, "utf8");
      await waitForPathMoments(capture, readmePath, 1);
      const watch = startWorkspaceFileObservation(workspace, sessions, lifecycle, {
        facts(facts) {
          const events: WatcherEvent[] = facts.map(fact => ({ path: fact.path, operation: fact.kind === "disappeared" ? "delete" : "update" }));
          capture.observeFileEvents(events); batches.push(events);
        },
        resync: () => capture.resyncFileObservation(), captured() {}, pulled() {}, degraded() {},
      });
      await watch.ready;
      try {
        const before = await stat(join(root, readmePath));
        const session = await capture.openYDocSession({
          path: readmePath,
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        await session.close();
        // A full settle window plus slack: any write the close made would
        // surface here.
        await sessions.run(workspace, async binding => { await new EngineFileObservation(binding.client, binding.workspace).drain(); });
        await watch.pulledPaths([]);
        expect(readmeEvents()).toEqual([]);
        expect(await readFile(join(root, readmePath), "utf8")).toBe(readme);
        const after = await stat(join(root, readmePath));
        expect(after.mtimeMs).toBe(before.mtimeMs);

        // The control half: a real edit must reach the feed exactly as
        // before the skip existed.
        const edited = await capture.openYDocSession({
          path: readmePath,
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        const editor = new Y.Doc();
        Y.applyUpdate(editor, edited.initialUpdate);
        const vector = Y.encodeStateVector(editor);
        const body = editor.getXmlFragment("body");
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("A real edit.")]);
        body.insert(body.length, [paragraph]);
        await edited.applyLocalUpdate(Y.encodeStateAsUpdate(editor, vector));
        await edited.close();
        await expect.poll(() => readmeEvents().length, { timeout: 60_000 }).toBeGreaterThan(0);
        expect(readmeEvents().length).toBeGreaterThan(0);
        expect(await readFile(join(root, readmePath), "utf8")).toContain(
          "A real edit.",
        );
      } finally {
        await watch.stop().catch(() => undefined);
      }
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

// No window shows these workspaces.
const NO_WINDOWS = { all: () => [], workspaceIdOf: () => undefined };

// A capture on its own real engine, with the reads desktop main bases two
// workspace notices on (dohc#2342). `health` first has the engine scan the
// folder, so it counts a change whether or not the watcher has reported it.
// Then it reads the newest moment as the shell does, which waits for capture
// to settle and fails as "dohc could not check whether open files changed"
// while History is still updating. Last, it answers the outcome of the first
// health poll, which raises History paused unless it is null.
async function openRealCapture(workspaceId: string, options: Partial<WorkspaceEngineCaptureOptions> = {}, existingRoot?: string) {
  const root = existingRoot ?? await createTestScratch(`dohc-${workspaceId}-`);
  const workspace = { workspaceId, rootPath: root, attachmentId: Symbol(workspaceId) };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const outcomes: WorkspaceEngineCaptureFailure[] = [];
  const capture = createAttachedWorkspaceEngineCapture({
    ...workspace, rustEngineSessions: sessions, onError: () => undefined, ...options,
    onCaptureOutcome: (failure) => outcomes.push(failure),
  });
  const health = async () => {
    await sessions.run(workspace, ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId }).reconcileCapture());
    const newestMoment = await capture.listMoments({ limit: 1 }).then(() => "read", (error: unknown) => {
      if (isWorkspaceUpdatingRefusal(error)) return "still updating";
      throw error;
    });
    capture.start();
    await vi.waitFor(() => expect(outcomes).not.toEqual([]), { timeout: REAL_DAEMON_DEADLINE_MS });
    return { newestMoment, health: outcomes[0] };
  };
  const stop = async () => {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  };
  const withEngine = <T>(run: (engine: VersionedLiveAdapter) => Promise<T>) => sessions.run(workspace,
    ({ client, workspace: handle }) => run(new VersionedLiveAdapter(client, handle, { workspaceId })));
  return { root, sessions, capture, health, stop, withEngine, workspaceId, stopEngine: () => lifecycle.stop() };
}

it.skipIf(engine.missing).each(["rename", "in-place"] as const)(
  "captures an outside %s write into an open document without pausing History (#2463)",
  async (style) => {
    const opened = await openRealCapture(`outside-write-${style}`, { settleDebounceMs: 60_000 });
    const editor = new Y.Doc();
    const base = "base\n";
    const outside = "written outside dohc\n";
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, base, "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const session = await opened.capture.openYDocSession({
        path: "note.md", contentKind: "plaintext",
        onRemoteUpdate: (update) => Y.applyUpdate(editor, update),
      });
      Y.applyUpdate(editor, session.initialUpdate);
      expect(editor.getText("plainText").toString()).toBe(base);

      if (style === "rename") {
        const temporary = join(opened.root, "note.md.tmp");
        await writeFile(temporary, outside, "utf8");
        await rename(temporary, absolute);
      } else {
        const file = await open(absolute, "r+");
        try {
          await file.truncate(0);
          await file.writeFile(outside, "utf8");
        } finally {
          await file.close();
        }
      }

      // Part (a) keeps this editor unchanged. Part (b) takes in the edit.
      expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
      expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["note.md"] });
      expect(await opened.withEngine((engine) => engine.flushCapture())).toMatchObject({ settled: true, deferredWrites: ["note.md"] });
      expect(await opened.withEngine((engine) => engine.reconcileCapture())).toMatchObject({ degraded: false, deferredWrites: ["note.md"] });
      expect(await opened.health()).toEqual({ newestMoment: "read", health: null });
      await writeFile(join(opened.root, "other.md"), "other file\n");
      await waitForPathMoments(opened.capture, "other.md", 1);
      await opened.withEngine(async (engine) => {
        const operationId = `dohc-operation:other-during-${style}`;
        const hold = await engine.holdCapture({ operationId });
        try {
          await engine.renameTextFile({ workspaceId: opened.workspaceId, versionId: "main",
            fromPath: "other.md", toPath: "moved.md", captureHoldId: hold.holdId, metadata: { origin: "api" } });
          await rename(join(opened.root, "other.md"), join(opened.root, "moved.md"));
        } finally { await engine.releaseCapture(hold.holdId); }
        await engine.undoHistoryOperation({ workspaceId: opened.workspaceId, operationId, requestId: `undo-other-${style}` });
        expect(await engine.watcherStatus()).toMatchObject({ deferredWrites: ["note.md"] });
      });
      expect.soft(await readFile(absolute, "utf8")).toBe(outside);
      // A refused pre-close save must still release the session's lease.
      await session.close().catch(() => undefined);
      await waitForPathMoments(opened.capture, "note.md", 2);
      const history = await opened.capture.listMoments({ limit: 100 }).then(async (page) =>
        Promise.all(page.moments.filter((moment) => moment.path === "note.md").map(async (moment) => {
          const detail = await opened.capture.readMoment(moment.id);
          return detail?.protected === false ? detail.moment.payload.after?.text : undefined;
        })),
      (error: unknown) => isWorkspaceUpdatingRefusal(error) ? "still updating" : Promise.reject(error));
      expect.soft(history).toEqual([outside, base]);
      expect.soft(await readFile(absolute, "utf8")).toBe(outside);
      expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
    } finally {
      await opened.stop();
      editor.destroy();
    }
  },
  60_000,
);

// An agent replaces an open note's file, by rename or in place.
async function writeOutside(absolute: string, text: string, style: "rename" | "in-place"): Promise<void> {
  if (style === "rename") {
    await writeFile(`${absolute}.tmp`, text, "utf8");
    await rename(`${absolute}.tmp`, absolute);
    return;
  }
  const file = await open(absolute, "r+");
  try {
    await file.truncate(0);
    await file.writeFile(text, "utf8");
  } finally {
    await file.close();
  }
}

// The editor's part of an open note: its Y.Doc, the save states main
// reports, and what main says when the file changed outside dohc.
async function openNote(capture: Pick<Awaited<ReturnType<typeof openRealCapture>>["capture"], "openYDocSession">) {
  const editor = new Y.Doc();
  const states: string[] = [];
  const changedOutside: boolean[] = [];
  const session = await capture.openYDocSession({
    path: "note.md", contentKind: "plaintext",
    onRemoteUpdate: (update) => Y.applyUpdate(editor, update),
    onSaveState: (state) => states.push(state),
    onChangedOutside: (unsaved) => changedOutside.push(unsaved),
  });
  Y.applyUpdate(editor, session.initialUpdate);
  // An agent's edit through dohc reaches the same session with its origin.
  const type = (text: string, author: "person" | "agent" = "person") => {
    const vector = Y.encodeStateVector(editor);
    editor.getText("plainText").insert(0, text);
    session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, vector), undefined, author === "agent"
      ? { actorOriginId: "test-agent", attribution: { actorKind: "agent", onBehalfOf: "local-person", depth: 0 } }
      : undefined);
  };
  return { editor, session, states, changedOutside, type, text: () => editor.getText("plainText").toString() };
}

const RECOVERED_COPY = /^note \(recovered [0-9a-f]{8} [0-9a-f]{64}\)\.md$/;

it.skipIf(engine.missing).each(["rename", "in-place"] as const)(
  "reloads an open note with nothing unsaved after a %s write outside dohc (#2463)",
  async (style) => {
    const opened = await openRealCapture(`reload-untouched-${style}`, { settleDebounceMs: 60_000 });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const note = await openNote(opened.capture);
      await writeOutside(absolute, "written outside dohc\n", style);
      opened.capture.start();
      await vi.waitFor(() => expect(note.changedOutside).toEqual([false]), { timeout: REAL_DAEMON_DEADLINE_MS });
      const reported = note.states.length;
      // The editor reopens by itself: its close saves nothing and answers
      // once capture recorded the disk version.
      await note.session.close();
      expect(note.states.slice(reported)).not.toContain("error");
      const reopened = await openNote(opened.capture);
      expect(reopened.text()).toBe("written outside dohc\n");
      await reopened.session.close();
      expect(await readdir(opened.root)).toEqual([".dohc", "note.md"]);
      expect(await readFile(absolute, "utf8")).toBe("written outside dohc\n");
      expect(await opened.health()).toEqual({ newestMoment: "read", health: null });
      expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing).each([
  ["person", "reload", "rename"], ["person", "reload", "in-place"], ["person", "close", "rename"], ["person", "close", "in-place"],
  ["agent", "reload", "rename"], ["agent", "close", "in-place"],
] as const)(
  "keeps the %s's unsaved edit in a copy on %s after a %s write outside dohc (#2463)",
  async (author, action, style) => {
    const opened = await openRealCapture(`reload-unsaved-${author}-${action}-${style}`, { settleDebounceMs: 60_000 });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const note = await openNote(opened.capture);
      note.type("typed ", author);
      await writeOutside(absolute, "written outside dohc\n", style);
      opened.capture.start();
      await vi.waitFor(() => expect(note.changedOutside).toEqual([true]), { timeout: REAL_DAEMON_DEADLINE_MS });
      // The editor keeps the person's text until they act.
      expect(note.text()).toBe("typed base\n");
      // Reload closes the session and opens it again. Closing the note is
      // the same close without the reopen.
      await note.session.close();
      if (action === "reload") {
        const reopened = await openNote(opened.capture);
        expect(reopened.text()).toBe("written outside dohc\n");
        await reopened.session.close();
      }
      expect(await readFile(absolute, "utf8")).toBe("written outside dohc\n");
      const copies = (await readdir(opened.root)).filter((name) => RECOVERED_COPY.test(name));
      expect(copies).toHaveLength(1);
      expect(await readFile(join(opened.root, copies[0]!), "utf8")).toBe("typed base\n");
      expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing)("treats unsettled text a reopened note starts with as unsaved (#2463)", async () => {
  const opened = await openRealCapture("reload-unsettled-restart", { settleDebounceMs: 60_000 });
  let restarted: Awaited<ReturnType<typeof openRealCapture>> | undefined;
  let releaseSettle = (): void => undefined;
  const settleGate = new Promise<void>((resolve) => { releaseSettle = resolve; });
  try {
    const absolute = join(opened.root, "note.md");
    await writeFile(absolute, "base\n", "utf8");
    await waitForPathMoments(opened.capture, "note.md", 1);
    const note = await openNote(opened.capture);
    await new Promise<void>((armed) => {
      const vector = Y.encodeStateVector(note.editor);
      note.editor.getText("plainText").insert(0, "typed ");
      note.session.applyLocalUpdate(Y.encodeStateAsUpdate(note.editor, vector), armed);
    });
    // Stop the daemon before any save, then open the note again. Its save of
    // the text it starts with waits, so an outside write arrives first.
    await opened.stopEngine();
    restarted = await openRealCapture("reload-unsettled-restart", { settleDebounceMs: 60_000, openSettleGate: () => settleGate }, opened.root);
    const reopened = await openNote(restarted.capture);
    expect(reopened.text()).toBe("typed base\n");
    await writeOutside(absolute, "written outside dohc\n", "rename");
    restarted.capture.start();
    await vi.waitFor(() => expect(reopened.changedOutside).toEqual([true]), { timeout: REAL_DAEMON_DEADLINE_MS });
    releaseSettle();
    await reopened.session.close();
    expect(await readFile(absolute, "utf8")).toBe("written outside dohc\n");
  } finally {
    releaseSettle();
    await restarted?.stop();
    await opened.stop();
  }
}, 60_000);

it.skipIf(engine.missing)("does not open a note again until capture records its outside version (#2463)", async () => {
  const root = await createTestScratch("dohc-capture-unrecorded-");
  const workspace = { workspaceId: "capture-unrecorded", rootPath: root, attachmentId: Symbol("capture-unrecorded") };
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Capture that does not record the outside version: its status keeps the
  // path waiting. Its flush can also fail.
  let captureRecords = false;
  let flushFails = false;
  const live = createCaptureLiveStores(workspace, sessions).store;
  const store = new Proxy(live, {
    get(target, property) {
      if (property === "watcherStatus") {
        return async () => {
          const status = await target.watcherStatus!();
          return captureRecords ? status : { ...status, deferredWrites: [...new Set([...status.deferredWrites, "note.md"])] };
        };
      }
      if (property === "flushCapture") {
        return async () => {
          if (flushFails) throw new Error("capture did not settle");
          await target.flushCapture!();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const errors: string[] = [];
  const capture = createAttachedWorkspaceEngineCapture({
    ...workspace, rustEngineSessions: sessions, store, settleDebounceMs: 60_000,
    onError: (context) => errors.push(context),
  });
  try {
    const absolute = join(root, "note.md");
    await writeFile(absolute, "base\n", "utf8");
    await waitForPathMoments(capture, "note.md", 1);
    const note = await openNote(capture);
    await writeOutside(absolute, "written outside dohc\n", "rename");
    capture.start();
    await vi.waitFor(() => expect(note.changedOutside).toEqual([false]), { timeout: REAL_DAEMON_DEADLINE_MS });
    // The close waits for capture, then says it could not record the change.
    await note.session.close();
    expect(errors).toContain("capture of note.md after its close");
    // Opening again would take the file back and show the old version.
    const refusal = await openNote(capture).then(() => null, (error: unknown) => error);
    expect(isYDocOutsideWriteWaitingError(refusal)).toBe(true);
    // A check that fails proves nothing either: the open still waits, and
    // says why.
    flushFails = true;
    const failedCheck = await openNote(capture).then(() => null, (error: unknown) => error);
    expect(isYDocOutsideWriteWaitingError(failedCheck)).toBe(true);
    expect(String((failedCheck as Error).cause)).toContain("capture did not settle");
    flushFails = false;
    // Once capture records it, the note opens on the disk version.
    captureRecords = true;
    const reopened = await openNote(capture);
    expect(reopened.text()).toBe("written outside dohc\n");
    await reopened.session.close();
  } finally {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  }
}, 60_000);

// Capture keeps a note's unsaved text in History when it records an outside
// version, but has nothing that keeps a drawing's strokes. A drawing keeps its
// guarded close: the close refuses, and the strokes stay in the open drawing.
it.skipIf(engine.missing)("keeps a drawing's unsaved strokes when its file changed outside dohc (#2463)", async () => {
  const opened = await openRealCapture("drawing-outside-write", { settleDebounceMs: 60_000 });
  const scene = (elements: unknown[]) => JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} });
  const stroke = { id: "stroke", x: 42, y: 17, type: "rectangle", version: 1, versionNonce: 1, isDeleted: false };
  try {
    const absolute = join(opened.root, "drawing.excalidraw");
    await writeFile(absolute, scene([]), "utf8");
    await waitForPathMoments(opened.capture, "drawing.excalidraw", 1);
    const editor = new Y.Doc();
    const states: string[] = [];
    const changedOutside: boolean[] = [];
    const session = await opened.capture.openYDocSession({
      path: "drawing.excalidraw", contentKind: "scene",
      onRemoteUpdate: (update) => Y.applyUpdate(editor, update),
      onSaveState: (state) => states.push(state),
      onChangedOutside: (unsaved) => changedOutside.push(unsaved),
    });
    Y.applyUpdate(editor, session.initialUpdate);
    await new Promise<void>((armed) => {
      const vector = Y.encodeStateVector(editor);
      insertElementRevision(editor, stroke);
      session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, vector), armed);
    });
    await writeOutside(absolute, scene([{ ...stroke, id: "outside" }]), "rename");
    opened.capture.start();
    await vi.waitFor(async () => expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["drawing.excalidraw"] }), { timeout: REAL_DAEMON_DEADLINE_MS });
    const closed = await session.close().then(() => null, (error: unknown) => error);
    // The close stays refused, and the lease stays held with the strokes.
    expect(closed).not.toBeNull();
    expect(foldScene(session.doc).elements.map((element) => element.id)).toEqual(["stroke"]);
    expect(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["drawing.excalidraw"] });
    // The drawing has no notice, and its chip promises nothing about History.
    expect(changedOutside).toEqual([]);
    expect(states).not.toContain("changed-on-disk");
  } finally {
    await opened.stop();
  }
}, 60_000);

it.skipIf(engine.missing)("keeps two open files' outside writes independent (#2463)", async () => {
  const opened = await openRealCapture("two-deferred-writes", { settleDebounceMs: 60_000 });
  try {
    const sessions = [];
    for (const path of ["first.md", "second.md"]) {
      await writeFile(join(opened.root, path), "base\n");
      await waitForPathMoments(opened.capture, path, 1);
      sessions.push(await opened.capture.openYDocSession({ path, contentKind: "plaintext", onRemoteUpdate: () => undefined }));
      await writeFile(join(opened.root, path), `outside ${path}\n`);
      expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
    }
    expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ deferredWrites: ["first.md", "second.md"] });
    await sessions[1]!.close().catch(() => undefined);
    await waitForPathMoments(opened.capture, "second.md", 2);
    expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: ["first.md"] });
    await sessions[0]!.close().catch(() => undefined);
    await waitForPathMoments(opened.capture, "first.md", 2);
    expect.soft(await opened.withEngine((engine) => engine.watcherStatus())).toMatchObject({ degraded: false, deferredWrites: [] });
  } finally { await opened.stop(); }
}, 60_000);

it.skipIf(engine.missing)("records a deferred outside write after the daemon restarts (#2463)", async () => {
  const opened = await openRealCapture("deferred-write-restart", { settleDebounceMs: 60_000 });
  let restarted: Awaited<ReturnType<typeof openRealCapture>> | undefined;
  try {
    await writeFile(join(opened.root, "note.md"), "base\n");
    await waitForPathMoments(opened.capture, "note.md", 1);
    await opened.capture.openYDocSession({ path: "note.md", contentKind: "plaintext", onRemoteUpdate: () => undefined });
    await writeFile(join(opened.root, "note.md"), "outside before restart\n");
    expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
    // Stop the daemon without closing or settling the document session.
    await opened.stopEngine();
    restarted = await openRealCapture("deferred-write-restart", {}, opened.root);
    const moments = await waitForPathMoments(restarted.capture, "note.md", 2);
    // Startup may also retain the abandoned Y.Doc as a recovery moment.
    // The outside bytes themselves must be captured exactly once.
    const texts = await Promise.all(moments.filter((moment) => moment.metadata.origin === "local-file").map(async (moment) => {
      const detail = await restarted!.capture.readMoment(moment.id);
      return detail?.protected === false ? detail.moment.payload.after?.text : undefined;
    }));
    expect(texts).toEqual(["outside before restart\n", "base\n"]);
    expect(await restarted.health()).toEqual({ newestMoment: "read", health: null });
    expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe("outside before restart\n");
  } finally {
    await restarted?.stop();
    await opened.stop();
  }
}, 60_000);

// Waits on #2478: baseline settlement refuses an outside write before the open note's links can be rewritten.
it.skip("keeps an outside write when a rename rewrites the open note's links (#2463)", async () => {
  const opened = await openRealCapture("deferred-write-rename", { settleDebounceMs: 60_000 });
  const outside = "agent text [[old]]\n";
  try {
    await writeFile(join(opened.root, "old.md"), "target\n");
    await writeFile(join(opened.root, "note.md"), "[[old]]\n");
    await waitForPathMoments(opened.capture, "old.md", 1);
    await waitForPathMoments(opened.capture, "note.md", 1);
    const session = await opened.capture.openYDocSession({ path: "note.md", contentKind: "richdoc", onRemoteUpdate: () => undefined });
    await writeFile(join(opened.root, "note.md"), outside);
    expect.soft(await opened.health()).toEqual({ newestMoment: "read", health: null });
    const operationId = "dohc-operation:deferred-rename";
    await opened.withEngine(async (engine) => {
      const hold = await engine.holdCapture({ operationId });
      try {
        await engine.renameTextFile({ workspaceId: opened.workspaceId, versionId: "main",
          fromPath: "old.md", toPath: "new.md", captureHoldId: hold.holdId, metadata: { origin: "api" } });
        await rename(join(opened.root, "old.md"), join(opened.root, "new.md"));
      } finally { await engine.releaseCapture(hold.holdId); }
    });
    const rewritten = await opened.withEngine((engine) => engine.rewriteHistoryLinks({ workspaceId: opened.workspaceId, operationId, requestId: "rewrite-deferred" }));
    expect(rewritten).toMatchObject({ documents: 1, complete: true });
    expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe(outside);
    await vi.waitFor(async () => expect((await readdir(opened.root)).some((path) => path.includes(".conflict"))).toBe(true));
    const conflicts = (await readdir(opened.root)).filter((path) => path.includes(".conflict"));
    expect(await Promise.all(conflicts.map((path) => readFile(join(opened.root, path), "utf8")))).toContain("[[new]]\n");
    const undone = await opened.withEngine((engine) => engine.undoHistoryOperation({ workspaceId: opened.workspaceId, operationId: operationId!, requestId: "undo-deferred" }));
    expect(undone.notRestored).toContain("note.md");
    expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe(outside);
    await session.close().catch(() => undefined);
    await vi.waitFor(async () => {
      const moments = await opened.capture.listMoments({ limit: 100 });
      const note = moments.moments.filter((moment) => moment.path === "note.md");
      const texts = await Promise.all(note.map(async (moment) => {
        const detail = await opened.capture.readMoment(moment.id);
        return detail?.protected === false ? detail.moment.payload.after?.text : undefined;
      }));
      expect(texts).toContain(outside);
    }, { timeout: REAL_DAEMON_DEADLINE_MS });
  } finally { await opened.stop(); }
}, 60_000);

// dohc#2308. An open document whose file was deleted outside dohc. The engine
// refuses every save over the missing file, so nothing writes it back until
// the person chooses Save it again. `shape` is a file capture recorded and
// saved over, or one New File left empty and deleted before its first save.
// Drafts go to a real draft store, as the app keeps them. The store refuses
// the first `failedDiscards` removals.
async function openDeletedDocument(shape: "recorded" | "new", failedDiscards = 0) {
  const draftStore = await createTestScratch("dohc-deleted-file-drafts-");
  const workspaceId = `deleted-file-${shape}`;
  const store = workspaceDraftStore(draftStore, workspaceId, NO_WINDOWS);
  const { root, sessions, capture, health, stop } = await openRealCapture(workspaceId, {
    settleDebounceMs: 60_000,
    preserveUnsentState: store.preserveUnsentState,
    discardUnsentState: async (draftId) => {
      if (failedDiscards-- > 0) throw new Error("The draft store is busy.");
      await store.discardUnsentState(draftId);
    },
  });
  const absolute = join(root, "note.md");
  const states: string[] = [];
  const drafts = async () => (await listLiveDraftRecovery(draftStore, workspaceId)).map(({ path, text }) => `${path}: ${text}`);
  try {
    if (shape === "recorded") {
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);
    } else {
      await writeFile(absolute, "", { flag: "wx" });
    }
    const session = await capture.openYDocSession({
      path: "note.md", contentKind: "plaintext", onRemoteUpdate: () => undefined, onSaveState: (state) => states.push(state),
    });
    const editor = new Y.Doc();
    Y.applyUpdate(editor, session.initialUpdate);
    const type = (text: string) => {
      const before = Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0, text);
      session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
    };
    if (shape === "recorded") {
      type("saved\n");
      await session.settleNow();
    }
    expect(await drafts()).toEqual([]);
    await rm(absolute);
    capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);
    type("unsaved\n");
    await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
    expect(states.at(-1)).toBe("error");
    const text = () => editor.getText("plainText").toString();
    // A crash from here on keeps the text: the first refused save set it aside.
    await vi.waitFor(async () => expect(await drafts()).toEqual([`note.md: ${text()}`]));
    return { root, capture, session, sessions, absolute, states, type, text, drafts, health, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// dohc#2342. Capture leaves a deleted file's head alone while its document
// is open, because that document still holds it. Capture is waiting, not
// failing: the person already has the save notice with Save it again, so
// History stays readable and capture reads as healthy.
it.skipIf(engine.missing).each(["recorded", "new"] as const)(
  "reports no capture or History failure while a %s file deleted outside dohc is open",
  async (shape) => {
    const deleted = await openDeletedDocument(shape);
    try {
      expect(await deleted.health()).toEqual({ newestMoment: "read", health: null });
      // The save notice stays: the next save is refused the same way.
      deleted.type("more\n");
      await expect(deleted.session.settleNow()).rejects.toThrow("conflict-stale-target");
      expect(existsSync(deleted.absolute)).toBe(false);
    } finally {
      await deleted.stop();
    }
  },
  60_000,
);

// The wait ends with the document: once it closes, History records the delete.
// History already holds all of the document, so the close is no failed save
// and sets nothing aside (dohc#2366).
it.skipIf(engine.missing).each(["no edit", "an edit saved before the delete"] as const)(
  "records a file deleted outside dohc once its document closes, with %s and no failed save",
  async (edit) => {
    const workspaceId = `deleted-file-closed-${edit === "no edit" ? "unedited" : "saved"}`;
    const draftStore = await createTestScratch("dohc-deleted-file-closed-drafts-");
    const store = workspaceDraftStore(draftStore, workspaceId, NO_WINDOWS);
    const opened = await openRealCapture(workspaceId, {
      settleDebounceMs: 60_000, preserveUnsentState: store.preserveUnsentState, discardUnsentState: store.discardUnsentState,
    });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      const states: string[] = [];
      const session = await opened.capture.openYDocSession({
        path: "note.md", contentKind: "plaintext", onRemoteUpdate: () => undefined, onSaveState: (state) => states.push(state),
      });
      const writes = edit === "no edit" ? ["write"] : ["write", "write"];
      if (edit !== "no edit") {
        const editor = new Y.Doc();
        Y.applyUpdate(editor, session.initialUpdate);
        const before = Y.encodeStateVector(editor);
        editor.getText("plainText").insert(0, "saved\n");
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
        await session.settleNow();
        await waitForPathMoments(opened.capture, "note.md", 2);
      }
      await rm(absolute);
      opened.capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);
      expect(await opened.health()).toEqual({ newestMoment: "read", health: null });
      const before = await waitForPathMoments(opened.capture, "note.md", writes.length);
      expect(before.map((moment) => moment.operation)).toEqual(writes);

      await expect(session.close()).resolves.toBeUndefined();
      const after = await waitForPathMoments(opened.capture, "note.md", writes.length + 1);
      expect(after.map((moment) => moment.operation)).toEqual(["delete", ...writes]);
      expect(existsSync(absolute)).toBe(false);
      expect(states).not.toContain("error");
      expect(await listLiveDraftRecovery(draftStore, workspaceId)).toEqual([]);
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

// A folder capture cannot read is a real failure, so both workspace notices
// still come, also while a deleted file's document is open.
it.skipIf(engine.missing).each(["no document", "a deleted file's document"] as const)(
  "still reports a folder capture cannot read, with %s open",
  async (open) => {
    const opened = open === "no document" ? await openRealCapture("unreadable-folder") : await openDeletedDocument("recorded");
    const locked = join(opened.root, "locked");
    try {
      await mkdir(locked);
      await writeFile(join(locked, "note.md"), "Out of reach.\n");
      await chmod(locked, 0o000);
      // Root reads any folder, so there this fixture cannot fail capture.
      if (await readdir(locked).then(() => true, () => false)) return;
      expect(await opened.health()).toEqual({ newestMoment: "still updating", health: "other" });
    } finally {
      await chmod(locked, 0o755).catch(() => undefined);
      await opened.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing).each(["recorded", "new"] as const)(
  "saves a %s file deleted outside dohc again only when the person asks",
  async (shape) => {
    const deleted = await openDeletedDocument(shape);
    try {
      // Try again repeats the save, and the engine refuses it the same way.
      // The draft takes the newest text.
      deleted.type("more\n");
      await expect(deleted.session.settleNow()).rejects.toThrow("conflict-stale-target");
      expect(existsSync(deleted.absolute)).toBe(false);
      await vi.waitFor(async () => expect(await deleted.drafts()).toEqual([`note.md: ${deleted.text()}`]));

      await expect(deleted.capture.saveDeletedFileAgain("note.md")).resolves.toBe(true);
      expect(await readFile(deleted.absolute, "utf8")).toBe(deleted.text());
      expect(deleted.states.at(-1)).toBe("saved");
      await vi.waitFor(async () => expect(await deleted.drafts()).toEqual([]));

      deleted.type("later\n");
      await deleted.session.settleNow();
      expect(await readFile(deleted.absolute, "utf8")).toBe(deleted.text());
      await expect(deleted.session.close()).resolves.toBeUndefined();
      expect(await deleted.drafts()).toEqual([]);
    } finally {
      await deleted.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing)("saves a deleted file again after its tab closed, and the close finishes", async () => {
  const deleted = await openDeletedDocument("recorded");
  try {
    // The close is refused, so the session keeps the text, nothing is
    // written, and the draft stays.
    await expect(deleted.session.close()).rejects.toThrow("conflict-stale-target");
    expect(existsSync(deleted.absolute)).toBe(false);
    expect(await deleted.drafts()).toEqual(["note.md: unsaved\nsaved\nbase\n"]);

    await expect(deleted.capture.saveDeletedFileAgain("note.md")).resolves.toBe(true);
    expect(await readFile(deleted.absolute, "utf8")).toBe("unsaved\nsaved\nbase\n");
    await expect(deleted.session.close()).resolves.toBeUndefined();
    await vi.waitFor(async () => expect(await deleted.drafts()).toEqual([]));

    // Nothing holds the document now, so nothing more is written.
    await rm(deleted.absolute);
    await expect(deleted.capture.saveDeletedFileAgain("note.md")).resolves.toBe(false);
    expect(existsSync(deleted.absolute)).toBe(false);
  } finally {
    await deleted.stop();
  }
}, 60_000);

it.skipIf(engine.missing)("removes a replaced draft the store first refused to remove, by the time the session ends", async () => {
  const deleted = await openDeletedDocument("recorded", 1);
  try {
    deleted.type("more\n");
    await expect(deleted.session.settleNow()).rejects.toThrow("conflict-stale-target");
    // The newer draft is written, and the older one stays until a removal works.
    await vi.waitFor(async () => expect(await deleted.drafts()).toHaveLength(2));
    await expect(deleted.session.close()).rejects.toThrow("conflict-stale-target");
    expect(await deleted.drafts()).toEqual([`note.md: ${deleted.text()}`]);
  } finally {
    await deleted.stop();
  }
}, 60_000);

it.skipIf(engine.missing).each(["workspace close", "quit"] as const)(
  "keeps the draft of a deleted file through a %s, and does not write the file",
  async (ending) => {
    const deleted = await openDeletedDocument("recorded");
    try {
      deleted.type("last\n");
      const newest = ["note.md: last\nunsaved\nsaved\nbase\n"];
      if (ending === "quit") {
        deleted.capture.beginShutdown();
        await deleted.session.close({ shuttingDown: true }).catch(() => undefined);
        // The app exits right after a quit, so the close itself waits for
        // the draft its refused save sets aside.
        expect(await deleted.drafts()).toEqual(newest);
      } else {
        await expect(deleted.capture.settleAndCloseAllLiveSessions()).rejects.toThrow("conflict-stale-target");
        await vi.waitFor(async () => expect(await deleted.drafts()).toEqual(newest));
      }
      // Releasing the session lets capture retire the path. The draft stays.
      await deleted.capture.stop();
      await deleted.sessions.closeAll();
      expect(await deleted.drafts()).toEqual(newest);
      expect(existsSync(deleted.absolute)).toBe(false);
    } finally {
      await deleted.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing)("sets nothing aside for a document whose saves are not refused over a deleted file", async () => {
  const root = await createTestScratch("dohc-no-draft-");
  const draftStore = await createTestScratch("dohc-no-draft-drafts-");
  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  const store = workspaceDraftStore(draftStore, "no-draft", NO_WINDOWS);
  const preserve = vi.fn(store.preserveUnsentState);
  const capture = createWorkspaceEngineCapture({
    workspaceId: "no-draft", rootPath: root, rustEngineSessions: sessions, settleDebounceMs: 60_000, onError: () => undefined,
    preserveUnsentState: preserve, discardUnsentState: store.discardUnsentState,
  });
  try {
    await writeFile(join(root, "note.md"), "base\n", "utf8");
    await waitForPathMoments(capture, "note.md", 1);
    const session = await capture.openYDocSession({ path: "note.md", contentKind: "plaintext", onRemoteUpdate: () => undefined });
    const editor = new Y.Doc();
    Y.applyUpdate(editor, session.initialUpdate);
    const type = (text: string) => {
      const before = Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0, text);
      session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
    };
    type("saved\n");
    await session.settleNow();
    // A save refused because the file changed outside dohc leaves the text
    // in History, and the file is there to open.
    await writeFile(join(root, "note.md"), "outside\n", "utf8");
    type("typed\n");
    await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
    await session.close().catch(() => undefined);
    await capture.stop();
    expect(preserve).not.toHaveBeenCalled();
    expect(await listLiveDraftRecovery(draftStore, "no-draft")).toEqual([]);
  } finally {
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  }
}, 60_000);

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import pipelineFixture from "../../../../crates/dohc-engine-domain/tests/fixtures/collection-field-pipeline.json";
import { defaultWorkspaceMode, type WatcherEvent } from "@dohc/workspace-core";
import { VersionedLiveAdapter, openEngineYdocProviderSession, type EngineTransport } from "@dohc/workspace-engine-client";
import { createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture, DAEMON_CAPTURE_HEALTH_POLL_MS } from "./workspaceEngineCapture";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { startWorkspaceFileObservation } from "./workspaceFileObservation";
import { EngineFileObservation } from "@dohc/workspace-engine-client/daemon";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { encodeFixtureBigInts } from "@dohc/workspace-engine-client/testing";
import { decodeCollectionValue } from "../../../../packages/workspace-engine-client/src/workspace/workspaceWireContract";
import type { JsonValue } from "@dohc/workspace-engine-client";
import { RESTORER, createWorkspaceEngineCapture, decodePipelineFixtureValue, engine } from "./workspaceEngineCaptureRust.fixture";

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

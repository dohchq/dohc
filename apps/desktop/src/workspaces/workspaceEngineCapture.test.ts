import type { MomentAuthor } from "@dohc/workspace-contracts";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { denyRead, restoreRead } from "@dohc/workspace-fs/testing";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "./testTemp";
import { createWorkspaceActivity } from "./workspaceActivity";
import { invokePluginSdkHost } from "../plugins/pluginSdkHost";
import {
  EXPECTED_ENGINE_EVENT_EXPIRY_MS,
  DAEMON_CAPTURE_HEALTH_POLL_MS,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
  MAX_SETTLED_FILE_BYTES,
  UnsupportedWorkspacePathError,
  assertGeneratedMarkdownPath,
  createDefaultDiskWriter,
  createWorkspaceEngineCapture,
  isYDocPathNotInVersionError,
  YDocOpenRacedError,
  YDocSessionUnreleasedError,
  YDocUncapturedArtifactError,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import {
  DaemonRefusalError,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { startWorkspaceWatch } from "./workspaceWatcher";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";
import * as Y from "yjs";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await createTestScratch("dohc-engine-capture-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface EngineMomentRow {
  path: string;
  operation: string;
  text: string;
  origin: string;
  summary: string | null;
  correlationId: string | null;
}

async function write(root: string, path: string, contents: string | Uint8Array) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const WORKSPACE_ID = "engine-capture-test";

// chmod/ACL-based fixtures cannot make a path unreadable for root (root
// ignores file modes), so every test that needs an unreadable path skips
// under uid 0.
const itNonRoot = process.getuid?.() === 0 ? it.skip : it;

interface CaptureOptions {
  store?: CaptureVersionedTextStore;
  now?: () => number;
  createId?: () => string;
  onError?: (context: string, error: unknown) => void;
  onCaptureOutcome?: (outcome: { ok: boolean }) => void;
  activeAgentRun?: () => { agentId: string; onBehalfOf: string; agentRunId: string } | null;
  rustEngineSessions?: EngineWorkspaceSessions;
  daemonOwnsCapture?: boolean;
  openRustYDocProviderSession?: (
    options: EngineYdocProviderSessionOptions,
  ) => Promise<EngineYdocProviderSession>;
}

function capture(root: string, options: CaptureOptions = {}) {
  const { rustEngineSessions, ...rest } = options;
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    rustEngineSessions:
      rustEngineSessions ?? mockLiveSessions(new VersionedLoopbackEngine()),
    ...rest,
  });
}

// Daemon-path capture: `rustEngineSessions` selects the Rust engine, and the
// VersionedLoopbackEngine behind it holds real state and real sha256 — so the
// history these tests read back is recorded engine state, not a hand-written
// responder. Passing the SAME loopback to two captures models two sessions
// against one workspace, the way two sessions shared one engine.db before.
function liveCapture(
  root: string,
  loopback: VersionedLoopbackEngine,
  options: Omit<CaptureOptions, "rustEngineSessions"> & { requests?: Request[] } = {},
): WorkspaceEngineCapture {
  const { requests, ...rest } = options;
  return capture(root, {
    rustEngineSessions: mockLiveSessions(loopback, requests),
    ...rest,
  });
}

// The daemon-path equivalent of readEngineMoments: the same six facts, read
// through the engine's own timeline API. Oldest first, matching the raw
// `ORDER BY moment_order` query. PROTECTED (secret) rows are dropped here
// exactly as a query against the text `moments` table dropped them.
async function liveMoments(engine: WorkspaceEngineCapture): Promise<EngineMomentRow[]> {
  // DRAINED, not capped. An earlier draft asked for one 500-row page, which
  // returns the NEWEST 500 — so the moment a test recorded more, the reversed
  // array stopped being oldest-first and every count and sequence assertion
  // below would have compared against a truncated page without saying so. A cap
  // here is a limit rejecting valid work; paging costs nothing and removes the
  // question. (Same correction as the moments reader on #417.)
  const summaries: Awaited<ReturnType<WorkspaceEngineCapture["listMoments"]>>["moments"] = [];
  let beforeMomentOrder: number | undefined;
  for (;;) {
    const page = await engine.listMoments({
      ...(beforeMomentOrder === undefined ? {} : { beforeMomentOrder }),
    });
    summaries.push(...page.moments);
    if (page.nextBeforeMomentOrder === null) break;
    beforeMomentOrder = page.nextBeforeMomentOrder;
  }
  const rows: EngineMomentRow[] = [];
  for (const summary of [...summaries].reverse()) {
    if (summary.protected) continue;
    const detail = await engine.readMoment(summary.id);
    // A null detail must FAIL, not collapse to an empty body: `text: ""` for a
    // missing read makes a readMoment regression look like an empty file, which
    // several assertions below would accept.
    if (detail === null) {
      throw new Error(`readMoment returned null for ${summary.id} (${summary.path})`);
    }
    const payload = detail.protected === false ? detail.moment.payload : undefined;
    rows.push({
      path: summary.path,
      operation: summary.operation,
      text: payload?.after.text ?? "",
      origin: summary.metadata.origin,
      summary: summary.metadata.summary ?? null,
      correlationId: summary.metadata.correlationId ?? null,
    });
  }
  return rows;
}

// A loopback whose versioned requests reject while `failing` is true — the
// daemon-path stand-in for a broken engine store. Only the calls that carry
// history fail: workspace open/close, capture flush, and watcher status are
// answered by mockLiveSessions before the request reaches here, exactly as a
// live daemon whose store is failing would still answer its lifecycle calls.
function failableLoopback(match: (request: Request) => boolean = () => true): {
  loopback: VersionedLoopbackEngine;
  state: { failing: boolean };
} {
  const real = new VersionedLoopbackEngine();
  const state = { failing: true };
  const loopback = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== "sendRequest") return Reflect.get(target, prop, receiver);
      return async (request: Request) => {
        if (state.failing && match(request)) {
          throw new Error("engine store unavailable");
        }
        return await target.sendRequest(request);
      };
    },
  });
  return { loopback, state };
}

// The daemon-path equivalent of readSnapshotKinds and readBinaryBlobRows: the
// tracked head of every file in a version, read straight off the wire. Unlike
// the timeline it survives the capture's stop(), so it also answers "was the
// last capture really recorded" after shutdown.
async function liveTrackedFiles(
  loopback: VersionedLoopbackEngine,
  versionId = "main",
  workspace = WORKSPACE_ID,
): Promise<Array<{ path: string; contentKind: string; sha256: string; byteLength: number }>> {
  const response = await loopback.sendRequest({
    id: -1,
    method: VERSIONED_METHOD.textList,
    workspace,
    params: { versionId, limit: 500 },
  });
  const files = (response.result as { files: Array<Record<string, JsonValue>> }).files;
  return files.map((file) => ({
    path: String(file.path),
    contentKind: String(file.contentKind),
    sha256: String(file.sha256),
    byteLength: Number(file.byteLength),
  }));
}

// The daemon-path equivalent of readEngineMomentAuthors: the author each
// recorded moment carries, oldest first, with null for actor-neutral.
async function liveMomentAuthors(
  engine: WorkspaceEngineCapture,
): Promise<Array<MomentAuthor | null>> {
  const page = await engine.listMoments({ limit: 500 });
  return [...page.moments]
    .reverse()
    .filter((moment) => !moment.protected)
    .map((moment) => moment.author ?? null);
}

// Recorded moment paths read off the wire, which — unlike the timeline API —
// still answers after the capture has stopped. That is what makes it the
// replacement for a post-shutdown engine.db query.
async function liveMomentPaths(
  loopback: VersionedLoopbackEngine,
  workspace = WORKSPACE_ID,
): Promise<string[]> {
  const paths: string[] = [];
  let beforeMomentOrder: number | undefined;
  for (;;) {
    const response = await loopback.sendRequest({
      id: -1,
      method: VERSIONED_METHOD.momentsList,
      workspace,
      params: {
        limit: 500,
        ...(beforeMomentOrder === undefined ? {} : { beforeMomentOrder }),
      },
    });
    const result = response.result as {
      moments: Array<Record<string, JsonValue>>;
      nextBeforeMomentOrder: JsonValue;
    };
    paths.push(...result.moments.map((moment) => String(moment.path)));
    if (result.nextBeforeMomentOrder === null) return paths;
    beforeMomentOrder = Number(result.nextBeforeMomentOrder);
  }
}

describe("workspaceEngineCapture batch capture", () => {
  it("uses the daemon as the sole capture and version-switch materialization owner", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "note.md",
      text: "main",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
      daemonOwnsCapture: true,
    });

    engine.start();
    await engine.flush();
    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    expect(
      loopback.requests.some(
        (request) =>
          request.method === VERSIONED_METHOD.textWrite ||
          request.method === VERSIONED_METHOD.textDelete,
      ),
    ).toBe(false);

    const draft = await engine.createVersion("Draft");
    loopback.requests.length = 0;
    requests.length = 0;
    const result = await engine.switchVersion("main");

    expect(result).toEqual({
      activeVersionId: "main",
      changedFileCount: 0,
    });
    expect(
      loopback.requests.some(
        (request) =>
          request.method === VERSIONED_METHOD.textRead ||
          request.method === VERSIONED_METHOD.binaryRead ||
          request.method === VERSIONED_METHOD.textWrite ||
          request.method === VERSIONED_METHOD.textDelete,
      ),
    ).toBe(false);
    const flushIndex = requests.findIndex(
      (request) => request.method === "capture.flush",
    );
    // MUTATION: omit the daemon flush in switchVersion. Source metadata is
    // listed without a capture settlement between the target preflight and
    // the before/after comparison.
    expect(flushIndex).toBeGreaterThanOrEqual(0);
    expect(
      requests
        .slice(flushIndex + 1)
        .some((request) => request.method === VERSIONED_METHOD.textList),
    ).toBe(true);
    expect(
      loopback.requests.some(
        (request) => request.method === VERSIONED_METHOD.versionsSetActive,
      ),
    ).toBe(true);
    expect(draft.activeVersionId).not.toBe("main");
    await engine.stop();
  });

  it("flushes daemon capture before resolving a file object id", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "just-saved.md",
      text: "ready for chat",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
      daemonOwnsCapture: true,
    });

    const objectId = await engine.fileObjectIdForPath("just-saved.md");
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.textRead,
      );

    expect(objectId).toBeTruthy();
    // MUTATION: remove fileObjectIdForPath's flushCapture call. The read
    // remains, making this order assertion fail on the missing first entry.
    expect(relevant).toEqual(["capture.flush", VERSIONED_METHOD.textRead]);
    await engine.stop();
  });

  it("flushes daemon capture before reading versions for a merge", async () => {
    const root = await tempRoot();
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
      daemonOwnsCapture: true,
    });

    const outcome = await engine
      .mergeVersionIntoMain("missing-version")
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.versionsList,
      );

    // MUTATION: remove mergeVersionIntoMain's daemon flush. The versions read
    // remains, making this order assertion fail on the missing first entry.
    expect(relevant).toEqual(["capture.flush", VERSIONED_METHOD.versionsList]);
    await engine.stop();
  });

  it("flushes daemon capture before reading conflicts for resolution", async () => {
    const root = await tempRoot();
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
      daemonOwnsCapture: true,
    });

    const outcome = await engine
      .resolveConflict("missing-conflict", { kind: "keep-current" })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) => method === "capture.flush" || method === "conflicts.list",
      );

    // MUTATION: remove resolveConflict's daemon flush. The conflict lookup
    // remains, making this order assertion fail on the missing first entry.
    expect(relevant).toEqual(["capture.flush", "conflicts.list"]);
    await engine.stop();
  });

  it("flushes daemon capture before reading a moment for restore", async () => {
    const root = await tempRoot();
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
      daemonOwnsCapture: true,
    });

    const outcome = await engine
      .restoreFileToBeforeMoment("missing-moment")
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.momentsGet,
      );

    // MUTATION: remove restoreFileToBeforeMoment's daemon flush. The moment
    // read remains, making this order assertion fail on the missing first entry.
    expect(relevant).toEqual(["capture.flush", VERSIONED_METHOD.momentsGet]);
    await engine.stop();
  });

  it("closes both daemon stores when the final capture flush rejects", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    let settled = true;
    const sessions = mockLiveSessions(loopback, undefined, () => ({
      settled,
      running: true,
      degraded: !settled,
    }));
    const closeWorkspace = vi.spyOn(sessions, "closeWorkspace");
    const engine = capture(root, {
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
    });

    // createVersion opens both the text and secret daemon adapters.
    await engine.createVersion("Draft");
    settled = false;
    const outcome = await engine.stop().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("did not settle");
    // MUTATION: await the final flush outside try/finally. Its rejection skips
    // both adapter closes, so this count is zero.
    expect(closeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("flushes daemon capture before closing production workspace stores", async () => {
    const root = await tempRoot();
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
      daemonOwnsCapture: true,
    });

    // createVersion opens both the text and secret daemon adapters.
    await engine.createVersion("Draft");
    requests.length = 0;
    await engine.stop();

    expect(
      requests
        .map((request) => request.method)
        .filter(
          (method) => method === "capture.flush" || method === "workspace.close",
        ),
    ).toEqual(["capture.flush", "workspace.close"]);
  });

  it("mutation proof: installs remote updates buffered during the initial Y.Doc open", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "note.md",
      text: "seed",
    });
    const baseDoc = new Y.Doc();
    baseDoc.getText("content").insert(0, "base");
    const staleInitialUpdate = Y.encodeStateAsUpdate(baseDoc);
    const daemonDoc = new Y.Doc();
    Y.applyUpdate(daemonDoc, staleInitialUpdate);
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, staleInitialUpdate);
    remoteDoc.getText("content").insert(4, "+remote");
    const bufferedUpdate = Y.encodeStateAsUpdate(
      remoteDoc,
      Y.encodeStateVector(daemonDoc),
    );
    const forwarded: Uint8Array[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        Y.applyUpdate(daemonDoc, bufferedUpdate);
        options.onRemoteUpdate(bufferedUpdate);
        return {
          doc: daemonDoc,
          initialUpdate: staleInitialUpdate,
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "a".repeat(64), markdown: "" }) as never,
          applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
          close: async () => undefined,
        };
      },
    });

    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: (update) => forwarded.push(update),
    });
    const rendererDoc = new Y.Doc();
    Y.applyUpdate(rendererDoc, session.initialUpdate);

    expect(rendererDoc.getText("content").toString()).toBe("base+remote");
    expect(forwarded).toEqual([bufferedUpdate]);
    await session.close({ settle: false });
    await engine.stop();
  });

  // #338. The engine owns the .md: it materializes a changed projection and
  // leaves a drifted file alone. The desktop mirrored the settled markdown
  // over the file anyway, so an edit made outside dohc while the document was
  // open vanished from disk. The desktop no longer writes here at all, and
  // every case below drives the REAL onSettled against a REAL file; only the
  // daemon session is a fake, and it calls onSettled exactly where
  // ydocProviderSession's runSettle does.
  function driftFixture(settled: {
    sha256: string;
    markdown: string | null;
    path?: string;
  }) {
    return async (options: EngineYdocProviderSessionOptions) => {
      const doc = new Y.Doc();
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: settled.path ?? "note.md",
        // Stated by hand: `as never` below stops tsc checking this literal, and
        // an absent `head` would silently disable the absent-head refusal for
        // every drift case here.
        head: "present" as const,
        lineage: "existing" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () => {
          await options.onSettled?.({ ...settled, materialized: true } as never, 1);
          return settled as never;
        },
        close: async (closeOptions?: { settle?: boolean }) => {
          if (closeOptions?.settle === false) return;
          await options.onSettled?.({ ...settled, materialized: true } as never, 2);
        },
      } as never;
    };
  }

  // Open a session on note.md, let its close settle, and report the save
  // states that settle produced.
  async function settleOnClose(
    root: string,
    settled: { sha256: string; markdown: string | null },
    onError?: (context: string, error: unknown) => void,
  ): Promise<string[]> {
    const states: string[] = [];
    const engine = capture(root, {
      ...(onError ? { onError } : {}),
      openRustYDocProviderSession: driftFixture(settled),
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state),
    });
    await session.close();
    await engine.stop();
    return states;
  }

  const EDITOR_TEXT = "typed in dohc\n";

  it("keeps an edit made outside dohc when the open document's session closes", async () => {
    const root = await tempRoot();
    const outside = "written outside dohc\n";
    await write(root, "note.md", outside);

    // MUTATION: restore the mirror write and the file reads "typed in dohc" —
    // the outside edit is gone from disk.
    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      markdown: EDITOR_TEXT,
    });

    expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // The size the old check gave up at: readDiskTextState returns
  // untracked-content with NO sha past its 5 MiB cap, so a check that trusted
  // it read "no proof of drift" and mirrored 14 bytes over the biggest file in
  // the workspace — reporting "Saved".
  it("keeps an outside edit larger than the capture size cap", async () => {
    const root = await tempRoot();
    const huge = `${"o".repeat(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1)}\n`;
    await write(root, "note.md", huge);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      markdown: EDITOR_TEXT,
    });

    expect((await readFile(join(root, "note.md"), "utf8")).length).toBe(
      huge.length,
    );
    expect(states).toEqual(["changed-on-disk"]);
  });

  // An outside DELETE is an intent, not an accident. Writing the document back
  // is the same overwrite in reverse.
  it("does not recreate a file deleted outside dohc", async () => {
    const root = await tempRoot();

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      markdown: EDITOR_TEXT,
    });

    expect(existsSync(join(root, "note.md"))).toBe(false);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // markdown === null: the body is past the engine's in-band response cap, so
  // it never rode back over the wire. The settle still reports its sha, so
  // drift is just as answerable there — the old code returned "Saved" without
  // looking.
  it("reports the drift for an over-cap settle whose markdown never crossed the wire", async () => {
    const root = await tempRoot();
    const outside = "written outside dohc\n";
    await write(root, "note.md", outside);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8("a body far past the in-band cap"),
      markdown: null,
    });

    expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // A file bigger than the largest projection the engine can produce cannot BE
  // the settled artifact, so its size answers the question and its bytes are
  // never read — a close must not wait on an unbounded read. The deny-read ACE
  // is the proof: reading would fail (EPERM), which would report "error"
  // instead. MUTATION: drop the size check and this reports ["error"].
  itNonRoot("answers an oversized file from its size, without reading it", async () => {
    const root = await tempRoot();
    const absolute = join(root, "note.md");
    await write(root, "note.md", "b".repeat(MAX_SETTLED_FILE_BYTES + 1));
    await denyRead(absolute, "file");

    try {
      const states = await settleOnClose(root, {
        sha256: sha256Utf8(EDITOR_TEXT),
        markdown: EDITOR_TEXT,
      });

      expect(states).toEqual(["changed-on-disk"]);
    } finally {
      await restoreRead(absolute, 0o644);
    }
  });

  // A file dohc cannot read is not a file dohc knows changed. Sending the user
  // to History over a scanner's transient lock would be a lie about a file
  // that probably holds exactly this document; "error" is the retryable state,
  // and the next settle checks again.
  itNonRoot("reports the retryable error state when the file cannot be read", async () => {
    const root = await tempRoot();
    const absolute = join(root, "note.md");
    await write(root, "note.md", EDITOR_TEXT);
    await denyRead(absolute, "file");
    const errors: Array<{ context: string; error: unknown }> = [];

    try {
      const states = await settleOnClose(
        root,
        { sha256: sha256Utf8(EDITOR_TEXT), markdown: EDITOR_TEXT },
        (context, error) => errors.push({ context, error }),
      );

      expect(states).toEqual(["error"]);
      expect(String(errors[0]?.error)).toContain("could not check the file");
    } finally {
      await restoreRead(absolute, 0o644);
    }
  });

  // Containment, the same invariant the disk writer holds: a parent directory
  // replaced by a link out of the workspace must not be read through. A file
  // out there whose bytes matched would otherwise report a save — and arm a
  // self-write suppression — for an artifact that is not in the workspace.
  it("refuses to read the settled file through a folder that leaves the workspace", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "note.md", EDITOR_TEXT);
    let linked = true;
    try {
      // A junction needs no privilege on Windows; symlink elsewhere.
      await symlink(
        join(outside),
        join(root, "notes"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      linked = false;
    }
    if (!linked) return;

    const states: string[] = [];
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: driftFixture({
        sha256: sha256Utf8(EDITOR_TEXT),
        markdown: EDITOR_TEXT,
        path: "notes/note.md",
      }),
    });
    const session = await engine.openYDocSession({
      path: "notes/note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state),
    });
    await session.close();
    await engine.stop();

    // MUTATION: drop the containment check and the matching file OUTSIDE the
    // workspace reports ["saved"].
    expect(states).toEqual(["error"]);
    expect(String(errors[0]?.error)).toContain("outside the workspace");
  });

  // The narrowness guard: the refusal above must fire ONLY on a drifted file.
  it("still reports a plain saved settle when nothing changed the file", async () => {
    const root = await tempRoot();
    await write(root, "note.md", EDITOR_TEXT);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      markdown: EDITOR_TEXT,
    });

    expect(await readFile(join(root, "note.md"), "utf8")).toBe(EDITOR_TEXT);
    expect(states).toEqual(["saved"]);
  });

  // A settle that agrees with the file registers its sha, so the watcher event
  // for the ENGINE's own write is recognized. A settle that does NOT agree
  // must register nothing: those bytes are on no disk, and an armed
  // suppression would swallow the next event that happens to carry that sha.
  it("arms the self-write suppression only for a settle the file agrees with", async () => {
    const root = await tempRoot();
    const outside = "written outside dohc\n";
    await write(root, "note.md", outside);
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "note.md",
      text: outside,
    });
    const requests: Request[] = [];
    const engine = liveCapture(root, loopback, {
      requests,
      openRustYDocProviderSession: driftFixture({
        sha256: sha256Utf8(EDITOR_TEXT),
        markdown: EDITOR_TEXT,
      }),
    });

    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    });
    await session.close();
    // Something else puts exactly those settled bytes on disk afterwards. It
    // is a genuine change to the tracked file, and history must record it.
    await write(root, "note.md", EDITOR_TEXT);
    const writesBefore = requests.filter(
      (request) => request.method === VERSIONED_METHOD.textWrite,
    ).length;
    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();

    expect(
      requests.filter(
        (request) => request.method === VERSIONED_METHOD.textWrite,
      ).length,
    ).toBeGreaterThan(writesBefore);
    await engine.stop();
  });

  it("mutation proof: polls daemon watcher degradation after startup", async () => {
    vi.useFakeTimers();
    try {
      const root = await tempRoot();
      let degraded = false;
      const outcomes: boolean[] = [];
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: root },
        sessions,
      ).store;
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus") {
            return async () => ({
              running: true,
              degraded,
              terminal: false,
            });
          }
          if (property === "flushCapture") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
        daemonOwnsCapture: true,
        onCaptureOutcome: ({ ok }) => outcomes.push(ok),
      });
      try {
        engine.start();
        await engine.flush();
        degraded = true;
        await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
        await engine.flush();

        expect(outcomes).toEqual([true, false]);
      } finally {
        try {
          await engine.stop();
        } finally {
          await liveStore.close();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("mutation proof: counts a secret-only daemon version switch", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedSecretFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: ".env",
      text: "VALUE=main\n",
    });
    await write(root, ".env", "VALUE=main\n");
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      daemonOwnsCapture: true,
    });
    const created = await engine.createVersion("Draft");
    const draftId = created.activeVersionId;
    loopback.seedSecretFile({
      workspace: "engine-capture-test",
      versionId: draftId,
      path: ".env",
      text: "VALUE=draft\n",
    });
    await write(root, ".env", "VALUE=draft\n");

    await expect(engine.switchVersion("main")).resolves.toEqual({
      activeVersionId: "main",
      changedFileCount: 1,
    });
    await engine.stop();
  });

  it(
    "captures, reads back, and switches materialized text with the live backend",
    async () => {
      const root = await tempRoot();
      const loopback = new VersionedLoopbackEngine();

      await write(root, "notes.md", "main text\n");
      const engine = liveCapture(root, loopback);
      engine.captureBatch([{ path: "notes.md", operation: "update" }]);
      await engine.flush();
      expect(await engine.fileObjectIdForPath("notes.md")).toBeTruthy();

      const created = await engine.createVersion("Draft");
      const draftId = created.activeVersionId;
      await write(root, "notes.md", "draft text\n");
      engine.captureBatch([{ path: "notes.md", operation: "update" }]);
      await engine.flush();

      await engine.switchVersion("main");
      expect(await readFile(join(root, "notes.md"), "utf8")).toBe("main text\n");
      await engine.switchVersion(draftId);
      expect(await readFile(join(root, "notes.md"), "utf8")).toBe("draft text\n");
      await engine.stop();

      expect(
        loopback.requests.some(
          (request) => request.method === "versionedText.list",
        ),
      ).toBe(true);
      expect(
        loopback.requests.some(
          (request) => request.method === "versionedText.read",
        ),
      ).toBe(true);
    },
  );

  it("hydrates target text after the daemon metadata-only list before materialization", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    await write(root, "note.md", "main\n");
    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    const draft = await engine.createVersion("Draft");
    await write(root, "note.md", "draft\n");
    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    loopback.requests.length = 0;

    await engine.switchVersion("main");
    const targetListIndex = loopback.requests.findIndex(
      (request) =>
        request.method === "versionedText.list" &&
        (request.params as { versionId?: string }).versionId === "main",
    );
    const targetReadIndex = loopback.requests.findIndex(
      (request) =>
        request.method === "versionedText.read" &&
        (request.params as { versionId?: string; path?: string }).versionId ===
          "main" &&
        (request.params as { path?: string }).path === "note.md",
    );
    expect(targetListIndex).toBeGreaterThanOrEqual(0);
    expect(targetReadIndex).toBeGreaterThan(targetListIndex);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("main\n");
    await engine.stop();
    expect(draft.activeVersionId).not.toBe("main");
  });

  it("uses list metadata sha to avoid binary hydration when target bytes already match", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await write(root, "logo.png", bytes);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    await engine.createVersion("Draft");
    loopback.requests.length = 0;

    await engine.switchVersion("main");
    expect(
      loopback.requests.filter(
        (request) => request.method === "versionedBinary.read",
      ),
    ).toHaveLength(0);
    expect(await readFile(join(root, "logo.png"))).toEqual(bytes);
    await engine.stop();
  });

  it("validates an unknown switch target from metadata without attempting text hydration", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    loopback.requests.length = 0;

    await expect(engine.switchVersion("missing-version")).rejects.toThrow();
    expect(
      loopback.requests.filter(
        (request) => request.method === "versionedText.read",
      ),
    ).toHaveLength(0);
    await engine.stop();
  });

  it("reconciles the tracked set from metadata and hydrates only the path being deleted", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "closed-period-delete.md",
      text: "gone from disk\n",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    loopback.requests.length = 0;

    engine.start();
    await engine.flush();
    const listIndex = loopback.requests.findIndex(
      (request) => request.method === "versionedText.list",
    );
    const readIndexes = loopback.requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.method === "versionedText.read")
      .map(({ index }) => index);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    // The one read belongs to deleteIfTracked's presence check. The live
    // facade must use the mutation's atomic preimage, not race it with a
    // second pre-delete read. Hydrating listTextFiles would add another read.
    expect(readIndexes).toHaveLength(1);
    expect(readIndexes.every((index) => index > listIndex)).toBe(true);
    await engine.stop();
  });

  it("uses previous-version metadata for deletion planning without hydrating its text", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    await engine.createVersion("Draft");
    await write(root, "draft-only.md", "draft only\n");
    engine.captureBatch([{ path: "draft-only.md", operation: "update" }]);
    await engine.flush();
    loopback.requests.length = 0;

    await engine.switchVersion("main");
    const previousListIndex = loopback.requests.findLastIndex(
      (request) =>
        request.method === "versionedText.list" &&
        (request.params as { versionId?: string }).versionId !== "main",
    );
    const readAfterPreviousList = loopback.requests
      .slice(previousListIndex + 1)
      .some((request) => request.method === "versionedText.read");
    expect(previousListIndex).toBeGreaterThanOrEqual(0);
    expect(readAfterPreviousList).toBe(false);
    expect(existsSync(join(root, "draft-only.md"))).toBe(false);
    await engine.stop();
  });

  it("captures an in-cap binary file as a binary moment", async () => {
    const root = await tempRoot();
    const pngLike = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await write(root, "logo.png", pngLike);
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    expect(await liveTrackedFiles(loopback)).toEqual([
      {
        path: "logo.png",
        contentKind: "binary",
        sha256: createHash("sha256").update(pngLike).digest("hex"),
        byteLength: pngLike.byteLength,
      },
    ]);
    expect(await liveMoments(engine)).toHaveLength(1);
    await engine.stop();
  });

  it("skips oversized binary content exactly like other untracked content", async () => {
    const root = await tempRoot();
    await write(root, "huge.png", new Uint8Array(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1));
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "huge.png", operation: "update" }]);
    await engine.flush();

    expect(await liveMoments(engine)).toHaveLength(0);
    // Nothing tracked means nothing stored: a binary blob only exists as some
    // moment's payload, which is what the row count above pins.
    expect(await liveTrackedFiles(loopback)).toEqual([]);
    await engine.stop();
  });

  it("captures an over-text-cap invalid-UTF-8 text-media file as a binary moment", async () => {
    const root = await tempRoot();
    // 1 MiB of 0xFF: a text-suffixed path over the text cap that is binary
    // in disguise (invalid UTF-8) and within the binary cap. The text cap
    // must not retire it before the binary path can claim it.
    const bytes = Buffer.alloc(1024 * 1024, 0xff);
    await write(root, "blob.md", bytes);
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "blob.md", operation: "update" }]);
    await engine.flush();

    expect(await liveTrackedFiles(loopback)).toEqual([
      {
        path: "blob.md",
        contentKind: "binary",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      },
    ]);
    expect(await liveMoments(engine)).toHaveLength(1);
    await engine.stop();
  });

  it("retires an over-text-cap valid-UTF-8 text file instead of demoting it to binary", async () => {
    const root = await tempRoot();
    await write(root, "big.md", "small\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "big.md", operation: "update" }]);
    await engine.flush();

    // Genuine text over the text cap is untracked content (established
    // behavior): the previously tracked path is retired, never stored as
    // binary bytes.
    await write(root, "big.md", "x".repeat(1024 * 1024));
    engine.captureBatch([{ path: "big.md", operation: "update" }]);
    await engine.flush();

    expect((await liveMoments(engine)).map((m) => [m.path, m.operation])).toEqual([
      ["big.md", "write"],
      ["big.md", "delete"],
    ]);
    // Never stored as bytes: no moment on this path carried a binary payload,
    // which is the only way binary bytes enter the store at all.
    expect(
      (await engine.listMoments()).moments.map((moment) => moment.contentKind),
    ).toEqual(["text", "text"]);
    await engine.stop();
  });

  it("does not record a duplicate moment for unchanged binary recapture", async () => {
    const root = await tempRoot();
    const bytes = Buffer.from([0, 1, 2, 255]);
    await write(root, "logo.png", bytes);
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();
    engine.captureBatch([{ path: "logo.png", operation: "update" }]);
    await engine.flush();

    expect(await liveMoments(engine)).toHaveLength(1);
    expect(await liveTrackedFiles(loopback)).toEqual([
      {
        path: "logo.png",
        contentKind: "binary",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      },
    ]);
    await engine.stop();
  });

  it("captures a settled write into the engine main version", async () => {
    const root = await tempRoot();
    await write(root, "notes/today.md", "# Today\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "notes/today.md", operation: "update" }]);
    await engine.flush();

    expect(await liveMoments(engine)).toEqual([
      {
        path: "notes/today.md",
        operation: "write",
        text: "# Today\n",
        origin: "local-file",
        summary: null,
        correlationId: null,
      },
    ]);
    await engine.stop();
  });

  it("coalesces rapid writes to one file into one engine record per physical state", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);

    // Two rapid writes settle into ONE watcher batch carrying the final
    // content — the engine records exactly one moment for it.
    await write(root, "a.md", "draft 1\n");
    await write(root, "a.md", "draft 2\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(1);
    expect((await liveMoments(engine))[0].text).toBe("draft 2\n");

    // A second batch observing the SAME content (e.g. touch, re-save) is a
    // no-op — never a duplicate engine record for one physical state.
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(1);

    // New content records again.
    await write(root, "a.md", "draft 3\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(2);
    await engine.stop();
  });

  it("captures deletes for engine-tracked files and skips deletes for unknown paths", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "gone soon\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();

    await unlink(join(root, "a.md"));
    engine.captureBatch([
      { path: "a.md", operation: "delete" },
      { path: "never-tracked.md", operation: "delete" },
    ]);
    await engine.flush();

    const moments = await liveMoments(engine);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["a.md", "write"],
      ["a.md", "delete"],
    ]);
    await engine.stop();
  });

  it("skips secret, ignored, and oversized files while capturing in-cap binary content", async () => {
    const root = await tempRoot();
    await write(root, ".env", "SECRET=1\n");
    await write(root, "config/.env", "SECRET=2\n");
    await write(root, "prod.env", "SECRET=3\n");
    await write(root, "node_modules/pkg/index.js", "ignored\n");
    await write(root, "logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await write(root, "not-utf8.md", new Uint8Array([0xff, 0xfe, 0x00, 0xc3]));
    await write(root, "huge.md", "x".repeat(MAX_ENGINE_CAPTURE_TEXT_BYTES + 1));
    await write(root, "ok.md", "tracked\n");

    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([
      { path: ".env", operation: "update" },
      { path: "config/.env", operation: "update" },
      { path: "prod.env", operation: "update" },
      { path: "node_modules/pkg/index.js", operation: "update" },
      { path: "logo.png", operation: "update" },
      { path: "not-utf8.md", operation: "update" },
      { path: "huge.md", operation: "update" },
      { path: "ok.md", operation: "update" },
    ]);
    await engine.flush();

    expect((await liveMoments(engine)).map((m) => m.path)).toEqual([
      "logo.png",
      "not-utf8.md",
      "ok.md",
    ]);
    expect(
      (await liveTrackedFiles(loopback)).map((file) => [file.path, file.contentKind]),
    ).toEqual([
      ["logo.png", "binary"],
      ["not-utf8.md", "binary"],
      ["ok.md", "text"],
    ]);
    // The secret paths went to the SECRET side, never into text history: the
    // timeline's protected rows are where .env edits live, and liveMoments
    // drops them exactly as the text-moments query did.
    expect(
      (await engine.listMoments())
        .moments.filter((moment) => moment.protected)
        .map((moment) => moment.path)
        .sort(),
    ).toEqual([".env", "config/.env", "prod.env"]);
    await engine.stop();
  });

  // Symlink containment (CodeRabbit arc gate): the live watcher can emit a
  // symlink LEAF path even though the scanner skips symlinks, and stat()
  // would dereference it OUTSIDE the workspace — foreign content must never
  // enter durable engine history as owned text.
  it("never captures a symlink leaf, even when it dereferences outside the workspace", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "secret.md", "outside secret\n");
    await mkdir(join(root, "notes"), { recursive: true });
    await symlink(join(outside, "secret.md"), join(root, "notes", "today.md"));
    await write(root, "inside.md", "real inside text\n");
    await symlink(join(root, "inside.md"), join(root, "alias.md"));

    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([
      { path: "notes/today.md", operation: "update" },
      { path: "alias.md", operation: "update" },
      { path: "inside.md", operation: "update" },
    ]);
    await engine.flush();

    // Only the real file was captured; neither symlink (outside-pointing or
    // workspace-internal) produced an engine moment.
    expect((await liveMoments(engine)).map((m) => [m.path, m.text])).toEqual([
      ["inside.md", "real inside text\n"],
    ]);
    await engine.stop();
  });

  it("retires a tracked path that later becomes a symlink", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "secret.md", "outside secret\n");
    await write(root, "notes.md", "honest text\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "notes.md", operation: "update" }]);
    await engine.flush();

    await unlink(join(root, "notes.md"));
    await symlink(join(outside, "secret.md"), join(root, "notes.md"));
    engine.captureBatch([{ path: "notes.md", operation: "update" }]);
    await engine.flush();

    const moments = await liveMoments(engine);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["notes.md", "write"],
      ["notes.md", "delete"],
    ]);
    // The symlink target's content never entered the store.
    expect(moments.some((m) => m.text.includes("outside secret"))).toBe(false);
    await engine.stop();
  });

  it("preserves identity when a tracked text path becomes in-cap binary content", async () => {
    const root = await tempRoot();
    await write(root, "data.md", "text at first\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.flush();

    await write(root, "data.md", new Uint8Array([0x00, 0x01, 0x02, 0xff]));
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.flush();

    const moments = await liveMoments(engine);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["data.md", "write"],
      ["data.md", "write"],
    ]);
    // The transition is an honest moment, not a generic update.
    expect(moments[1].summary).toBe("Became a binary file");
    expect(
      (await liveTrackedFiles(loopback)).map((file) => [file.path, file.contentKind]),
    ).toEqual([["data.md", "binary"]]);
    await engine.stop();
  });

  it("records an honest moment when a binary path becomes text again", async () => {
    const root = await tempRoot();
    await write(root, "data.md", new Uint8Array([0x00, 0x01, 0x02, 0xff]));
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.flush();

    await write(root, "data.md", "text again\n");
    engine.captureBatch([{ path: "data.md", operation: "update" }]);
    await engine.flush();

    const moments = await liveMoments(engine);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["data.md", "write"],
      ["data.md", "write"],
    ]);
    expect(moments[1].summary).toBe("Became a text file");
    expect(
      (await liveTrackedFiles(loopback)).map((file) => [file.path, file.contentKind]),
    ).toEqual([["data.md", "text"]]);
    await engine.stop();
  });

  it("honors files policy tracked false without deleting prior moments", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "v1\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "kept.md", operation: "update" }]);
    await engine.flush();
    expect((await liveMoments(engine)).map((m) => [m.path, m.text])).toEqual([
      ["kept.md", "v1\n"],
    ]);

    await write(
      root,
      ".dohc/files.toml",
      '[[rule]]\npath = "kept.md"\ntracked = false\n\n[[rule]]\npath = "new.md"\ntracked = false\n',
    );
    await write(root, "kept.md", "v2\n");
    await write(root, "new.md", "new\n");
    engine.captureBatch([
      { path: "kept.md", operation: "update" },
      { path: "new.md", operation: "update" },
    ]);
    await engine.flush();

    expect((await liveMoments(engine)).map((m) => [m.path, m.text])).toEqual([
      ["kept.md", "v1\n"],
    ]);
    await engine.stop();
  });

  it("retires a policy-untracked path on the next reconcile pass without touching disk", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "v1\n");
    // One loopback across both captures: two sessions, one workspace — the
    // role the shared engine.db played before.
    const loopback = new VersionedLoopbackEngine();
    const first = liveCapture(root, loopback);
    first.captureBatch([{ path: "kept.md", operation: "update" }]);
    await first.stop();

    // Policy lands while the engine is closed; the next session's startup
    // reconciliation must retire the engine snapshot (never-stale rule) with
    // an honest summary while leaving the disk file alone.
    await write(root, ".dohc/files.toml", '[[rule]]\npath = "kept.md"\ntracked = false\n');
    const second = liveCapture(root, loopback);
    second.start();
    await second.flush();

    const moments = await liveMoments(second);
    expect(moments.map((m) => [m.path, m.operation])).toEqual([
      ["kept.md", "write"],
      ["kept.md", "delete"],
    ]);
    expect(moments[1].summary).toBe("Stopped tracking by policy");
    await expect(readFile(join(root, "kept.md"), "utf8")).resolves.toBe("v1\n");
    await second.stop();
  });

  it("surfaces malformed policy through onError without breaking other files", async () => {
    const root = await tempRoot();
    await write(root, ".dohc/files.toml", '[[rule]]\npath = "ignored.md"\nmode = true\n');
    await write(root, "a.md", "alpha\n");
    await write(root, "b.md", "beta\n");
    const errors: Array<{ context: string; error: unknown }> = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback, {
      onError: (context, error) => {
        errors.push({ context, error });
      },
    });

    engine.captureBatch([
      { path: "a.md", operation: "update" },
      { path: "b.md", operation: "update" },
    ]);
    await engine.flush();

    expect(errors.some((entry) => entry.context.includes("policy validation"))).toBe(true);
    expect((await liveMoments(engine)).map((m) => m.path)).toEqual(["a.md", "b.md"]);
    await engine.stop();
  });

  it("refreshes policy files on the next capture pass without watcher invalidation", async () => {
    const root = await tempRoot();
    await write(root, "policy-target.md", "v1\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.captureBatch([{ path: "policy-target.md", operation: "update" }]);
    await engine.flush();
    expect((await liveMoments(engine)).map((m) => m.text)).toEqual(["v1\n"]);

    await write(
      root,
      ".dohc/files.toml",
      '[[rule]]\npath = "policy-target.md"\ntracked = false\n',
    );
    await write(root, "policy-target.md", "v2\n");
    engine.captureBatch([{ path: "policy-target.md", operation: "update" }]);
    await engine.flush();

    expect((await liveMoments(engine)).map((m) => m.text)).toEqual(["v1\n"]);
    await engine.stop();
  });
});

describe("workspaceEngineCapture expected engine events", () => {
  it("suppresses engine re-capture of a registered engine-originated write, once", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    await write(root, "restored.md", "engine wrote this\n");

    engine.registerExpectedEngineEvents([
      {
        path: "restored.md",
        operation: "write",
        sha256: sha256Utf8("engine wrote this\n"),
      },
    ]);
    engine.captureBatch([{ path: "restored.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(0);

    // Consumed: the same observation again is a real capture.
    engine.captureBatch([{ path: "restored.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(1);
    await engine.stop();
  });

  it("does not suppress a later USER edit with different content", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    engine.registerExpectedEngineEvents([
      { path: "a.md", operation: "write", sha256: sha256Utf8("engine content\n") },
    ]);
    // The user overwrote the path before the batch settled: content differs,
    // so the registration must NOT swallow the user's edit.
    await write(root, "a.md", "user content\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    const moments = await liveMoments(engine);
    expect(moments).toHaveLength(1);
    expect(moments[0].text).toBe("user content\n");
    await engine.stop();
  });

  it("expires registrations and honors cancellation", async () => {
    const root = await tempRoot();
    let nowMs = 1_000_000;
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback, { now: () => nowMs });
    await write(root, "expired.md", "stale\n");

    engine.registerExpectedEngineEvents([
      { path: "expired.md", operation: "write", sha256: sha256Utf8("stale\n") },
    ]);
    nowMs += EXPECTED_ENGINE_EVENT_EXPIRY_MS + 1;
    engine.captureBatch([{ path: "expired.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(1);

    await write(root, "cancelled.md", "cancelled\n");
    const cancel = engine.registerExpectedEngineEvents([
      { path: "cancelled.md", operation: "write", sha256: sha256Utf8("cancelled\n") },
    ]);
    cancel();
    engine.captureBatch([{ path: "cancelled.md", operation: "update" }]);
    await engine.flush();
    expect((await liveMoments(engine)).map((m) => m.path)).toEqual([
      "expired.md",
      "cancelled.md",
    ]);
    await engine.stop();
  });

  it("suppresses a registered engine-originated delete", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    await write(root, "a.md", "content\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();

    // Engine restore deleted the file on disk AND recorded its own moment;
    // the watcher's observation must not double-record the delete.
    await unlink(join(root, "a.md"));
    engine.registerExpectedEngineEvents([{ path: "a.md", operation: "delete" }]);
    engine.captureBatch([{ path: "a.md", operation: "delete" }]);
    await engine.flush();
    expect((await liveMoments(engine)).map((m) => m.operation)).toEqual(["write"]);
    await engine.stop();
  });
});

describe("workspaceEngineCapture relay sync materialization (0P-B)", () => {
  it("initializes the main version before the first relay task", async () => {
    const root = await tempRoot();
    const requests: Request[] = [];
    const engine = liveCapture(root, new VersionedLoopbackEngine(), {
      daemonOwnsCapture: true,
      requests,
    });

    let initializedWhenTaskRan = false;
    await engine.runRelaySync(async () => {
      initializedWhenTaskRan = requests.some(
        (request) => request.method === VERSIONED_METHOD.versionsEnsureMain,
      );
      return { fastForwardedPaths: [] };
    });

    expect(initializedWhenTaskRan).toBe(true);
    await engine.stop();
  });

  it("settles daemon capture after relay materialization before committing the cursor", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    let settled = true;
    const engine = capture(root, {
      daemonOwnsCapture: true,
      rustEngineSessions: mockLiveSessions(loopback, requests, () => ({
        settled,
        running: true,
        degraded: !settled,
      })),
    });
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });
    let flushedWhenCommitted = false;

    await engine.runRelaySync(async () => ({
      fastForwardedPaths: [
        { path: "notes/remote.md", operation: "write" as const, contentKind: "text" as const },
      ],
      commitFetchCursor: async () => {
        flushedWhenCommitted = requests.some(
          (request) => request.method === "capture.reconcile",
        );
      },
    }));

    expect(flushedWhenCommitted).toBe(true);

    settled = false;
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "new remote text\n",
      origin: "sync",
    });
    const commitWhileUnsettled = vi.fn(async () => {});
    await expect(
      engine.runRelaySync(async () => ({
        fastForwardedPaths: [
          { path: "notes/remote.md", operation: "write" as const, contentKind: "text" as const },
        ],
        commitFetchCursor: commitWhileUnsettled,
      })),
    ).rejects.toThrow("did not settle");
    expect(commitWhileUnsettled).not.toHaveBeenCalled();

    settled = true;
    await engine.stop();
  });

  it("materializes pull-fast-forwarded paths to disk and suppresses the watcher echo", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    // Simulate the post-pull state: the engine holds remote content the folder
    // does not have yet (pull applies ops to the engine; runRelaySync owns
    // getting them onto disk).
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });
    const momentsBefore = (await liveMoments(engine)).length;

    const result = await engine.runRelaySync(async () => ({
      fastForwardedPaths: [
        { path: "notes/remote.md", operation: "write" as const, contentKind: "text" as const },
      ],
    }));
    expect(result.fastForwardedPaths).toHaveLength(1);
    expect(await readFile(join(root, "notes/remote.md"), "utf8")).toBe(
      "remote machine wrote this\n",
    );

    // The watcher observes the sync write; the expected-event registration
    // must swallow it — materializing remote state is not a new local moment.
    engine.captureBatch([{ path: "notes/remote.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(momentsBefore);

    // A later REAL user edit on the same path is still captured.
    await write(root, "notes/remote.md", "user follow-up\n");
    engine.captureBatch([{ path: "notes/remote.md", operation: "update" }]);
    await engine.flush();
    const moments = await liveMoments(engine);
    expect(moments).toHaveLength(momentsBefore + 1);
    expect(moments[moments.length - 1].text).toBe("user follow-up\n");
    await engine.stop();
  });

  it("materializes a remote delete and reports no disk work when nothing fast-forwarded", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    await write(root, "doomed.md", "here today\n");
    engine.captureBatch([{ path: "doomed.md", operation: "update" }]);
    await engine.flush();

    // Remote deleted the file; pull already applied the delete to the engine.
    await loopback.sendRequest({
      id: -2,
      method: VERSIONED_METHOD.textDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "doomed.md",
        origin: "sync",
        summary: "remote delete",
      },
    });
    const momentsBefore = (await liveMoments(engine)).length;

    await engine.runRelaySync(async () => ({
      fastForwardedPaths: [
        { path: "doomed.md", operation: "delete" as const, contentKind: "text" as const },
      ],
    }));
    expect(existsSync(join(root, "doomed.md"))).toBe(false);
    engine.captureBatch([{ path: "doomed.md", operation: "delete" }]);
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(momentsBefore);

    // A quiescent pass (no fast-forwarded paths) touches nothing.
    await engine.runRelaySync(async () => ({ fastForwardedPaths: [] }));
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(momentsBefore);
    await engine.stop();
  });

  it("materializes protected writes and deletes before committing the relay cursor", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: ".env",
      text: "ACCESS_TOKEN=protected\r\n",
      origin: "sync",
    });
    const commitOrder: string[] = [];

    await engine.runRelaySync(async () => ({
      fastForwardedPaths: [
        { path: ".env", operation: "write" as const, contentKind: "secret" as const },
      ],
      commitFetchCursor: async () => {
        expect(await readFile(join(root, ".env"), "utf8")).toBe(
          "ACCESS_TOKEN=protected\r\n",
        );
        commitOrder.push("write");
      },
    }));

    await loopback.sendRequest({
      id: -3,
      method: VERSIONED_METHOD.secretsDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        origin: "sync",
        momentId: "remote-secret-delete",
      },
    });
    await engine.runRelaySync(async () => ({
      fastForwardedPaths: [
        { path: ".env", operation: "delete" as const, contentKind: "secret" as const },
      ],
      commitFetchCursor: async () => {
        expect(existsSync(join(root, ".env"))).toBe(false);
        commitOrder.push("delete");
      },
    }));

    expect(commitOrder).toEqual(["write", "delete"]);
    await engine.stop();
  });

  // Data-safety gate finding: the relay fetch cursor must only commit AFTER
  // the pulled state is safely on disk. A failed materialization leaves the
  // cursor un-advanced so the next pass retries the same ops.
  it("commits the relay fetch cursor only after disk materialization succeeds", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });

    // Block materialization: a directory squats on the file path.
    await mkdir(join(root, "notes/remote.md"), { recursive: true });
    const commit = vi.fn(async () => {});
    const pullResult = () => ({
      fastForwardedPaths: [
        { path: "notes/remote.md", operation: "write" as const, contentKind: "text" as const },
      ],
      commitFetchCursor: commit,
    });
    await expect(engine.runRelaySync(async () => pullResult())).rejects.toThrow(
      /Could not update notes\/remote\.md/u,
    );
    expect(commit).not.toHaveBeenCalled();

    // Unblock the path: the retry pass materializes and THEN commits.
    await rm(join(root, "notes/remote.md"), { recursive: true, force: true });
    await engine.runRelaySync(async () => pullResult());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "notes/remote.md"), "utf8")).toBe(
      "remote machine wrote this\n",
    );

    // A quiescent pass (chat-only or own-origin ops) still commits: cursor
    // progress must not depend on file materialization work existing.
    const quiescentCommit = vi.fn(async () => {});
    await engine.runRelaySync(async () => ({
      fastForwardedPaths: [],
      commitFetchCursor: quiescentCommit,
    }));
    await engine.stop();
    expect(quiescentCommit).toHaveBeenCalledTimes(1);
  });
});

describe("workspaceEngineCapture startup reconciliation", () => {
  it("captures closed-period edits and deletions, idempotently", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "unchanged\n");
    await write(root, "edited.md", "before\n");
    await write(root, "deleted.md", "doomed\n");
    await write(root, ".env", "SECRET=1\n");

    // First session: engine learns the workspace via reconciliation. One
    // loopback across all three captures: three sessions, one workspace.
    const loopback = new VersionedLoopbackEngine();
    const first = liveCapture(root, loopback);
    first.start();
    await first.flush();
    expect((await liveMoments(first)).map((m) => m.path).sort()).toEqual([
      "deleted.md",
      "edited.md",
      "kept.md",
    ]);
    await first.stop();

    // Closed period: one edit, one delete, one new file.
    await write(root, "edited.md", "after\n");
    await unlink(join(root, "deleted.md"));
    await write(root, "created.md", "new\n");

    const second = liveCapture(root, loopback);
    second.start();
    await second.flush();
    const afterSecond = await liveMoments(second);
    const reconciled = afterSecond.slice(3);
    expect(
      reconciled.map((m) => [m.path, m.operation]).sort(),
    ).toEqual([
      ["created.md", "write"],
      ["deleted.md", "delete"],
      ["edited.md", "write"],
    ]);
    // Actor-neutral local provenance, one correlation id per pass.
    for (const moment of reconciled) {
      expect(moment.origin).toBe("local-file");
      expect(moment.summary).toBe("Reconciled offline edits");
      expect(moment.correlationId).toMatch(/^reconcile-/);
    }
    expect(new Set(reconciled.map((m) => m.correlationId)).size).toBe(1);
    await second.stop();

    // Idempotent: running reconciliation again adds nothing new.
    const third = liveCapture(root, loopback);
    third.start();
    await third.flush();
    expect(await liveMoments(third)).toHaveLength(afterSecond.length);
    await third.stop();
  });

  it("stamps reconcile correlation ids from an injected createId seam", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "before\n");
    const loopback = new VersionedLoopbackEngine();
    const first = liveCapture(root, loopback, { createId: () => "corr-fixed-0001" });
    first.start();
    await first.stop();

    // Closed-period edit so the next session reconciles a change.
    await write(root, "kept.md", "after\n");
    const second = liveCapture(root, loopback, { createId: () => "corr-fixed-0001" });
    second.start();
    await second.flush();

    const stamped = (await liveMoments(second)).filter((m) => m.correlationId !== null);
    expect(stamped.length).toBeGreaterThan(0);
    for (const moment of stamped) {
      expect(moment.correlationId).toBe("reconcile-corr-fixed-0001");
    }
    await second.stop();
  });

  it("serializes reconciliation before a live watcher batch on one chain", async () => {
    const root = await tempRoot();
    await write(root, "offline.md", "offline edit\n");

    const order: string[] = [];
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root },
      sessions,
    ).store;
    const trackedStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "listTextFileMetadata") {
          return async (
            input: Parameters<
              NonNullable<typeof liveStore.listTextFileMetadata>
            >[0],
          ) => {
            // Reconciliation's final phase, so its disk scan has already run.
            // The watcher's file lands HERE, not before start(): a scan that
            // saw live.md would reconcile it itself, and the pass would then
            // write both paths in scan order (live.md, offline.md) with the
            // batch deduped to nothing — a sequence that says nothing about
            // which task reached the chain first. Created after the scan, the
            // path can only be written by the batch.
            await write(root, "live.md", "live edit\n");
            // Slow, so a batch that jumped the chain interleaves ahead of the
            // push below instead of racing it.
            await new Promise((resolve) => setTimeout(resolve, 50));
            order.push("reconcile:listTextFileMetadata");
            return await liveStore.listTextFileMetadata!(input);
          };
        }
        if (property === "writeTextFile") {
          return async (input: Parameters<typeof liveStore.writeTextFile>[0]) => {
            order.push(`write:${input.path}`);
            return await liveStore.writeTextFile(input);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    // "Daemon path" here means the daemon-BACKED STORE, not daemon-owns-
    // capture. Production's only construction (engineCaptureGate.ts) passes
    // daemonOwnsCapture: true, and under that flag BOTH enqueues below return
    // early — the daemon captures on its own side and settles through
    // flushCapture. So this pins the client-side chain contract, not the
    // capture ownership production actually runs.
    const engine = capture(root, {
      store: trackedStore,
      rustEngineSessions: sessions,
    });
    engine.start();
    engine.captureBatch([{ path: "live.md", operation: "update" }]);
    await engine.stop();

    expect(order).toEqual([
      "write:offline.md",
      "reconcile:listTextFileMetadata",
      "write:live.md",
    ]);
    await liveStore.close();
  });

  itNonRoot("cold adoption survives an unreadable subdirectory: the rest of the tree seeds and the pass reports degraded", async () => {
    const root = await tempRoot();
    await write(root, "notes/adopted.md", "# Adopted\n");
    await write(root, "docs/deep/nested.md", "# Nested\n");
    await write(root, "locked/secret.md", "# Never readable this pass\n");
    await denyRead(join(root, "locked"), "dir");

    const outcomes: boolean[] = [];
    const errors: Array<{ context: string; error: unknown }> = [];
    const loopback = new VersionedLoopbackEngine();
    try {
      const engine = liveCapture(root, loopback, {
        onCaptureOutcome: ({ ok }) => outcomes.push(ok),
        onError: (context, error) => errors.push({ context, error }),
      });
      engine.start();
      await engine.flush();
      // Every readable file seeded — one bad directory no longer starves the
      // whole first reconciliation.
      expect((await liveMoments(engine)).map((m) => [m.path, m.operation]).sort()).toEqual(
        [
          ["docs/deep/nested.md", "write"],
          ["notes/adopted.md", "write"],
        ],
      );
      await engine.stop();
    } finally {
      await restoreRead(join(root, "locked"), 0o755);
    }

    // ...and the failure surfaced as a DEGRADED outcome (raises the capture
    // notice), never silently.
    expect(outcomes).toEqual([false]);
    const scanError = errors.find((entry) => entry.context === "reconciliation scan");
    expect(String((scanError?.error as Error)?.message)).toContain("locked");
  });

  itNonRoot("does not retire tracked files under a transiently unreadable directory", async () => {
    const root = await tempRoot();
    await write(root, "kept.md", "kept\n");
    await write(root, "locked/inside.md", "tracked earlier\n");

    // First session seeds both files while everything is readable.
    const loopback = new VersionedLoopbackEngine();
    const first = liveCapture(root, loopback);
    first.start();
    await first.flush();
    expect((await liveMoments(first)).map((m) => m.path).sort()).toEqual([
      "kept.md",
      "locked/inside.md",
    ]);
    await first.stop();

    // Second session: the directory is unreadable. Absent-from-a-degraded-
    // listing is NOT deletion evidence — no delete moment may be recorded.
    await denyRead(join(root, "locked"), "dir");
    const outcomes: boolean[] = [];
    let recorded: EngineMomentRow[] = [];
    try {
      const second = liveCapture(root, loopback, {
        onCaptureOutcome: ({ ok }) => outcomes.push(ok),
        onError: () => {},
      });
      second.start();
      await second.flush();
      recorded = await liveMoments(second);
      await second.stop();
    } finally {
      await restoreRead(join(root, "locked"), 0o755);
    }

    expect(outcomes).toEqual([false]);
    expect(recorded.filter((m) => m.operation === "delete")).toEqual([]);
  });

  it("a file deleted between the scan and the pass reconciles as a real delete, not a degraded pass", async () => {
    const root = await tempRoot();
    await write(root, "stays.md", "stays\n");
    await write(root, "vanishes.md", "gone soon\n");

    const loopback = new VersionedLoopbackEngine();
    const first = liveCapture(root, loopback);
    first.start();
    await first.stop();

    // Delete while dohc is closed: the next startup pass records an honest
    // delete moment and reports OK (nothing was unreadable).
    await unlink(join(root, "vanishes.md"));
    const outcomes: boolean[] = [];
    const second = liveCapture(root, loopback, {
      onCaptureOutcome: ({ ok }) => outcomes.push(ok),
    });
    second.start();
    await second.flush();

    expect(outcomes).toEqual([true]);
    expect(
      (await liveMoments(second))
        .filter((m) => m.operation === "delete")
        .map((m) => m.path),
    ).toEqual(["vanishes.md"]);
    await second.stop();
  });
});

describe("assertGeneratedMarkdownPath host-unsafe rejection (materialize boundary)", () => {
  it("throws a TYPED unsupported-name error only when the host is Windows", () => {
    // Windows-illegal names that can arrive from a sync peer and cannot be
    // materialized on a Windows disk.
    for (const path of ["nul.md", "notes.md:hidden.md", "DOHC~1.md"]) {
      expect(() => assertGeneratedMarkdownPath(path, "win32")).toThrow(
        UnsupportedWorkspacePathError,
      );
      try {
        assertGeneratedMarkdownPath(path, "win32");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedWorkspacePathError);
        expect((error as UnsupportedWorkspacePathError).code).toBe("unsupported-name");
        expect((error as UnsupportedWorkspacePathError).workspacePath).toBe(path);
      }
      // Same names are host-legal off Windows: no typed rejection.
      expect(assertGeneratedMarkdownPath(path, "linux")).toBe(path);
    }
  });

  it("still rejects genuinely-unsafe generated paths generically on every host", () => {
    expect(() => assertGeneratedMarkdownPath("../escape.md", "linux")).toThrow(
      /safe visible Markdown path/,
    );
    expect(() => assertGeneratedMarkdownPath("notes/plan.txt", "linux")).toThrow(
      /safe visible Markdown path/,
    );
  });
});

describe("workspaceEngineCapture sole recorder (PR 0M-5)", () => {
  it("records flagged-workspace batches into the engine only — no legacy change set", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-sole-recorder",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      engineCapture: () => engine,
      onRecorded: () => resolveRecorded?.(),
    });
    await handle.ready;
    await write(root, "notes.md", "# Notes\n");
    await recorded;
    await handle.stop();

    const moments = await liveMoments(engine);
    expect(moments.map((moment) => moment.path)).toEqual(["notes.md"]);
    expect(moments[0].text).toBe("# Notes\n");
    expect(existsSync(join(root, ".dohc", "history"))).toBe(false);
    await engine.stop();
  });

  it("records NOTHING without an engine capture (retirement Phase C: opt-out has no recorder)", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "opted-out-no-recorder",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      onRecorded: () => resolveRecorded?.(),
    });
    await handle.ready;
    await write(root, "notes.md", "# Notes\n");
    // The batch still settles (UI refresh / cloud queue), but no history of
    // any kind is written: no legacy change sets, no engine store.
    await recorded;
    await handle.stop();

    expect(existsSync(join(root, ".dohc", "history"))).toBe(false);
    expect(existsSync(join(root, ".dohc", "engine", "engine.db"))).toBe(false);
  });
});

describe("workspaceEngineCapture failure isolation", () => {
  // PR 0M-5 ended the 0M-3 interim dual-write: with the engine as the sole
  // recorder, an engine-store failure surfaces via onError and the watcher
  // keeps running, but no legacy change set is written for the flagged
  // workspace (fail visible, no second source of truth — the disk stays the
  // source and the next reconcile pass recovers the missed capture). This
  // test previously asserted the legacy fail-open record; the change is the
  // deliberate 0M-5 behavior flip.
  it("surfaces engine failures without crashing the watcher and without a legacy record", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-fail-visible",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const errors: string[] = [];
    const { loopback } = failableLoopback();
    const engine = liveCapture(root, loopback, {
      onError: (context) => {
        errors.push(context);
      },
    });

    let recordedCount = 0;
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      engineCapture: () => engine,
      onRecorded: () => {
        recordedCount += 1;
        resolveRecorded?.();
      },
    });
    await handle.ready;
    await write(root, "notes.md", "# Notes\n");
    await recorded;
    await handle.stop();
    await engine.stop();

    // The watcher survived and completed the batch, the failure surfaced,
    // and NO legacy change set was written for the flagged workspace.
    expect(recordedCount).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(existsSync(join(root, ".dohc", "history"))).toBe(false);
  });

  it("one bad path does not drop the rest of the batch", async () => {
    const root = await tempRoot();
    await write(root, "good.md", "fine\n");
    await write(root, "bad.md", "poison\n");
    // One path poisoned on the wire: the daemon refuses this write and only
    // this write.
    const { loopback } = failableLoopback(
      (request) =>
        request.method === VERSIONED_METHOD.textWrite &&
        (request.params as { path?: string }).path === "bad.md",
    );
    const errors: string[] = [];
    const engine = liveCapture(root, loopback, {
      onError: (context) => {
        errors.push(context);
      },
    });
    engine.captureBatch([
      { path: "bad.md", operation: "update" },
      { path: "good.md", operation: "update" },
    ]);
    await engine.flush();

    expect((await liveMoments(engine)).map((m) => m.path)).toEqual(["good.md"]);
    expect(errors).toEqual(["batch capture of bad.md"]);
    await engine.stop();
  });
});

describe("workspaceEngineCapture capture-failure notice (PR 0M-7)", () => {
  it("reports a failed outcome per failing capture pass and success on recovery", async () => {
    const root = await tempRoot();
    await write(root, "note.md", "v1\n");
    const { loopback, state } = failableLoopback();
    const outcomes: boolean[] = [];
    const engine = liveCapture(root, loopback, {
      onError: () => {},
      onCaptureOutcome: ({ ok }) => outcomes.push(ok),
    });

    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    expect(outcomes).toEqual([false]);

    state.failing = false;
    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    expect(outcomes).toEqual([false, true]);
    // The recovered pass really captured: a transient open failure must not
    // be cached forever.
    expect((await liveMoments(engine)).map((m) => m.path)).toEqual(["note.md"]);
    await engine.stop();
  });

  it("mutation proof: daemon startup open failure raises the capture outcome", async () => {
    const root = await tempRoot();
    const { loopback, state } = failableLoopback();
    const outcomes: boolean[] = [];
    const errors: string[] = [];
    let resolveOutcome!: () => void;
    const outcomeReported = new Promise<void>((resolve) => {
      resolveOutcome = resolve;
    });
    let resolveError!: () => void;
    const errorReported = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const engine = liveCapture(root, loopback, {
      daemonOwnsCapture: true,
      onCaptureOutcome: ({ ok }) => {
        outcomes.push(ok);
        resolveOutcome();
      },
      onError: (context) => {
        errors.push(context);
        resolveError();
      },
    });

    engine.start();
    await Promise.all([outcomeReported, errorReported]);

    expect(outcomes).toEqual([false]);
    expect(errors).toEqual(["daemon capture health"]);
    state.failing = false;
    await engine.stop();
  });

  it("reports a failed outcome when only one path in a batch fails", async () => {
    const root = await tempRoot();
    await write(root, "good.md", "fine\n");
    await write(root, "bad.md", "poison\n");
    const { loopback } = failableLoopback(
      (request) =>
        request.method === VERSIONED_METHOD.textWrite &&
        (request.params as { path?: string }).path === "bad.md",
    );
    const outcomes: boolean[] = [];
    const engine = liveCapture(root, loopback, {
      onError: () => {},
      onCaptureOutcome: ({ ok }) => outcomes.push(ok),
    });
    engine.captureBatch([
      { path: "bad.md", operation: "update" },
      { path: "good.md", operation: "update" },
    ]);
    await engine.stop();
    expect(outcomes).toEqual([false]);
  });

  it("raises the workspace notice once without spam and clears it when capture recovers", async () => {
    const root = await tempRoot();
    await write(root, "note.md", "v1\n");
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-notice",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const { loopback, state } = failableLoopback();
    let notifyCount = 0;
    const activity = createWorkspaceActivity(
      () => {
        notifyCount += 1;
      },
      {
        captureFor: (w, hooks) => ({
          shareView: false,
          capture: createWorkspaceEngineCapture({
            workspaceId: w.workspaceId,
            rootPath: w.rootPath,
            rustEngineSessions: mockLiveSessions(loopback),
            onError: () => {},
            onCaptureOutcome: hooks.onCaptureOutcome,
          }),
        }),
      },
    );
    await activity.open(workspace);
    const engineCapture = activity.engineCaptureFor(workspace.workspaceId);
    expect(engineCapture).not.toBeNull();
    // Startup reconciliation fails against the broken store: the notice is
    // raised (one notify for the transition).
    await engineCapture!.flush();
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(true);
    const notifiesAtRaise = notifyCount;
    expect(notifiesAtRaise).toBeGreaterThan(0);

    // Repeated failures keep the flag raised but never re-notify (no spam).
    engineCapture!.captureBatch([{ path: "note.md", operation: "update" }]);
    await engineCapture!.flush();
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(true);
    expect(notifyCount).toBe(notifiesAtRaise);

    // A later successful capture clears the notice (one more notify).
    state.failing = false;
    engineCapture!.captureBatch([{ path: "note.md", operation: "update" }]);
    await engineCapture!.flush();
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(false);
    expect(notifyCount).toBe(notifiesAtRaise + 1);

    await activity.stopAll();
  }, 15_000);

  it("keeps unflagged workspaces unaffected", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-unflagged-notice",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ capture: null, shareView: false }),
    });
    await activity.open(workspace);
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBe(false);
    await activity.stopAll();
    // Not-open workspaces report a clean status too.
    expect(activity.getStatus("never-opened").historyCaptureFailed).toBe(false);
  }, 15_000);
});

describe("workspaceEngineCapture lifecycle via workspaceActivity", () => {
  it("attaches per open workspace and flushes the last capture before closing", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-lifecycle",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    let captureBuilds = 0;
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const writeGateState: { release: (() => void) | null } = { release: null };
    let markWriteBlocked: (() => void) | null = null;
    const writeGate = new Promise<void>((resolve) => {
      writeGateState.release = resolve;
    });
    const writeBlocked = new Promise<void>((resolve) => {
      markWriteBlocked = resolve;
    });
    let markStopStarted: (() => void) | null = null;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    const sessions = mockLiveSessions(
      loopback,
      requests,
      undefined,
      async (request) => {
        if (
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { path?: unknown }).path === "flushed.md"
        ) {
          markWriteBlocked?.();
          await writeGate;
        }
      },
    );
    const closeWorkspace = sessions.closeWorkspace.bind(sessions);
    let closeWorkspaceInvoked = false;
    sessions.closeWorkspace = async (...args) => {
      closeWorkspaceInvoked = true;
      await closeWorkspace(...args);
    };
    const activity = createWorkspaceActivity(
      () => resolveRecorded?.(),
      {
        captureFor: (w) => {
          captureBuilds += 1;
          const engineCapture = createWorkspaceEngineCapture({
            workspaceId: w.workspaceId,
            rootPath: w.rootPath,
            rustEngineSessions: sessions,
          });
          const stopCapture = engineCapture.stop.bind(engineCapture);
          engineCapture.stop = async () => {
            markStopStarted?.();
            await stopCapture();
          };
          return { capture: engineCapture, shareView: false };
        },
      },
    );

    await activity.open(workspace);
    // Re-opening must not build a second engine instance (singleton per open).
    await activity.open(workspace);
    expect(captureBuilds).toBe(1);

    await write(root, "flushed.md", "must survive shutdown\n");
    await recorded;
    await writeBlocked;
    // Hold the text write before the mock records the wire request. stopAll
    // must enter capture.stop and wait for that write before workspace.close.
    const stopping = activity.stopAll();
    await stopStarted;
    // A close-before-drain mutation reaches closeWorkspace here, even though
    // EngineWorkspaceSessions then waits for this active write run to finish.
    expect(closeWorkspaceInvoked).toBe(false);
    writeGateState.release?.();
    await stopping;
    expect(closeWorkspaceInvoked).toBe(true);

    const writeIndex = requests.findIndex(
      (request) =>
        request.method === VERSIONED_METHOD.textWrite &&
        (request.params as { path?: unknown }).path === "flushed.md",
    );
    const closeIndex = requests.findIndex(
      (request, index) =>
        index > writeIndex && request.method === "workspace.close",
    );
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(writeIndex);
    expect(await liveMomentPaths(loopback, workspace.workspaceId)).toContain(
      "flushed.md",
    );
  }, 15_000);

  it("registerExpectedEngineEvents reaches the open workspace's capture", async () => {
    const root = await tempRoot();
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-expected",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const loopback = new VersionedLoopbackEngine();
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (w) => ({
        shareView: false,
        capture: createWorkspaceEngineCapture({
          workspaceId: w.workspaceId,
          rootPath: w.rootPath,
          rustEngineSessions: mockLiveSessions(loopback),
        }),
      }),
    });
    await activity.open(workspace);
    const cancel = activity.registerExpectedEngineEvents(workspace.workspaceId, [
      { path: "a.md", operation: "delete" },
    ]);
    expect(typeof cancel).toBe("function");
    cancel?.();
    await activity.stopAll();

    expect(() =>
      activity.registerExpectedEngineEvents("not-open", [
        { path: "a.md", operation: "delete" },
      ]),
    ).toThrow(/not open/i);
  }, 15_000);
});

describe("workspaceEngineCapture loopback scale coverage (PR 0M-3)", () => {
  it("processes a 100-file burst through the loopback adapter", async () => {
    const root = await tempRoot();
    const events = [] as Array<{ path: string; operation: "update" }>;
    for (let index = 0; index < 100; index += 1) {
      const path = `burst/file-${String(index).padStart(3, "0")}.md`;
      await write(root, path, `# File ${index}\n\ncontent ${index}\n`);
      events.push({ path, operation: "update" });
    }
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    const startedAt = performance.now();
    engine.captureBatch(events);
    await engine.flush();
    const elapsedMs = performance.now() - startedAt;
    const momentCount = (await liveMoments(engine)).length;
    await engine.stop();

    expect(momentCount).toBe(100);
    console.log(
      `[scale] loopback watcher-batch fixture, 100-file burst completed in ${elapsedMs.toFixed(1)}ms ` +
        `(${(elapsedMs / 100).toFixed(2)}ms/file) on ${cpus()[0]?.model ?? "unknown CPU"}, ` +
        `node ${process.version}, ${process.platform}`,
    );
  }, 60_000);

  it("reconciles a 1,000-file loopback fixture with 10 changes", async () => {
    const root = await tempRoot();
    const paths: string[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const path = `corpus/dir-${index % 20}/file-${String(index).padStart(4, "0")}.md`;
      await write(root, path, `# Doc ${index}\n\nbody ${index}\n`);
      paths.push(path);
    }
    // Session one seeds the engine.
    const loopback = new VersionedLoopbackEngine();
    const first = liveCapture(root, loopback);
    first.start();
    await first.stop();
    expect(await liveMomentPaths(loopback)).toHaveLength(1000);

    // Closed period: 10 files change.
    for (let index = 0; index < 10; index += 1) {
      await write(root, paths[index * 97], `# Doc changed\n\nedited ${index}\n`);
    }
    const second = liveCapture(root, loopback);
    const startedAt = performance.now();
    second.start();
    await second.flush();
    const elapsedMs = performance.now() - startedAt;
    await second.stop();

    expect(await liveMomentPaths(loopback)).toHaveLength(1010);
    console.log(
      `[scale] loopback startup fixture, 1,000 files / 10 changed completed in ${elapsedMs.toFixed(1)}ms ` +
        `on ${cpus()[0]?.model ?? "unknown CPU"}, node ${process.version}, ${process.platform}`,
    );
  }, 120_000);
});

describe("createDefaultDiskWriter symlink containment", () => {
  // The engine's own materialization writes (switch/merge/restore) must stay
  // inside the workspace even against adversarial symlinks on disk.
  it("refuses to write through a symlink leaf", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "target.md", "original outside content\n");
    await symlink(join(outside, "target.md"), join(root, "notes.md"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "notes.md"), "engine text\n"),
    ).rejects.toThrow(/symlink/);
    // The symlink target outside the workspace was never touched.
    expect(await readFile(join(outside, "target.md"), "utf8")).toBe(
      "original outside content\n",
    );
  });

  it("refuses to mkdir through a symlinked ancestor pointing outside the workspace", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(root, "escape"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "escape", "deep", "file.md"), "x\n"),
    ).rejects.toThrow(/escaped the workspace root/);
    // mkdir -p never created directories on the far side of the symlink.
    expect(existsSync(join(outside, "deep"))).toBe(false);
  });

  it("writes normally inside the workspace, creating missing directories", async () => {
    const root = await tempRoot();
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "a", "b", "c.md"), "nested\n");
    expect(await readFile(join(root, "a", "b", "c.md"), "utf8")).toBe("nested\n");
  });

  it("deleting a symlink leaf removes the link, not its target", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await write(outside, "keep.md", "must survive\n");
    await symlink(join(outside, "keep.md"), join(root, "gone.md"));

    const writer = createDefaultDiskWriter(root);
    await writer.deletePath(join(root, "gone.md"));
    expect(existsSync(join(root, "gone.md"))).toBe(false);
    expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("must survive\n");
  });
});

// PR 0N-1 agent-attributed capture: a batch settled while a dohc-tracked
// agent run is active carries agent authorship into its engine moments;
// everything else stays actor-neutral (the raw external-CLI principle is
// unchanged — an absent run means an absent author).
describe("workspaceEngineCapture agent attribution", () => {
  const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" };

  it("routes plugin files.write with an explicit plugin author, not the ambient run", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback, { activeAgentRun: () => run });
    const spawnId = "plugin-spawn-123";

    await invokePluginSdkHost(
      {
        pluginId: "hello-plugin",
        workspaceRoot: root,
        spawnId,
        isWritable: () => true,
        writeAvailable: async () => true,
        writeAuthoredText: async (path, text, options) => {
          expect(options.overwrite).toBe(true);
          await engine.writeAuthoredTextFile(
            join(root, path),
            text,
            options.author,
          );
          return { path };
        },
      },
      "files.write",
      { path: "plugin-output.txt", text: "Written by plugin\n" },
    );

    expect(await readFile(join(root, "plugin-output.txt"), "utf8")).toBe(
      "Written by plugin\n",
    );
    expect(await liveMomentAuthors(engine)).toEqual([
      {
        kind: "agent",
        agentId: "plugin:hello-plugin",
        onBehalfOf: "local",
        agentRunId: spawnId,
      },
    ]);
    await engine.stop();
  });

  it("records the canonical path when an authored write uses an in-workspace alias", async () => {
    const root = await tempRoot();
    const canonical = join(root, "canonical");
    await mkdir(canonical);
    await symlink(
      canonical,
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const engine = liveCapture(root, new VersionedLoopbackEngine());

    await engine.writeAuthoredTextFile(
      join(root, "alias", "output.txt"),
      "canonical\n",
      { kind: "agent", agentId: "plugin:test", onBehalfOf: "local", agentRunId: "spawn" },
    );

    await expect(readFile(join(canonical, "output.txt"), "utf8")).resolves.toBe(
      "canonical\n",
    );
    expect((await liveMoments(engine)).map((moment) => moment.path)).toEqual([
      "canonical/output.txt",
    ]);
    await engine.stop();
  });

  it("serializes concurrent create-only authored writes so exactly one wins", async () => {
    const root = await tempRoot();
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const target = join(root, "exclusive.txt");
    const author = {
      kind: "agent" as const,
      agentId: "plugin:test",
      onBehalfOf: "local",
      agentRunId: "spawn",
    };

    const attempts = await Promise.allSettled([
      engine.writeAuthoredTextFile(target, "first", author, { createOnly: true }),
      engine.writeAuthoredTextFile(target, "second", author, { createOnly: true }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(String(attempts.find((attempt) => attempt.status === "rejected")?.reason)).toContain(
      "File already exists: exclusive.txt",
    );
    await expect(readFile(target, "utf8")).resolves.toMatch(/^(?:first|second)$/);
    await engine.stop();
  });

  it("rechecks panel cancellation after an authored write reaches the capture queue", async () => {
    const root = await tempRoot();
    const realLoopback = new VersionedLoopbackEngine();
    const entered = deferredVoid();
    const release = deferredVoid();
    let blocked = false;
    const loopback = new Proxy(realLoopback, {
      get(target, property, receiver) {
        if (property !== "sendRequest") return Reflect.get(target, property, receiver);
        return async (request: Request) => {
          if (!blocked && request.method === VERSIONED_METHOD.textWrite) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return target.sendRequest(request);
        };
      },
    });
    const engine = liveCapture(root, loopback);
    await write(root, "queue-blocker.txt", "block\n");
    engine.captureBatch([{ path: "queue-blocker.txt", operation: "update" }]);
    await entered.promise;

    const controller = new AbortController();
    const pending = engine.writeAuthoredTextFile(
      join(root, "cancelled.txt"),
      "must not land\n",
      { kind: "agent", agentId: "plugin:test", onBehalfOf: "local", agentRunId: "spawn" },
      { signal: controller.signal },
    );
    controller.abort();
    release.resolve();

    await expect(pending).rejects.toThrow("Plugin panel is no longer active.");
    expect(existsSync(join(root, "cancelled.txt"))).toBe(false);
    await engine.stop();
  });

  it("enforces the authored capture size limit and reports observed UTF-8 bytes", async () => {
    const root = await tempRoot();
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const author = {
      kind: "agent" as const,
      agentId: "plugin:test",
      onBehalfOf: "local",
      agentRunId: "spawn",
    };

    await expect(
      engine.writeAuthoredTextFile(
        join(root, "at-limit.txt"),
        "x".repeat(MAX_ENGINE_CAPTURE_TEXT_BYTES),
        author,
      ),
    ).resolves.toBeUndefined();
    await expect(
      engine.writeAuthoredTextFile(
        join(root, "over-limit.txt"),
        "x".repeat(MAX_ENGINE_CAPTURE_TEXT_BYTES + 1),
        author,
      ),
    ).rejects.toThrow(
      `Authored text exceeds the capture limit: limit ${MAX_ENGINE_CAPTURE_TEXT_BYTES} bytes, observed ${MAX_ENGINE_CAPTURE_TEXT_BYTES + 1} bytes.`,
    );
    await engine.stop();
  });

  it("mutation proof: daemon author state is set before work and flushed before clear", async () => {
    const root = await tempRoot();
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
      daemonOwnsCapture: true,
    });

    await engine.setActiveAgentRun(run);
    await engine.setActiveAgentRun(null);

    const authorRequests = requests.filter((request) =>
      request.method === "capture.setAuthor" ||
      request.method === "capture.flush",
    );
    expect(authorRequests.map((request) => request.method)).toEqual([
      "capture.setAuthor",
      "capture.flush",
      "capture.setAuthor",
    ]);
    expect(authorRequests[0]?.params).toEqual({
      author: { kind: "agent", ...run },
    });
    expect(authorRequests[2]?.params).toEqual({ author: null });
    await engine.stop();
  });

  it("mutation proof: an unsettled flush refuses to clear daemon authorship", async () => {
    const root = await tempRoot();
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    let settled = false;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests, () => ({
        settled,
        running: true,
        degraded: !settled,
      })),
      daemonOwnsCapture: true,
    });

    await engine.setActiveAgentRun(run);
    await expect(engine.setActiveAgentRun(null)).rejects.toThrow("did not settle");
    const methods = requests
      .filter(
        (request) =>
          request.method === "capture.flush" ||
          request.method === "capture.setAuthor",
      )
      .map((request) => request.method);
    // The guarantee is that authorship is never CLEARED behind an unsettled
    // flush — not how many times the flush was asked. flushCapture now polls
    // for quiescence, as the daemon documents and every Rust consumer does,
    // so pinning the exact call count would fail on the retries while proving
    // nothing extra. Pin the guarantee instead: the run was stamped once, the
    // clear never happened, and nothing but flushes ran in between.
    expect(methods[0]).toBe("capture.setAuthor");
    expect(methods.filter((method) => method === "capture.setAuthor")).toEqual([
      "capture.setAuthor",
    ]);
    expect(methods.slice(1).every((method) => method === "capture.flush")).toBe(
      true,
    );
    expect(methods.length).toBeGreaterThan(1);

    settled = true;
    await engine.setActiveAgentRun(null);
    expect(
      requests.filter((request) => request.method === "capture.setAuthor").at(-1)
        ?.params,
    ).toEqual({ author: null });
    await engine.stop();
  });

  it("stamps captured writes and deletes with the active run's author", async () => {
    const root = await tempRoot();
    await write(root, "notes/plan.md", "# Plan\n");
    await write(root, "notes/scratch.md", "scratch\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback, { activeAgentRun: () => run });
    engine.captureBatch([
      { path: "notes/plan.md", operation: "update" },
      { path: "notes/scratch.md", operation: "update" },
    ]);
    await engine.flush();
    await unlink(join(root, "notes/scratch.md"));
    engine.captureBatch([{ path: "notes/scratch.md", operation: "delete" }]);
    await engine.flush();

    const authored = {
      kind: "agent",
      agentId: "dohc-mcp",
      onBehalfOf: "local",
      agentRunId: "run-1",
    };
    expect(await liveMomentAuthors(engine)).toEqual([authored, authored, authored]);
    const moments = await liveMoments(engine);
    expect(moments.map((m) => m.operation)).toEqual(["write", "write", "delete"]);
    // Attribution is a moment fact only: origin metadata stays actor-neutral.
    expect(moments.map((m) => m.origin)).toEqual([
      "local-file",
      "local-file",
      "local-file",
    ]);
    await engine.stop();
  });

  it("keeps ordinary batches actor-neutral when no run is active", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "one\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback, { activeAgentRun: () => null });
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMomentAuthors(engine)).toEqual([null]);
    await engine.stop();
  });

  it("reads the slot at settle: a run ending before the chain drains still owns its batch, later batches are neutral", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "one\n");
    let active: typeof run | null = run;
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback, { activeAgentRun: () => active });

    // Batch settles (captureBatch called) while the run is active...
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    // ...and the run ends BEFORE the capture chain executes the batch.
    active = null;
    await engine.flush();
    expect(await liveMomentAuthors(engine)).toEqual([
      { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" },
    ]);

    // A batch that settles after the run ended is the local user's.
    await write(root, "a.md", "two\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();
    expect(await liveMomentAuthors(engine)).toEqual([
      { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" },
      null,
    ]);
    await engine.stop();
  });

  it("keeps reconciliation actor-neutral even while a run is active", async () => {
    const root = await tempRoot();
    await write(root, "offline.md", "edited while closed\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback, { activeAgentRun: () => run });
    engine.start();
    await engine.flush();
    expect((await liveMoments(engine)).map((m) => [m.path, m.summary])).toEqual([
      ["offline.md", "Reconciled offline edits"],
    ]);
    expect(await liveMomentAuthors(engine)).toEqual([null]);
    await engine.stop();
  });
});

describe("Rust engine session selection", () => {
  // An injected store can observe capture operations, but it cannot select the
  // retired in-process Y.Doc provider.
  async function openWith(
    root: string,
  ): Promise<{ providerOpened: number; storeReads: number }> {
    const loopback = new VersionedLoopbackEngine();
    const sessions = mockLiveSessions(loopback);
    const liveStore = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root },
      sessions,
    ).store;
    let storeReads = 0;
    const observedStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "readTextFile") {
          return async (input: Parameters<typeof liveStore.readTextFile>[0]) => {
            storeReads += 1;
            return await liveStore.readTextFile(input);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let providerOpened = 0;
    const engine = capture(root, {
      store: observedStore,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async () => {
        providerOpened += 1;
        const doc = new Y.Doc();
        doc.getText("content").insert(0, "daemon");
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "b".repeat(64), markdown: "daemon" }) as never,
          close: async () => undefined,
        } as never;
      },
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    });
    await session.close({ settle: false });
    await engine.stop();
    await liveStore.close();
    return { providerOpened, storeReads };
  }

  it("uses the Rust provider session when a store is injected", async () => {
    const root = await tempRoot();
    const { providerOpened } = await openWith(root);
    expect(providerOpened).toBe(1);
  });
});

// #493. A Y.Doc session's version binding and its registry entry are decided
// one daemon round trip apart: `openYDocSession` reads the active version,
// opens the provider, and only then records the session as live. Off the
// capture chain, a version operation running inside that gap swept a registry
// the session had not reached yet — so the sweep vacated nothing, and the
// session went live against the version the user had just LEFT. Everything
// typed into it settled into that version's lineage and materialized its
// projection over the folder the operation had just written.
//
// Both tests STAGE the interleaving rather than race it. The daemon request
// that marks "this version operation is past its live-session sweep" blocks,
// the open is issued INSIDE that window, and the window is then held open for
// a full daemon round trip the test drives itself (`listVersions`) — strictly
// more turns than an unserialized open needs to reach the provider. So an
// empty provider log at that point is PROOF the open is queued behind the
// chain, not evidence that it happened to be slower.
describe("workspaceEngineCapture Y.Doc session ordering against version operations", () => {
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  function recordingProvider(openedVersionIds: string[]) {
    return async (
      options: EngineYdocProviderSessionOptions,
    ): Promise<EngineYdocProviderSession> => {
      openedVersionIds.push(options.versionId);
      const doc = new Y.Doc();
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: options.path,
        // `as never` below stops tsc checking this literal, so these two are
        // stated by hand. Without them `head` was undefined here and the
        // absent-head refusal never ran in this test at all.
        head: "present" as const,
        lineage: "existing" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () =>
          ({ sha256: "c".repeat(64), markdown: "" }) as never,
        close: async () => undefined,
      } as never;
    };
  }

  it("opens a session against the version a running switch is ENTERING, never the one it is leaving", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const switchReachedMaterialization = deferred();
    const releaseSwitch = deferred();
    // The daemon materializes the entered version INSIDE versions.setActive,
    // so blocking that request holds the switch exactly where the issue puts
    // it: past the live-session sweep, still rewriting the folder.
    const sessions = mockLiveSessions(
      loopback,
      undefined,
      undefined,
      async (request) => {
        if (request.method !== VERSIONED_METHOD.versionsSetActive) return;
        const params = request.params as { versionId?: string };
        // createVersion's own set-active is not the switch under test.
        if (params.versionId !== "main") return;
        switchReachedMaterialization.resolve();
        await releaseSwitch.promise;
      },
    );
    const engine = capture(root, {
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
      openRustYDocProviderSession: recordingProvider(openedVersionIds),
    });

    // Create-and-switch leaves "Draft" active; the switch under test returns
    // to Main, so the two versions are distinguishable in the assertion.
    const created = await engine.createVersion("Draft");
    const draftVersionId = created.activeVersionId;
    expect(draftVersionId).not.toBe("main");

    const switching = engine.switchVersion("main");
    await switchReachedMaterialization.promise;
    const opening = engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    // Hold the window open for two full daemon round trips. The open's own
    // active-version read was issued first and travels the same transport, so
    // an off-chain open has already reached the provider by the time these
    // return.
    await engine.listVersions();
    await engine.listVersions();
    // MUTATION: drop the enqueueResult wrapper from openYDocSession. The open
    // reads the active version while set-active is still blocked and opens the
    // provider on [draftVersionId] — a live session on the version the user
    // left, which the switch's sweep had already passed and could not vacate.
    expect(openedVersionIds).toEqual([]);

    releaseSwitch.resolve();
    const session = await opening;
    await switching;

    // Whatever the user types next belongs to the version they are looking at.
    expect(openedVersionIds).toEqual(["main"]);
    await session.close({ settle: false });
    await engine.stop();
  });

  // The loopback has no conflict ledger, and mergeVersionIntoMain reads one
  // unconditionally to resume an already-open conflict. An empty page is the
  // honest answer for a workspace that has never conflicted, and it keeps the
  // merge under test a REAL merge instead of a rejected one.
  class MergeableLoopbackEngine extends VersionedLoopbackEngine {
    override async sendRequest(request: Request): Promise<Response> {
      if (request.method === "conflicts.list") {
        return {
          id: request.id,
          result: { conflicts: [], nextAfterConflictId: null },
        };
      }
      return await super.sendRequest(request);
    }
  }

  it("opens a session only after a running merge has finished reading and writing heads", async () => {
    const root = await tempRoot();
    const loopback = new MergeableLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const order: string[] = [];
    const mergeReachedHeads = deferred();
    const releaseMerge = deferred();
    // conflicts.list runs after the merge's sweep and flush, before it reads
    // or writes a single head — the "merging immediately after an edit" window.
    const sessions = mockLiveSessions(
      loopback,
      undefined,
      undefined,
      async (request) => {
        if (request.method !== "conflicts.list") return;
        order.push("merge:reads-heads");
        mergeReachedHeads.resolve();
        await releaseMerge.promise;
      },
    );
    const engine = capture(root, {
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
      openRustYDocProviderSession: async (options) => {
        order.push("ydoc:open");
        return await recordingProvider(openedVersionIds)(options);
      },
    });

    const created = await engine.createVersion("Draft");
    const draftVersionId = created.activeVersionId;
    const merging = engine.mergeVersionIntoMain(draftVersionId);
    await mergeReachedHeads.promise;
    const opening = engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    // Same verification staging as the switch test: two round trips the test
    // drives itself, so an unserialized open has provably reached the provider.
    await engine.listVersions();
    await engine.listVersions();
    // MUTATION: drop the enqueueResult wrapper from openYDocSession. The open
    // lands INSIDE the merge, so this reads
    // ["merge:reads-heads", "ydoc:open"] — a session seeded from a head the
    // merge is in the middle of replacing, and invisible to the sweep that was
    // supposed to vacate it.
    expect(order).toEqual(["merge:reads-heads"]);

    releaseMerge.resolve();
    const session = await opening;
    await merging;

    expect(order).toEqual(["merge:reads-heads", "ydoc:open"]);
    await session.close({ settle: false });
    await engine.stop();
  });

  it("still opens a session on the active version when no version operation is running", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      daemonOwnsCapture: true,
      openRustYDocProviderSession: recordingProvider(openedVersionIds),
    });

    const first = await engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    await first.close({ settle: false });
    const created = await engine.createVersion("Draft");
    const second = await engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });

    expect(openedVersionIds).toEqual(["main", created.activeVersionId]);
    await second.close({ settle: false });
    await engine.stop();
  });
});

// #534, codex P1. The absent-head refusal reads the DISK, and that read is
// awaited. On a shared workspace a replicated `onRemoteUpdate` can land inside
// that await: a peer is writing this very path. Two things then stop being
// true at once — the version DOES have the document, so "not in this version"
// is false; and the lineage is dirty, so the refusal's `close({settle:false})`
// is answered with UnsettledClose and the provider escalates it to a SETTLING
// close, materializing the path the refusal was about to call missing. The
// refusal would create the phantom it exists to prevent.
describe("workspaceEngineCapture absent-head refusal against replication", () => {
  it("binds instead of refusing when a replicated update reached the session", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("content").insert(0, "written by a peer");
    const peerUpdate = Y.encodeStateAsUpdate(remoteDoc);
    const settles: string[] = [];
    let closedWithSettle: boolean | undefined;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        // AFTER the open resolves, INSIDE the awaited disk check. A timer beats
        // an lstat round trip, so the update lands where the race puts it —
        // which is what makes the recheck's POSITION testable, not just its
        // existence.
        // Delivered DURING the open, which the generation buffers and replays
        // the moment it installs — after the daemon has answered
        // head/lineage absent, before the guard runs. That is deterministic.
        // The window codex named (arrival inside the awaited disk check) is the
        // same defect one tick later, and the guard reads the count ONCE after
        // that await, so both arrivals take the identical path. Racing an lstat
        // with a timer is not stageable, so this stages the half that is.
        options.onRemoteUpdate(peerUpdate);
        return {
          doc: remoteDoc,
          initialUpdate: Y.encodeStateAsUpdate(remoteDoc),
          contentKind: "plaintext",
          path: options.path,
          // The daemon's answer at open time: nothing committed, nothing
          // durable. The peer's update is still in flight behind it.
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "d".repeat(64), markdown: "written by a peer" } as never;
          },
          close: async (closeOptions?: { settle?: boolean }) => {
            closedWithSettle = closeOptions?.settle;
          },
        } as never;
      },
    });

    // The path is in NEITHER the version nor on disk — every input the refusal
    // keys on says "missing". Only the peer's update says otherwise.
    const session = await engine.openYDocSession({
      path: "peer-created.md",
      onRemoteUpdate: () => undefined,
    });

    expect(session.path).toBe("peer-created.md");
    // Nothing was settled or materialized by a refusal that never happened.
    expect(settles).toEqual([]);
    expect(closedWithSettle).toBeUndefined();
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await session.close({ settle: false });
    await engine.stop();
  });

  it("refuses without settling, and without calling it missing, when an update wins the release gap", async () => {
    // The narrower seam: the count is read, THEN the release is queued through
    // the operation chain, so an update can still arrive before the close
    // reaches the daemon. The daemon answers UnsettledClose — "content arrived
    // after all". The session cannot be handed back (its provider already
    // closed itself and dropped every subscription) and cannot be reopened (a
    // refused close reinserts the daemon entry with its lease held).
    //
    // Two things must be true of the answer, and #665 changed which refusal
    // carries them. It may never call the path missing — something IS writing
    // it — and it may never leave the surface writable over a session the
    // daemon still holds (#564, codex r17).
    //
    // The orphan now EVICTS when its close is refused, so the daemon no longer
    // holds the session and the second hazard is gone with it. What remains is
    // the first, and `YDocOpenRacedError` is exactly it: this open's answer is
    // already stale, open it again — and the next open binds the lineage the
    // eviction preserved. The path this test guards is that the refusal is
    // decided by the REFUSED CLOSE, not by a second look at the disk.
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const settles: string[] = [];
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        let deliver: (() => void) | null = () => options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "e".repeat(64), markdown: "arrived from a peer" } as never;
          },
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
            // The update lands in the gap the release was queued across, and
            // the daemon refuses because the lineage is now dirty.
            if (deliver) {
              deliver();
              deliver = null;
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-unsettled-close",
                  retry: "no",
                },
                undefined,
              );
            }
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({ path: "peer-created.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // MUTATION: drop the `dischargedByEvict` arm (#665) -> the recheck finds
    // the path still absent and the refusal claims the version does not have a
    // file a peer is writing into it.
    expect(refusal).toBeInstanceOf(YDocOpenRacedError);
    expect(isYDocPathNotInVersionError(refusal)).toBe(false);
    // The lease is gone, so the surface may fall back — that is what makes the
    // raced refusal safe here where #564 needed the unreleased one.
    expect(refusal).not.toBeInstanceOf(YDocSessionUnreleasedError);
    expect(evicts).toBe(1);
    // And the release never escalated, so nothing was materialized.
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(settles).toEqual([]);
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await engine.stop();
  });

  it("clears dead-session health when orphan eviction discharges it", async () => {
    // A handed-out session can never become an orphan: only the absent-head
    // refusal below sets that state, before open returns. Stage daemon death at
    // that boundary through the provider's real reconnect callback instead.
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    const outcomes: boolean[] = [];
    const reconnectFailure = Object.assign(new Error("daemon exited"), {
      code: "transport-error",
    });
    const replacementFailure = new Error("replacement daemon unavailable");
    const unsettled = new DaemonRefusalError(
      {
        code: "INVALID_PARAMS",
        message: "ydoc-unsettled-close",
        retry: "no",
      },
      undefined,
    );
    let opens = 0;
    let evicts = 0;
    let reportedDeath = false;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      onCaptureOutcome: ({ ok }) => outcomes.push(ok),
      onError: () => undefined,
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        if (opens > 1) throw replacementFailure;
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          get head() {
            if (!reportedDeath) {
              reportedDeath = true;
              options.onSessionError?.(reconnectFailure);
            }
            return "absent" as const;
          },
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "f".repeat(64), markdown: "" }) as never,
          applyExternalMarkdownEdit: async (markdown: string) =>
            ({ kind: "merged", markdown }) as const,
          close: async () => {
            throw unsettled;
          },
        };
      },
    });

    const refusal = await engine
      .openYDocSession({
        path: "peer-created.md",
        onRemoteUpdate: () => undefined,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // MUTATION: delete `clearDeadYDocSession` from the orphan evict -> the last outcome stays false.
    expect(refusal).toBeInstanceOf(YDocOpenRacedError);
    expect(opens).toBe(2);
    expect(outcomes).toEqual([false, true]);
    // MUTATION: drop the `releaseObligation` branch from the wrapper's
    // `evict()` -> the obligated session's lease remains held forever.
    expect(evicts).toBe(1);
    await engine.stop();
  });

  it("does not evict an orphan when its close fails for an unrelated reason", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const settles: string[] = [];
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        let deliver: (() => void) | null = () =>
          options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return {
              sha256: "f".repeat(64),
              markdown: "arrived from a peer",
            } as never;
          },
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
            if (deliver) {
              deliver();
              deliver = null;
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-something-else",
                  retry: "no",
                },
                undefined,
              );
            }
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({
        path: "peer-created.md",
        onRemoteUpdate: () => undefined,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(YDocSessionUnreleasedError);
    expect(refusal).not.toBeInstanceOf(YDocOpenRacedError);
    expect(evicts).toBe(0);
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(settles).toEqual([]);
    await expect(
      readFile(join(root, "peer-created.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await engine.stop();
  });

  it("does not claim the version is missing a file an agent created during the release", async () => {
    // The disk read is one syscall and the release that follows awaits a daemon
    // round trip. This chain serializes ENGINE work, not the filesystem, so an
    // agent or an external editor can create the path inside that window — and
    // the queued watcher then captures a file the user was just told does not
    // exist. Staged on the close, which is the window.
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    const settles: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => ({
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: options.path,
        head: "absent" as const,
        lineage: "absent" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () => {
          settles.push("settle");
          return { sha256: "a".repeat(64), markdown: "" } as never;
        },
        close: async () => {
          // The agent's write lands while the release is in flight.
          await writeFile(join(root, "agent-made.md"), "written by an agent", "utf8");
        },
      }) as never,
    });

    const refusal = await engine
      .openYDocSession({ path: "agent-made.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // The file is there now, so "this version doesn't have this file" would be
    // a false statement to the user.
    expect(isYDocPathNotInVersionError(refusal)).toBe(false);
    expect(refusal).toBeInstanceOf(YDocOpenRacedError);
    // And the agent's bytes were never touched.
    expect(await readFile(join(root, "agent-made.md"), "utf8")).toBe(
      "written by an agent",
    );
    expect(settles).toEqual([]);
    await engine.stop();
  });

  it("keeps refusing an uncaptured artifact even when a replicated update arrived", async () => {
    // Replication-as-existence is safe for a path with NOTHING on disk. It is
    // NOT safe when the file is there with bytes capture has not ingested: this
    // bind carries no seed, so its doc holds only the replicated update, and
    // settling it would write that OVER the user's file — while this same
    // capture chain is what keeps the watcher from ingesting those bytes.
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    await writeFile(join(root, "uncaptured.md"), "bytes the watcher has not seen", "utf8");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const settles: string[] = [];
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        // Delivered during the open, so the count is already non-zero when the
        // rules run — the exact input that used to bypass this refusal.
        options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "f".repeat(64), markdown: "arrived from a peer" } as never;
          },
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({ path: "uncaptured.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(YDocUncapturedArtifactError);
    expect(settles).toEqual([]);
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    // The bytes the empty bind would have erased are untouched.
    expect(await readFile(join(root, "uncaptured.md"), "utf8")).toBe(
      "bytes the watcher has not seen",
    );
    await engine.stop();
  });

  it("refuses an uncaptured artifact again after orphan eviction resurrects its lineage", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    // The default policy tracks this short Markdown file, so capture will reach it.
    const path = "resurrected.md";
    const original = "already on disk, never captured";
    const resurrected = "resurrected and settled";
    await writeFile(join(root, path), original, "utf8");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, resurrected);
    const settled: string[] = [];
    let opens = 0;
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: opens === 1 ? ("absent" as const) : ("existing" as const),
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settled.push(resurrected);
            await writeFile(join(root, path), resurrected, "utf8");
            return { sha256: "7".repeat(64), markdown: resurrected } as never;
          },
          close: async () => {
            throw new DaemonRefusalError(
              {
                code: "INVALID_PARAMS",
                message: "ydoc-unsettled-close",
                retry: "no",
              },
              undefined,
            );
          },
        } as never;
      },
    });

    await expect(
      engine.openYDocSession({ path, onRemoteUpdate: () => undefined }),
    ).rejects.toBeInstanceOf(YDocUncapturedArtifactError);
    expect(evicts).toBe(1);
    expect(await readFile(join(root, path), "utf8")).toBe(original);

    // MUTATION: revert to `head === "absent" && lineage === "absent"` -> the
    // second open binds the resurrected doc and its settle clobbers the file.
    await expect(
      engine.openYDocSession({ path, onRemoteUpdate: () => undefined }),
    ).rejects.toBeInstanceOf(YDocUncapturedArtifactError);
    expect(opens).toBe(2);
    expect(evicts).toBe(2);
    expect(settled).toEqual([]);
    expect(await readFile(join(root, path), "utf8")).toBe(original);
    await engine.stop();
  });
});

import { open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import * as Y from "yjs";
import type { AttachedEngineWorkspace, EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { VersionedLiveAdapter, isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import { createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture, type WorkspaceEngineCaptureFailure, type WorkspaceEngineCaptureOptions } from "./workspaceEngineCapture";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions, REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { listLiveDraftRecovery, workspaceDraftStore } from "./liveDraftRecovery";
import { waitForPathMoments } from "./waitForPathMoments";

// The person a restore names, as desktop main reads them.
export const RESTORER = { kind: "human", humanId: "local-person" } as const;

export function createWorkspaceEngineCapture(
  options: Omit<WorkspaceEngineCaptureOptions, "attachmentId">,
) {
  return createAttachedWorkspaceEngineCapture({
    ...options,
    attachmentId: Symbol(`test-workspace-attachment:${options.workspaceId}`),
  });
}

export function decodePipelineFixtureValue(value: unknown): unknown {
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
export const engine = requireEngineBinaryOrSkip();

export async function waitForDaemonCaptureDeferral(
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
export async function waitForRecoveredSibling(root: string, stem: string): Promise<string> {
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

export async function listDaemonPathMoments(
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

// dohchq/dohc#337 item 5, driven by its own mechanism: another app holds the
// `.md` open without FILE_SHARE_DELETE, so every attempt to replace it fails
// with a sharing violation. An ACL cannot model this — the workspace folder
// grants FILE_DELETE_CHILD, which lets the replace through a deny-write ACE on
// the file itself.
export async function holdWithoutShareDelete(absolute: string): Promise<() => Promise<void>> {
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

// No window shows these workspaces.
export const NO_WINDOWS = { all: () => [], workspaceIdOf: () => undefined };

// A capture on its own real engine, with the reads desktop main bases two
// workspace notices on (dohc#2342). `health` first has the engine scan the
// folder, so it counts a change whether or not the watcher has reported it.
// Then it reads the newest moment as the shell does, which waits for capture
// to settle and answers "still updating" while History is still updating.
// Last, it answers the outcome of the first health poll, which raises History
// paused unless it is null.
export async function openRealCapture(workspaceId: string, options: Partial<WorkspaceEngineCaptureOptions> = {}, existingRoot?: string) {
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

// An agent replaces an open note's file, by rename or in place.
export async function writeOutside(absolute: string, text: string, style: "rename" | "in-place"): Promise<void> {
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
export async function openNote(capture: Pick<Awaited<ReturnType<typeof openRealCapture>>["capture"], "openYDocSession">) {
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

export const RECOVERED_COPY = /^note \(recovered [0-9a-f]{8} [0-9a-f]{64}\)\.md$/;

// dohc#2308. An open document whose file was deleted outside dohc. The engine
// refuses every save over the missing file, so nothing writes it back until
// the person chooses Save it again. `shape` is a file capture recorded and
// saved over, or one New File left empty and deleted before its first save.
// Drafts go to a real draft store, as the app keeps them. The store refuses
// the first `failedDiscards` removals.
export async function openDeletedDocument(shape: "recorded" | "new", failedDiscards = 0) {
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

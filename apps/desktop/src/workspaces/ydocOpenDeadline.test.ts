import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client";
import type {
  EngineWorkspaceRunOptions,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";
import {
  YDOC_OPEN_RETRY_DEADLINE_MS,
  createWorkspaceEngineCapture,
} from "./workspaceEngineCapture";

// #564: one document open may not hold the capture chain for the whole
// six-attempt transport ladder. The deadline lives in the sessions layer
// (engineWorkspaceSessions.test.ts proves what it does); these prove the
// desktop passes it for exactly the open that holds the chain, and record
// the measured healthy range the limit sits beyond.

const WORKSPACE_ID = "ydoc-open-deadline-test";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-ydoc-deadline-"));
  roots.push(root);
  return root;
}

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function recordingSessions(): {
  sessions: EngineWorkspaceSessions;
  runOptions: Array<EngineWorkspaceRunOptions | undefined>;
} {
  const sessions = mockLiveSessions(new VersionedLoopbackEngine());
  const runOptions: Array<EngineWorkspaceRunOptions | undefined> = [];
  const originalRun = sessions.run.bind(sessions);
  sessions.run = ((workspace, operation, options) => {
    runOptions.push(options);
    return originalRun(workspace, operation, options);
  }) as typeof sessions.run;
  return { sessions, runOptions };
}

function captureWith(root: string, sessions: EngineWorkspaceSessions) {
  const doc = new Y.Doc();
  doc.getText("plainText").insert(0, "seed");
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    rustEngineSessions: sessions,
    // The loopback speaks no ydoc.* method, so the provider is stubbed at the
    // same seam the drift/buffer fixtures use. head "present" keeps the open
    // off the absent-head disk checks — this file is about the chain hold,
    // not the admission rules.
    openRustYDocProviderSession: async () => ({
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext" as const,
      path: "note.md",
      head: "present" as const,
      lineage: "existing" as const,
      applyLocalUpdate: async () => undefined,
      settleNow: async () => ({ sha256: "a".repeat(64), markdown: "" }) as never,
      applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
      close: async () => undefined,
    }),
  });
}

describe("the document open's capture-chain hold (#564)", () => {
  it("passes the retry deadline for exactly the open that holds the chain", async () => {
    const root = await tempRoot();
    await write(root, "note.md", "hello\n");
    const { sessions, runOptions } = recordingSessions();
    const engine = captureWith(root, sessions);
    engine.start();
    await engine.flush();

    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    });
    await session.close({ settle: false });
    await engine.stop();

    // MUTATION: drop retryDeadlineMs from the first-generation open -> no run
    // carries a deadline and the six-attempt ladder holds the chain again.
    const bounded = runOptions.filter(
      (options) => options?.retryDeadlineMs !== undefined,
    );
    expect(bounded).toHaveLength(1);
    expect(bounded[0]?.retryDeadlineMs).toBe(YDOC_OPEN_RETRY_DEADLINE_MS);
    // Every OTHER run on the chain keeps the full transport ladder: bounding
    // a capture flush or a version op is not this issue's contract.
    expect(runOptions.length).toBeGreaterThan(1);
  });

  it("sits beyond the measured healthy open on a busy chain", async () => {
    // AGENTS.md, measure limits that reject work: the deadline only ever
    // interrupts transport-retry WAITING, but the honest floor is still the
    // healthy open itself. Eight opens, each queued behind a captureBatch of
    // three files (the chain traffic a busy workspace produces), through the
    // real chain + loopback RPCs with an instant provider stub. Real daemon
    // RPC latency is governed separately by WORKSPACE_OPEN_DEADLINE_MS, which
    // the deadline is derived FROM — so the margin measured here understates
    // the real one only by bounded, already-budgeted amounts.
    const root = await tempRoot();
    await write(root, "note.md", "hello\n");
    const { sessions } = recordingSessions();
    const engine = captureWith(root, sessions);
    engine.start();
    await engine.flush();

    let maxMs = 0;
    for (let round = 0; round < 8; round += 1) {
      for (let file = 0; file < 3; file += 1) {
        await write(root, `busy-${file}.md`, `round ${round} file ${file}\n`);
      }
      engine.captureBatch([
        { path: "busy-0.md", operation: "update" },
        { path: "busy-1.md", operation: "update" },
        { path: "busy-2.md", operation: "update" },
      ]);
      const startedAt = performance.now();
      const session = await engine.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      maxMs = Math.max(maxMs, performance.now() - startedAt);
      await session.close({ settle: false });
    }
    await engine.stop();

    console.log(
      `[measure] healthy ydoc open on a busy chain: max ${maxMs.toFixed(1)}ms ` +
        `over 8 opens; YDOC_OPEN_RETRY_DEADLINE_MS=${YDOC_OPEN_RETRY_DEADLINE_MS}ms`,
    );
    expect(maxMs).toBeLessThan(YDOC_OPEN_RETRY_DEADLINE_MS);
  });
});

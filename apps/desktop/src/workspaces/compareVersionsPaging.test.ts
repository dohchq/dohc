import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SecretFileComparePage,
  SecretFileStore,
} from "@dohc/workspace-contracts/engine";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

// #562, codex round 1: the compare surface's protected rows must ride the
// SAME page discipline as its text rows. The old shape drained every
// `secrets.compare` page per comparison page and put every remaining
// protected row on the final one. These drive capture.compareVersions with
// fake page-shaped stores, so each page's row provenance is exact.

const WORKSPACE_ID = "engine-capture-test";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-compare-paging-"));
  roots.push(root);
  return root;
}

interface FakeTextPage {
  entries: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  nextAfterPath: string | null;
}

function captureWith(
  root: string,
  textPages: Map<string | undefined, FakeTextPage>,
  secretPages: Map<string | undefined, SecretFileComparePage>,
  secretCalls: Array<string | undefined>,
): WorkspaceEngineCapture {
  const store = {
    ensureMainVersion: async () => ({ id: "main" }),
    getActiveVersion: async () => ({ id: "main" }),
    flushCapture: async () => undefined,
    compareVersionFilesPage: async (input: { afterPath?: string }) => {
      const page = textPages.get(input.afterPath);
      if (!page) throw new Error(`No fake text page after ${input.afterPath}`);
      return page;
    },
    readTextFile: async (input: { versionId: string; path: string }) => ({
      objectId: `object-${input.path}`,
      versionId: input.versionId,
      path: input.path,
      text: `${input.versionId} body of ${input.path}`,
      updatedAtMs: 1,
      latestMomentId: `moment-${input.path}`,
      metadata: { origin: "local-file" as const },
    }),
  } as unknown as CaptureVersionedTextStore;
  const secretStore = {
    compareSecretFileVersions: async (input: { afterPath?: string }) => {
      secretCalls.push(input.afterPath);
      const page = secretPages.get(input.afterPath);
      if (!page) throw new Error(`No fake secret page after ${input.afterPath}`);
      return page;
    },
  } as unknown as SecretFileStore;
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    daemonOwnsCapture: true,
    store,
    secretStore,
  });
}

describe("capture.compareVersions pages both sources under one cursor", () => {
  it("carries ONE engine page of protected rows per compare page", async () => {
    const root = await tempRoot();
    const secretCalls: Array<string | undefined> = [];
    const engine = captureWith(
      root,
      new Map<string | undefined, FakeTextPage>([
        [undefined, { entries: [], nextAfterPath: null }],
        [".env-a", { entries: [], nextAfterPath: null }],
      ]),
      new Map<string | undefined, SecretFileComparePage>([
        [
          undefined,
          {
            entries: [{ path: ".env-a", status: "modified" }],
            nextAfterPath: ".env-a",
          },
        ],
        [
          ".env-a",
          {
            entries: [{ path: ".env-b", status: "added" }],
            nextAfterPath: null,
          },
        ],
      ]),
      secretCalls,
    );
    engine.start();

    const first = await engine.compareVersions("v-1");
    // MUTATION: restore the drain -> both protected rows land on this page
    // and a second secrets.compare call rides the same comparison page.
    expect(first.files).toEqual([
      { path: ".env-a", status: "modified", protected: true },
    ]);
    expect(first.nextAfterPath).toBe(".env-a");
    expect(secretCalls).toEqual([undefined]);

    const second = await engine.compareVersions("v-1", {
      afterPath: first.nextAfterPath!,
    });
    expect(second.files).toEqual([
      { path: ".env-b", status: "added", protected: true },
    ]);
    expect(second.nextAfterPath).toBeNull();
    expect(secretCalls).toEqual([undefined, ".env-a"]);
    await engine.stop();
  });

  it("cuts the merged page at the smaller continuation, in engine path order", async () => {
    // The boundary case a UTF-16 comparison gets wrong: the text cursor is
    // U+E000 (one UTF-16 unit, 0xE000), the pending protected path starts
    // with U+10000 (a surrogate pair starting 0xD800). In UTF-16 order the
    // protected path sorts BELOW the boundary and lands on page one — and
    // the engine, resuming after the boundary in byte order, serves it AGAIN
    // on page two. In the engine's order (code points) it is past the
    // boundary and appears exactly once.
    const boundary = ".md";
    const astralSecret = "\u{10000}.env";
    const root = await tempRoot();
    const secretCalls: Array<string | undefined> = [];
    const engine = captureWith(
      root,
      new Map<string | undefined, FakeTextPage>([
        [
          undefined,
          {
            entries: [{ path: "a.md", status: "modified" }],
            nextAfterPath: boundary,
          },
        ],
        [boundary, { entries: [], nextAfterPath: null }],
      ]),
      new Map<string | undefined, SecretFileComparePage>([
        [
          undefined,
          {
            entries: [{ path: astralSecret, status: "modified" }],
            nextAfterPath: astralSecret,
          },
        ],
        [
          boundary,
          {
            entries: [{ path: astralSecret, status: "modified" }],
            nextAfterPath: null,
          },
        ],
      ]),
      secretCalls,
    );
    engine.start();

    const first = await engine.compareVersions("v-1");
    // MUTATION: compare the window in UTF-16 (`path <= boundary`) -> the
    // protected row rides page one AND page two.
    expect(first.files.map((file) => file.path)).toEqual(["a.md"]);
    expect(first.nextAfterPath).toBe(boundary);

    const second = await engine.compareVersions("v-1", {
      afterPath: first.nextAfterPath!,
    });
    expect(second.files).toEqual([
      { path: astralSecret, status: "modified", protected: true },
    ]);
    expect(second.nextAfterPath).toBeNull();
    await engine.stop();
  });
});

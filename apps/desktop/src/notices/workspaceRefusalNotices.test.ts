import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import { createCaptureLiveStores } from "../workspaces/workspaceEngineCaptureLiveStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import { createWorkspaceRefusalNotices } from "./workspaceRefusalNotices";
import { createNoticeStore, type NoticeStore } from "./noticeStore";

const notice = { noticeId: "refusal", originId: "peer", originSeq: 1,
  refusalCoordinates: [{ originId: "peer", originSeq: 1 }], reason: "seed-lineage-conflict", document: null };

async function fixture(shareView?: RegistryEntry["shareView"]) {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: await createTestScratch("refusal-attachment-"),
    kind: "personal", mode: "local-first", ...(shareView ? { shareView } : {}),
  };
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: id => id === workspace.workspaceId ? workspace : null,
    canonicalizeRoot: realpathSync,
    createState: () => ({}),
  });
  let pending = [notice];
  const sendRequest = vi.fn(async (request: Request): Promise<Response> => {
    if (request.method === "sync.dismissRefusal") {
      const { noticeId, refusalCoordinates } = request.params as { noticeId: string; refusalCoordinates: typeof notice.refusalCoordinates };
      pending = pending.filter(row => row.noticeId !== noticeId || !refusalCoordinates.some(
        coordinate => coordinate.originId === row.originId && coordinate.originSeq === row.originSeq));
    }
    return { id: request.id,
      result: request.method === "workspace.open" ? { workspace: "handle" }
        : request.method === "sync.refusalNotices" ? { notices: pending.length === 0 ? [] : [{
          ...pending[pending.length - 1], refusalCoordinates: pending.flatMap(row => row.refusalCoordinates),
        }] }
        : request.method === "sync.dismissRefusal" ? { dismissed: true } : { closed: true },
    };
  });
  const client = { sendRequest, close() {} };
  let store: NoticeStore | undefined;
  let refreshed: Promise<void> | undefined;
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client }, {
    onOpened: workspace => { refreshed = store?.refreshRefusals(workspace.workspaceId); },
  });
  const received = createReceivedShareEngineAccess({
    sessions: () => sessions, createStores: createCaptureLiveStores,
    relayClient: () => { throw new Error("No relay needed."); },
  });
  const deps = {
    sessions: () => sessions,
    workspaces: () => [workspace],
    withOperation: authorities.withOperation.bind(authorities),
    workspaceForRegistered: received.workspaceForRegistered,
  };
  const refusals = createWorkspaceRefusalNotices(deps);
  const directory = await createTestScratch("refusal-notices-");
  const onChanged = vi.fn();
  let now = Date.now();
  const createStore = () => store = createNoticeStore({ directory, session: async () => null,
    installId: () => "install", onChanged, nowMs: () => now, ...refusals });
  return { ...refusals, deps, sendRequest, authorities, createStore, onChanged,
    arriveRefusal: () => { pending.push({ ...notice, originSeq: 2, refusalCoordinates: [{ originId: "peer", originSeq: 2 }] }); },
    advanceYear: () => { now += 365 * 24 * 60 * 60_000; },
    closeEditor: () => authorities.withOperation(workspace.workspaceId, operation =>
      sessions.closeWorkspace(received.workspaceForRegistered(operation.workspace))),
    openEditor: async () => {
      const handle = await authorities.withOperation(workspace.workspaceId, operation =>
        sessions.run(received.workspaceForRegistered(operation.workspace), async binding => binding.workspace));
      await refreshed;
      return handle;
    },
    close: async () => { await sessions.closeAll(); await authorities.close(); },
  };
}

describe("workspace refusal notices", () => {
  it("does not open a closed workspace to list Notices, and refreshes on open", async () => {
    const f = await fixture();
    try {
      const store = f.createStore();
      expect((await store.list()).notices).toEqual([]);
      expect(f.sendRequest).not.toHaveBeenCalled();
      expect(await f.openEditor()).toBe("handle");
      expect(f.onChanged).toHaveBeenCalledOnce();
      expect((await store.list()).notices).toEqual([expect.objectContaining({ noticeId: "refusal" })]);
      await f.dismissRefusal("workspace", "refusal", notice.refusalCoordinates);
      expect(f.sendRequest.mock.calls.filter(([request]) => request.method === "workspace.open")).toHaveLength(1);
      expect(f.sendRequest.mock.calls.find(([request]) => request.method === "sync.dismissRefusal")?.[0]).toMatchObject({ workspace: "handle" });
    } finally { await f.close(); }
  });

  it("preserves received-share capture mode when the editor opens", async () => {
    const f = await fixture({ shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["docs"], versionId: null, access: "view" } });
    try {
      await f.refusalNotices();
      expect(f.sendRequest).not.toHaveBeenCalled();
      await f.openEditor();
      await f.refusalNotices();
      expect(f.sendRequest.mock.calls.find(([request]) => request.method === "workspace.open")?.[0].params).toMatchObject({ captureMode: "none" });
    } finally { await f.close(); }
  });

  it("keeps closed workspace rows and queues dismissal across restart until next open", async () => {
    const f = await fixture();
    try {
      await f.openEditor();
      const store = f.createStore();
      const [row] = (await store.list()).notices;
      await f.closeEditor();
      f.sendRequest.mockClear();
      expect((await store.list()).notices).toEqual([row]);
      await store.mark([row!], "dismissed", null);
      expect((await store.list()).notices).toEqual([]);
      expect(f.sendRequest).not.toHaveBeenCalled();

      f.advanceYear();
      const restarted = f.createStore();
      expect((await restarted.list()).notices).toEqual([]);
      expect(f.sendRequest).not.toHaveBeenCalled();
      await f.openEditor();
      expect(f.sendRequest.mock.calls.filter(([request]) => request.method === "sync.dismissRefusal")).toHaveLength(1);
      expect((await restarted.list()).notices).toEqual([]);
      expect(f.sendRequest.mock.calls.filter(([request]) => request.method === "workspace.open")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("keeps a newer refusal when a closed-workspace dismissal applies after restart", async () => {
    const f = await fixture();
    try {
      await f.openEditor();
      const store = f.createStore();
      const [shown] = (await store.list()).notices;
      await f.closeEditor();
      await store.mark([shown!], "dismissed", null);
      f.arriveRefusal();
      const restarted = f.createStore();
      await f.openEditor();
      const [remaining] = (await restarted.list()).notices;
      expect(remaining).toMatchObject({ noticeId: shown!.noticeId, readAtMs: null,
        refusalCoordinates: [{ originId: "peer", originSeq: 2 }] });
      expect(f.sendRequest.mock.calls.filter(([request]) => request.method === "sync.dismissRefusal")
        .map(([request]) => request.params)).toEqual([{ workspaceId: "workspace", noticeId: "refusal",
          refusalCoordinates: [{ originId: "peer", originSeq: 1 }] }]);
      await restarted.mark([remaining!], "dismissed", null);
      expect((await restarted.list()).notices).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([false, true])("keeps a newer refusal after list then dismiss (cache refreshed: %s)", async (refresh) => {
    const f = await fixture();
    try {
      await f.openEditor();
      const store = f.createStore();
      const [shown] = (await store.list()).notices;
      f.arriveRefusal();
      if (refresh) await store.refreshRefusals();
      await store.mark([shown!], "dismissed", null);
      const [remaining] = (await store.list()).notices;
      expect(remaining).toMatchObject({ noticeId: shown!.noticeId,
        refusalCoordinates: [{ originId: "peer", originSeq: 2 }] });
      expect(f.sendRequest.mock.calls.find(([request]) => request.method === "sync.dismissRefusal")?.[0].params)
        .toEqual({ workspaceId: "workspace", noticeId: "refusal", refusalCoordinates: notice.refusalCoordinates });
    } finally { await f.close(); }
  });

  it("preserves cached notices while the engine is unavailable", async () => {
    const f = await fixture();
    try {
      const notices = createWorkspaceRefusalNotices({ ...f.deps, sessions: () => null });
      expect(await notices.refusalNotices()).toEqual([{ workspaceId: "workspace", notices: null }]);
      expect(f.sendRequest).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});

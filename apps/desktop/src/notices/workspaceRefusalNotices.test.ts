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

const notice = { noticeId: "refusal", originId: "peer", originSeq: 1, reason: "seed-lineage-conflict", document: null };

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
  const sendRequest = vi.fn(async (request: Request): Promise<Response> => ({ id: request.id,
    result: request.method === "workspace.open" ? { workspace: "handle" }
      : request.method === "sync.refusalNotices" ? { notices: [notice] }
      : request.method === "sync.dismissRefusal" ? { dismissed: true } : { closed: true },
  }));
  const client = { sendRequest, close() {} };
  const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
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
  return { ...createWorkspaceRefusalNotices(deps), deps, sendRequest, authorities,
    openEditor: () => authorities.withOperation(workspace.workspaceId, operation =>
      sessions.run(received.workspaceForRegistered(operation.workspace), async binding => binding.workspace)),
    close: async () => { await sessions.closeAll(); await authorities.close(); },
  };
}

describe("workspace refusal notices", () => {
  it.each(["notices", "editor"])("shares one attachment when %s opens first", async first => {
    const f = await fixture();
    try {
      if (first === "editor") await f.openEditor();
      expect(await f.refusalNotices()).toEqual([{ workspaceId: "workspace", notices: [notice] }]);
      expect(await f.openEditor()).toBe("handle");
      await f.dismissRefusal("workspace", "refusal");
      expect(f.sendRequest.mock.calls.filter(([request]) => request.method === "workspace.open")).toHaveLength(1);
      expect(f.sendRequest.mock.calls.find(([request]) => request.method === "sync.dismissRefusal")?.[0]).toMatchObject({ workspace: "handle" });
    } finally { await f.close(); }
  });

  it("preserves received-share capture mode when notices open first", async () => {
    const f = await fixture({ shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["docs"], versionId: null, access: "view" } });
    try {
      await f.refusalNotices();
      expect(f.sendRequest.mock.calls.find(([request]) => request.method === "workspace.open")?.[0].params).toMatchObject({ captureMode: "none" });
      await f.openEditor();
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

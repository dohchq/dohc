import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { describe, expect, it, vi } from "vitest";
import { workspaceTrustOperations } from "./bridgeContract";
import { workspaceTrustHandlers } from "./workspaceTrustIpc";
import { createSitePreviewLifecycle } from "../workspaces/sitePreviewLifecycle";
import type { SiteProcessHandle } from "../workspaces/siteRunner";
import { createTestScratch } from "../workspaces/testTemp";
import { createWorkspaceTrust } from "../workspaces/workspaceTrust";

type Event = { windowId: number };

async function harness(input: { answer?: boolean; sharedView?: boolean } = {}) {
  const scratch = await createTestScratch("workspace-trust-ipc-");
  const rootPath = join(scratch, "trip");
  await mkdir(rootPath);
  const workspace = { workspaceId: "trip", rootPath };
  const trust = createWorkspaceTrust({ file: join(scratch, "profile", "workspace-trust.json") });
  const lifecycle = createSitePreviewLifecycle({ allowOrigin: () => () => undefined });
  let current = true;
  const operation = {
    workspace,
    state: { sitePreviews: lifecycle },
    assertCurrent: () => { if (!current) throw new Error("Open this workspace to trust it."); },
  };
  const confirm = vi.fn(async (_event: Event, _workspace: typeof workspace) => input.answer ?? false);
  const notified: Array<[string, boolean]> = [];
  const handlers = workspaceTrustHandlers<Event, typeof operation>({
    trust,
    isSharedView: () => input.sharedView ?? false,
    confirm,
    stopAppCommands: (held) => held.state.sitePreviews.stopWorkspace(held.workspace.workspaceId),
    notifyChanged: (workspaceId, trusted) => { notified.push([workspaceId, trusted]); },
  });
  const context = { event: { windowId: 1 }, operation };
  const payload = { workspaceId: "trip" };
  return {
    trust, workspace, lifecycle, confirm, notified, context,
    leave: () => { current = false; },
    read: () => handlers.readWorkspaceTrust(payload, context),
    request: () => handlers.requestWorkspaceTrust(payload, context),
    restrict: () => handlers.restrictWorkspace(payload, context),
  };
}

describe("main's workspace trust operations", () => {
  it("trusts a workspace only when the person chooses Trust workspace in main's dialog", async () => {
    const stay = await harness({ answer: false });
    await expect(stay.request()).resolves.toEqual({ workspaceId: "trip", trusted: false });
    expect(stay.confirm).toHaveBeenCalledWith({ windowId: 1 }, stay.workspace);
    await expect(stay.read()).resolves.toEqual({ workspaceId: "trip", trusted: false });
    expect(stay.notified).toEqual([]);

    const trust = await harness({ answer: true });
    await expect(trust.request()).resolves.toEqual({ workspaceId: "trip", trusted: true });
    await expect(trust.read()).resolves.toEqual({ workspaceId: "trip", trusted: true });
    expect(trust.notified).toEqual([["trip", true]]);
    // Asking again does not ask the person again.
    await trust.request();
    expect(trust.confirm).toHaveBeenCalledTimes(1);
  });

  it("gives a renderer no way to answer: every request payload carries only the workspace", () => {
    for (const row of Object.values(workspaceTrustOperations)) {
      expect(row.payload.parse({ workspaceId: "trip", trusted: true })).toEqual({ workspaceId: "trip" });
    }
    // No agent tool reaches trust.
    for (const id of ["workspace.trust.read", "workspace.trust.request", "workspace.trust.restrict"] as const) {
      const { mcp } = CAPABILITIES[id];
      expect([...mcp.owner, ...mcp.view, ...mcp.comment, ...mcp.edit]).toEqual([]);
    }
  });

  it("keeps a shared view restricted without asking", async () => {
    const h = await harness({ answer: true, sharedView: true });
    await expect(h.request()).rejects.toThrow("static preview only");
    expect(h.confirm).not.toHaveBeenCalled();
    await expect(h.read()).resolves.toMatchObject({ trusted: false });
  });

  it("does not trust a workspace the window left while the dialog was open", async () => {
    const h = await harness();
    h.confirm.mockImplementation(async () => {
      h.leave();
      return true;
    });
    await expect(h.request()).rejects.toThrow("Open this workspace");
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);
  });

  it("stops the workspace's running dev server when the person turns Restricted Mode back on", async () => {
    const h = await harness({ answer: true });
    await h.request();
    const stop = vi.fn(async () => undefined);
    const handle: SiteProcessHandle = {
      url: "http://127.0.0.1:43210/", command: "node", args: ["server.js"], cwd: h.workspace.rootPath,
      logs: () => [], onExit: () => undefined, stop,
    };
    await h.lifecycle.acquire({
      holderId: "tab", senderId: 1, workspaceId: "trip", siteRoot: "portal", mode: "dev", restart: false,
      isCurrent: () => true,
      prepare: async () => async () => ({ handle, result: { logs: [] } }),
    });
    expect(h.lifecycle.status("trip", "portal").running).toBe(true);

    await expect(h.restrict()).resolves.toEqual({ workspaceId: "trip", trusted: false });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.status("trip", "portal").running).toBe(false);
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);
    expect(h.notified).toEqual([["trip", true], ["trip", false]]);
  });
});

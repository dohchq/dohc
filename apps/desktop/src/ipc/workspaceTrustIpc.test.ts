import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { describe, expect, it, vi } from "vitest";
import { workspaceTrustOperations } from "./bridgeContract";
import { SAVE_FAILED_MESSAGE, STOP_AND_SAVE_FAILED_MESSAGE, STOP_FAILED_MESSAGE, restrictFailure, workspaceTrustHandlers } from "./workspaceTrustIpc";
import { createSitePreviewLifecycle } from "../workspaces/sitePreviewLifecycle";
import type { SiteProcessHandle } from "../workspaces/siteRunner";
import { createTestScratch } from "../workspaces/testTemp";
import { createWorkspaceTrust, folderIdentity } from "../workspaces/workspaceTrust";
import { deferred } from "../testing/deferred";

type Event = { windowId: number };

async function harness(input: {
  answer?: boolean;
  sharedView?: boolean;
  failWrites?: { value: boolean };
  // Stands in for the workspace's stop, when a test holds it.
  stop?: () => Promise<void>;
  // Stands in for the stop of the workspace's agent.
  stopAgents?: (workspaceId: string) => Promise<void>;
  // Hears the dialog open.
  onAsk?: (workspaceId: string) => void;
  // Hears every trust change.
  onChange?: (workspaceId: string, trusted: boolean) => void;
  // Keeps whether the dialog was shown, as dispatch does.
  asked?: Set<string>;
  // Runs before each write of the trust file, to hold it.
  writeGate?: { hold: (() => Promise<void>) | null };
} = {}) {
  const scratch = await createTestScratch("workspace-trust-ipc-");
  const rootPath = join(scratch, "trip");
  await mkdir(rootPath);
  const workspace = { workspaceId: "trip", rootPath };
  const file = join(scratch, "profile", "workspace-trust.json");
  const trust = createWorkspaceTrust({
    file,
    ...(input.onChange ? { onChange: input.onChange } : {}),
    writeText: async (path, text) => {
      await input.writeGate?.hold?.();
      if (input.failWrites?.value) throw new Error("disk full");
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
    },
  });
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
    identify: folderIdentity,
    isSharedView: () => input.sharedView ?? false,
    confirm,
    stopAppCommands: (held) =>
      input.stop?.() ?? held.state.sitePreviews.stopWorkspace(held.workspace.workspaceId, { rejectOnFailure: true }),
    stopAgents: input.stopAgents ?? (async () => undefined),
    ...(input.onAsk || input.asked ? {
      onAsk: (workspaceId: string) => { input.asked?.add(workspaceId); input.onAsk?.(workspaceId); },
    } : {}),
    ...(input.asked ? { wasAsked: (workspaceId: string) => input.asked!.has(workspaceId) } : {}),
    notifyChanged: (workspaceId, trusted) => { notified.push([workspaceId, trusted]); },
  });
  const context = { event: { windowId: 1 }, operation };
  const payload = { workspaceId: "trip" };
  return {
    trust, file, scratch, workspace, lifecycle, confirm, notified, context,
    leave: () => { current = false; },
    read: () => handlers.readWorkspaceTrust(payload, context),
    request: () => handlers.requestWorkspaceTrust(payload, context),
    // As the renderer asks after a send whose agent Restricted Mode holds.
    requestAutomatic: () => handlers.requestWorkspaceTrust({ ...payload, automatic: true }, context),
    restrict: () => handlers.restrictWorkspace(payload, context),
  };
}

function devServer(h: Awaited<ReturnType<typeof harness>>, stop: () => Promise<void>): Promise<unknown> {
  const handle: SiteProcessHandle = {
    url: "http://127.0.0.1:43210/", command: "node", args: ["server.js"], cwd: h.workspace.rootPath,
    logs: () => [], onExit: () => undefined, stop, stillRunning: async () => [],
  };
  return h.lifecycle.acquire({
    holderId: "tab", senderId: 1, workspaceId: "trip", siteRoot: "portal", mode: "dev", restart: false,
    isCurrent: () => true,
    prepare: async () => async () => ({ handle, result: { logs: [] } }),
  });
}

describe("main's workspace trust operations", () => {
  it("opens one dialog per workspace, and a second request waits for its answer", async () => {
    const h = await harness();
    const answer = deferred<boolean>();
    h.confirm.mockImplementation(() => answer.promise);
    const first = h.request();
    const second = h.request();
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    answer.resolve(true);
    await expect(first).resolves.toEqual({ workspaceId: "trip", trusted: true });
    await expect(second).resolves.toEqual({ workspaceId: "trip", trusted: true });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.notified).toEqual([["trip", true]]);
  });

  it("trusts only the folder the person was asked about, not one put at its path while the dialog was open", async () => {
    const h = await harness();
    h.confirm.mockImplementation(async () => {
      await rename(h.workspace.rootPath, join(h.scratch, "asked-about"));
      await mkdir(h.workspace.rootPath);
      return true;
    });
    await expect(h.request()).resolves.toEqual({ workspaceId: "trip", trusted: false });
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);
    expect(h.notified).toEqual([]);
  });

  it("lets a Trust given in another window while the restrict stops apps win, even over a stop it failed", async () => {
    const stopping = deferred<void>();
    const stopReached = deferred<void>();
    const h = await harness({
      answer: true,
      stop: () => {
        stopReached.resolve();
        return stopping.promise;
      },
    });
    await h.request();
    const restricting = h.restrict();
    await stopReached.promise;
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);
    await expect(h.request()).resolves.toEqual({ workspaceId: "trip", trusted: true });
    // That window started a dev server, so the restrict's sweep counts it.
    stopping.reject(new Error("An app is still running because dohc could not stop it."));
    await expect(restricting).resolves.toEqual({ workspaceId: "trip", trusted: true });
    expect(h.notified.at(-1)).toEqual(["trip", true]);
    expect(await h.trust.isTrusted(h.workspace)).toBe(true);
    expect(await createWorkspaceTrust({ file: h.file }).isTrusted(h.workspace)).toBe(true);
  });

  it("lets a Trust whose write the restrict's save waited behind win, with no error", async () => {
    const stopping = deferred<void>();
    const stopReached = deferred<void>();
    const writeGate: { hold: (() => Promise<void>) | null } = { hold: null };
    const h = await harness({
      answer: true,
      writeGate,
      stop: () => {
        stopReached.resolve();
        return stopping.promise;
      },
    });
    await h.request();
    const persisting = vi.spyOn(h.trust, "persistRevocation");
    const restricting = h.restrict();
    await stopReached.promise;
    // The save does not wait for the stop, so a quit meanwhile keeps it.
    expect(persisting).toHaveBeenCalledWith("trip");
    // The Trust from another window is writing its grant when the stop ends.
    const writing = deferred<void>();
    const releaseWrite = deferred<void>();
    writeGate.hold = async () => {
      writeGate.hold = null;
      writing.resolve();
      await releaseWrite.promise;
    };
    const trusting = h.request();
    await writing.promise;
    stopping.reject(new Error("An app is still running because dohc could not stop it."));
    releaseWrite.resolve();
    await expect(trusting).resolves.toEqual({ workspaceId: "trip", trusted: true });
    await expect(restricting).resolves.toEqual({ workspaceId: "trip", trusted: true });
    expect(await createWorkspaceTrust({ file: h.file }).isTrusted(h.workspace)).toBe(true);
  });

  it("leads with the running app when both its stop and the save fail", async () => {
    const failWrites = { value: false };
    const h = await harness({ answer: true, failWrites });
    await h.request();
    const stop = vi.fn(async () => { throw new Error("access denied"); });
    await devServer(h, stop);
    failWrites.value = true;
    await expect(h.restrict()).rejects.toThrow(STOP_AND_SAVE_FAILED_MESSAGE);
    expect(STOP_AND_SAVE_FAILED_MESSAGE.startsWith("An app in this workspace is still running")).toBe(true);
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);
  });

  it("reports a stop that failed, keeps the workspace restricted, and stops it on Try again", async () => {
    const h = await harness({ answer: true });
    await h.request();
    let failStop = true;
    const stop = vi.fn(async () => { if (failStop) throw new Error("access denied"); });
    await devServer(h, stop);

    await expect(h.restrict()).rejects.toThrow(STOP_FAILED_MESSAGE);
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);
    expect(h.notified.at(-1)).toEqual(["trip", false]);
    expect(h.lifecycle.status("trip", "portal").running).toBe(true);

    failStop = false;
    await expect(h.restrict()).resolves.toEqual({ workspaceId: "trip", trusted: false });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(h.lifecycle.status("trip", "portal").running).toBe(false);
  });

  it("stops commands even when Restricted Mode cannot be saved, says so, and saves it on Try again", async () => {
    const failWrites = { value: false };
    const h = await harness({ answer: true, failWrites });
    await h.request();
    const stop = vi.fn(async () => undefined);
    await devServer(h, stop);
    failWrites.value = true;

    await expect(h.restrict()).rejects.toThrow(SAVE_FAILED_MESSAGE);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);
    // A restart would read the grant the write could not remove.
    expect(await createWorkspaceTrust({ file: h.file }).isTrusted(h.workspace)).toBe(true);

    failWrites.value = false;
    await expect(h.restrict()).resolves.toEqual({ workspaceId: "trip", trusted: false });
    expect(await createWorkspaceTrust({ file: h.file }).isTrusted(h.workspace)).toBe(false);
  });

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
      logs: () => [], onExit: () => undefined, stop, stillRunning: async () => [],
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

  it("stops the workspace's agent with its apps, and says which one is still running", async () => {
    const stopAgents = vi.fn(async (_workspaceId: string) => undefined);
    const h = await harness({ answer: true, stopAgents });
    await h.request();
    await expect(h.restrict()).resolves.toEqual({ workspaceId: "trip", trusted: false });
    expect(stopAgents).toHaveBeenCalledWith("trip");

    await h.request();
    stopAgents.mockRejectedValueOnce(new Error("runner outlived its kill"));
    await expect(h.restrict()).rejects.toThrow("An agent in this workspace is still running. dohc could not stop it.");
    expect(await h.trust.isTrusted(h.workspace)).toBe(false);

    await h.request();
    await devServer(h, async () => { throw new Error("access denied"); });
    stopAgents.mockRejectedValueOnce(new Error("runner outlived its kill"));
    await expect(h.restrict()).rejects.toThrow("An app and an agent in this workspace are still running. dohc could not stop them.");
    expect(restrictFailure("agent", true)).toBe(
      "An agent in this workspace is still running, and dohc could not save Restricted Mode. Try again before you quit dohc, or this workspace will be trusted again after a restart.",
    );
  });

  it("saves Restricted Mode and tells windows without waiting for the agent to stop", async () => {
    const agentStopping = deferred<void>();
    const h = await harness({ answer: true, stopAgents: () => agentStopping.promise });
    await h.request();
    const restricting = h.restrict();
    // The agent is still stopping, and a restart would already find the workspace restricted.
    await vi.waitFor(async () => expect(await createWorkspaceTrust({ file: h.file }).isTrusted(h.workspace)).toBe(false));
    await vi.waitFor(() => expect(h.notified.at(-1)).toEqual(["trip", false]));
    agentStopping.resolve();
    await expect(restricting).resolves.toEqual({ workspaceId: "trip", trusted: false });
  });

  it("tells dispatch the dialog opened, once for requests that share it, and not for a trusted workspace", async () => {
    const asked: string[] = [];
    const h = await harness({ answer: false, onAsk: (workspaceId) => asked.push(workspaceId) });
    await Promise.all([h.request(), h.request()]);
    expect(asked).toEqual(["trip"]);
    const trusted = await harness({ answer: true, onAsk: (workspaceId) => asked.push(workspaceId) });
    await trusted.request();
    await trusted.request();
    expect(asked).toEqual(["trip", "trip"]);
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it("stops and saves a restrict, and keeps a grant, whatever a trust listener throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ answer: true, onChange: () => { throw new Error("listener failed"); } });
    await expect(h.request()).resolves.toEqual({ workspaceId: "trip", trusted: true });
    const stop = vi.fn(async () => undefined);
    await devServer(h, stop);
    await expect(h.restrict()).resolves.toEqual({ workspaceId: "trip", trusted: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await createWorkspaceTrust({ file: h.file }).isTrusted(h.workspace)).toBe(false);
    warn.mockRestore();
  });

  it("opens an automatic question only until it was shown, and Trust workspace the person clicks always", async () => {
    const asked = new Set<string>();
    const h = await harness({ answer: false, asked });
    // Two windows' sends: the second answer arrives after the person chose Stay.
    await h.requestAutomatic();
    await h.requestAutomatic();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    await h.request();
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it("counts the question as asked only once the dialog was shown", async () => {
    const asked = new Set<string>();
    const h = await harness({ answer: false, asked });
    h.confirm.mockRejectedValueOnce(new Error("The window closed before the dialog opened."));
    await expect(h.requestAutomatic()).rejects.toThrow("The window closed");
    expect(asked.size).toBe(0);
    await h.requestAutomatic();
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(asked).toEqual(new Set(["trip"]));
  });
});

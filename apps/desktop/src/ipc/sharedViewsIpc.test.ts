import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatcherStatusResult } from "@dohc/workspace-engine-client";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import {
  claimWorkspace,
  closeTestStorages,
  createShare,
  inspectDatabase,
  storagePath,
  testHandler,
  testStorage,
  request,
} from "@dohc/sync-relay/testing";
import { sharedViewAccessOperations, SHARE_EDITING_NOT_READY_MESSAGE } from "./bridgeContract";
import { shareCaptureNoticeState } from "../workspaces/shareCaptureNotice";
import {
  fetchShareViewAccess,
  probeShareViewLog,
  ShareSelectorInvalidError,
  type ShareViewInfo,
} from "../workspaces/shareViewInfo";
import type { ListedReach } from "@dohc/security-contract/listed-reach";
import { SharePinInvalidError } from "../workspaces/shareViewRecords";
import { requireShareViewProposalScope } from "../workspaces/shareProposals";
import {
  shareViewWriteLevel,
  shareViewWriteScopeOf,
  workspaceWriteRefusal,
} from "../workspaces/shareWriteGate";
import { workspaceSummaryFor } from "../workspaces/workspaceSummaryProjection";
import { shareViewRebuildStop } from "../workspaces/shareViewRebuild";
import { buildShareCode } from "../workspaces/syncCode";
import { deferred } from "../testing/deferred";
import {
  createSharedViewsIpcHarness as harness,
  credentials,
  info,
  outcome,
  ready,
} from "../testing/sharedViewsIpcHarness";
import { canonicalWorkspaceRoot, createWorkspaceFolder } from "../workspaces/createWorkspaceFolder";
import { assertActiveWorkspaceOperationLease } from "../workspaces/workspaceAssets";
import { createTestScratch } from "../workspaces/testTemp";

afterEach(() => vi.restoreAllMocks());

it.each(["background", "manual"] as const)(
  "binds the %s shared-view refresh before any service",
  async (trigger) => {
    const h = await harness();
    h.registry.set("other", {
      ...h.workspace,
      workspaceId: "other",
      rootPath: `${h.workspace.rootPath}-other`,
    });
    const payload = { workspaceId: "existing", trigger };
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, payload),
    ).resolves.toMatchObject({ ok: true });
    const services = [
      h.warm,
      h.registryRead,
      h.fetchInfo,
      h.probeLog,
      h.storeFor,
      h.reconcile,
      h.open,
      h.setView,
      h.notify,
    ];
    services.forEach((service) => service.mockClear());
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        ...payload,
        workspaceId: "other",
      }),
    ).rejects.toThrow("window changed workspaces");
    services.forEach((service) => expect(service).not.toHaveBeenCalled());
  },
);

it("opens a share into a folder chosen through a link and refreshes it under the folder's real path", async () => {
  const real = await createTestScratch("dohc-share-real-");
  const chosen = join(await createTestScratch("dohc-share-link-"), "received");
  await symlink(real, chosen, process.platform === "win32" ? "junction" : "dir");
  const homeDir = await createTestScratch("dohc-share-home-");
  const stateDir = await createTestScratch("dohc-share-state-");
  const h = await harness({
    rootPath: await createTestScratch("dohc-share-existing-"),
    canonicalizeRoot: canonicalWorkspaceRoot,
  });
  h.roots.approveRoot(chosen);
  h.createFolder.mockImplementation((input) =>
    createWorkspaceFolder({
      ...input,
      homeDir,
      stateDir,
      kind: "personal",
      computer: { installId: "install-here", label: "This Mac" },
    }),
  );
  // The real share files refuse a lease taken on another spelling of the root.
  h.reconcile.mockImplementation(async (lease) => {
    assertActiveWorkspaceOperationLease(canonicalWorkspaceRoot(real), lease);
    return { kind: "refresh", outcome };
  });

  await expect(
    h.invoke(sharedViewAccessOperations.openSharedView.channel, {
      ...h.openPayload,
      rootPath: chosen,
    }),
  ).resolves.toBeTruthy();

  const opened = [...h.registry.values()].filter(
    (entry) => entry.workspaceId !== h.workspace.workspaceId,
  );
  expect(opened.map((entry) => entry.rootPath)).toEqual([canonicalWorkspaceRoot(real)]);
  expect(h.reconcile).toHaveBeenCalledOnce();
});

it.each(["accept", "refresh"])("%s saves only a nonempty relay owner id", async (operation) => {
  for (const granterUserId of ["relay-owner", ""]) {
    const h = await harness();
    h.fetchInfo.mockResolvedValue({ ...info, granterUserId });
    const result =
      operation === "accept"
        ? await h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload)
        : await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
            workspaceId: "existing",
          });
    expect(result).toBeTruthy();
    const saved = h.setView.mock.calls[0]![1];
    if (granterUserId) expect.soft(saved).toHaveProperty("granterUserId", granterUserId);
    else expect(saved).not.toHaveProperty("granterUserId");
  }
});

describe("share capture Notice dismissal", () => {
  it("persists dismissal without changing protection or accepting a stale Notice", async () => {
    const h = await harness();
    const view = h.workspace.shareView!;
    view.unsavedPaths = ["docs/locked.md"];
    view.unconfirmedChanges = { paths: ["docs/local.yaml"], unchecked: false, checked: 1 };
    const payload = {
      workspaceId: h.workspace.workspaceId,
      shareId: view.shareId,
      key: shareCaptureNoticeState(view.unsavedPaths, view.unconfirmedChanges, false).key,
    };
    await h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, {
      ...payload,
      key: "old",
    });
    expect(h.setView).not.toHaveBeenCalled();
    await h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, payload);
    const saved = JSON.parse(
      JSON.stringify(h.registry.get(h.workspace.workspaceId)),
    ) as typeof h.workspace;
    expect(saved.shareView?.unconfirmedChanges?.dismissedKey).toBe(payload.key);
    expect(saved.shareView?.unsavedPaths).toEqual(["docs/locked.md"]);
    expect(h.notify).toHaveBeenCalledWith({
      workspaceId: h.workspace.workspaceId,
      summaryChanged: true,
    });
    expect(h.storeFor).not.toHaveBeenCalled();
  });
  it("rejects an untrusted or inactive sender", async () => {
    const h = await harness();
    const payload = {
      workspaceId: h.workspace.workspaceId,
      shareId: h.workspace.shareView!.shareId,
      key: "old",
    };
    await expect(
      h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, payload, false),
    ).rejects.toThrow();
    h.retireRenderer();
    await expect(
      h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, payload),
    ).rejects.toThrow();
    expect(h.setView).not.toHaveBeenCalled();
  });
});

describe("recovery folder Notice dismissal", () => {
  it("forgets only the folder the Notice named, and keeps the rest of the view", async () => {
    const h = await harness();
    const view = h.workspace.shareView!;
    view.accessSaved = { folder: ".dohc/local/recovery/new", count: 2 };
    const channel = sharedViewAccessOperations.dismissAccessSavedNotice.channel;
    await h.invoke(channel, {
      workspaceId: h.workspace.workspaceId,
      folder: ".dohc/local/recovery/old",
    });
    expect(h.setView).not.toHaveBeenCalled();
    await h.invoke(channel, {
      workspaceId: h.workspace.workspaceId,
      folder: ".dohc/local/recovery/new",
    });
    const saved = JSON.parse(
      JSON.stringify(h.registry.get(h.workspace.workspaceId)),
    ) as typeof h.workspace;
    expect(saved.shareView).not.toHaveProperty("accessSaved");
    expect(saved.shareView?.shareId).toBe(view.shareId);
    expect(h.notify).toHaveBeenCalledWith({
      workspaceId: h.workspace.workspaceId,
      summaryChanged: true,
    });
  });
  it("rejects an untrusted or inactive sender", async () => {
    const h = await harness();
    h.workspace.shareView!.accessSaved = { folder: "saved", count: 1 };
    const payload = { workspaceId: h.workspace.workspaceId, folder: "saved" };
    const channel = sharedViewAccessOperations.dismissAccessSavedNotice.channel;
    await expect(h.invoke(channel, payload, false)).rejects.toThrow();
    h.retireRenderer();
    await expect(h.invoke(channel, payload)).rejects.toThrow();
    expect(h.setView).not.toHaveBeenCalled();
  });
});

describe("metadata-only access checks", () => {
  it("discovers a real relay's Edit-to-View downgrade and revocation", async () => {
    const storage = await testStorage();
    try {
      const relay = testHandler(storage);
      await claimWorkspace(relay, "granter", "owner");
      const shareId = await createShare(relay, "granter", "owner", {
        recipientUserId: "recipient",
        paths: ["tasks"],
        access: "edit",
      });
      const h = await harness();
      h.workspace.shareView!.shareId = shareId;
      h.workspace.shareView!.grantedSelector.paths = ["tasks"];
      h.workspace.shareView!.relayUrl = "http://relay.test";
      h.cache.set({ ...credentials, relayUrl: "http://relay.test", token: "user:recipient" });
      h.fetchAccess.mockImplementation((input) =>
        fetchShareViewAccess({
          ...input,
          relay: { ...input.relay, fetch: async (url, init) => relay(new Request(url, init)) },
        }),
      );
      const checkAccess = () =>
        h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
          workspaceId: "existing",
        });
      expect(await checkAccess()).toEqual({ status: "current", access: "edit" });
      const db = inspectDatabase(storagePath(storage));
      // Named-grant retuning has no public route yet. Seed its current View
      // state in the real relay store; the authenticated GET remains real.
      db.prepare("UPDATE sync_relay_share_grants SET access = 'view' WHERE share_id = ?").run(
        shareId,
      );
      expect(await checkAccess()).toEqual({ status: "current", access: "view" });
      expect(h.workspace.shareView!.grantedSelector.access).toBe("view");
      expect(h.end).not.toHaveBeenCalled();
      const removed = await relay(
        request("granter", `/sync/shares/${shareId}/revoke`, { method: "POST" }),
      );
      expect(removed.status).toBe(200);
      expect(await checkAccess()).toEqual({ status: "ended" });
      expect(h.end).toHaveBeenCalledOnce();
      expect(h.workspace.shareView!.ended).toBe(true);
    } finally {
      await closeTestStorages();
    }
  });

  it.each(["missing", "different", "signed out", "relay"])(
    "keeps %s recipient credentials unverified",
    async (change) => {
      const h = await harness();
      if (change === "missing") delete h.workspace.shareView!.recipientUserId;
      if (change === "different") h.cache.set({ ...credentials, userId: "someone-else" });
      if (change === "signed out") h.cache.clear();
      if (change === "relay") h.cache.set({ ...credentials, relayUrl: "https://other.test" });
      expect(
        await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
          workspaceId: "existing",
        }),
      ).toEqual({ status: change === "missing" ? "needs-reopen" : "unverified" });
      expect(h.fetchAccess).not.toHaveBeenCalled();
      expect(h.end).not.toHaveBeenCalled();
    },
  );
  it.each(["credentials", "close", "timeout", "workspace"])(
    "publishes a committed end after %s changes",
    async (change) => {
      const h = await harness();
      vi.useFakeTimers();
      try {
        h.fetchAccess.mockRejectedValueOnce(new ShareUnavailableError());
        h.end.mockImplementationOnce(async (_lease, _target, assertCurrent) => {
          assertCurrent();
          h.workspace.shareView!.ended = true;
          if (change === "credentials") h.cache.set({ ...credentials, token: "new" });
          if (change === "close") for (const close of h.closed) close();
          if (change === "workspace") h.retireRenderer();
          if (change === "timeout") await vi.advanceTimersByTimeAsync(4_000);
        });
        await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
          workspaceId: "existing",
        });
        expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
        expect(h.surfaces).toHaveBeenCalledOnce();
        expect(h.closed.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("publishes narrowing even when capture cannot save a file", async () => {
    const h = await harness();
    h.fetchAccess.mockResolvedValue({ access: "view" });
    h.narrow.mockImplementationOnce(async (_lease, _target, assertCurrent, commit) => {
      assertCurrent();
      await commit(["docs/locked.md"], {
        paths: ["docs/automations.yaml"],
        unchecked: false,
        checked: 0,
      });
    });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      }),
    ).toEqual({ status: "current", access: "view" });
    expect(h.workspace.shareView).toMatchObject({
      grantedSelector: { access: "view" },
      unsavedPaths: ["docs/locked.md"],
      unconfirmedChanges: { paths: ["docs/automations.yaml"], unchecked: false, checked: 0 },
    });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
      workspaceId: "existing",
    });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
      workspaceId: "existing",
    });
    expect(h.narrow).toHaveBeenCalledOnce();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "existing",
      summaryChanged: true,
    });
    expect(h.steps.indexOf("pin")).toBeLessThan(h.steps.indexOf("notify"));
  });

  const payload = { workspaceId: "existing" };
  it("does no content work for unchanged access", async () => {
    const h = await harness();
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "edit" });
    expect(h.fetchAccess).toHaveBeenCalledTimes(1);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.storeFor).not.toHaveBeenCalled();
    expect(h.setView).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("retires and publishes only confirmed unavailability", async () => {
    const h = await harness();
    for (const error of [new Error("offline"), new RelayUnauthorizedError()]) {
      h.fetchAccess.mockRejectedValueOnce(error);
      expect(
        await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
      ).toEqual({ status: "unverified" });
      expect(h.end).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }
    h.fetchAccess.mockRejectedValueOnce(new ShareUnavailableError());
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "ended" });
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.workspace.shareView!.ended).toBe(true);
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
    expect(h.reconcile).not.toHaveBeenCalled();
  });
  it("narrows Edit to View without expanding the pinned paths or version", async () => {
    const h = await harness();
    h.workspace.shareView!.grantedSelector.versionId = "saved-version";
    h.fetchAccess.mockResolvedValue({ access: "view" });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "view" });
    expect(h.workspace.shareView!.grantedSelector).toEqual({
      paths: ["docs"],
      versionId: "saved-version",
      access: "view",
    });
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "view", relayStatesMore: true });
    expect(h.workspace.shareView!.grantedSelector.access).toBe("view");
    expect(h.reconcile).not.toHaveBeenCalled();
  });
  // A membership's level is the owner's member level now, not the one it
  // opened with, so it follows the relay both ways. Its scope never moves.
  it("follows a membership's level up and down, keeping the whole-workspace pin", async () => {
    const h = await harness();
    h.workspace.shareView!.grantedSelector = {
      paths: [],
      versionId: null,
      access: "view",
      wholeWorkspace: true,
    };
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "edit", levelChanged: true });
    expect(h.workspace.shareView!.grantedSelector).toEqual({
      paths: [],
      versionId: null,
      access: "edit",
      wholeWorkspace: true,
    });
    expect(h.narrow).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
    h.fetchAccess.mockResolvedValue({ access: "comment" });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "comment", levelChanged: true });
    expect(h.narrow).toHaveBeenCalledOnce();
    expect(h.workspace.shareView!.grantedSelector).toEqual({
      paths: [],
      versionId: null,
      access: "comment",
      wholeWorkspace: true,
    });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "comment" });
  });
  // Main's write gate takes a membership's levels from its stored reach, and
  // the window offers New page from the level. A check that moves the level
  // stores the relay's reach with it, so a page made offline after the owner
  // raised members to Edit is written, and one after a drop is refused.
  it("stores the relay's reach with a membership's new level", async () => {
    const h = await harness();
    const listed = (signature: string, rootLevel: "comment" | "edit") => ({
      signature,
      visibilitySignature: "v1",
      rootLevel,
      groupDefault: rootLevel,
      groups: [],
      folders: [],
    });
    Object.assign(h.workspace.shareView!, {
      grantedSelector: { paths: [], versionId: null, access: "comment", wholeWorkspace: true },
      reach: listed("r1", "comment"),
    });
    const levelAt = (path: string) =>
      shareViewWriteLevel(shareViewWriteScopeOf(h.workspace.shareView, null)!, { path });
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    h.fetchReach.mockResolvedValue(listed("r2", "edit"));
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    expect(levelAt("notes/Budget.md")).toBe("edit");
    h.fetchAccess.mockResolvedValue({ access: "comment" });
    h.fetchReach.mockResolvedValue(listed("r3", "comment"));
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    expect(levelAt("notes/Budget.md")).toBe("comment");
    expect(h.workspace.shareView!.reach).toEqual(listed("r3", "comment"));
    // A changed visibility is the rebuild's to install, not this check's. The
    // raise waits for it, so the window offers no more than the gate allows.
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    const v2 = { ...listed("r4", "edit"), visibilitySignature: "v2" };
    h.fetchReach.mockResolvedValue(v2);
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "unverified" });
    expect(h.workspace.shareView!.reach).toEqual(listed("r3", "comment"));
    expect(h.workspace.shareView!.grantedSelector.access).toBe("comment");
    expect(levelAt("notes/Budget.md")).toBe("comment");
    // Once the rebuild installs the new visibility's reach, a check raises it.
    h.workspace.shareView = { ...h.workspace.shareView!, reach: v2 };
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "edit", levelChanged: true });
    expect(levelAt("notes/Budget.md")).toBe("edit");
  });
  // A rule on the whole workspace can hold members at View. The copy then sends
  // no file changes, so it follows a raised member level with no identity.
  it("follows a membership's level to Edit when its reach lists no Edit", async () => {
    const h = await harness();
    const viewOnly = (signature: string) => ({
      signature,
      visibilitySignature: "v1",
      rootLevel: "view" as const,
      groupDefault: "view" as const,
      groups: [],
      folders: [],
    });
    Object.assign(h.workspace.shareView!, {
      grantedSelector: { paths: [], versionId: null, access: "view", wholeWorkspace: true },
      reach: viewOnly("r1"),
    });
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    h.fetchReach.mockResolvedValue(viewOnly("r2"));
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "edit", levelChanged: true });
    expect(h.workspace.shareView!.grantedSelector.access).toBe("edit");
    expect(h.workspace.shareView!.reach).toEqual(viewOnly("r2"));
  });
  // The answer agrees with the write gates and the summary: a membership that
  // waits to send is at View, and the relay states more, so the window
  // refreshes and enrolls again.
  it("answers View for a membership at Edit until it can send", async () => {
    const h = await harness();
    const reach = {
      signature: "r1",
      visibilitySignature: "v1",
      rootLevel: "edit" as const,
      folders: [],
      groupDefault: "edit" as const,
      groups: [],
    };
    Object.assign(h.workspace.shareView!, {
      grantedSelector: { paths: [], versionId: null, access: "edit", wholeWorkspace: true },
      reach,
      editingNotReady: true,
    });
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    h.fetchReach.mockResolvedValue(reach);
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "view", relayStatesMore: true });
    expect(h.workspace.shareView).toMatchObject({ editingNotReady: true });
  });
  // The window runs the check beside a pull, and the pull can close the copy
  // for a rebuild while the reach is read. The check then leaves the record
  // to the rebuild.
  it("keeps a rebuild and capture a refresh records during the reach read", async () => {
    const h = await harness();
    const stored = {
      signature: "r1",
      visibilitySignature: "v1",
      rootLevel: "comment" as const,
      groupDefault: "comment" as const,
      groups: [],
    };
    const selector = {
      paths: [],
      versionId: null,
      access: "comment" as const,
      wholeWorkspace: true as const,
    };
    Object.assign(h.workspace.shareView!, {
      grantedSelector: selector,
      reach: { ...stored, folders: [] },
    });
    h.fetchInfo.mockResolvedValue({ ...info, role: "member", selector });
    h.reconcile.mockImplementationOnce(async () => ({
      kind: "refresh",
      outcome: { ...outcome, status: "unchanged", rebuildId: "rebuild-concurrent" },
    }));
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    const reach = deferred<ListedReach>();
    h.fetchReach.mockReturnValueOnce(reach.promise);
    const checked = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    await vi.waitFor(() => expect(h.fetchReach).toHaveBeenCalledOnce());
    await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, payload);
    const unsavedPaths = ["notes/Draft.md"];
    h.workspace.shareView = { ...h.workspace.shareView!, unsavedPaths };
    reach.resolve({
      ...stored,
      signature: "r2",
      rootLevel: "edit",
      groupDefault: "edit",
      folders: [],
    });
    const answer = await checked;
    expect(h.workspace.shareView).toMatchObject({
      rebuild: { rebuildId: "rebuild-concurrent" },
      unsavedPaths,
      grantedSelector: selector,
    });
    expect(answer).toEqual({ status: "unverified" });
  });
  it("leaves a closed copy and a newer reach alone when a drop commits", async () => {
    const h = await harness();
    const reach = (signature: string, visibilitySignature: string) => ({
      signature,
      visibilitySignature,
      rootLevel: "comment" as const,
      groupDefault: "comment" as const,
      groups: [],
      folders: [],
    });
    const selector = {
      paths: [],
      versionId: null,
      access: "edit" as const,
      wholeWorkspace: true as const,
    };
    Object.assign(h.workspace.shareView!, { grantedSelector: selector, reach: reach("r1", "v1") });
    h.fetchAccess.mockResolvedValue({ access: "comment" });
    h.fetchReach.mockResolvedValue(reach("r2", "v1"));
    // A rebuild installs the new visibility's reach while capture runs.
    h.narrow.mockImplementationOnce(async (_lease, _target, assertCurrent, commit) => {
      assertCurrent();
      h.workspace.shareView = { ...h.workspace.shareView!, reach: reach("r3", "v2") };
      await commit([], { paths: [], unchecked: false, checked: 0 });
    });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    expect(h.workspace.shareView!.reach).toEqual(reach("r3", "v2"));
    // A refresh closed the copy while the reach was read: nothing narrows it.
    Object.assign(h.workspace.shareView!, { grantedSelector: selector, reach: reach("r1", "v1") });
    h.narrow.mockClear();
    const held = deferred<ListedReach>();
    h.fetchReach.mockReturnValueOnce(held.promise);
    const checked = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    await vi.waitFor(() => expect(h.fetchReach).toHaveBeenCalledTimes(2));
    h.workspace.shareView = { ...h.workspace.shareView!, rebuild: { rebuildId: "rebuild-1" } };
    held.resolve(reach("r2", "v1"));
    expect(await checked).toEqual({ status: "unverified" });
    expect(h.narrow).not.toHaveBeenCalled();
    expect(h.workspace.shareView).toMatchObject({
      grantedSelector: selector,
      reach: reach("r1", "v1"),
      rebuild: { rebuildId: "rebuild-1" },
    });
  });
  it("names who changed a membership's level only when this check moved it", async () => {
    const h = await harness();
    h.workspace.shareView!.grantedSelector = {
      paths: [],
      versionId: null,
      access: "edit",
      wholeWorkspace: true,
    };
    h.fetchAccess.mockResolvedValue({ access: "view", role: "member", levelChangedBy: "Ana" });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({
      status: "current",
      access: "view",
      role: "member",
      levelChanged: true,
      levelChangedBy: "Ana",
    });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "view", role: "member" });
  });
  it("names a membership's role, and never a path share's", async () => {
    const h = await harness();
    h.fetchAccess.mockResolvedValue({ access: "edit", role: "admin" });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "edit" });
    h.workspace.shareView!.grantedSelector = {
      paths: [],
      versionId: null,
      access: "edit",
      wholeWorkspace: true,
    };
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "edit", role: "admin" });
    h.fetchAccess.mockResolvedValue({ access: "edit", role: "member" });
    expect(
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
    ).toEqual({ status: "current", access: "edit", role: "member" });
  });
  // The window and main's menus read the role from the view, so they know it
  // before the next check. The relay still decides every action.
  it("keeps the role the relay named on a membership, and never on a path share", async () => {
    const h = await harness();
    h.fetchAccess.mockResolvedValue({ access: "edit", role: "admin" });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    expect(h.workspace.shareView).not.toHaveProperty("role");
    h.workspace.shareView!.grantedSelector = {
      paths: [],
      versionId: null,
      access: "edit",
      wholeWorkspace: true,
    };
    h.notify.mockClear();
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    expect(h.workspace.shareView!.role).toBe("admin");
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
    // The same role again writes nothing.
    h.notify.mockClear();
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    expect(h.notify).not.toHaveBeenCalled();
    h.fetchAccess.mockResolvedValue({ access: "edit", role: "member" });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    expect(h.workspace.shareView!.role).toBe("member");
  });

  describe("when the owner raised this person's level", () => {
    const check = (h: Awaited<ReturnType<typeof harness>>) =>
      h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    const refresh = (h: Awaited<ReturnType<typeof harness>>, trigger: "background" | "manual") =>
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { ...payload, trigger });
    const view = { paths: ["docs"], versionId: null, access: "view" as const };
    const edit = { paths: ["docs"], versionId: null, access: "edit" as const };
    async function openAtView() {
      const h = await harness();
      h.workspace.shareView!.grantedSelector = { ...view };
      h.fetchInfo.mockResolvedValue({ ...info, selector: view });
      h.fetchAccess.mockResolvedValue({ access: "view" });
      await refresh(h, "background");
      for (const mock of [
        h.fetchInfo,
        h.fetchAccess,
        h.setView,
        h.recordIdentity,
        h.reconcile,
        h.notify,
      ])
        mock.mockClear();
      return h;
    }

    it.each([
      ["view", "comment"],
      ["view", "edit"],
      ["comment", "edit"],
    ] as const)(
      "says the relay states more for a pin at %s and a stated %s, and widens nothing itself",
      async (pinned, stated) => {
        const h = await openAtView();
        h.workspace.shareView!.grantedSelector = { ...view, access: pinned };
        h.fetchAccess.mockResolvedValue({ access: stated });
        expect(await check(h)).toEqual({
          status: "current",
          access: pinned,
          relayStatesMore: true,
        });
        expect(h.workspace.shareView!.grantedSelector).toEqual({ ...view, access: pinned });
        for (const mock of [h.fetchInfo, h.setView, h.recordIdentity, h.reconcile, h.notify])
          expect(mock).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["view", "view"],
      ["comment", "comment"],
      ["edit", "edit"],
      ["edit", "view"],
      ["comment", "view"],
    ] as const)("says nothing more for a pin at %s and a stated %s", async (pinned, stated) => {
      const h = await openAtView();
      h.workspace.shareView!.grantedSelector = { ...view, access: pinned };
      h.fetchAccess.mockResolvedValue({ access: stated });
      expect(await check(h)).toEqual({ status: "current", access: stated });
      expect(h.fetchInfo).not.toHaveBeenCalled();
    });

    it("widens the pin and records the identity through the refresh the window then asks for", async () => {
      const h = await openAtView();
      h.fetchAccess.mockResolvedValue({ access: "edit" });
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      expect(await check(h)).toMatchObject({ access: "view", relayStatesMore: true });
      await refresh(h, "background");
      expect(h.fetchInfo).not.toHaveBeenCalled();
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      await expect(refresh(h, "manual")).resolves.toMatchObject({ ok: true });
      expect(h.fetchInfo).toHaveBeenCalledOnce();
      expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
      expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
        grantedSelector: edit,
        reach: null,
      });
      expect(h.notify).toHaveBeenLastCalledWith({ workspaceId: "existing", summaryChanged: true });
      expect(workspaceSummaryFor(h.workspace).shareView?.access).toBe("edit");
      expect(() => requireShareViewProposalScope(h.workspace.shareView)).not.toThrow();
      expect(await check(h)).toEqual({ status: "current", access: "edit" });
    });

    it.each([
      ["states other paths", { paths: ["everything"], versionId: null, access: "edit" as const }],
      [
        "states a version",
        { paths: ["docs"], versionId: "saved-version", access: "edit" as const },
      ],
    ])("changes nothing when that refresh's read %s", async (_name, selector) => {
      const h = await openAtView();
      h.fetchAccess.mockResolvedValue({ access: "edit" });
      h.fetchInfo.mockResolvedValue({ ...info, selector });
      expect(await check(h)).toMatchObject({ relayStatesMore: true });
      await expect(refresh(h, "manual")).resolves.toMatchObject({ ok: true });
      expect(h.fetchInfo).toHaveBeenCalledOnce();
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(() => requireShareViewProposalScope(h.workspace.shareView)).toThrow();
      expect(await check(h)).toMatchObject({ access: "view", relayStatesMore: true });
      expect(h.fetchInfo).toHaveBeenCalledOnce();
    });

    describe("a copy that says editing could not be turned on", () => {
      async function marked(pinned: "view" | "comment") {
        const h = await openAtView();
        h.workspace.shareView = {
          ...h.workspace.shareView!,
          grantedSelector: { ...view, access: pinned },
          editingNotReady: true,
        };
        h.surfaces.mockClear();
        return h;
      }

      it.each([
        ["view", "view"],
        ["view", "comment"],
        ["comment", "view"],
      ] as const)(
        "stops saying it, in every window, when a check finds a copy at %s and the relay at %s",
        async (pinned, stated) => {
          const h = await marked(pinned);
          h.fetchAccess.mockResolvedValue({ access: stated });
          await check(h);
          expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
          expect(workspaceSummaryFor(h.workspace).shareView).not.toHaveProperty("editingNotReady");
          expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
          expect(h.surfaces).toHaveBeenCalled();
        },
      );

      it("keeps saying it when the check finds the relay still states Edit", async () => {
        const h = await marked("view");
        h.fetchAccess.mockResolvedValue({ access: "edit" });
        expect(await check(h)).toEqual({
          status: "current",
          access: "view",
          relayStatesMore: true,
        });
        expect(h.workspace.shareView!.editingNotReady).toBe(true);
        expect(h.notify).not.toHaveBeenCalled();
      });

      it("keeps saying it when the check cannot verify", async () => {
        const h = await marked("view");
        h.fetchAccess.mockRejectedValue(new Error("offline"));
        expect(await check(h)).toEqual({ status: "unverified" });
        expect(h.workspace.shareView!.editingNotReady).toBe(true);
        expect(h.notify).not.toHaveBeenCalled();
      });
    });

    describe("a check whose answer is older than a refresh", () => {
      async function checkDuringUpgrade() {
        const h = await openAtView();
        const stale = deferred<{ access: "view" | "edit" }>();
        h.fetchAccess.mockReturnValueOnce(stale.promise);
        const checking = check(h);
        await vi.waitFor(() => expect(h.fetchAccess).toHaveBeenCalledOnce());
        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        await refresh(h, "manual");
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
        return { h, stale, checking };
      }

      it("does not undo the Edit the refresh pinned: it reads access again", async () => {
        const { h, stale, checking } = await checkDuringUpgrade();
        h.fetchAccess.mockResolvedValue({ access: "edit" });
        stale.resolve({ access: "view" });
        expect(await checking).toEqual({ status: "current", access: "edit" });
        expect(h.fetchAccess).toHaveBeenCalledTimes(2);
        expect(h.narrow).not.toHaveBeenCalled();
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
      });

      it("narrows when the second reading still states View", async () => {
        const { h, stale, checking } = await checkDuringUpgrade();
        h.fetchAccess.mockResolvedValue({ access: "view" });
        stale.resolve({ access: "view" });
        expect(await checking).toEqual({ status: "current", access: "view" });
        expect(h.fetchAccess).toHaveBeenCalledTimes(2);
        expect(h.narrow).toHaveBeenCalledOnce();
        expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      });

      it("narrows nothing and reads no third time when the pin moves again", async () => {
        const { h, stale, checking } = await checkDuringUpgrade();
        const second = deferred<{ access: "view" | "edit" }>();
        h.fetchAccess.mockReturnValueOnce(second.promise);
        stale.resolve({ access: "view" });
        await vi.waitFor(() => expect(h.fetchAccess).toHaveBeenCalledTimes(2));
        h.workspace.shareView!.grantedSelector = { ...view, access: "comment" };
        second.resolve({ access: "view" });
        expect(await checking).toEqual({ status: "unverified" });
        expect(h.fetchAccess).toHaveBeenCalledTimes(2);
        expect(h.narrow).not.toHaveBeenCalled();
        expect(h.workspace.shareView!.grantedSelector).toEqual({ ...view, access: "comment" });
      });

      it("ends the copy when the second reading says the share ended", async () => {
        const { h, stale, checking } = await checkDuringUpgrade();
        h.fetchAccess.mockRejectedValue(new ShareUnavailableError());
        stale.resolve({ access: "view" });
        expect(await checking).toEqual({ status: "ended" });
        expect(h.end).toHaveBeenCalledOnce();
        expect(h.narrow).not.toHaveBeenCalled();
      });

      it("does not narrow a pin a refresh raised while the narrowing saved unsent work", async () => {
        const h = await openAtView();
        h.workspace.shareView!.grantedSelector = { ...view, access: "comment" };
        h.fetchAccess.mockResolvedValue({ access: "view" });
        h.narrow.mockImplementationOnce(async (_lease, _target, assertCurrent, commit) => {
          assertCurrent();
          h.workspace.shareView!.grantedSelector = { ...edit };
          await commit([], { paths: [], unchecked: false, checked: 0 });
        });
        expect(await check(h)).toEqual({ status: "current", access: "edit" });
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
        expect(h.setView).not.toHaveBeenCalled();
      });
    });

    it("changes nothing when that refresh's read fails", async () => {
      const h = await openAtView();
      h.fetchAccess.mockResolvedValue({ access: "edit" });
      h.fetchInfo.mockRejectedValue(new Error("offline"));
      expect(await check(h)).toMatchObject({ relayStatesMore: true });
      await expect(refresh(h, "manual")).rejects.toThrow("offline");
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      expect(h.setView).not.toHaveBeenCalled();
      expect(h.recordIdentity).not.toHaveBeenCalled();
    });
  });
  it.each(["workspace", "credentials", "close"])(
    "discards a deferred 404 after %s changes",
    async (change) => {
      const h = await harness();
      const response = deferred<{ access: "edit" | "view" }>();
      h.fetchAccess.mockReturnValueOnce(response.promise);
      const result = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
      await vi.waitFor(() => expect(h.fetchAccess).toHaveBeenCalledTimes(1));
      if (change === "workspace") h.retireRenderer();
      if (change === "credentials") h.cache.set({ ...credentials, token: "new-token" });
      if (change === "close") for (const close of h.closed) close();
      response.reject(new ShareUnavailableError());
      expect(await result).toEqual({ status: "unverified" });
      expect(h.end).not.toHaveBeenCalled();
      expect(h.setView).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    },
  );
  it("bounds a hung request and refuses overlapping work", async () => {
    const h = await harness();
    vi.useFakeTimers();
    try {
      const started = deferred<void>();
      h.fetchAccess.mockImplementationOnce(async ({ signal }) => {
        started.resolve();
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
        );
      });
      const result = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
      await started.promise;
      expect(
        await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload),
      ).toEqual({ status: "unverified" });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await result).toEqual({ status: "unverified" });
      expect(h.fetchAccess).toHaveBeenCalledTimes(1);
      expect(h.end).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a hung reach read by the same deadline", async () => {
    const h = await harness();
    h.workspace.shareView!.grantedSelector = {
      paths: [],
      versionId: null,
      access: "comment",
      wholeWorkspace: true,
    };
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    vi.useFakeTimers();
    try {
      const started = deferred<AbortSignal>();
      h.fetchReach.mockImplementationOnce(async ({ signal }) => {
        started.resolve(signal!);
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
        );
      });
      const result = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
      const signal = await started.promise;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(signal.aborted).toBe(true);
      expect(await result).toEqual({ status: "unverified" });
      expect(h.workspace.shareView!.grantedSelector.access).toBe("comment");
      // The sender left the running checks, so the next one asks the relay.
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
      expect(h.fetchAccess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registered received-view handlers", () => {
  it.each(["view", "ended"])("preserves %s while refresh metadata is deferred", async (change) => {
    const h = await harness();
    const started = deferred<void>();
    const response = deferred<ShareViewInfo>();
    h.fetchInfo.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const refreshed = h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    await started.promise;
    if (change === "view") h.fetchAccess.mockResolvedValueOnce({ access: "view" });
    else h.fetchAccess.mockRejectedValueOnce(new ShareUnavailableError());
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
      workspaceId: "existing",
    });
    response.resolve({ ...info, subjectName: "Renamed" });
    await refreshed;
    expect(h.workspace.shareView).toMatchObject({
      subjectName: "Renamed",
      ...(change === "view" ? { grantedSelector: { access: "view" } } : { ended: true }),
    });
    expect(h.recordIdentity).not.toHaveBeenCalledWith({
      grantedSelector: info.selector,
      reach: null,
    });
  });

  it("tells an old received copy to reopen before capture or pull", async () => {
    const h = await harness();
    delete h.workspace.shareView!.recipientUserId;
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).rejects.toThrow("This share must be reopened");
    expect(h.storeFor).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("records current identity when refresh receives a deferred 404", async () => {
    const h = await harness();
    const response = deferred<ShareViewInfo>();
    h.fetchInfo.mockReturnValueOnce(response.promise);
    const refresh = h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    await vi.waitFor(() => expect(h.fetchInfo).toHaveBeenCalledOnce());
    h.fetchAccess.mockResolvedValueOnce({ access: "view" });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
      workspaceId: "existing",
    });
    response.reject(new ShareUnavailableError());
    await refresh;
    expect(h.recordIdentity).not.toHaveBeenCalled();
  });

  it("registers open before refresh and rejects untrusted or malformed inputs before work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([
      sharedViewAccessOperations.openSharedView.channel,
      sharedViewAccessOperations.refreshSharedView.channel,
      sharedViewAccessOperations.retryShareViewRebuild.channel,
      sharedViewAccessOperations.dismissShareCaptureNotice.channel,
      sharedViewAccessOperations.dismissAccessSavedNotice.channel,
      sharedViewAccessOperations.checkSharedViewAccess.channel,
    ]);
    for (const channel of h.handlers.keys())
      await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    await expect(
      h.invoke(sharedViewAccessOperations.openSharedView.channel, { rootPath: "", shareCode: "x" }),
    ).rejects.toThrow();
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "" }),
    ).rejects.toThrow();
    await expect(
      h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "" }),
    ).rejects.toThrow();
    expect(h.fetchAccess).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.startup).not.toHaveBeenCalled();
  });

  it("opens without entering a sender workspace operation", async () => {
    const h = await harness();
    await h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
    expect(h.workspaceOperation).not.toHaveBeenCalled();
    expect(h.open).toHaveBeenCalledOnce();
  });

  it("rejects a foreign relay before preflight and retains preflight-before-root ordering", async () => {
    const h = await harness();
    await expect(
      h.invoke(sharedViewAccessOperations.openSharedView.channel, {
        ...h.openPayload,
        shareCode: "broken",
      }),
    ).rejects.toThrow("share code");
    expect(h.load).not.toHaveBeenCalled();
    await expect(
      h.invoke(sharedViewAccessOperations.openSharedView.channel, {
        ...h.openPayload,
        shareCode: buildShareCode({ shareId: "share", relayUrl: "https://foreign.example.test" }),
      }),
    ).rejects.toThrow("different server");
    expect(h.fetchInfo).not.toHaveBeenCalled();
    await expect(
      h.invoke(sharedViewAccessOperations.openSharedView.channel, {
        ...h.openPayload,
        rootPath: `${h.openPayload.rootPath}-sibling`,
      }),
    ).rejects.toThrow("chosen through dohc");
    expect(h.fetchInfo).toHaveBeenCalledOnce();
    expect(h.readDir).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
  });

  it.each([
    [new ShareUnavailableError(), "No share matches"],
    [new RelayUnauthorizedError(), "session expired"],
    [new ShareSelectorInvalidError("share"), "server did not say"],
    // A person knows the server, not its address.
    [new TypeError("fetch failed"), /^dohc could not reach the server\. Check your connection\.$/],
  ])("maps preflight errors without creating local state", async (error, message) => {
    const h = await harness();
    h.fetchInfo.mockRejectedValue(error);
    await expect(
      h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
    ).rejects.toThrow(message);
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.createFolder).not.toHaveBeenCalled();
  });

  it("refuses chat-only shares and populated folders before creation", async () => {
    const h = await harness();
    h.fetchInfo.mockResolvedValue({ ...info, selector: null });
    await expect(
      h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
    ).rejects.toThrow();
    expect(h.readDir).not.toHaveBeenCalled();
    h.fetchInfo.mockResolvedValue(info);
    h.readDir.mockResolvedValue(["keep.md"]);
    await expect(
      h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
    ).rejects.toThrow("empty folder");
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.createFolder).not.toHaveBeenCalled();
  });

  it("holds creation behind preflight and pins the grant before identity, refresh, activity, and projection", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred<ShareViewInfo>();
    h.fetchInfo.mockImplementation(() => {
      h.steps.push("preflight");
      started.resolve();
      return held.promise;
    });
    const result = h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
    await started.promise;
    expect(h.mkdir).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(1);
    held.resolve(info);
    await expect(result).resolves.toMatchObject({
      workspace: {
        rootPath: h.openPayload.rootPath,
        shareView: { access: "edit", genericChatWritable: true, granterEmail: info.granterEmail },
      },
    });
    expect(h.steps).toEqual([
      "preflight",
      "mkdir",
      "create",
      "register",
      "pin",
      "identity",
      "pin",
      "surfaces",
      "reconcile",
      "open",
      "notify",
    ]);
    expect(h.setView).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        grantedSelector: { ...info.selector, access: "view" },
        relayUrl: credentials.relayUrl,
      }),
    );
    expect(h.setView).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ grantedSelector: info.selector, relayUrl: credentials.relayUrl }),
    );
    expect(h.relayFor).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: expect.any(Symbol) }),
    );
    expect(h.recordIdentity).toHaveBeenCalledWith({ grantedSelector: info.selector, reach: null });
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({
        shareView: expect.objectContaining({ grantedSelector: info.selector }),
      }),
    );
  });

  it("waits for daemon startup before creating a shared view", async () => {
    const h = await harness();
    const startup = deferred();
    const waiting = deferred();
    h.startup.mockImplementation(() => {
      waiting.resolve();
      return startup.promise;
    });
    const result = h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
    await waiting.promise;
    expect(h.steps).toEqual(["preflight"]);
    expect(h.mkdir).not.toHaveBeenCalled();
    startup.resolve();
    await expect(result).resolves.toMatchObject({
      workspace: { rootPath: h.openPayload.rootPath },
    });
    expect(h.steps.slice(0, 3)).toEqual(["preflight", "mkdir", "create"]);
  });

  it("rolls back a failed first refresh before opening activity", async () => {
    const h = await harness();
    h.reconcile.mockResolvedValue({ kind: "refresh", outcome: { ...outcome, status: "ended" } });
    const result = h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
    await expect(result).rejects.toThrow("ended before it could be opened");
    await expect(result).rejects.toThrow(`Files stay in ${h.openPayload.rootPath}.`);
    await expect(result).rejects.toThrow("choose another empty folder");
    expect(h.cleanup).toHaveBeenCalledWith(expect.any(String));
    expect(h.registry.size).toBe(1);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.steps.indexOf("cleanup")).toBeLessThan(h.steps.indexOf("remove"));
  });

  it("names the preserved folder and another empty folder when the share download fails", async () => {
    const h = await harness();
    h.reconcile.mockRejectedValue(new Error("download interrupted"));
    const result = h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
    await expect(result).rejects.toThrow(`Files stay in ${h.openPayload.rootPath}.`);
    await expect(result).rejects.toThrow("choose another empty folder");
    expect(h.registry.size).toBe(1);
  });

  it("retains the registered view and reports the recovery path if rollback cleanup fails", async () => {
    const h = await harness();
    h.reconcile.mockRejectedValue(new Error("pull failed"));
    h.cleanup.mockRejectedValue(new Error("folder busy"));
    const result = h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
    await expect(result).rejects.toThrow("Files stay in");
    await expect(result).rejects.toThrow(
      "choose Remove from list on its row in Manage workspaces before opening the share again",
    );
    expect(h.registry.size).toBe(2);
    expect(h.open).not.toHaveBeenCalled();
  });

  // A membership can be a large workspace. A first pull that fails keeps what
  // arrived, and opening the same folder again continues the pull.
  describe("a membership", () => {
    const member: ShareViewInfo = {
      ...info,
      subjectName: "Community",
      role: "member",
      selector: { paths: [], versionId: null, access: "comment", wholeWorkspace: true },
    };

    it("pins the role and the workspace id Members routes name", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue({ ...member, membersWorkspaceId: "owner-workspace" });
      await h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
      const opened = [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")!;
      expect(opened.shareView).toMatchObject({
        role: "member",
        membersWorkspaceId: "owner-workspace",
      });
    });

    it("stores the reach the relay lists before its first pull", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      await h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
      const opened = [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")!;
      expect(opened.shareView?.reach).toEqual({
        signature: "r1",
        visibilitySignature: "v1",
        rootLevel: "edit",
        groupDefault: "edit" as const,
        groups: [],
        folders: [],
      });
      expect(h.steps.indexOf("reach")).toBeLessThan(h.steps.indexOf("reconcile"));
    });

    // A pull under other reach signatures applies nothing. The refresh reads
    // the reach again and settles it before anything else is pulled.
    const stored = {
      signature: "r1",
      visibilitySignature: "v1",
      rootLevel: "edit" as const,
      groupDefault: "edit" as const,
      groups: [],
      folders: [{ path: "Notes", level: "view" as const }],
    };
    const stoppedPull = (reachChanged: { signature: string; visibilitySignature: string }) => ({
      kind: "refresh" as const,
      outcome: {
        ...outcome,
        status: "unchanged" as const,
        changedPaths: 0,
        refusedOps: 0,
        reachChanged,
      },
    });

    it("installs new levels under the same visibility after capture, then pulls again", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      Object.assign(h.workspace.shareView!, { grantedSelector: member.selector!, reach: stored });
      const listed = {
        ...stored,
        signature: "r2",
        folders: [{ path: "Notes", level: "edit" as const }],
      };
      h.fetchReach.mockResolvedValue(listed);
      h.reconcile.mockImplementationOnce(async () =>
        stoppedPull({ signature: "r2", visibilitySignature: "v1" }),
      );
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.narrow).toHaveBeenCalledOnce();
      expect(h.workspace.shareView!.reach).toEqual(listed);
      expect(h.reconcile).toHaveBeenCalledTimes(2);
      expect(h.narrow.mock.invocationCallOrder[0]).toBeLessThan(
        h.reconcile.mock.invocationCallOrder[1]!,
      );
      expect(h.workspace.shareView).not.toHaveProperty("rebuild");
    });

    it("enrolls for sending when installed levels list Edit where the member had none", async () => {
      const h = await harness();
      const viewer = { ...member.selector!, access: "view" as const };
      h.fetchInfo.mockResolvedValue({ ...member, selector: viewer });
      const viewOnly = {
        ...stored,
        rootLevel: "view" as const,
        groupDefault: "view" as const,
        groups: [],
      };
      Object.assign(h.workspace.shareView!, { grantedSelector: viewer, reach: viewOnly });
      const listed = {
        ...viewOnly,
        signature: "r2",
        folders: [{ path: "Notes", level: "edit" as const }],
      };
      h.fetchReach.mockResolvedValue(listed);
      h.reconcile.mockImplementationOnce(async () =>
        stoppedPull({ signature: "r2", visibilitySignature: "v1" }),
      );
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
        grantedSelector: viewer,
        reach: listed,
      });
      expect(h.narrow.mock.invocationCallOrder[0]).toBeLessThan(
        h.recordIdentity.mock.invocationCallOrder[0]!,
      );
      expect(h.recordIdentity.mock.invocationCallOrder[0]).toBeLessThan(
        h.reconcile.mock.invocationCallOrder[1]!,
      );
    });

    it("enrolls for sending at open when only a folder lists Edit", async () => {
      const h = await harness();
      const viewer = { ...member.selector!, access: "view" as const };
      h.fetchInfo.mockResolvedValue({ ...member, selector: viewer });
      const listed = {
        signature: "r1",
        visibilitySignature: "v1",
        rootLevel: "view" as const,
        groupDefault: "view" as const,
        groups: [],
        folders: [{ path: "Notes", level: "edit" as const }],
      };
      h.fetchReach.mockResolvedValue(listed);
      await h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
      expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
        grantedSelector: viewer,
        reach: listed,
      });
      expect(h.steps.indexOf("identity")).toBeLessThan(h.steps.indexOf("reconcile"));
    });

    // An edit made with no identity would never be sent, so every gate gives
    // View until one is recorded.
    const levelIn = (view: unknown, path: string) =>
      shareViewWriteLevel(shareViewWriteScopeOf(view, null)!, { path });

    it("takes no Edit until a failed enrolment at open is recorded by a refresh", async () => {
      const h = await harness();
      const viewer = { ...member.selector!, access: "view" as const };
      h.fetchInfo.mockResolvedValue({ ...member, selector: viewer });
      h.fetchReach.mockResolvedValue({
        signature: "r1",
        visibilitySignature: "v1",
        rootLevel: "view",
        groupDefault: "view",
        groups: [],
        folders: [{ path: "Notes", level: "edit" }],
      });
      h.recordIdentity.mockRejectedValueOnce(new Error("offline"));
      await h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
      const opened = [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")!;
      expect(opened.shareView).toMatchObject({ editingNotReady: true });
      expect(levelIn(opened.shareView, "Notes/a.md")).toBe("view");
      // The window refreshes the copy it has open.
      h.workspace.shareView = opened.shareView;
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
      expect(levelIn(h.workspace.shareView, "Notes/a.md")).toBe("edit");
    });

    it("takes no Edit from installed levels until it enrols for them", async () => {
      const h = await harness();
      const viewer = { ...member.selector!, access: "view" as const };
      h.fetchInfo.mockResolvedValue({ ...member, selector: viewer });
      const viewOnly = { ...stored, rootLevel: "view" as const };
      Object.assign(h.workspace.shareView!, { grantedSelector: viewer, reach: viewOnly });
      h.fetchReach.mockResolvedValue({
        ...viewOnly,
        signature: "r2",
        folders: [{ path: "Notes", level: "edit" as const }],
      });
      h.reconcile.mockImplementationOnce(async () =>
        stoppedPull({ signature: "r2", visibilitySignature: "v1" }),
      );
      h.recordIdentity.mockRejectedValue(new Error("offline"));
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.workspace.shareView).toMatchObject({ editingNotReady: true });
      expect(levelIn(h.workspace.shareView, "Notes/a.md")).toBe("view");
      // The pull is not cached while the copy waits, so the next background
      // refresh enrolls again.
      h.recordIdentity.mockResolvedValue({ identity: "recorded" });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
        trigger: "background",
      });
      expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
      expect(levelIn(h.workspace.shareView, "Notes/a.md")).toBe("edit");
    });

    const enrolled = {
      ...stored,
      rootLevel: "view" as const,
      folders: [{ path: "Notes", level: "edit" as const }],
    };

    it("keeps editing on when a refresh signed out can't enrol again", async () => {
      const h = await harness();
      const viewer = { ...member.selector!, access: "view" as const };
      h.fetchInfo.mockResolvedValue({ ...member, selector: viewer });
      Object.assign(h.workspace.shareView!, { grantedSelector: viewer, reach: enrolled });
      h.cache.clear();
      await h
        .invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" })
        .catch(() => undefined);
      expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
      expect(levelIn(h.workspace.shareView, "Notes/a.md")).toBe("edit");
    });

    it("keeps the mark a newer install set when an older read needed no identity", async () => {
      const h = await harness();
      const viewer = { ...member.selector!, access: "view" as const };
      h.fetchInfo.mockResolvedValue({ ...member, selector: viewer });
      const viewOnly = { ...stored, rootLevel: "view" as const };
      Object.assign(h.workspace.shareView!, { grantedSelector: viewer, reach: viewOnly });
      // While this refresh's own record runs, another pull installs Edit in a
      // folder and waits to enrol.
      let warmed = 0;
      h.warm.mockImplementation(async () => {
        if (!new Error().stack?.includes("recordShareViewIdentity")) return;
        warmed++;
        h.workspace.shareView = {
          ...h.workspace.shareView!,
          reach: { ...enrolled, signature: "r2" },
          editingNotReady: true,
        };
      });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(warmed).toBe(1);
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(h.workspace.shareView).toMatchObject({ editingNotReady: true });
      expect(levelIn(h.workspace.shareView, "Notes/a.md")).toBe("view");
    });

    // The levels moved, and the visibility moved before the pull that follows
    // them: the engine closes the copy on that second pull.
    it("marks the view as updating access when the pull after new levels closes the copy", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      Object.assign(h.workspace.shareView!, { grantedSelector: member.selector!, reach: stored });
      h.fetchReach.mockResolvedValue({
        ...stored,
        signature: "r2",
        folders: [{ path: "Notes", level: "edit" as const }],
      });
      h.reconcile.mockImplementationOnce(async () =>
        stoppedPull({ signature: "r2", visibilitySignature: "v1" }),
      );
      h.reconcile.mockImplementationOnce(async () => {
        const stopped = stoppedPull({ signature: "r3", visibilitySignature: "v2" });
        return { ...stopped, outcome: { ...stopped.outcome, rebuildId: "rebuild-1" } };
      });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.reconcile).toHaveBeenCalledTimes(2);
      expect(h.workspace.shareView).toMatchObject({ rebuild: { rebuildId: "rebuild-1" } });
      expect(h.rebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-1");
      // Nothing caches the closed copy as unchanged: the next refresh asks again.
      await expect(
        h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
          workspaceId: "existing",
          trigger: "background",
        }),
      ).rejects.toThrow("dohc could not refresh this workspace while its access is being updated.");
    });

    // The engine closed the copy before the pull answered. The view records
    // the rebuild and the window shows "Updating access"; nothing reads the
    // copy again, and its levels wait for the rebuild.
    it("marks the view as updating access when the engine closes the copy", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      Object.assign(h.workspace.shareView!, { grantedSelector: member.selector!, reach: stored });
      h.fetchReach.mockResolvedValue({
        ...stored,
        signature: "r2",
        visibilitySignature: "v2",
        folders: [],
      });
      h.reconcile.mockImplementationOnce(async () => {
        const stopped = stoppedPull({ signature: "r2", visibilitySignature: "v2" });
        return { ...stopped, outcome: { ...stopped.outcome, rebuildId: "rebuild-1" } };
      });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.workspace.shareView).toMatchObject({
        rebuild: { rebuildId: "rebuild-1" },
        reach: stored,
      });
      expect(workspaceSummaryFor(h.workspace).shareView).toMatchObject({ updatingAccess: true });
      expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
      expect(h.fetchReach).not.toHaveBeenCalled();
      expect(h.narrow).not.toHaveBeenCalled();
      await expect(
        h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
      ).rejects.toThrow("dohc could not refresh this workspace while its access is being updated.");
      expect(h.reconcile).toHaveBeenCalledOnce();
      // Each refresh of the closed copy asks main to rebuild it.
      expect(h.rebuild).toHaveBeenCalledTimes(2);
      expect(h.rebuild).toHaveBeenCalledWith("existing", "rebuild-1");
    });

    // The engine closed the copy, but its answer never reached the record: a
    // crash or a failed write lost the id. A refresh asks the engine first.
    it("finds a rebuild whose id never reached the record, and starts it", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      Object.assign(h.workspace.shareView!, { grantedSelector: member.selector!, reach: stored });
      h.readRebuild.mockResolvedValue({ rebuildId: "rebuild-9", phase: "closed" });
      await expect(
        h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
      ).rejects.toThrow("dohc could not refresh this workspace while its access is being updated.");
      expect(h.workspace.shareView).toMatchObject({ rebuild: { rebuildId: "rebuild-9" } });
      expect(h.rebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-9");
      expect(h.reconcile).not.toHaveBeenCalled();
    });

    // The record already holds what the rebuild built and opens the copy;
    // only the engine's finish failed. A refresh finishes it and reads on.
    it("finishes a converged rebuild the record already installed, and refreshes", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      Object.assign(h.workspace.shareView!, { grantedSelector: member.selector!, reach: stored });
      h.readRebuild.mockResolvedValue({ rebuildId: "rebuild-9", phase: "converged" });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.finishRebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-9");
      expect(h.workspace.shareView).not.toHaveProperty("rebuild");
      expect(h.rebuild).not.toHaveBeenCalled();
      expect(h.reconcile).toHaveBeenCalledOnce();
    });

    // The runner installed the rebuild while the status read was out: the
    // record no longer names it, so the refresh finishes it and reads on
    // instead of naming it again.
    it("finishes a rebuild installed while its status was being read", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      Object.assign(h.workspace.shareView!, {
        grantedSelector: member.selector!,
        reach: stored,
        rebuild: { rebuildId: "rebuild-9" },
      });
      h.readRebuild.mockImplementationOnce(async () => {
        const { rebuild: _installed, ...view } = h.workspace.shareView!;
        h.workspace.shareView = view;
        return { rebuildId: "rebuild-9", phase: "converged" };
      });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.finishRebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-9");
      expect(h.workspace.shareView).not.toHaveProperty("rebuild");
      expect(h.rebuild).not.toHaveBeenCalled();
      expect(h.reconcile).toHaveBeenCalledOnce();
    });

    // After a restart the window shows Updating access and starts nothing.
    it("resumes each closed copy's rebuild at start, including one whose id was lost", async () => {
      const rebuiltReach = { ...stored, signature: "r2", visibilitySignature: "v2" };
      const h = await harness();
      Object.assign(h.workspace.shareView!, {
        grantedSelector: member.selector!,
        reach: stored,
        rebuild: { rebuildId: "rebuild-1" },
      });
      await h.resumeRebuilds();
      expect(h.rebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-1");

      const lost = await harness();
      Object.assign(lost.workspace.shareView!, {
        grantedSelector: member.selector!,
        reach: stored,
      });
      lost.readRebuild.mockResolvedValue({ rebuildId: "rebuild-2", phase: "closed" });
      lost.rebuild.mockImplementationOnce(async (workspaceId) => {
        const { rebuild: _closed, ...view } = lost.registry.get(workspaceId)!.shareView!;
        lost.registry.get(workspaceId)!.shareView = { ...view, reach: rebuiltReach };
        return { kind: "rebuilt", recoveryFolder: null, recovered: 0 };
      });
      await lost.resumeRebuilds();
      expect(lost.rebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-2");
      await vi.waitFor(() =>
        expect(lost.registry.get("existing")!.shareView).not.toHaveProperty("rebuild"),
      );
      expect(lost.registry.get("existing")!.shareView).toMatchObject({ reach: rebuiltReach });

      // An open copy, and a path share, start nothing.
      const open = await harness();
      Object.assign(open.workspace.shareView!, {
        grantedSelector: member.selector!,
        reach: stored,
      });
      await open.resumeRebuilds();
      const path = await harness();
      path.readRebuild.mockResolvedValue({ rebuildId: "rebuild-3", phase: "closed" });
      await path.resumeRebuilds();
      expect(open.rebuild).not.toHaveBeenCalled();
      expect(path.rebuild).not.toHaveBeenCalled();
      expect(path.readRebuild).not.toHaveBeenCalled();
    });

    // After a restart the panel shows with no workspace open in its window,
    // so its Try again has no session to refresh through.
    it("starts a stopped rebuild again from Try again after a restart", async () => {
      const h = await harness();
      Object.assign(h.workspace.shareView!, {
        grantedSelector: member.selector!,
        reach: stored,
        rebuild: {
          rebuildId: "rebuild-1",
          stopped: { reason: "failed", detail: "dohc could not update access: the disk is full." },
        },
      });
      h.withoutRendererSession();
      await h.invoke(sharedViewAccessOperations.retryShareViewRebuild.channel, {
        workspaceId: "existing",
      });
      expect(h.rebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-1");
      // Only a trusted window, and only a membership that hasn't ended.
      await expect(
        h.invoke(
          sharedViewAccessOperations.retryShareViewRebuild.channel,
          { workspaceId: "existing" },
          false,
        ),
      ).rejects.toThrow("untrusted");
      h.workspace.shareView!.ended = true;
      await h.invoke(sharedViewAccessOperations.retryShareViewRebuild.channel, {
        workspaceId: "existing",
      });
      expect(h.rebuild).toHaveBeenCalledOnce();
    });

    // The panel shows while the engine may still be starting, as refresh can.
    it("waits for the engine to start before Try again reaches it", async () => {
      const h = await harness();
      Object.assign(h.workspace.shareView!, {
        grantedSelector: member.selector!,
        reach: stored,
        rebuild: {
          rebuildId: "rebuild-1",
          stopped: { reason: "failed", detail: "dohc could not update access." },
        },
      });
      h.withoutRendererSession();
      let started!: () => void;
      h.startup.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            started = resolve;
          }),
      );
      const retry = h.invoke(sharedViewAccessOperations.retryShareViewRebuild.channel, {
        workspaceId: "existing",
      });
      await vi.waitFor(() => expect(h.startup).toHaveBeenCalled());
      expect(h.readRebuild).not.toHaveBeenCalled();
      expect(h.rebuild).not.toHaveBeenCalled();
      started();
      await retry;
      expect(h.rebuild).toHaveBeenCalledExactlyOnceWith("existing", "rebuild-1");
    });

    it("tells the window why an update of access stopped", async () => {
      const h = await harness();
      Object.assign(h.workspace.shareView!, {
        grantedSelector: member.selector!,
        reach: stored,
        rebuild: {
          rebuildId: "rebuild-1",
          stopped: shareViewRebuildStop({ kind: "failed", error: new Error("the disk is full.") })!,
        },
      });
      expect(workspaceSummaryFor(h.workspace).shareView).toMatchObject({
        updatingAccess: true,
        updatingAccessStopped: {
          reason: "failed",
          detail: "dohc could not update access: the disk is full.",
        },
      });
      h.workspace.shareView!.rebuild = { rebuildId: "rebuild-1" };
      expect(workspaceSummaryFor(h.workspace).shareView).not.toHaveProperty(
        "updatingAccessStopped",
      );
    });

    // The relay listed another visibility, but the pull was served before it:
    // the engine did not close the copy, so nothing changes until a pull does.
    it("keeps the copy and its levels when the listed visibility runs ahead of the pull", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      Object.assign(h.workspace.shareView!, { grantedSelector: member.selector!, reach: stored });
      h.fetchReach.mockResolvedValue({
        ...stored,
        signature: "r2",
        visibilitySignature: "v2",
        folders: [],
      });
      h.reconcile.mockImplementationOnce(async () =>
        stoppedPull({ signature: "r2", visibilitySignature: "v1" }),
      );
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.narrow).not.toHaveBeenCalled();
      expect(h.reconcile).toHaveBeenCalledOnce();
      expect(h.workspace.shareView!.reach).toEqual(stored);
      expect(h.workspace.shareView).not.toHaveProperty("rebuild");
    });

    it("follows the relay's role on refresh, and keeps a path share free of one", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue({
        ...member,
        role: "admin",
        membersWorkspaceId: "owner-workspace",
      });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.workspace.shareView).not.toHaveProperty("role");
      expect(h.workspace.shareView).not.toHaveProperty("membersWorkspaceId");
      h.workspace.shareView!.grantedSelector = member.selector!;
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.workspace.shareView).toMatchObject({
        role: "admin",
        membersWorkspaceId: "owner-workspace",
      });
    });

    it("keeps what a failed first pull brought, and Try again continues it in place", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      h.reconcile.mockRejectedValueOnce(new Error("relay went away"));
      const first = h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
      await expect(first).rejects.toThrow(
        "dohc could not finish reading Community: relay went away.",
      );
      await expect(first).rejects.toThrow(
        `What arrived stays in ${h.openPayload.rootPath}. Try again continues from there.`,
      );
      expect(h.cleanup).not.toHaveBeenCalled();
      expect(h.registry.size).toBe(2);
      const kept = [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")!;
      expect(kept.shareView?.grantedSelector).toEqual(member.selector);
      // The view is usable with what arrived: it opens and the list shows it.
      expect(h.open).toHaveBeenCalledOnce();
      // The folder now holds what arrived, and the same folder continues the pull.
      h.readDir.mockResolvedValue(["notes.md"]);
      await expect(
        h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
      ).resolves.toMatchObject({
        workspace: { workspaceId: kept.workspaceId, rootPath: h.openPayload.rootPath },
      });
      expect(h.createFolder).toHaveBeenCalledOnce();
      expect(h.reconcile).toHaveBeenCalledTimes(2);
      expect(h.registry.size).toBe(2);
    });

    // The engine closed the copy during the first pull. What arrived stays,
    // the open succeeds, and the rebuild starts at once: the window shows
    // Updating access until it finishes. Opening the folder again continues
    // the pull from the rebuilt copy.
    it("rebuilds a first open whose copy the engine closed", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      h.reconcile.mockImplementationOnce(async () => ({
        kind: "refresh" as const,
        outcome: {
          ...outcome,
          status: "unchanged" as const,
          changedPaths: 0,
          refusedOps: 0,
          reachChanged: { signature: "r2", visibilitySignature: "v2" },
          rebuildId: "rebuild-1",
        },
      }));
      const rebuiltReach = {
        signature: "r2",
        visibilitySignature: "v2",
        rootLevel: "edit" as const,
        groupDefault: "edit" as const,
        groups: [],
        folders: [],
      };
      h.rebuild.mockImplementationOnce(async (workspaceId) => {
        const { rebuild: _closed, ...view } = h.registry.get(workspaceId)!.shareView!;
        h.registry.get(workspaceId)!.shareView = { ...view, reach: rebuiltReach };
        return { kind: "rebuilt", recoveryFolder: null, recovered: 0 };
      });
      const opened = (await h.invoke(
        sharedViewAccessOperations.openSharedView.channel,
        h.openPayload,
      )) as { workspace: { workspaceId: string } };
      expect(h.cleanup).not.toHaveBeenCalled();
      const kept = [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")!;
      expect(opened.workspace.workspaceId).toBe(kept.workspaceId);
      await vi.waitFor(() =>
        expect(h.rebuild).toHaveBeenCalledExactlyOnceWith(kept.workspaceId, "rebuild-1"),
      );
      await vi.waitFor(() =>
        expect(h.registry.get(kept.workspaceId)!.shareView).not.toHaveProperty("rebuild"),
      );
      expect(h.registry.get(kept.workspaceId)!.shareView).toMatchObject({ reach: rebuiltReach });
      h.readDir.mockResolvedValue(["notes.md"]);
      const reopened = (await h.invoke(
        sharedViewAccessOperations.openSharedView.channel,
        h.openPayload,
      )) as { workspace: { workspaceId: string } };
      expect(reopened.workspace.workspaceId).toBe(kept.workspaceId);
      expect(h.rebuild).toHaveBeenCalledOnce();
      expect(h.reconcile).toHaveBeenCalledTimes(2);
    });

    // A rebuild that stops keeps the copy closed: opening the folder again
    // tries the rebuild again and reads nothing from the copy.
    it("keeps a first open closed while its rebuild stops", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      h.reconcile.mockImplementationOnce(async () => ({
        kind: "refresh" as const,
        outcome: {
          ...outcome,
          status: "unchanged" as const,
          changedPaths: 0,
          refusedOps: 0,
          reachChanged: { signature: "r2", visibilitySignature: "v2" },
          rebuildId: "rebuild-1",
        },
      }));
      await h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload);
      await vi.waitFor(() => expect(h.rebuild).toHaveBeenCalledOnce());
      const updating = `dohc could not finish reading Community while its access is being updated. What arrived stays in ${h.openPayload.rootPath}.`;
      h.readDir.mockResolvedValue(["notes.md"]);
      await expect(
        h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
      ).rejects.toThrow(updating);
      const kept = [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")!;
      expect(kept.shareView?.rebuild).toEqual({ rebuildId: "rebuild-1" });
      expect(h.rebuild).toHaveBeenCalledTimes(2);
      expect(h.reconcile).toHaveBeenCalledOnce();
    });

    it("continues only its own copy: another share or account still needs an empty folder", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      h.reconcile.mockRejectedValueOnce(new Error("relay went away"));
      await expect(
        h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
      ).rejects.toThrow("Try again");
      const kept = [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")!;
      h.readDir.mockResolvedValue(["notes.md"]);
      kept.shareView = { ...kept.shareView!, recipientUserId: "someone-else" };
      await expect(
        h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
      ).rejects.toThrow("empty folder");
      kept.shareView = {
        ...kept.shareView,
        recipientUserId: credentials.userId,
        shareId: "another",
      };
      await expect(
        h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
      ).rejects.toThrow("empty folder");
      expect(h.createFolder).toHaveBeenCalledOnce();
    });

    it("still rolls back when the membership ended before it opened", async () => {
      const h = await harness();
      h.fetchInfo.mockResolvedValue(member);
      h.reconcile.mockResolvedValue({ kind: "refresh", outcome: { ...outcome, status: "ended" } });
      await expect(
        h.invoke(sharedViewAccessOperations.openSharedView.channel, h.openPayload),
      ).rejects.toThrow("ended before it could be opened");
      expect(h.registry.size).toBe(1);
    });
  });

  describe("opening a share for the first time", () => {
    const view = { paths: ["docs"], versionId: null, access: "view" as const };
    const edit = { paths: ["docs"], versionId: null, access: "edit" as const };
    type Opened = { workspace: { workspaceId: string; shareView?: { access?: string } } };
    type ShareViewRecord = NonNullable<
      Awaited<ReturnType<typeof harness>>["workspace"]["shareView"]
    >;
    async function opening(selector: NonNullable<ShareViewInfo["selector"]>) {
      const h = await harness();
      h.fetchInfo.mockResolvedValue({ ...info, selector });
      const opened = () =>
        [...h.registry.values()].find((entry) => entry.workspaceId !== "existing")?.shareView;
      const pinnedAtPull: unknown[] = [];
      h.reconcile.mockImplementation(async () => {
        pinnedAtPull.push(opened()?.grantedSelector);
        return { kind: "refresh", outcome };
      });
      const open = () =>
        h.invoke(
          sharedViewAccessOperations.openSharedView.channel,
          h.openPayload,
        ) as Promise<Opened>;
      return { h, opened, pinnedAtPull, open };
    }

    it("records the identity of a share at Edit while the copy is at View, and pins Edit before the first pull", async () => {
      const { h, opened, pinnedAtPull, open } = await opening(edit);
      const pinnedAtIdentity: unknown[] = [];
      h.recordIdentity.mockImplementation(async () => {
        pinnedAtIdentity.push(opened()?.grantedSelector);
        expect(() => requireShareViewProposalScope(opened())).toThrow();
        return { identity: "recorded" };
      });
      const result = await open();
      expect(result).toMatchObject({ workspace: { shareView: { access: "edit" } } });
      expect(result.workspace.shareView).not.toHaveProperty("editingNotReady");
      expect(opened()).not.toHaveProperty("editingNotReady");
      expect(pinnedAtIdentity).toEqual([view]);
      expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
        grantedSelector: edit,
        reach: null,
      });
      expect(pinnedAtPull).toEqual([edit]);
      expect(opened()?.grantedSelector).toEqual(edit);
      expect(() => requireShareViewProposalScope(opened())).not.toThrow();
    });

    it("opens a share at Edit at View and says editing is not on when the identity cannot be recorded, until a refresh records it", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { h, opened, pinnedAtPull, open } = await opening(edit);
      h.recordIdentity.mockRejectedValue(new Error("identity unavailable"));
      await expect(open()).resolves.toMatchObject({
        workspace: { shareView: { access: "view", editingNotReady: true } },
      });
      expect(opened()).toMatchObject({
        grantedSelector: view,
        editingNotReady: true,
        relayUrl: credentials.relayUrl,
        recipientUserId: credentials.userId,
      });
      expect(pinnedAtPull).toEqual([view]);
      expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
        grantedSelector: edit,
        reach: null,
      });
      expect(h.open).toHaveBeenCalledOnce();
      expect(() => requireShareViewProposalScope(opened())).toThrow();

      h.workspace.shareView = { ...opened()! };
      const refresh = () =>
        h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
          workspaceId: "existing",
          trigger: "manual",
        });
      h.reconcile.mockImplementation(async () => ({ kind: "refresh", outcome }));
      await expect(refresh()).resolves.toEqual({
        ok: false,
        errorKind: "transient",
        changedPaths: outcome.changedPaths,
        errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
        editingNotReady: true,
      });
      expect(h.workspace.shareView).toMatchObject({ grantedSelector: view, editingNotReady: true });
      expect(workspaceSummaryFor(h.workspace).shareView?.editingNotReady).toBe(true);

      h.recordIdentity.mockResolvedValue({ identity: "recorded" });
      await expect(refresh()).resolves.toMatchObject({ ok: true });
      expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
      expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
      expect(workspaceSummaryFor(h.workspace).shareView).not.toHaveProperty("editingNotReady");
      expect(() => requireShareViewProposalScope(h.workspace.shareView)).not.toThrow();
    });

    it("opens at View and says editing is not on when the account changes before the identity is asked for", async () => {
      const { h, opened, open } = await opening(edit);
      h.warm.mockImplementationOnce(async () => {
        h.cache.set({ ...credentials, userId: "someone-else" });
      });
      await expect(open()).resolves.toMatchObject({
        workspace: { shareView: { access: "view", editingNotReady: true } },
      });
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(opened()).toMatchObject({ grantedSelector: view, editingNotReady: true });
    });

    it("opens at View and says editing is not on when the engine answers that it recorded no identity", async () => {
      const { h, opened, open } = await opening(edit);
      h.recordIdentity.mockResolvedValue({ identity: "not-required" });
      await expect(open()).resolves.toMatchObject({
        workspace: { shareView: { access: "view", editingNotReady: true } },
      });
      expect(opened()).toMatchObject({ grantedSelector: view, editingNotReady: true });
    });

    it.each([
      [
        "the share ended",
        (shareView: ShareViewRecord) => Object.assign(shareView, { ended: true }),
      ],
      [
        "its level was changed",
        (shareView: ShareViewRecord) =>
          Object.assign(shareView, { grantedSelector: { ...view, access: "comment" } }),
      ],
    ])("does not pin Edit when %s while the identity was recorded", async (_name, change) => {
      const { h, opened, open } = await opening(edit);
      h.recordIdentity.mockImplementation(async () => {
        change(opened()!);
        return { identity: "recorded" };
      });
      await open().catch(() => undefined);
      expect(h.setView).toHaveBeenCalledOnce();
      expect(opened()?.grantedSelector.access).not.toBe("edit");
    });

    it("keeps saying editing is not on when a newer check found Edit while a refresh read View", async () => {
      const h = await harness();
      h.workspace.shareView = {
        ...h.workspace.shareView!,
        grantedSelector: { ...view },
        editingNotReady: true,
      };
      const reply = deferred<ShareViewInfo>();
      h.fetchInfo.mockReturnValueOnce(reply.promise);
      const refreshed = h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      await vi.waitFor(() => expect(h.fetchInfo).toHaveBeenCalledOnce());
      h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      });
      reply.resolve({ ...info, selector: view });
      await refreshed;
      expect(h.workspace.shareView).toMatchObject({ grantedSelector: view, editingNotReady: true });
    });

    describe("a refresh whose level read an access check overtook", () => {
      const comment = { ...view, access: "comment" as const };
      const refresh = (h: Awaited<ReturnType<typeof harness>>) =>
        h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
          workspaceId: "existing",
          trigger: "background",
        });
      const check = (h: Awaited<ReturnType<typeof harness>>) =>
        h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
          workspaceId: "existing",
        });
      async function refreshing(pinned: typeof view | typeof comment, marked: boolean) {
        const h = await harness();
        h.workspace.shareView = {
          ...h.workspace.shareView!,
          grantedSelector: { ...pinned },
          ...(marked ? { editingNotReady: true as const } : {}),
        };
        h.reconcile.mockImplementation(async (_lease, _target, _request, onCursorCommitted) => {
          onCursorCommitted?.({ cursor: 42, changes: [] });
          return { kind: "refresh", outcome };
        });
        const reply = deferred<ShareViewInfo>();
        h.fetchInfo.mockReturnValueOnce(reply.promise);
        const refreshed = refresh(h);
        await vi.waitFor(() => expect(h.fetchInfo).toHaveBeenCalledOnce());
        return { h, reply, refreshed };
      }

      it("reads the level again on the next pull after it read View and a newer check found Edit", async () => {
        const { h, reply, refreshed } = await refreshing(view, true);
        h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
        await check(h);
        reply.resolve({ ...info, selector: view });
        await expect(refreshed).resolves.toMatchObject({ ok: true });
        expect(h.workspace.shareView).toMatchObject({
          grantedSelector: view,
          editingNotReady: true,
        });

        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        await refresh(h);
        expect(h.fetchInfo).toHaveBeenCalledTimes(2);
        expect(h.probeLog).not.toHaveBeenCalled();
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
        expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
      });

      it("does not bring the notice back after it read Edit and a newer check found View", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        for (const answer of [
          () => Promise.reject(new Error("store busy")),
          async () => ({ identity: "not-required" as const }),
        ]) {
          const { h, reply, refreshed } = await refreshing(view, false);
          h.recordIdentity.mockImplementation(answer);
          h.fetchAccess.mockResolvedValueOnce({ access: "view" });
          await check(h);
          reply.resolve({ ...info, selector: edit });
          await expect(refreshed).resolves.toMatchObject({ ok: true });
          expect(h.workspace.shareView!.grantedSelector).toEqual(view);
          expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
          expect(workspaceSummaryFor(h.workspace).shareView).not.toHaveProperty("editingNotReady");

          await refresh(h);
          expect(h.fetchInfo).toHaveBeenCalledTimes(2);
        }
      });

      it("does not lower the copy or drop its notice after it read View and a newer check found Edit", async () => {
        const { h, reply, refreshed } = await refreshing(comment, true);
        h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
        await check(h);
        reply.resolve({ ...info, selector: view });
        await expect(refreshed).resolves.toMatchObject({ ok: true });
        expect(h.narrow).not.toHaveBeenCalled();
        expect(h.workspace.shareView).toMatchObject({
          grantedSelector: comment,
          editingNotReady: true,
        });
      });

      it("does not lower the copy when the newer check answers while the lowering saves unsent work", async () => {
        const { h, reply, refreshed } = await refreshing(comment, true);
        h.narrow.mockImplementationOnce(async (_lease, _target, assertCurrent, commit) => {
          assertCurrent();
          h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
          await check(h);
          await commit(["docs/draft.md"], { paths: [], unchecked: false, checked: 0 });
        });
        reply.resolve({ ...info, selector: view });
        await expect(refreshed).resolves.toMatchObject({ ok: true });
        expect(h.narrow).toHaveBeenCalledOnce();
        expect(h.workspace.shareView!.grantedSelector).toEqual(comment);
        expect(h.workspace.shareView).not.toHaveProperty("unsavedPaths");

        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        await refresh(h);
        expect(h.fetchInfo).toHaveBeenCalledTimes(2);
      });

      it("does not raise a copy to Comment after a newer check answered", async () => {
        const { h, reply, refreshed } = await refreshing(view, false);
        h.fetchAccess.mockResolvedValueOnce({ access: "view" });
        await check(h);
        reply.resolve({ ...info, selector: comment });
        await expect(refreshed).resolves.toMatchObject({ ok: true });
        expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      });

      it("stops saying editing is not on once the identity is recorded, though a newer answer held the upgrade back, and turns editing on at the next pull", async () => {
        const { h, reply, refreshed } = await refreshing(view, true);
        const recording = deferred<{ identity: "recorded" }>();
        h.recordIdentity.mockReturnValueOnce(recording.promise);
        reply.resolve({ ...info, selector: edit });
        await vi.waitFor(() => expect(h.recordIdentity).toHaveBeenCalledOnce());
        h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
        await check(h);
        recording.resolve({ identity: "recorded" });
        await expect(refreshed).resolves.toMatchObject({ ok: true });
        expect(h.workspace.shareView!.grantedSelector).toEqual(view);
        expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");

        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        await refresh(h);
        expect(h.fetchInfo).toHaveBeenCalledTimes(2);
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
      });

      it("still takes a level read that no check overtook", async () => {
        const { h, reply, refreshed } = await refreshing(view, true);
        reply.resolve({ ...info, selector: view });
        await expect(refreshed).resolves.toMatchObject({ ok: true });
        expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
        await refresh(h);
        expect(h.fetchInfo).toHaveBeenCalledOnce();
        expect(h.probeLog).toHaveBeenCalledOnce();
      });
    });

    it("stops saying editing is not on when the relay states View", async () => {
      const h = await harness();
      h.workspace.shareView = {
        ...h.workspace.shareView!,
        grantedSelector: { ...view },
        editingNotReady: true,
      };
      h.fetchInfo.mockResolvedValue({ ...info, selector: view });
      await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
    });

    it.each([
      ["View", view],
      ["Comment", { ...view, access: "comment" as const }],
    ])("opens a share at %s as before, with no identity", async (_name, selector) => {
      const { h, opened, pinnedAtPull, open } = await opening(selector);
      const result = await open();
      expect(result).toMatchObject({ workspace: { shareView: { access: selector.access } } });
      expect(result.workspace.shareView).not.toHaveProperty("editingNotReady");
      expect(opened()).not.toHaveProperty("editingNotReady");
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(h.setView).toHaveBeenCalledOnce();
      expect(opened()?.grantedSelector).toEqual(selector);
      expect(pinnedAtPull).toEqual([selector]);
      expect(h.steps.filter((step) => step !== "preflight")).toEqual([
        "mkdir",
        "create",
        "register",
        "pin",
        "surfaces",
        "open",
        "notify",
      ]);
    });
  });

  it("holds refresh behind daemon startup and capture readiness before relay identity or reconciliation", async () => {
    const h = await harness();
    const bootStarted = deferred();
    const boot = deferred();
    h.startup.mockImplementation(() => {
      bootStarted.resolve();
      return boot.promise;
    });
    const statusStarted = deferred();
    const capture = deferred<WatcherStatusResult>();
    h.status.mockImplementation(() => {
      statusStarted.resolve();
      return capture.promise;
    });
    const result = h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    await bootStarted.promise;
    expect(h.storeFor).not.toHaveBeenCalled();
    boot.resolve();
    await statusStarted.promise;
    expect(h.fetchInfo).not.toHaveBeenCalled();
    expect(h.recordIdentity).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
    capture.resolve(ready);
    await expect(result).resolves.toEqual(outcome);
    expect(h.storeFor).toHaveBeenCalledWith({
      engineWorkspaceId: "existing",
      rootPath: h.workspace.rootPath,
      attachmentId: h.attachmentId,
    });
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
  });

  it.each(["renderer", "authority"] as const)(
    "stops refresh when its %s retires during capture readiness",
    async (kind) => {
      const h = await harness();
      const started = deferred();
      const held = deferred<WatcherStatusResult>();
      h.status.mockImplementation(() => {
        started.resolve();
        return held.promise;
      });
      const result = h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
      });
      await started.promise;
      let drained: Promise<void> | undefined;
      if (kind === "renderer") h.retireRenderer();
      else drained = h.authorities.invalidate("existing");
      held.resolve(ready);
      await expect(result).rejects.toThrow();
      await drained;
      expect(h.fetchInfo).not.toHaveBeenCalled();
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it("does not widen the pinned grant while updating the relay-derived chat fact", async () => {
    const h = await harness();
    const pinned = h.workspace.shareView!.grantedSelector;
    h.fetchInfo.mockResolvedValue({
      ...info,
      subjectName: "Renamed",
      sharerName: "Ana",
      selector: { paths: ["everything"], versionId: null, access: "edit" },
    });
    await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    expect(h.workspace.shareView!.grantedSelector).toBe(pinned);
    expect(h.workspace.shareView!.genericChatWritable).toBe(true);
    expect(h.workspace.shareView).toMatchObject({ subjectName: "Renamed", sharerName: "Ana" });
    expect(h.recordIdentity).toHaveBeenCalledWith({ grantedSelector: pinned, reach: null });
  });

  describe("a refresh after the owner changed this person's level", () => {
    const refresh = (h: Awaited<ReturnType<typeof harness>>, trigger?: "background" | "manual") =>
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
        ...(trigger ? { trigger } : {}),
      });
    const view = { paths: ["docs"], versionId: null, access: "view" as const };
    const edit = { paths: ["docs"], versionId: null, access: "edit" as const };
    async function pinnedAt(access: "view" | "edit") {
      const h = await harness();
      h.workspace.shareView!.grantedSelector = { ...view, access };
      const pinnedAtPull: unknown[] = [];
      h.reconcile.mockImplementation(async (_lease, _target, _request, onCursorCommitted) => {
        h.steps.push("reconcile");
        pinnedAtPull.push(h.registry.get("existing")!.shareView!.grantedSelector);
        onCursorCommitted?.({ cursor: 42, changes: [] });
        return { kind: "refresh", outcome };
      });
      return { h, pinnedAtPull };
    }

    it.each(["background", "manual"] as const)(
      "lets a %s refresh edit after an upgrade: the pin and the pull take Edit, and the identity is recorded",
      async (trigger) => {
        const { h, pinnedAtPull } = await pinnedAt("view");
        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        await expect(refresh(h, trigger)).resolves.toMatchObject({ ok: true });
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
        expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
          grantedSelector: edit,
          reach: null,
        });
        expect(pinnedAtPull).toEqual([edit]);
        expect(h.steps.indexOf("identity")).toBeLessThan(h.steps.indexOf("reconcile"));
        expect(h.narrow).not.toHaveBeenCalled();
        expect(h.surfaces).toHaveBeenCalledOnce();
        expect(h.notify).toHaveBeenLastCalledWith({
          workspaceId: "existing",
          summaryChanged: true,
        });
        expect(() => requireShareViewProposalScope(h.workspace.shareView)).not.toThrow();
      },
    );

    it("stops offering edits after a downgrade: the pin and the pull take View, and what was not sent is kept", async () => {
      const { h, pinnedAtPull } = await pinnedAt("edit");
      h.fetchInfo.mockResolvedValue({ ...info, selector: view });
      h.narrow.mockImplementationOnce(async (_lease, _target, assertCurrent, commit) => {
        assertCurrent();
        await commit(["docs/draft.md"], { paths: ["docs/sent.md"], unchecked: false, checked: 1 });
      });
      expect(() => requireShareViewProposalScope(h.workspace.shareView)).not.toThrow();
      await expect(refresh(h)).resolves.toMatchObject({ ok: true });
      expect(h.narrow).toHaveBeenCalledOnce();
      expect(h.workspace.shareView).toMatchObject({
        grantedSelector: view,
        unsavedPaths: ["docs/draft.md"],
        unconfirmedChanges: { paths: ["docs/sent.md"], unchecked: false, checked: 1 },
      });
      expect(pinnedAtPull).toEqual([view]);
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(h.surfaces).toHaveBeenCalledOnce();
      expect(h.notify).toHaveBeenLastCalledWith({ workspaceId: "existing", summaryChanged: true });
      expect(() => requireShareViewProposalScope(h.workspace.shareView)).toThrow();
      expect(workspaceSummaryFor(h.workspace).shareView?.access).toBe("view");
    });

    it.each([
      ["other paths", { paths: ["everything"], versionId: null, access: "edit" as const }],
      ["more paths", { paths: ["docs", "plans"], versionId: null, access: "edit" as const }],
      ["a version", { paths: ["docs"], versionId: "saved-version", access: "edit" as const }],
      ["a chat", null],
    ])("keeps a pin at View when the server states %s for the share", async (_name, selector) => {
      const { h, pinnedAtPull } = await pinnedAt("view");
      const pinned = h.workspace.shareView!.grantedSelector;
      h.fetchInfo.mockResolvedValue({ ...info, selector });
      await expect(refresh(h)).resolves.toMatchObject({ ok: true });
      expect(h.workspace.shareView!.grantedSelector).toBe(pinned);
      expect(pinnedAtPull).toEqual([view]);
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(h.surfaces).not.toHaveBeenCalled();
    });

    it.each([
      ["fails", new Error("offline"), false],
      ["cannot be read", new ShareSelectorInvalidError("share"), false],
      ["says the share ended", new ShareUnavailableError(), true],
    ])("keeps the pin when the read %s", async (_name, error, pulls) => {
      for (const access of ["view", "edit"] as const) {
        const { h, pinnedAtPull } = await pinnedAt(access);
        const pinned = h.workspace.shareView!.grantedSelector;
        h.fetchInfo.mockRejectedValue(error);
        if (pulls) await expect(refresh(h)).resolves.toMatchObject({ ok: true });
        else await expect(refresh(h)).rejects.toThrow();
        expect(h.workspace.shareView!.grantedSelector).toBe(pinned);
        expect(h.setView).not.toHaveBeenCalled();
        expect(h.narrow).not.toHaveBeenCalled();
        expect(pinnedAtPull).toEqual(pulls ? [{ ...view, access }] : []);
      }
    });

    it("keeps the pin of a share that ended on this computer", async () => {
      const { h } = await pinnedAt("view");
      h.workspace.shareView!.ended = true;
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      await refresh(h);
      expect(h.fetchInfo).not.toHaveBeenCalled();
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
    });

    it("keeps the pin when the share ends while the read is out", async () => {
      const { h } = await pinnedAt("view");
      const response = deferred<ShareViewInfo>();
      h.fetchInfo.mockReturnValueOnce(response.promise);
      const refreshed = refresh(h);
      await vi.waitFor(() => expect(h.fetchInfo).toHaveBeenCalledOnce());
      h.workspace.shareView!.ended = true;
      response.resolve({ ...info, selector: edit });
      await refreshed;
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      expect(h.recordIdentity).not.toHaveBeenCalled();
    });

    it.each(["background", "manual"] as const)(
      "keeps the pin on a %s refresh while another account is signed in",
      async (trigger) => {
        const { h } = await pinnedAt("view");
        h.workspace.shareView!.recipientUserId = "someone-else";
        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        await refresh(h, trigger);
        expect(h.fetchInfo).not.toHaveBeenCalled();
        expect(h.workspace.shareView!.grantedSelector).toEqual(view);
        expect(h.recordIdentity).not.toHaveBeenCalled();
      },
    );

    it("does not take an upgrade that a newer access answer came after, and takes it on the next refresh", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      const recording = deferred<{ identity: "recorded" }>();
      h.recordIdentity.mockReturnValueOnce(recording.promise);
      const refreshed = refresh(h);
      await vi.waitFor(() => expect(h.recordIdentity).toHaveBeenCalledOnce());
      h.fetchAccess.mockResolvedValueOnce({ access: "view" });
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      });
      recording.resolve({ identity: "recorded" });
      await refreshed;
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      expect(() => requireShareViewProposalScope(h.workspace.shareView)).toThrow();

      await refresh(h);
      expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
    });

    it("does not take an upgrade once the relay has said the share is gone, before the copy is ended", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      const recording = deferred<{ identity: "recorded" }>();
      h.recordIdentity.mockReturnValueOnce(recording.promise);
      const ending = deferred<void>();
      h.end.mockImplementationOnce(async () => ending.promise);
      const refreshed = refresh(h);
      await vi.waitFor(() => expect(h.recordIdentity).toHaveBeenCalledOnce());
      h.fetchAccess.mockRejectedValueOnce(new ShareUnavailableError());
      const checked = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      });
      await vi.waitFor(() => expect(h.end).toHaveBeenCalledOnce());
      recording.resolve({ identity: "recorded" });
      await refreshed;
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      ending.resolve();
      await checked;
    });

    it("gives the level read a time limit", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: view });
      await refresh(h);
      expect(h.fetchInfo).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("does not take an upgrade from a reply that an access answer overtook", async () => {
      const { h } = await pinnedAt("view");
      const response = deferred<ShareViewInfo>();
      h.fetchInfo.mockReturnValueOnce(response.promise);
      const refreshed = refresh(h);
      await vi.waitFor(() => expect(h.fetchInfo).toHaveBeenCalledOnce());
      h.fetchAccess.mockResolvedValueOnce({ access: "view" });
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      });
      response.resolve({ ...info, selector: edit });
      await refreshed;
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      expect(() => requireShareViewProposalScope(h.workspace.shareView)).toThrow();
    });

    it("still says a collision record was set aside when editing could not be turned on", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { h } = await pinnedAt("view");
      h.reconcile.mockResolvedValue({
        kind: "refresh",
        outcome: { ...outcome, collisionRecordQuarantined: true },
      });
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      h.recordIdentity.mockRejectedValueOnce(new Error("store busy"));
      await expect(refresh(h)).resolves.toMatchObject({
        ok: false,
        errorMessage:
          "dohc could not turn on editing for this share. Choose Refresh, or return to this window, to try again.",
        collisionRecordQuarantined: true,
      });
    });

    it("reads the level once for an open window, and not again on its background pulls", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      await refresh(h, "background");
      await refresh(h, "background");
      h.probeLog.mockResolvedValue({ unchanged: false });
      await refresh(h, "background");
      expect(h.fetchInfo).toHaveBeenCalledOnce();
      expect(h.reconcile).toHaveBeenCalledTimes(2);
    });

    it("does not narrow twice when the access check narrowed first", async () => {
      const { h } = await pinnedAt("edit");
      const response = deferred<ShareViewInfo>();
      h.fetchInfo.mockReturnValueOnce(response.promise);
      const refreshed = refresh(h);
      await vi.waitFor(() => expect(h.fetchInfo).toHaveBeenCalledOnce());
      h.fetchAccess.mockResolvedValueOnce({ access: "view" });
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      });
      response.resolve({ ...info, selector: view });
      await refreshed;
      expect(h.narrow).toHaveBeenCalledOnce();
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
    });

    it("keeps what the first narrowing saved when the access check narrows during the refresh's own", async () => {
      const { h } = await pinnedAt("edit");
      h.fetchInfo.mockResolvedValue({ ...info, selector: view });
      const capturing = deferred<void>();
      const release = deferred<void>();
      h.narrow.mockImplementationOnce(async (_lease, _target, _assertCurrent, commit) => {
        capturing.resolve();
        await release.promise;
        await commit([], { paths: [], unchecked: false, checked: 0 });
      });
      h.narrow.mockImplementationOnce(async (_lease, _target, _assertCurrent, commit) => {
        await commit(["docs/draft.md"], { paths: ["docs/sent.md"], unchecked: false, checked: 1 });
      });
      const refreshed = refresh(h);
      await capturing.promise;
      h.fetchAccess.mockResolvedValueOnce({ access: "view" });
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      });
      release.resolve();
      await refreshed;
      expect(h.narrow).toHaveBeenCalledTimes(2);
      expect(h.workspace.shareView).toMatchObject({
        grantedSelector: view,
        unsavedPaths: ["docs/draft.md"],
        unconfirmedChanges: { paths: ["docs/sent.md"], unchecked: false, checked: 1 },
      });
    });

    describe("a copy already at Edit whose identity is not recorded", () => {
      it.each(["background", "manual"] as const)(
        "narrows to View on a %s refresh when the record throws, keeps unsent work, says so, and the next refresh turns editing back on",
        async (trigger) => {
          vi.spyOn(console, "error").mockImplementation(() => undefined);
          const { h, pinnedAtPull } = await pinnedAt("edit");
          h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
          h.recordIdentity.mockRejectedValueOnce(new Error("store busy"));
          h.narrow.mockImplementationOnce(async (_lease, _target, assertCurrent, commit) => {
            assertCurrent();
            await commit(["docs/draft.md"], {
              paths: ["docs/sent.md"],
              unchecked: false,
              checked: 1,
            });
          });
          await expect(refresh(h, trigger)).resolves.toEqual({
            ok: false,
            errorKind: "transient",
            changedPaths: outcome.changedPaths,
            errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
            editingNotReady: true,
          });
          expect(h.narrow).toHaveBeenCalledOnce();
          expect(h.workspace.shareView).toMatchObject({
            grantedSelector: view,
            editingNotReady: true,
            unsavedPaths: ["docs/draft.md"],
            unconfirmedChanges: { paths: ["docs/sent.md"], unchecked: false, checked: 1 },
          });
          expect(pinnedAtPull).toEqual([view]);
          expect(h.surfaces).toHaveBeenCalledOnce();
          expect(() => requireShareViewProposalScope(h.workspace.shareView)).toThrow();

          await expect(refresh(h, "background")).resolves.toMatchObject({ ok: true });
          expect(h.fetchInfo).toHaveBeenCalledTimes(2);
          expect(h.recordIdentity).toHaveBeenLastCalledWith({ grantedSelector: edit, reach: null });
          expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
          expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
          expect(h.workspace.shareView!.unsavedPaths).toEqual(["docs/draft.md"]);
          expect(pinnedAtPull).toEqual([view, edit]);
          expect(() => requireShareViewProposalScope(h.workspace.shareView)).not.toThrow();
        },
      );

      it.each([
        [
          "another account is signed in",
          (h: Awaited<ReturnType<typeof harness>>) =>
            h.cache.set({ ...credentials, userId: "someone-else" }),
          false,
          // The refresh is refused before it asks the server anything.
          false,
        ],
        [
          "nobody is signed in",
          (h: Awaited<ReturnType<typeof harness>>) => h.cache.clear(),
          false,
          true,
        ],
        [
          "the engine answers that it recorded no identity",
          (h: Awaited<ReturnType<typeof harness>>) =>
            h.recordIdentity.mockResolvedValue({ identity: "not-required" }),
          true,
          true,
        ],
      ])("keeps Edit when the record is not made because %s", async (_name, arrange, asked, ok) => {
        const { h } = await pinnedAt("edit");
        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        arrange(h);
        await expect(refresh(h, "manual")).resolves.toMatchObject({ ok });
        if (asked)
          expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
            grantedSelector: edit,
            reach: null,
          });
        else expect(h.recordIdentity).not.toHaveBeenCalled();
        expect(h.narrow).not.toHaveBeenCalled();
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
        expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");
      });

      it("keeps Edit when the identity is already recorded", async () => {
        const { h } = await pinnedAt("edit");
        h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
        h.recordIdentity.mockResolvedValue({ identity: "already-recorded" });
        await expect(refresh(h, "manual")).resolves.toMatchObject({ ok: true });
        expect(h.narrow).not.toHaveBeenCalled();
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
      });
    });

    it("records the identity while the pin is still View, and only then offers editing", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      const pinnedAtIdentity: unknown[] = [];
      h.recordIdentity.mockImplementation(async () => {
        pinnedAtIdentity.push(h.registry.get("existing")!.shareView!.grantedSelector);
        expect(() => requireShareViewProposalScope(h.workspace.shareView)).toThrow();
        return { identity: "recorded" };
      });
      await expect(refresh(h)).resolves.toMatchObject({ ok: true });
      expect(pinnedAtIdentity).toEqual([view]);
      expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
    });

    it.each(["background", "manual"] as const)(
      "keeps the pin on a %s refresh when the identity cannot be recorded, says so, and tries again next time",
      async (trigger) => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { h, pinnedAtPull } = await pinnedAt("view");
        h.fetchInfo.mockResolvedValue({ ...info, selector: edit, subjectName: "Renamed" });
        h.recordIdentity.mockRejectedValueOnce(new Error("store busy"));
        await expect(refresh(h, trigger)).resolves.toEqual({
          ok: false,
          errorKind: "transient",
          changedPaths: outcome.changedPaths,
          errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
          editingNotReady: true,
        });
        expect(h.workspace.shareView).toMatchObject({
          grantedSelector: view,
          editingNotReady: true,
          subjectName: "Renamed",
        });
        expect(pinnedAtPull).toEqual([view]);
        expect(() => requireShareViewProposalScope(h.workspace.shareView)).toThrow();
        expect(h.surfaces).not.toHaveBeenCalled();
        expect(h.recordIdentity).toHaveBeenCalledExactlyOnceWith({
          grantedSelector: edit,
          reach: null,
        });

        await expect(refresh(h, "background")).resolves.toMatchObject({ ok: true });
        expect(h.fetchInfo).toHaveBeenCalledTimes(2);
        expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
        expect(pinnedAtPull).toEqual([view, edit]);
        expect(() => requireShareViewProposalScope(h.workspace.shareView)).not.toThrow();
      },
    );

    it("says editing is not on when the relay states Edit and the record is not made without an error, and reads the level again on every pull until it is", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      h.recordIdentity.mockResolvedValue({ identity: "not-required" });
      await expect(refresh(h, "background")).resolves.toEqual({
        ok: false,
        errorKind: "transient",
        changedPaths: outcome.changedPaths,
        errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
        editingNotReady: true,
      });
      expect(h.workspace.shareView).toMatchObject({ grantedSelector: view, editingNotReady: true });
      expect(workspaceSummaryFor(h.workspace).shareView?.editingNotReady).toBe(true);

      await refresh(h, "background");
      expect(h.fetchInfo).toHaveBeenCalledTimes(2);
      expect(h.probeLog).not.toHaveBeenCalled();
      expect(h.workspace.shareView).toMatchObject({ grantedSelector: view, editingNotReady: true });

      h.recordIdentity.mockResolvedValue({ identity: "recorded" });
      await expect(refresh(h, "background")).resolves.toMatchObject({ ok: true });
      expect(h.fetchInfo).toHaveBeenCalledTimes(3);
      expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
      expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");

      await refresh(h, "background");
      expect(h.fetchInfo).toHaveBeenCalledTimes(3);
      expect(h.probeLog).toHaveBeenCalledOnce();
    });

    it("reads the level again on the next background pull when a newer access answer held the upgrade back, and says nothing meanwhile", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      const recording = deferred<{ identity: "recorded" }>();
      h.recordIdentity.mockReturnValueOnce(recording.promise);
      const refreshed = refresh(h, "background");
      await vi.waitFor(() => expect(h.recordIdentity).toHaveBeenCalledOnce());
      h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      });
      recording.resolve({ identity: "recorded" });
      await expect(refreshed).resolves.toMatchObject({ ok: true });
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
      expect(h.workspace.shareView).not.toHaveProperty("editingNotReady");

      await refresh(h, "background");
      expect(h.fetchInfo).toHaveBeenCalledTimes(2);
      expect(h.workspace.shareView!.grantedSelector).toEqual(edit);
    });

    it("keeps the pin when the share ends while the identity is recorded", async () => {
      const { h } = await pinnedAt("view");
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit });
      h.recordIdentity.mockImplementation(async () => {
        h.workspace.shareView!.ended = true;
        return { identity: "recorded" };
      });
      await refresh(h);
      expect(h.workspace.shareView!.grantedSelector).toEqual(view);
    });

    it("takes Comment without an identity", async () => {
      const { h } = await pinnedAt("view");
      const comment = { ...view, access: "comment" as const };
      h.fetchInfo.mockResolvedValue({ ...info, selector: comment });
      await expect(refresh(h)).resolves.toMatchObject({ ok: true });
      expect(h.workspace.shareView!.grantedSelector).toEqual(comment);
      expect(h.recordIdentity).not.toHaveBeenCalled();
    });

    it.each([
      ["omits its share id", { statedShareId: undefined }],
      ["names another share", { statedShareId: "another-share" }],
    ])("changes no level when the reply %s, and still takes its labels", async (_name, reply) => {
      for (const [pinned, stated] of [
        ["view", edit],
        ["edit", view],
      ] as const) {
        const { h, pinnedAtPull } = await pinnedAt(pinned);
        h.fetchInfo.mockResolvedValue({
          ...info,
          ...reply,
          selector: stated,
          subjectName: "Renamed",
        });
        await expect(refresh(h)).resolves.toMatchObject({ ok: true });
        expect(h.workspace.shareView).toMatchObject({
          grantedSelector: { ...view, access: pinned },
          subjectName: "Renamed",
        });
        expect(pinnedAtPull).toEqual([{ ...view, access: pinned }]);
        expect(h.narrow).not.toHaveBeenCalled();
        expect(h.surfaces).not.toHaveBeenCalled();
      }
    });

    it("changes no level for a copy that does not record which server it came from", async () => {
      const { h } = await pinnedAt("view");
      delete h.workspace.shareView!.relayUrl;
      h.fetchInfo.mockResolvedValue({ ...info, selector: edit, subjectName: "Renamed" });
      await refresh(h);
      expect(h.fetchInfo).toHaveBeenCalledOnce();
      expect(h.workspace.shareView).toMatchObject({
        grantedSelector: view,
        subjectName: "Renamed",
      });
      expect(h.recordIdentity).not.toHaveBeenCalled();
    });
  });

  it("fills the sharer's email on refresh for a share reopened after Forget", async () => {
    const h = await harness();
    Object.assign(h.workspace.shareView!, {
      granterEmail: null,
      subjectName: null,
      sharerName: null,
      unsavedPaths: null,
    });
    await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    expect(h.workspace.shareView).toMatchObject({
      granterEmail: info.granterEmail,
      grantedSelector: info.selector,
      unsavedPaths: null,
    });
  });

  it("keeps the sharer's email on refresh when the server sends a different one", async () => {
    const h = await harness();
    h.fetchInfo.mockResolvedValue({ ...info, granterEmail: "other@example.test" });
    await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    expect(h.fetchInfo).toHaveBeenCalled();
    expect(h.workspace.shareView!.granterEmail).toBe(info.granterEmail);
  });

  it.each(["background", "manual"] as const)(
    "asks the server nothing on a %s refresh while another account is signed in",
    async (trigger) => {
      const h = await harness();
      Object.assign(h.workspace.shareView!, {
        recipientUserId: "someone-else",
        granterEmail: null,
        unsavedPaths: null,
      });
      const result = await h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
        workspaceId: "existing",
        trigger,
      });
      // Neither refresh reaches the reconcile, which would capture disk edits.
      expect(result).toMatchObject({ ok: false, errorKind: "unauthorized" });
      expect(h.storeFor).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.fetchInfo).not.toHaveBeenCalled();
      expect(h.recordIdentity).not.toHaveBeenCalled();
      expect(h.setView).not.toHaveBeenCalled();
      expect(h.workspace.shareView!.granterEmail).toBeNull();
      expect(workspaceWriteRefusal(h.workspace.shareView)).toContain("This is a shared view");
    },
  );

  it("rejects stale metadata before writing the grant or starting file reconciliation", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred<ShareViewInfo>();
    h.fetchInfo.mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const result = h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    await started.promise;
    h.retireRenderer();
    held.resolve(info);
    await expect(result).rejects.toThrow();
    expect(h.setView).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("refuses a refresh signed in on another relay before metadata, edit identity and the local refresh", async () => {
    const h = await harness();
    h.cache.set({ ...credentials, relayUrl: "https://other.example.test" });
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).resolves.toMatchObject({ ok: false, errorKind: "unauthorized" });
    expect(h.fetchInfo).not.toHaveBeenCalled();
    expect(h.recordIdentity).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("keeps the local refresh path while signed out", async () => {
    const h = await harness();
    h.cache.clear();
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).resolves.toEqual(outcome);
    expect(h.fetchInfo).not.toHaveBeenCalled();
    expect(h.reconcile).toHaveBeenCalledOnce();
  });

  it("does not notify a successor workspace after a held refresh settles", async () => {
    const h = await harness();
    const started = deferred();
    const held = deferred<Awaited<ReturnType<typeof h.reconcile>>>();
    h.reconcile.mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const result = h.invoke(sharedViewAccessOperations.refreshSharedView.channel, {
      workspaceId: "existing",
    });
    await started.promise;
    h.retireRenderer();
    held.resolve({ kind: "refresh", outcome });
    await expect(result).rejects.toThrow("changed workspaces");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("records a store refusal that needs an update on the workspace status", async () => {
    const h = await harness();
    const refusal = (message: string) =>
      Object.assign(new Error(message), { wireError: { code: "INTERNAL", message, retry: "no" } });
    h.status.mockRejectedValueOnce(
      refusal("migrated-by-newer-build: a newer build ran migration 5 (next)"),
    );
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).rejects.toThrow("migrated-by-newer-build");
    expect(h.recordRefusal).toHaveBeenCalledWith(
      "existing",
      "migrated-by-newer-build",
      "a newer build ran migration 5 (next)",
    );
    expect(h.reconcile).not.toHaveBeenCalled();

    h.recordRefusal.mockClear();
    h.status.mockRejectedValueOnce(refusal("foreign-database"));
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).rejects.toThrow("foreign-database");
    expect(h.recordRefusal).not.toHaveBeenCalled();

    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).resolves.toEqual(outcome);
    expect(h.recordRefusal).toHaveBeenCalledWith("existing", null, null);
  });

  it("notifies about partial pull work and preserves damaged-pin and ended outcomes", async () => {
    const h = await harness();
    h.reconcile.mockResolvedValue({
      kind: "refresh",
      outcome: { ok: false, changedPaths: 3, errorMessage: "later page failed" },
    });
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).resolves.toEqual({ ok: false, changedPaths: 3, errorMessage: "later page failed" });
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
    h.notify.mockClear();
    h.reconcile.mockRejectedValue(new SharePinInvalidError("share"));
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).rejects.toThrow("Remove it, then open");
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing" });
    h.reconcile.mockResolvedValue({ kind: "refresh", outcome: { ...outcome, status: "ended" } });
    await expect(
      h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }),
    ).resolves.toMatchObject({ status: "ended" });
    expect(h.surfaces).toHaveBeenCalled();
  });
});

describe("background share pulls", () => {
  const channel = sharedViewAccessOperations.refreshSharedView.channel;
  const payload = { workspaceId: "existing", trigger: "background" };
  async function primed() {
    const h = await harness();
    await h.invoke(channel, { workspaceId: "existing" });
    vi.clearAllMocks();
    return h;
  }
  function noLocalWork(h: Awaited<ReturnType<typeof harness>>) {
    expect(h.workspaceOperation).not.toHaveBeenCalled();
    expect(h.registryRead).not.toHaveBeenCalled();
    for (const mock of [
      h.startup,
      h.relayFor,
      h.storeFor,
      h.status,
      h.reconcile,
      h.fetchInfo,
      h.recordIdentity,
      h.notify,
      h.setView,
      h.recordRefusal,
      h.surfaces,
      h.syncNotices,
    ])
      expect(mock).not.toHaveBeenCalled();
  }
  it("uses one authenticated log request and no engine, registry, file or event work when unchanged", async () => {
    const h = await primed();
    const reads = vi.spyOn(h.registry, "get");
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ops: [], hasMore: false, nextCursor: 42 }),
    );
    h.probeLog.mockImplementation((input) =>
      probeShareViewLog({ ...input, relay: { ...input.relay, fetch } }),
    );
    const result = await h.invoke(channel, payload);
    expect(result).toMatchObject({ ok: true, status: "unchanged", probed: true });
    expect(result).not.toHaveProperty("nextCursor");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&level=edit",
      expect.objectContaining({ headers: expect.any(Headers), signal: expect.any(AbortSignal) }),
    );
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer token");
    expect(reads).not.toHaveBeenCalled();
    noLocalWork(h);
  });
  it("holds a membership's pull at the relay and says when its level changed", async () => {
    const h = await primed();
    const bodies = [
      { ops: [], hasMore: false, nextCursor: 42 },
      { ops: [], hasMore: false, nextCursor: 42, levelChanged: true },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(bodies.shift()));
    h.probeLog.mockImplementation((input) =>
      probeShareViewLog({ ...input, relay: { ...input.relay, fetch } }),
    );
    await expect(h.invoke(channel, { ...payload, trigger: "held" })).resolves.toMatchObject({
      ok: true,
      status: "unchanged",
      probed: true,
      held: true,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&hold=25000&level=edit",
      expect.anything(),
    );
    const changed = await h.invoke(channel, { ...payload, trigger: "held" });
    expect(changed).toMatchObject({
      ok: true,
      status: "unchanged",
      probed: true,
      held: true,
      levelChanged: true,
    });
    noLocalWork(h);
    // A plain background pull neither holds nor asks to be held again.
    bodies.push({ ops: [], hasMore: false, nextCursor: 42 });
    const plain = await h.invoke(channel, payload);
    expect(plain).not.toHaveProperty("held");
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page",
      expect.anything(),
    );
  });
  // A level change that lands between holds: the next hold names the level
  // this computer knows, and the relay answers at once when its own differs.
  it("names the level a membership knows in its held pull, once until the access check moves it", async () => {
    const h = await harness();
    h.workspace.shareView!.grantedSelector = {
      paths: [],
      versionId: null,
      access: "comment",
      wholeWorkspace: true,
    };
    h.fetchInfo.mockResolvedValue({
      ...info,
      selector: { paths: [], versionId: null, access: "comment", wholeWorkspace: true },
    });
    await h.invoke(channel, { workspaceId: "existing" });
    vi.clearAllMocks();
    const bodies = [
      { ops: [], hasMore: false, nextCursor: 42, levelChanged: true },
      { ops: [], hasMore: false, nextCursor: 42 },
      { ops: [], hasMore: false, nextCursor: 42 },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(bodies.shift()));
    h.probeLog.mockImplementation((input) =>
      probeShareViewLog({ ...input, relay: { ...input.relay, fetch } }),
    );
    const held = { ...payload, trigger: "held" };
    await expect(h.invoke(channel, held)).resolves.toMatchObject({ levelChanged: true });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&hold=25000&level=comment",
      expect.anything(),
    );
    // Answered once: the next hold names no level, so a stale one cannot loop,
    // even when checkSharedViewAccess answers unverified while waiting for a rebuild.
    h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
    h.fetchReach.mockResolvedValueOnce({
      signature: "r2",
      visibilitySignature: "v2",
      rootLevel: "edit",
      groupDefault: "edit",
      groups: [],
      folders: [],
    });
    h.workspace.shareView!.reach = {
      signature: "r1",
      visibilitySignature: "v1",
      rootLevel: "comment",
      groupDefault: "comment",
      groups: [],
      folders: [],
    };
    await expect(
      h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      }),
    ).resolves.toEqual({ status: "unverified" });
    await h.invoke(channel, held);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&hold=25000",
      expect.anything(),
    );
    delete h.workspace.shareView!.reach;
    h.fetchAccess.mockResolvedValue({ access: "edit" });
    await expect(
      h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      }),
    ).resolves.toMatchObject({ status: "current", access: "edit" });
    await h.invoke(channel, held);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&hold=25000&level=edit",
      expect.anything(),
    );
  });
  it("tracks a path share's level across View to Edit recovery, scope refusal, and transient unverified checks", async () => {
    const h = await harness();
    h.workspace.shareView!.grantedSelector = { paths: ["docs"], versionId: null, access: "view" };
    h.fetchInfo.mockResolvedValue({
      ...info,
      selector: { paths: ["docs"], versionId: null, access: "view" },
    });
    await h.invoke(channel, { workspaceId: "existing" });
    vi.clearAllMocks();

    const bodies = [
      { ops: [], hasMore: false, nextCursor: 42, levelChanged: true },
      { ops: [], hasMore: false, nextCursor: 42, levelChanged: true },
      { ops: [], hasMore: false, nextCursor: 42 },
      { ops: [], hasMore: false, nextCursor: 42 },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(bodies.shift()));
    h.probeLog.mockImplementation((input) =>
      probeShareViewLog({ ...input, relay: { ...input.relay, fetch } }),
    );

    await expect(h.invoke(channel, payload)).resolves.toMatchObject({
      probed: true,
      levelChanged: true,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&level=view",
      expect.anything(),
    );

    // Transient unverified check restores the pending level so the next background poll still checks it.
    h.fetchAccess.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      }),
    ).resolves.toEqual({ status: "unverified" });

    await expect(h.invoke(channel, payload)).resolves.toMatchObject({
      probed: true,
      levelChanged: true,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&level=view",
      expect.anything(),
    );

    // Verified relayStatesMore clears the cached level so polling does not spin while manual refresh runs.
    h.fetchAccess.mockResolvedValueOnce({ access: "edit" });
    await expect(
      h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, {
        workspaceId: "existing",
      }),
    ).resolves.toEqual({ status: "current", access: "view", relayStatesMore: true });

    await h.invoke(channel, payload);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page",
      expect.anything(),
    );

    // A manual refresh that widens the path share caches the post-refresh Edit level.
    h.fetchInfo.mockResolvedValueOnce({
      ...info,
      selector: { paths: ["docs"], versionId: null, access: "edit" },
    });
    await h.invoke(channel, { workspaceId: "existing", trigger: "manual" });
    expect(h.workspace.shareView!.grantedSelector.access).toBe("edit");
    await h.invoke(channel, payload);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page&level=edit",
      expect.anything(),
    );

    // When a manual refresh refuses to widen (scope mismatch), the cached pull omits level so it never loops.
    h.workspace.shareView!.grantedSelector = { paths: ["docs"], versionId: null, access: "view" };
    h.fetchInfo.mockResolvedValueOnce({
      ...info,
      selector: { paths: ["docs", "other"], versionId: null, access: "edit" },
    });
    await h.invoke(channel, { workspaceId: "existing", trigger: "manual" });
    expect(h.workspace.shareView!.grantedSelector.access).toBe("view");
    bodies.push({ ops: [], hasMore: false, nextCursor: 42 });
    await h.invoke(channel, payload);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://relay.example.test/sync/shares/share/log?since=42&scan=page",
      expect.anything(),
    );

    // When a background probe carries both new ops and levelChanged, run the full refresh (info + reconcile).
    h.workspace.shareView!.grantedSelector = { paths: ["docs"], versionId: null, access: "edit" };
    h.fetchInfo.mockResolvedValueOnce({
      ...info,
      selector: { paths: ["docs"], versionId: null, access: "edit" },
    });
    await h.invoke(channel, { workspaceId: "existing", trigger: "manual" });
    vi.clearAllMocks();
    bodies.push({
      ops: [{ seq: 43 }],
      hasMore: false,
      nextCursor: 43,
      levelChanged: true,
    } as never);
    h.fetchInfo.mockResolvedValueOnce({
      ...info,
      selector: { paths: ["docs"], versionId: null, access: "view" },
    });
    await expect(h.invoke(channel, payload)).resolves.toMatchObject({
      ok: true,
      status: "updated",
    });
    expect(h.fetchInfo).toHaveBeenCalledOnce();
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.workspace.shareView!.grantedSelector.access).toBe("view");
  });
  it("asks for the next held pull after a held pull brought changes", async () => {
    const h = await primed();
    h.probeLog.mockResolvedValue({ unchanged: false });
    await expect(h.invoke(channel, { ...payload, trigger: "held" })).resolves.toMatchObject({
      ok: true,
      status: "updated",
      held: true,
    });
    expect(h.reconcile).toHaveBeenCalledOnce();
  });
  it("runs the full path once for new ops, keeps its committed cursor and skips metadata and identity", async () => {
    const h = await primed();
    h.probeLog.mockResolvedValue({ unchanged: false });
    h.reconcile.mockImplementation(async (_lease, _target, _request, onPullCommitted) => {
      onPullCommitted?.({ cursor: 57, changes: [] });
      return { kind: "refresh", outcome };
    });
    const result = await h.invoke(channel, payload);
    expect(result).toMatchObject({ ok: true, status: "updated" });
    expect(result).not.toHaveProperty("nextCursor");
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.status).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.fetchInfo).not.toHaveBeenCalled();
    expect(h.recordIdentity).not.toHaveBeenCalled();
    h.probeLog.mockResolvedValue({ unchanged: true });
    await h.invoke(channel, payload);
    expect(h.probeLog).toHaveBeenLastCalledWith(expect.objectContaining({ since: 57 }));
    expect(h.reconcile).toHaveBeenCalledOnce();
  });
  it("says when every change a pull wrote is to a document its live session already shows", async () => {
    const h = await primed();
    h.probeLog.mockResolvedValue({ unchanged: false });
    h.showsLive.mockImplementation(
      (attachmentId, path) => attachmentId === h.attachmentId && path === "docs/plan.md",
    );
    const pulled = (
      changedPaths: number,
      changes: { path: string; operation: "write" | "delete" }[],
    ) =>
      h.reconcile.mockImplementation(async (_lease, _target, _request, onPullCommitted) => {
        onPullCommitted?.({ cursor: 57, changes });
        return { kind: "refresh", outcome: { ...outcome, changedPaths } };
      });
    pulled(1, [{ path: "docs/plan.md", operation: "write" }]);
    await expect(h.invoke(channel, { ...payload, trigger: "held" })).resolves.toMatchObject({
      ok: true,
      status: "updated",
      held: true,
      shownLive: true,
    });
    // Another file, a delete, or a local change the capture found still repaints.
    for (const [changedPaths, changes] of [
      [
        2,
        [
          { path: "docs/plan.md", operation: "write" },
          { path: "docs/other.md", operation: "write" },
        ],
      ],
      [1, [{ path: "docs/plan.md", operation: "delete" }]],
      [2, [{ path: "docs/plan.md", operation: "write" }]],
    ] as const) {
      pulled(changedPaths, [...changes]);
      expect(await h.invoke(channel, payload)).not.toHaveProperty("shownLive");
    }
  });
  it.each(["manual", "background"] as const)(
    "syncs Notices after a changed %s pull commits",
    async (trigger) => {
      const h = await primed();
      h.probeLog.mockResolvedValue({ unchanged: false });
      h.syncNotices.mockImplementation(async (isCurrent) => {
        expect(isCurrent()).toBe(true);
        expect(h.reconcile).toHaveBeenCalledOnce();
      });
      await h.invoke(channel, { ...payload, trigger });
      expect(h.syncNotices).toHaveBeenCalledOnce();
      expect(h.notify).toHaveBeenLastCalledWith({ workspaceId: "existing" });
    },
  );
  it("publishes a changed summary without claiming file changes", async () => {
    const h = await primed();
    h.probeLog.mockResolvedValue({ unchanged: false });
    h.reconcile.mockImplementation(async () => {
      h.workspace.shareView!.unsavedPaths = ["docs/local.md"];
      return {
        kind: "refresh",
        outcome: { ...outcome, status: "unchanged", changedPaths: 0, refusedOps: 0 },
      };
    });
    await h.invoke(channel, payload);
    expect(h.notify).toHaveBeenLastCalledWith({ workspaceId: "existing", summaryChanged: true });
    expect(h.syncNotices).toHaveBeenCalledOnce();
  });
  it("syncs content-neutral journal changes but leaves an unchanged manual pull alone", async () => {
    const h = await primed();
    h.reconcile.mockImplementation(async (_lease, _target, _request, onPullCommitted) => {
      onPullCommitted?.({ cursor: 42, changes: [] });
      return {
        kind: "refresh",
        outcome: { ...outcome, status: "unchanged", changedPaths: 0, refusedOps: 0 },
      };
    });
    await h.invoke(channel, { workspaceId: "existing", trigger: "manual" });
    expect(h.syncNotices).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenLastCalledWith({ workspaceId: "existing" });
    h.probeLog.mockResolvedValue({ unchanged: false });
    h.reconcile.mockImplementation(async (_lease, _target, _request, onPullCommitted) => {
      onPullCommitted?.({ cursor: 57, changes: [] });
      return {
        kind: "refresh",
        outcome: { ...outcome, status: "unchanged", changedPaths: 0, refusedOps: 0 },
      };
    });
    await h.invoke(channel, payload);
    expect(h.syncNotices).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenLastCalledWith({ workspaceId: "existing" });
  });
  it("does not sync Notices for a different account's manual local refresh", async () => {
    const h = await primed();
    h.cache.set({ ...credentials, userId: "another" });
    await h.invoke(channel, { workspaceId: "existing", trigger: "manual" });
    expect(h.syncNotices).not.toHaveBeenCalled();
  });
  it.each(["workspace", "account", "closed"] as const)(
    "invalidates a share's Notices pass after %s changes",
    async (change) => {
      const h = await primed();
      h.probeLog.mockResolvedValue({ unchanged: false });
      const pass = deferred();
      h.syncNotices.mockReturnValue(pass.promise);
      await h.invoke(channel, payload);
      expect(h.syncNotices).toHaveBeenCalledOnce();
      expect(h.closed.size).toBe(1); // The pull cache owns the only close listener.
      const isCurrent = h.syncNotices.mock.calls[0]![0];
      if (change === "workspace") h.retireRenderer();
      else if (change === "account") h.cache.set({ ...credentials, userId: "another" });
      else h.closeRenderer();
      expect(isCurrent()).toBe(false);
      pass.resolve();
      await pass.promise;
    },
  );
  it.each(["workspace", "account", "closed"] as const)(
    "invalidates an unchanged burst's Notices pass after %s changes",
    async (change) => {
      const h = await primed();
      const pass = deferred();
      h.syncNotices.mockReturnValue(pass.promise);
      await h.invoke(channel, { ...payload, trigger: "press-burst" });
      expect(h.syncNotices).toHaveBeenCalledOnce();
      expect(h.closed.size).toBe(1);
      expect(h.notify).not.toHaveBeenCalled();
      expect(h.storeFor).not.toHaveBeenCalled();
      const isCurrent = h.syncNotices.mock.calls[0]![0];
      expect(isCurrent()).toBe(true);
      if (change === "workspace") h.retireRenderer();
      else if (change === "account") h.cache.set({ ...credentials, userId: "another" });
      else h.closeRenderer();
      expect(isCurrent()).toBe(false);
      pass.resolve();
      await pass.promise;
    },
  );
  it("does a full refresh without a cached cursor and invalidates it after a failed full path", async () => {
    const h = await harness();
    await h.invoke(channel, payload);
    expect(h.probeLog).not.toHaveBeenCalled();
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.fetchInfo).toHaveBeenCalledOnce();
    expect(h.recordIdentity).toHaveBeenCalledOnce();
    h.probeLog.mockResolvedValue({ unchanged: false });
    h.reconcile.mockResolvedValueOnce({
      kind: "refresh",
      outcome: { ok: false, changedPaths: 0, errorMessage: "failed" },
    });
    await h.invoke(channel, payload);
    h.probeLog.mockClear();
    await h.invoke(channel, payload);
    expect(h.probeLog).not.toHaveBeenCalled();
    expect(h.reconcile).toHaveBeenCalledTimes(3);
  });
  it.each(["workspace", "credentials"])(
    "discards an unchanged probe after %s changes",
    async (change) => {
      const h = await primed();
      const held = deferred<{ unchanged: boolean }>();
      const started = deferred();
      h.probeLog.mockImplementation(() => {
        started.resolve();
        return held.promise;
      });
      const response = h.invoke(channel, payload);
      await started.promise;
      if (change === "workspace") h.retireRenderer();
      else h.cache.set({ ...credentials, token: "changed" });
      held.resolve({ unchanged: true });
      await expect(response).rejects.toThrow();
      noLocalWork(h);
    },
  );
  it("returns typed unauthorized and transient probe failures without touching local work", async () => {
    const h = await primed();
    h.probeLog.mockRejectedValueOnce(new RelayUnauthorizedError());
    await expect(h.invoke(channel, payload)).resolves.toMatchObject({
      ok: false,
      errorKind: "unauthorized",
      changedPaths: 0,
    });
    h.probeLog.mockRejectedValueOnce(new Error("offline"));
    await expect(h.invoke(channel, payload)).resolves.toMatchObject({
      ok: false,
      errorKind: "transient",
      changedPaths: 0,
    });
    noLocalWork(h);
  });
  it("uses the ended-share full path on removal instead of declaring it unchanged", async () => {
    const h = await primed();
    h.probeLog.mockRejectedValue(new ShareUnavailableError());
    h.reconcile.mockResolvedValue({ kind: "refresh", outcome: { ...outcome, status: "ended" } });
    await expect(h.invoke(channel, payload)).resolves.toMatchObject({ status: "ended" });
    expect(h.reconcile).toHaveBeenCalledOnce();
    expect(h.surfaces).toHaveBeenCalledOnce();
  });
  it.each(["account", "relay", "missing relay", "signed out"])(
    "pauses no-cursor background work for %s before operation admission",
    async (change) => {
      const h = await harness();
      if (change === "account") h.cache.set({ ...credentials, userId: "other" });
      if (change === "relay") h.cache.set({ ...credentials, relayUrl: "https://other.test" });
      if (change === "missing relay") delete h.workspace.shareView!.relayUrl;
      if (change === "signed out") h.cache.clear();
      await expect(h.invoke(channel, payload)).resolves.toMatchObject({
        ok: false,
        errorKind: "unauthorized",
        probed: true,
      });
      expect(h.registryRead).toHaveBeenCalledOnce();
      h.registryRead.mockClear();
      noLocalWork(h);
    },
  );
  it.each(["recipient", "selector"])(
    "skips a no-cursor opening pull when its %s requires reopening",
    async (missing) => {
      const h = await harness();
      if (missing === "recipient") delete h.workspace.shareView!.recipientUserId;
      else h.workspace.shareView!.grantedSelector = { paths: [], versionId: null, access: "edit" };
      await expect(h.invoke(channel, payload)).resolves.toMatchObject({
        ok: true,
        probed: true,
        status: "unchanged",
      });
      expect(h.registryRead).toHaveBeenCalledOnce();
      h.registryRead.mockClear();
      noLocalWork(h);
    },
  );
  it("does not suppress a later pull after X to Y to X changes credentials during a no-cursor refresh", async () => {
    const h = await harness();
    h.reconcile.mockImplementationOnce(async () => {
      h.cache.set({ ...credentials, userId: "Y" });
      h.cache.set(credentials);
      return { kind: "refresh", outcome };
    });
    await h.invoke(channel, payload);
    await h.invoke(channel, payload);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    expect(h.fetchInfo).toHaveBeenCalledTimes(2);
    expect(h.probeLog).not.toHaveBeenCalled();
  });
  it("returns a typed transient failure for a timed-out probe without local work", async () => {
    const h = await primed();
    const started = deferred();
    h.probeLog.mockImplementation(({ signal }) => {
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
    });
    vi.useFakeTimers();
    try {
      const response = h.invoke(channel, payload);
      await started.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(response).resolves.toMatchObject({
        ok: false,
        probed: true,
        errorKind: "transient",
      });
      expect(vi.getTimerCount()).toBe(0);
      noLocalWork(h);
    } finally {
      vi.useRealTimers();
    }
  });
  it("remembers a successful full refresh without a cursor until manual refresh or credentials change", async () => {
    const h = await harness();
    h.reconcile.mockResolvedValue({ kind: "refresh", outcome });
    await h.invoke(channel, payload);
    vi.clearAllMocks();
    await expect(h.invoke(channel, payload)).resolves.toMatchObject({
      ok: true,
      status: "unchanged",
      probed: true,
    });
    noLocalWork(h);
    expect(h.probeLog).not.toHaveBeenCalled();
    await h.invoke(channel, { workspaceId: "existing" });
    expect(h.reconcile).toHaveBeenCalledOnce();
    h.cache.set({ ...credentials, token: "renewed" });
    await h.invoke(channel, payload);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    expect(h.fetchInfo).toHaveBeenCalledTimes(2);
    expect(h.probeLog).not.toHaveBeenCalled();
  });
  it("starts one scoped burst pass even when the cached share has no log cursor", async () => {
    const h = await harness();
    h.reconcile.mockResolvedValue({ kind: "refresh", outcome });
    await h.invoke(channel, payload);
    vi.clearAllMocks();
    await h.invoke(channel, { ...payload, trigger: "press-burst" });
    expect(h.syncNotices).toHaveBeenCalledOnce();
    expect(h.syncNotices.mock.calls[0]![0]()).toBe(true);
    expect(h.probeLog).not.toHaveBeenCalled();
    expect(h.storeFor).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it.each(["idle", "in flight"])(
    "drops the probe cache when Forget retires the binding (%s)",
    async (phase) => {
      const h = await primed();
      const held = deferred<{ unchanged: boolean }>();
      const started = deferred();
      h.probeLog.mockImplementation(({ signal }) => {
        started.resolve();
        signal!.addEventListener("abort", () => held.reject(signal!.reason), { once: true });
        return held.promise;
      });
      const response = phase === "in flight" ? h.invoke(channel, payload) : undefined;
      const rejected = response && expect(response).rejects.toThrow();
      if (response) await started.promise;
      await h.authorities.retireBinding(h.authorities.currentBinding("existing"), {
        removeBinding: () => {
          h.registry.delete("existing");
        },
      });
      if (rejected) await rejected;
      expect(h.closed.size).toBe(0);
      await expect(h.invoke(channel, payload)).rejects.toThrow(
        "This workspace was closed. Open it again.",
      );
      noLocalWork(h);
    },
  );
  it("aborts a hung probe and releases its timeout when the sender closes", async () => {
    const h = await primed();
    const started = deferred();
    h.probeLog.mockImplementation(({ signal }) => {
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
      );
    });
    vi.useFakeTimers();
    try {
      const response = h.invoke(channel, payload);
      await started.promise;
      for (const close of h.closed) close();
      await expect(response).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.closed.size).toBe(0);
      noLocalWork(h);
    } finally {
      vi.useRealTimers();
    }
  });
});

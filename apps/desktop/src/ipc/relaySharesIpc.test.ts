import { relayShareOperations } from "./shareOperations";
import { registerOperations } from "./operationTable";
import { describe, expect, it, vi } from "vitest";
import { createRelaySharesIpcHandlers } from "./relaySharesIpc";
import { createPresencePollRegistry } from "../collab/presencePollRegistry";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { deferred } from "../testing/deferred";

type Sender = { id: number };
type Event = { sender: Sender };
type Workspace = {
  workspaceId: string;
  attachmentId: symbol;
  shareView?: unknown;
};
type Operation = {
  workspace: Workspace;
  assertCurrent(): void;
};
type Dependencies = Parameters<
  typeof createRelaySharesIpcHandlers<Sender, Event, Workspace, Operation>
>[0];

const workspaceId = "workspace";
const linkInput = { workspaceId, paths: ["notes.md"], access: "view" };
const linkResult = {
  ok: true,
  shareId: "share",
  grantId: "grant",
  url: "https://relay.example/link",
};
const pollInput = {
  workspaceId,
  shareId: "share",
  since: 0,
  hold: 30_000,
  limit: 10,
  pollId: "54df38bc-6863-46a7-964a-820d81e833aa",
};
const activityResult = {
  ok: true,
  latestRevision: 1,
  cursorRevision: 1,
  hasMore: false,
  messages: [],
  principals: [],
  linkCommentsPaused: false,
};

function harness() {
  const workspace: Workspace = { workspaceId, attachmentId: Symbol("attachment") };
  const credentials: CloudCredentials = {
    serverUrl: "https://account.example",
    relayUrl: "https://relay.example",
    userId: "owner",
    email: "owner@example.com",
    token: "owner-token",
  };
  let generation = 1;
  let rendererCurrent = true;
  let physicalCurrent = true;
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner({
    currentSession: (_sender: Sender) => ({
      workspaceId,
      attachmentId: workspace.attachmentId,
      generation: 1,
      isCurrent: () => rendererCurrent,
    }),
    withPhysicalOperation: async <Result>(
      requestedWorkspaceId: string,
      work: (operation: {
        workspace: Workspace;
        state: object;
        signal: AbortSignal;
        assertCurrent(): void;
      }) => Result | Promise<Result>,
    ) => {
      const attached =
        requestedWorkspaceId === workspaceId
          ? workspace
          : { ...workspace, workspaceId: requestedWorkspaceId, attachmentId: Symbol("other") };
      return work({
        workspace: attached,
        state: {},
        signal: new AbortController().signal,
        assertCurrent() {
          if (!physicalCurrent) throw new Error("physical workspace retired");
        },
      });
    },
  });
  const workspaceOperations = vi.fn();
  const remote = vi.fn(async (_workspace: Workspace, _options?: { allowPaused: boolean }) => ({
    credentials,
    credentialGeneration: generation,
  }));
  const request = vi.fn<
    (
      credentials: CloudCredentials,
      path: string,
      init?: RequestInit,
      options?: unknown,
    ) => Promise<unknown>
  >(async () => linkResult);
  const accountRequest = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(
    async () => ({ granted: [], received: [] }),
  );
  const polls = createPresencePollRegistry();
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const trusted = vi.fn((event: Event) => {
    if (event.sender.id < 0) throw new Error("untrusted sender");
  });
  const warm = vi.fn(async () => undefined);
  const sendRendererActivity = vi.fn();
  const sharesChanged = vi.fn<(workspaceId: string | null) => void>();
  const reconcileReceivedShares = vi.fn<(listing: unknown) => Promise<void>>(async () => undefined);
  let enrolled = true;
  const localStops = vi.fn<Dependencies["listOwnerLiveStops"]>(async () => []);
  const ownerLiveQuarantines = vi.fn<Dependencies["ownerLiveQuarantines"]>(() => []);
  const unwrittenOwnerLiveReleases = vi.fn<Dependencies["unwrittenOwnerLiveReleases"]>(
    async () => [],
  );
  const retryOwnerLiveQuarantine = vi.fn<Dependencies["retryOwnerLiveQuarantine"]>(
    async () => undefined,
  );
  const saveOwnerLiveRecoveryCopy = vi.fn<Dependencies["saveOwnerLiveRecoveryCopy"]>(async () => ({
    copyPath: "notes/a (recovered).md",
    packagePath: "notes/a (recovered).dohc-recovery.json",
    storedOn: "this-computer",
    keptEdits: "kept",
  }));
  const retryOwnerLiveRelease = vi.fn<Dependencies["retryOwnerLiveRelease"]>(async () => undefined);
  const ownerLiveStop = vi.fn<Dependencies["ownerLiveStop"]>(async (_workspace, action, path) =>
    action === "clear" || action === "retired"
      ? undefined
      : {
          state: action === "release" || !enrolled ? "released" : "requested",
          relayDatabaseNamespace: enrolled ? "relay" : "",
          retirementOwed: action !== "release",
          document: { mainVersionId: "main", objectId: "object", currentPath: path },
          binding: enrolled
            ? {
                workspaceId,
                mainVersionId: "main",
                objectId: "object",
                lineageClaimId: "a".repeat(64),
                currentPath: path,
                selectorPaths: [path],
                restoreFenceGeneration: 0,
              }
            : null,
          ...(action === "release" ? { materialized: true } : {}),
        },
  );
  // Each path holds the document "object", which the object ids name at "live.md".
  const liveDocument = vi.fn<Dependencies["liveDocument"]>(async (_workspace, target) => ({
    mainVersionId: "main",
    objectId: "objectId" in target ? target.objectId : "object",
    currentPath: "path" in target ? target.path : "live.md",
  }));
  const pushRecorded = vi.fn<Dependencies["pushRecorded"]>(async () => undefined);
  const editors = new Set<string>(),
    reserved: string[] = [];
  const withoutEditors: Dependencies["withoutEditors"] = async (_workspace, path, change) => {
    if (editors.has(path))
      throw new Error(`${path} is open in an editor. Close it in dohc, then try again.`);
    reserved.push(path);
    return change();
  };
  const ownerHandlersDependencies: Dependencies = {
    remoteForWorkspace: remote,
    currentCredentialGeneration: () => generation,
    currentCredentials: () => credentials,
    warmCredentialCache: warm,
    relayShareJson: accountRequest as Dependencies["relayShareJson"],
    relayShareJsonWithCredentials: request as Dependencies["relayShareJsonWithCredentials"],
    relayShareErrorCopy: (status) => `sharing failed (${status})`,
    relayShareDiscussionActivityPolls: polls,
    ownerLiveStop,
    pushRecorded,
    liveDocument,
    withoutEditors,
    listOwnerLiveStops: localStops,
    ownerLiveQuarantines,
    unwrittenOwnerLiveReleases,
    retryOwnerLiveQuarantine,
    retryOwnerLiveRelease,
    saveOwnerLiveRecoveryCopy,
    sharesChanged,
    sendRendererActivity,
    reconcileReceivedShares,
  };
  const ownerHandlers = createRelaySharesIpcHandlers<Sender, Event, Workspace, Operation>(
    ownerHandlersDependencies,
  );
  registerOperations<typeof relayShareOperations, Event, Operation>(
    {
      handle: (channel, handler) => {
        expect(handlers.has(channel)).toBe(false);
        handlers.set(channel, handler);
      },
      assertTrustedSender: trusted,
      withActiveWorkspace: (event, requestedWorkspaceId, message, work) => {
        workspaceOperations(event.sender, requestedWorkspaceId, message);
        return withRendererWorkspaceOperation(event.sender, requestedWorkspaceId, message, work);
      },
    },
    relayShareOperations,
    ownerHandlers,
  );
  const invoke = async (channel: string, payload?: unknown, senderId = 1) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({ sender: { id: senderId } }, payload);
  };
  return {
    workspace,
    workspaceOperations,
    credentials,
    remote,
    request,
    accountRequest,
    polls,
    handlers,
    warm,
    invoke,
    sharesChanged,
    sendRendererActivity,
    reconcileReceivedShares,
    unenrolled: () => {
      enrolled = false;
    },
    localStops,
    ownerLiveStop,
    pushRecorded,
    liveDocument,
    editors,
    reserved,
    ownerLiveQuarantines,
    unwrittenOwnerLiveReleases,
    retryOwnerLiveQuarantine,
    retryOwnerLiveRelease,
    saveOwnerLiveRecoveryCopy,
    ownerHandlersDependencies,
    retireRenderer: () => {
      rendererCurrent = false;
    },
    retirePhysical: () => {
      physicalCurrent = false;
    },
    rotateCredentials: () => {
      generation += 1;
    },
  };
}

describe("sync before live hosting", () => {
  const editShare = {
    workspaceId,
    paths: ["docs"],
    recipientEmail: "friend@dohc.test",
    access: "edit",
  };
  const shareSent = (h: ReturnType<typeof harness>) =>
    h.request.mock.calls.some(
      ([, path, init]) => path === "/sync/workspace/shares" && init?.method === "POST",
    );

  it("sends an edit share only after sync sends what it recorded", async () => {
    const h = harness(),
      pushed = deferred<void>();
    h.request.mockResolvedValue({ shareId: "share", grantId: "grant" });
    h.pushRecorded.mockReturnValue(pushed.promise);
    const created = h.invoke(relayShareOperations.createRelayShare.channel, editShare);
    await vi.waitFor(() => expect(h.pushRecorded).toHaveBeenCalledWith(workspaceId));
    expect(shareSent(h)).toBe(false);
    pushed.resolve();
    await created;
    expect(shareSent(h)).toBe(true);
  });

  it("sends the share at 10 s when sync takes longer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      h.request.mockResolvedValue({ shareId: "share", grantId: "grant" });
      h.pushRecorded.mockReturnValue(new Promise(() => {}));
      const created = h.invoke(relayShareOperations.createRelayShare.channel, editShare);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(shareSent(h)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await created;
      expect(shareSent(h)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't restore the share when the window changes workspaces while Undo syncs", async () => {
    const h = harness(),
      pushed = deferred<void>();
    h.pushRecorded.mockReturnValue(pushed.promise);
    const undone = h.invoke(relayShareOperations.undoRelayShare.channel, {
      workspaceId,
      shareId: "share",
      undoId: "undo-1",
    });
    await vi.waitFor(() => expect(h.pushRecorded).toHaveBeenCalledWith(workspaceId));
    h.retireRenderer();
    pushed.resolve();
    await expect(undone).rejects.toThrow(relayShareOperations.undoRelayShare.inactiveMessage);
    expect(h.accountRequest).not.toHaveBeenCalled();
  });
});

describe("owner live document enrollment", () => {
  // Document A stopped at old.md and moved to new.md; B now has old.md. The
  // server resumed A, so Resume clears A's Stop where A is now, never B's.
  // When this computer no longer has the resumed document, it clears that
  // document's Stop as the engine holds it, or nothing when it holds none.

  // Proves: a document stopped on a diverged server copy keeps the reason and
  // offers no Resume, whether its Stop finished or waits on this computer.

  // Proves: a deferred Stop offers Resume on a document whose server copy
  // is missing an owner edit, or whose history is too long to check, since a
  // Resume tries it again, but not on one whose conflict parent is withheld.
  it.each([
    ["live-edit-unadmitted", true],
    ["live-history-over-budget", true],
    ["conflict-parent-withheld", false],
  ] as const)("offers Resume for a deferred Stop with %s: %s", async (reason, canResume) => {
    const h = harness();
    h.localStops.mockResolvedValue([
      {
        state: "released",
        binding: null,
        document: { mainVersionId: "main", objectId: "object", currentPath: "edited.md" },
        retirementOwed: false,
        relayDatabaseNamespace: "relay",
        deferred: { unsentEdits: 1, editable: true },
      },
    ]);
    h.request.mockImplementation(async (_credentials, path) =>
      path.includes("retired=1")
        ? { ok: true, documents: [], nextCursor: null }
        : {
            ok: true,
            documents: [{ path: "edited.md", objectId: "object", status: "unavailable", reason }],
          },
    );
    await expect(
      h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, { workspaceId }),
    ).resolves.toEqual({
      documents: [
        {
          path: "edited.md",
          objectId: "object",
          status: "unavailable",
          reason,
          canResume,
          deferredStop: { unsentEdits: 1, editable: true },
        },
      ],
      nextCursor: null,
    });
  });
  const refusal = {
    shareId: "share",
    paths: ["docs"],
    code: "live_document_limit",
    message: "This server reached its live document limit.",
  };

  it("rejects nonadvancing cursors and unsafe or oversized refusal responses", async () => {
    const h = harness();
    for (const result of [
      { ok: true, refusals: [], nextCursor: "same" },
      { ok: true, refusals: [{ ...refusal, paths: ["../secret"] }], nextCursor: null },
      { ok: true, refusals: Array(65).fill(refusal), nextCursor: null },
      { ok: true, refusals: [{ ...refusal, token: "server-secret" }], nextCursor: null },
    ]) {
      h.request.mockResolvedValue(result);
      await expect(
        h.invoke(relayShareOperations.listOwnerLiveRefusals.channel, {
          workspaceId,
          after: "same",
        }),
      ).rejects.toThrow();
    }
  });

  it("lists active and retired rows without exposing bindings", async () => {
    const h = harness();
    h.request.mockImplementation(async (_credentials, path) =>
      path.includes("retired=1")
        ? {
            ok: true,
            documents: [
              { path: "old.md", objectId: "object", status: "retired", acceptedCursor: 0 },
            ],
            nextCursor: "old.md",
          }
        : {
            ok: true,
            documents: [
              {
                path: "live.md",
                objectId: "live",
                status: "ready",
                document: { shareId: "secret" },
              },
              { path: "paused.md", objectId: "paused", status: "paused" },
              {
                path: "moved.md",
                objectId: "moved",
                status: "paused",
                reason: "document-unavailable",
              },
              {
                path: "changed.md",
                objectId: "changed",
                status: "unavailable",
                reason: "workspace-changed",
              },
              {
                path: "refused.md",
                objectId: "refused",
                status: "unavailable",
                reason: "session-host-refused",
              },
              {
                path: "unopened.md",
                objectId: "unopened",
                status: "unavailable",
                reason: "live-document-without-lineage",
              },
              {
                path: "diverged.md",
                objectId: "diverged",
                status: "unavailable",
                reason: "session-host-diverged",
              },
              {
                path: "edited.md",
                objectId: "edited",
                status: "unavailable",
                reason: "live-edit-unadmitted",
              },
              {
                path: "long.md",
                objectId: "long",
                status: "unavailable",
                reason: "live-history-over-budget",
              },
              {
                path: "failing.md",
                objectId: "failing",
                status: "unavailable",
                reason: "live-start-failing",
                failure: { word: "engine-refused", since: "2026-11-13T01:00:00.000Z" },
              },
              {
                path: "newer.md",
                objectId: "newer",
                status: "unavailable",
                reason: "a-reason-from-a-newer-server",
                failure: { word: "x" },
              },
            ],
          },
    );
    await expect(
      h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, {
        workspaceId,
        retiredAfter: "older.md",
      }),
    ).resolves.toEqual({
      documents: [
        { path: "old.md", objectId: "object", status: "retired", canResume: true },
        { path: "live.md", objectId: "live", status: "ready", canResume: false },
        { path: "paused.md", objectId: "paused", status: "paused", canResume: true },
        {
          path: "moved.md",
          objectId: "moved",
          status: "paused",
          reason: "document-unavailable",
          canResume: false,
        },
        {
          path: "changed.md",
          objectId: "changed",
          status: "unavailable",
          reason: "workspace-changed",
          canResume: false,
        },
        {
          path: "refused.md",
          objectId: "refused",
          status: "unavailable",
          reason: "session-host-refused",
          canResume: true,
        },
        {
          path: "unopened.md",
          objectId: "unopened",
          status: "unavailable",
          reason: "live-document-without-lineage",
          canResume: true,
        },
        // Only the server's operator can continue a diverged server copy.
        {
          path: "diverged.md",
          objectId: "diverged",
          status: "unavailable",
          reason: "session-host-diverged",
          canResume: false,
        },
        // A Resume adds an edit made while live editing was off to the server's copy.
        {
          path: "edited.md",
          objectId: "edited",
          status: "unavailable",
          reason: "live-edit-unadmitted",
          canResume: true,
        },
        // A Resume tries again now.
        {
          path: "long.md",
          objectId: "long",
          status: "unavailable",
          reason: "live-history-over-budget",
          canResume: true,
        },
        // The server keeps trying; a Resume tries now.
        {
          path: "failing.md",
          objectId: "failing",
          status: "unavailable",
          reason: "live-start-failing",
          failure: { word: "engine-refused", since: "2026-11-13T01:00:00.000Z" },
          canResume: true,
        },
        // A newer server's reason this build doesn't know keeps the row, by its status alone.
        { path: "newer.md", objectId: "newer", status: "unavailable", canResume: false },
      ],
      nextCursor: "old.md",
    });
    expect(h.request.mock.calls.map((call) => call[1])).toEqual([
      "/sync/workspace/live-host",
      "/sync/workspace/live-host?retired=1&after=older.md",
    ]);
  });

  describe("edits the server refused", () => {
    const released =
      (
        deferred?: { unsentEdits: number; editable: boolean },
        materialized = true,
        requested: "requested" | "released" = "requested",
      ) =>
      async (...[, action, path]: Parameters<Dependencies["ownerLiveStop"]>) =>
        action === "request"
          ? {
              state: requested,
              relayDatabaseNamespace: "relay",
              retirementOwed: requested === "requested",
              document: { mainVersionId: "main", objectId: "object", currentPath: path },
              binding: {
                workspaceId,
                mainVersionId: "main",
                objectId: "object",
                lineageClaimId: "a".repeat(64),
                currentPath: path,
                selectorPaths: [path],
                restoreFenceGeneration: 0,
              },
            }
          : {
              state: "released",
              relayDatabaseNamespace: "relay",
              retirementOwed: false,
              document: { mainVersionId: "main", objectId: "object", currentPath: path },
              binding: {
                workspaceId,
                mainVersionId: "main",
                objectId: "object",
                lineageClaimId: "a".repeat(64),
                currentPath: path,
                selectorPaths: [path],
                restoreFenceGeneration: 0,
              },
              materialized,
              ...(deferred ? { deferred } : {}),
            };

    // A Stop that finished but could not write the file: Try again names the
    // row's document and settles that release again, wherever the document is
    // now. It never asks for a new Stop or the server. The record decides,
    // even before this computer's list of kept edits is read, as after a
    // restart or an engine store reset.
    it("writes the file again from the unwritten release alone, and never starts a new Stop", async () => {
      const h = harness();
      h.unwrittenOwnerLiveReleases.mockResolvedValue([
        { objectId: "object", path: "old name.md", retry: true },
      ]);
      const settled = await released(undefined, true)(h.workspace, "release", "live.md");
      h.retryOwnerLiveRelease
        .mockResolvedValueOnce(settled)
        .mockResolvedValueOnce({ ...settled!, materialized: false })
        .mockResolvedValueOnce(undefined);
      const tryAgain = () =>
        h.invoke(relayShareOperations.stopOwnerLiveDocument.channel, {
          workspaceId,
          path: "old name.md",
          again: { objectId: "object", recovery: "not-written" },
        });
      await expect(tryAgain()).resolves.toEqual({ keptEdits: "recovered" });
      await expect(tryAgain()).resolves.toEqual({ keptEdits: "kept" });
      // The engine holds no such release any more: the edits stay kept for Save recovery copy.
      await expect(tryAgain()).resolves.toEqual({ keptEdits: "kept" });
      // A Try again that fails still starts no Stop a later release could take for the record's own.
      h.retryOwnerLiveRelease.mockRejectedValueOnce(new Error("dohc could not write the file."));
      h.request.mockRejectedValue(new Error("offline"));
      await expect(tryAgain()).rejects.toThrow("dohc could not write the file.");
      expect(h.retryOwnerLiveRelease.mock.calls).toEqual([
        [h.workspace, "object"],
        [h.workspace, "object"],
        [h.workspace, "object"],
        [h.workspace, "object"],
      ]);
      // Its editors are held off where the document is now.
      expect(h.reserved).toEqual(["live.md", "live.md", "live.md", "live.md"]);
      expect(h.ownerLiveQuarantines).not.toHaveBeenCalled();
      expect(h.ownerLiveStop).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    });

    // Record A keeps "old.md" after its document moved to "new.md"; document B
    // now has "old.md". Each Stop names its document before it changes anything.
    it("names the document before it chooses a record or starts a Stop", async () => {
      const h = harness();
      h.unwrittenOwnerLiveReleases.mockResolvedValue([
        { objectId: "object", path: "old.md", retry: true },
      ]);
      const b = { mainVersionId: "main", objectId: "other", currentPath: "old.md" };
      h.liveDocument.mockImplementation(async (_workspace, target) =>
        "path" in target
          ? target.path === "old.md"
            ? b
            : null
          : target.objectId === "object"
            ? { mainVersionId: "main", objectId: "object", currentPath: "new.md" }
            : target.objectId === "other"
              ? b
              : null,
      );
      h.ownerLiveStop.mockImplementation(async (_workspace, action, path, target) => {
        const document =
          target && !("lineageClaimId" in target)
            ? target
            : { mainVersionId: "main", objectId: target!.objectId, currentPath: path };
        return {
          state: action === "request" ? "requested" : "released",
          relayDatabaseNamespace: "relay",
          retirementOwed: action === "request",
          document,
          binding: {
            workspaceId,
            mainVersionId: "main",
            objectId: document.objectId,
            lineageClaimId: "a".repeat(64),
            currentPath: path,
            selectorPaths: [path],
            restoreFenceGeneration: 0,
          },
          ...(action === "release" ? { materialized: true } : {}),
        };
      });
      h.request.mockImplementation(async (_credentials, _path, init) => {
        const { path, objectId } = JSON.parse(init!.body as string) as {
          path: string;
          objectId: string;
        };
        return { ok: true, path, objectId, status: "retired", acceptedCursor: 37 };
      });
      const stop = (input: {
        path: string;
        again?: { objectId: string; recovery: "not-written" | "stopping" };
      }) => h.invoke(relayShareOperations.stopOwnerLiveDocument.channel, { workspaceId, ...input });
      // Stop of "old.md" stops B, and leaves A's record.
      await expect(stop({ path: "old.md" })).resolves.toEqual({ keptEdits: "none" });
      expect(h.retryOwnerLiveRelease).not.toHaveBeenCalled();
      expect(
        h.ownerLiveStop.mock.calls.map(([, action, path, target]) => [
          action,
          path,
          target?.objectId,
        ]),
      ).toEqual([
        ["request", "old.md", "other"],
        ["release", "old.md", "other"],
      ]);
      // A Stop again for a document that is gone creates no Stop for anyone, nor for B at its row's path.
      h.ownerLiveStop.mockClear();
      h.request.mockClear();
      await expect(
        stop({ path: "old.md", again: { objectId: "gone", recovery: "stopping" } }),
      ).rejects.toThrow("This document changed.");
      // B has no record to try again; A's record is not B's.
      await expect(
        stop({ path: "old.md", again: { objectId: "other", recovery: "not-written" } }),
      ).rejects.toThrow("This document changed.");
      expect(h.ownerLiveStop).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.retryOwnerLiveRelease).not.toHaveBeenCalled();
      // A waiting Stop of A runs again for A where it is now, never for B.
      await expect(
        stop({ path: "old.md", again: { objectId: "object", recovery: "stopping" } }),
      ).resolves.toEqual({ keptEdits: "none" });
      expect(
        h.ownerLiveStop.mock.calls.map(([, action, path, target]) => [
          action,
          path,
          target?.objectId,
        ]),
      ).toEqual([
        ["request", "new.md", "object"],
        ["release", "new.md", "object"],
      ]);
      expect(
        h.request.mock.calls.map((call) => JSON.parse(call[2]!.body as string).objectId),
      ).toEqual(["object"]);
      expect(h.retryOwnerLiveRelease).not.toHaveBeenCalled();
    });

    it("saves a recovery copy for the workspace's own path, and only there", async () => {
      const h = harness();
      await expect(
        h.invoke(relayShareOperations.saveOwnerLiveRecoveryCopy.channel, {
          workspaceId,
          path: "notes/a.md",
        }),
      ).resolves.toEqual({
        copyPath: "notes/a (recovered).md",
        packagePath: "notes/a (recovered).dohc-recovery.json",
        storedOn: "this-computer",
        keptEdits: "kept",
      });
      expect(h.saveOwnerLiveRecoveryCopy).toHaveBeenCalledExactlyOnceWith(
        h.workspace,
        "notes/a.md",
        undefined,
      );
      await expect(
        h.invoke(relayShareOperations.saveOwnerLiveRecoveryCopy.channel, {
          workspaceId: "other",
          path: "notes/a.md",
        }),
      ).rejects.toThrow();
      await expect(
        h.invoke(relayShareOperations.saveOwnerLiveRecoveryCopy.channel, {
          workspaceId,
          path: "../outside.md",
        }),
      ).rejects.toThrow();
      expect(h.saveOwnerLiveRecoveryCopy).toHaveBeenCalledOnce();
      // A row's Save names the kept edits it shows.
      await h.invoke(relayShareOperations.saveOwnerLiveRecoveryCopy.channel, {
        workspaceId,
        path: "notes/a.md",
        incident: "release:a:0",
      });
      expect(h.saveOwnerLiveRecoveryCopy).toHaveBeenLastCalledWith(
        h.workspace,
        "notes/a.md",
        "release:a:0",
      );
    });
  });

  it("rejects renderer identity, unsafe paths, and unavailable resumes", async () => {
    const h = harness();
    await expect(
      h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, {
        workspaceId,
        credentials: h.credentials,
      }),
    ).rejects.toThrow();
    await expect(
      h.invoke(relayShareOperations.stopOwnerLiveDocument.channel, {
        workspaceId,
        path: "../secret",
      }),
    ).rejects.toThrow();
    h.request.mockResolvedValue({
      ok: true,
      path: "live.md",
      objectId: "object",
      status: "unavailable",
    });
    await expect(
      h.invoke(relayShareOperations.resumeOwnerLiveDocument.channel, {
        workspaceId,
        path: "live.md",
      }),
    ).rejects.toThrow("could not resume");
    expect(h.request.mock.calls.at(-1)?.[0]).toBe(h.credentials);
  });

  // A status this build doesn't know leaves nothing to show, so its row is dropped. A reason it doesn't know leaves the row by its status alone.
  it.each([
    ["drops a row with an unknown status", "status", []],
    [
      "keeps a row with an unknown reason as a row by its status",
      "reason",
      [{ path: "unknown.md", objectId: "unknown", status: "ready", canResume: false }],
    ],
  ] as const)(
    "%s, beside the known active and retired rows, using the last raw cursor",
    async (_name, field, kept) => {
      const h = harness();
      const unknown = (status: string) => ({
        path: "unknown.md",
        objectId: "unknown",
        status,
        [field]: "future-value",
      });
      h.request.mockImplementation(async (_credentials, path) =>
        path.includes("retired=1")
          ? {
              ok: true,
              documents: [
                { path: "old.md", objectId: "old", status: "retired" },
                unknown("retired"),
              ],
              nextCursor: "unknown.md",
            }
          : {
              ok: true,
              documents: [
                unknown("ready"),
                { path: "live.md", objectId: "live", status: "ready" },
                {
                  path: "held.md",
                  objectId: "held",
                  status: "unavailable",
                  reason: "conflict-parent-withheld",
                },
              ],
            },
      );
      await expect(
        h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, { workspaceId }),
      ).resolves.toEqual({
        documents: [
          { path: "old.md", objectId: "old", status: "retired", canResume: true },
          ...kept,
          { path: "live.md", objectId: "live", status: "ready", canResume: false },
          {
            path: "held.md",
            objectId: "held",
            status: "unavailable",
            reason: "conflict-parent-withheld",
            canResume: false,
          },
        ],
        nextCursor: "unknown.md",
      });
      await expect(
        h.invoke(relayShareOperations.listOwnerLiveDocuments.channel, {
          workspaceId,
          retiredAfter: "unknown.md",
        }),
      ).rejects.toThrow("list changed");
    },
  );
});

describe("registered owner restore handler", () => {
  const document = {
    workspaceId,
    mainVersionId: "main",
    objectId: "object",
    lineageClaimId: "lineage",
  };
  const intent = {
    deliveryKind: "owner",
    operationId: "restore",
    document,
    shareId: "share",
    grantId: "grant",
    expectedGrantGeneration: 4,
    expectedDependentGrantIds: [],
    expectedFence: 1,
    restorePointCursor: 0,
    restorePointReceiptDigest: "a".repeat(64),
  };
  const status = {
    operationId: "restore",
    document,
    path: "notes.md",
    phase: "authority-invalidated",
    intent,
    proposalDigest: null,
  };
  const statusInput = { workspaceId, action: "status", operationId: "restore" };

  it("keeps owner restore bound to the sender's original workspace", async () => {
    const h = harness();
    await expect(
      h.invoke(relayShareOperations.ownerRestore.channel, { ...statusInput, workspaceId: "other" }),
    ).rejects.toThrow("Sharing stopped because this window changed workspaces.");
    h.workspace.shareView = {};
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, statusInput)).rejects.toThrow(
      "original workspace",
    );
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["retireRenderer", "retirePhysical", "rotateCredentials"] as const)(
    "rejects %s before request and before response parsing",
    async (invalidate) => {
      const loading = harness(),
        loaded = deferred<{ credentials: CloudCredentials; credentialGeneration: number }>(),
        started = deferred();
      loading.remote.mockImplementation(() => {
        started.resolve();
        return loaded.promise;
      });
      const pending = loading.invoke(relayShareOperations.ownerRestore.channel, statusInput);
      await started.promise;
      loading[invalidate]();
      loaded.resolve({ credentials: loading.credentials, credentialGeneration: 1 });
      await expect(pending).rejects.toThrow();
      expect(loading.request).not.toHaveBeenCalled();

      const h = harness(),
        response = deferred<unknown>(),
        requested = deferred();
      h.request.mockImplementation(() => {
        requested.resolve();
        return response.promise;
      });
      const result = h.invoke(relayShareOperations.ownerRestore.channel, statusInput);
      await requested.promise;
      h[invalidate]();
      const read = vi.fn(() => "restore");
      response.resolve({
        ...status,
        get operationId() {
          return read();
        },
      });
      await expect(result).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["workspace", "point"])("rejects substituted %s coordinates", async (substitution) => {
    const h = harness();
    let input: unknown = statusInput,
      response: unknown = structuredClone(status);
    if (substitution === "workspace")
      response = {
        ...status,
        intent: { ...intent, document: { ...document, workspaceId: "other" } },
      };
    if (substitution === "operation")
      response = { ...status, intent: { ...intent, operationId: "other" } };
    if (substitution === "top-operation") response = { ...status, operationId: "other" };
    if (substitution === "top-document")
      response = { ...status, document: { ...document, objectId: "other" } };
    if (substitution === "point") {
      input = {
        workspaceId,
        action: "plan",
        document,
        shareId: "share",
        grantId: "grant",
        restorePointCursor: 0,
        restorePointReceiptDigest: "a".repeat(64),
      };
      response = { intent: { ...intent, restorePointCursor: 1 }, path: "notes.md", recipients: [] };
    }
    if (substitution === "path") {
      input = { workspaceId, action: "options", path: "notes.md" };
      response = {
        document,
        path: "other.md",
        grants: [],
        points: [],
        authors: [],
        nextBeforeCursor: null,
        nextGrantCursor: null,
        pendingOperation: null,
      };
    }
    h.request.mockResolvedValue(response);
    await expect(h.invoke(relayShareOperations.ownerRestore.channel, input)).rejects.toThrow();
  });
});

describe("registered relay share handlers", () => {
  it.each([
    { ok: true, access: "view" },
    { ok: true, access: "edit", url: "https://relay.example/new" },
    { ok: true, access: "comment", url: "not a URL" },
    { ok: true, access: "comment", url: null },
    { ok: false, access: "comment", url: "https://relay.example/new" },
  ])("rejects a malformed or mismatched retune response %j", async (response) => {
    const h = harness();
    h.request.mockResolvedValue({ kind: "success", body: response });
    await expect(
      h.invoke(relayShareOperations.retuneRelayShareLink.channel, {
        workspaceId,
        shareId: "share",
        grantId: "grant",
        expectedDependentGrantIds: [],
        access: "comment",
      }),
    ).rejects.toThrow("sharing failed (500)");
  });

  it("registers only this family and authenticates every channel before parsing or work", async () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual([
      relayShareOperations.ownerRestore.channel,
      relayShareOperations.listOwnerLiveDocuments.channel,
      relayShareOperations.listOwnerLiveRefusals.channel,
      relayShareOperations.retryOwnerLiveShare.channel,
      relayShareOperations.stopOwnerLiveDocument.channel,
      relayShareOperations.resumeOwnerLiveDocument.channel,
      relayShareOperations.retryOwnerLiveQuarantine.channel,
      relayShareOperations.saveOwnerLiveRecoveryCopy.channel,
      relayShareOperations.createRelayShare.channel,
      relayShareOperations.listRelayShares.channel,
      relayShareOperations.getRelayReceivedShare.channel,
      relayShareOperations.revokeRelayShare.channel,
      relayShareOperations.undoRelayShare.channel,
      relayShareOperations.createRelayShareLink.channel,
      relayShareOperations.addRelayShareLink.channel,
      relayShareOperations.listRelayShareLinks.channel,
      relayShareOperations.retuneRelayShareLink.channel,
      relayShareOperations.rotateRelayShareLink.channel,
      relayShareOperations.revokeRelayShareLink.channel,
      relayShareOperations.listRelayShareLinkAgents.channel,
      relayShareOperations.disconnectRelayShareLinkAgent.channel,
      relayShareOperations.listRelayShareDiscussion.channel,
      relayShareOperations.pollRelayShareDiscussionActivity.channel,
      relayShareOperations.cancelRelayShareDiscussionActivity.channel,
      relayShareOperations.appendRelayShareDiscussion.channel,
      relayShareOperations.deleteRelayShareDiscussionMessage.channel,
      relayShareOperations.blockRelayShareDiscussionPrincipal.channel,
      relayShareOperations.unblockRelayShareDiscussionPrincipal.channel,
      relayShareOperations.pauseRelayShareDiscussion.channel,
      relayShareOperations.resumeRelayShareDiscussion.channel,
      relayShareOperations.promoteRelayShareGrant.channel,
      relayShareOperations.revokeRelayShareGrant.channel,
    ]);
    expect(h.handlers.size).toBe(32);
    for (const channel of h.handlers.keys()) {
      await expect(h.invoke(channel, null, -1)).rejects.toThrow("untrusted sender");
    }
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.accountRequest).not.toHaveBeenCalled();
    expect(h.polls.activeCount()).toBe(0);
  });

  it.each([
    [relayShareOperations.listOwnerLiveDocuments.channel, { workspaceId }],
    [relayShareOperations.stopOwnerLiveDocument.channel, { workspaceId, path: "live.md" }],
    [relayShareOperations.resumeOwnerLiveDocument.channel, { workspaceId, path: "live.md" }],
    [relayShareOperations.createRelayShareLink.channel, linkInput],
    [
      relayShareOperations.promoteRelayShareGrant.channel,
      {
        workspaceId,
        shareId: "share",
        grantId: "grant",
        expectedParentGrantId: "parent",
        expectedParentGeneration: 2,
      },
    ],
    [relayShareOperations.pauseRelayShareDiscussion.channel, { workspaceId, shareId: "share" }],
  ] as const)("checks currentness after the relay resolves for %s", async (channel, payload) => {
    for (const invalidate of ["retireRenderer", "retirePhysical", "rotateCredentials"] as const) {
      const h = harness();
      const response = deferred<unknown>();
      const started = deferred();
      h.request.mockImplementation(() => {
        started.resolve();
        return response.promise;
      });
      const result = h.invoke(channel, payload);
      await started.promise;
      h[invalidate]();
      const readResult = vi.fn(() => true);
      response.resolve({
        get ok() {
          return readResult();
        },
      });
      await expect(result).rejects.toThrow();
      expect(readResult).not.toHaveBeenCalled();
      expect(h.request).toHaveBeenCalledTimes(
        channel === relayShareOperations.listOwnerLiveDocuments.channel ? 2 : 1,
      );
    }
  });

  it("creates a link using the authorized workspace and credential snapshot", async () => {
    const h = harness();
    await expect(
      h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput),
    ).resolves.toEqual({
      shareId: "share",
      grantId: "grant",
      url: linkResult.url,
    });
    expect(h.request).toHaveBeenCalledWith(h.credentials, "/sync/workspace/shares/links", {
      method: "POST",
      body: JSON.stringify({ paths: ["notes.md"], access: "view" }),
    });
  });

  it("rejects a shared view and unauthorized remote before relay mutation", async () => {
    const h = harness();
    h.workspace.shareView = {};
    await expect(
      h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput),
    ).rejects.toThrow("original workspace");
    expect(h.remote).not.toHaveBeenCalled();
    h.workspace.shareView = undefined;
    h.remote.mockRejectedValue(new Error("wrong account"));
    await expect(
      h.invoke(relayShareOperations.createRelayShareLink.channel, linkInput),
    ).rejects.toThrow("wrong account");
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("registered account share handlers", () => {
  it("rejects a credential switch during exact-share reconciliation", async () => {
    const h = harness(),
      started = deferred(),
      reconciled = deferred();
    h.reconcileReceivedShares.mockImplementation(() => {
      started.resolve();
      return reconciled.promise;
    });
    const pending = h.invoke(relayShareOperations.listRelayShares.channel);
    await started.promise;
    h.rotateCredentials();
    reconciled.resolve();
    await expect(pending).rejects.toThrow("session changed");
  });
});

describe("registered discussion poll lifetime", () => {
  it("cancels only the sender's poll and keeps presence polling independent", async () => {
    const h = harness();
    const presence = createPresencePollRegistry();
    const presencePoll = presence.begin(1, pollInput.pollId, "presence");
    const started = deferred<AbortSignal>();
    h.request.mockImplementation((_credentials, _path, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing poll signal");
      started.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const result = h.invoke(
      relayShareOperations.pollRelayShareDiscussionActivity.channel,
      pollInput,
    );
    const signal = await started.promise;
    await h.invoke(
      relayShareOperations.cancelRelayShareDiscussionActivity.channel,
      { pollId: pollInput.pollId },
      2,
    );
    expect(signal.aborted).toBe(false);
    await h.invoke(relayShareOperations.cancelRelayShareDiscussionActivity.channel, {
      pollId: pollInput.pollId,
    });
    await expect(result).rejects.toThrow("aborted");
    expect(h.polls.activeCount()).toBe(0);
    expect(presencePoll.signal.aborted).toBe(false);
    presencePoll.release();
  });

  it("checks cancellation after a relay ignores the abort and returns a valid response", async () => {
    const h = harness();
    const started = deferred();
    const response = deferred<unknown>();
    h.request.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const result = h.invoke(
      relayShareOperations.pollRelayShareDiscussionActivity.channel,
      pollInput,
    );
    await started.promise;
    await h.invoke(relayShareOperations.cancelRelayShareDiscussionActivity.channel, {
      pollId: pollInput.pollId,
    });
    response.resolve(activityResult);
    await expect(result).rejects.toThrow("aborted");
    expect(h.polls.activeCount()).toBe(0);
  });
});

const ownerInputs = {
  ownerRestore: { workspaceId, action: "options", path: "notes.md" },
  listOwnerLiveDocuments: { workspaceId },
  listOwnerLiveRefusals: { workspaceId },
  retryOwnerLiveShare: { workspaceId, shareId: "share" },
  stopOwnerLiveDocument: { workspaceId, path: "live.md" },
  resumeOwnerLiveDocument: { workspaceId, path: "live.md" },
  retryOwnerLiveQuarantine: { workspaceId, objectId: "object", incident: "outbox:delivery:0" },
  listRelayShares: undefined,
  getRelayReceivedShare: { shareId: "share" },
  revokeRelayShare: { shareId: "share" },
  undoRelayShare: { workspaceId, shareId: "share", undoId: "undo-1" },
  pollRelayShareDiscussionActivity: pollInput,
  cancelRelayShareDiscussionActivity: { pollId: pollInput.pollId },
  createRelayShare: {
    workspaceId,
    paths: ["docs"],
    recipientEmail: "friend@dohc.test",
    access: "edit",
  },
  createRelayShareLink: linkInput,
  addRelayShareLink: { workspaceId, shareId: "share", access: "view" },
  listRelayShareLinks: { workspaceId },
  retuneRelayShareLink: {
    workspaceId,
    shareId: "share",
    grantId: "grant",
    expectedDependentGrantIds: [],
    access: "view",
  },
  rotateRelayShareLink: {
    workspaceId,
    shareId: "share",
    grantId: "grant",
    expectedDependentGrantIds: [],
  },
  revokeRelayShareLink: {
    workspaceId,
    shareId: "share",
    grantId: "grant",
    expectedDependentGrantIds: [],
  },
  listRelayShareLinkAgents: { workspaceId, shareId: "share", grantId: "grant" },
  disconnectRelayShareLinkAgent: {
    workspaceId,
    shareId: "share",
    grantId: "grant",
    connectionId: "connection",
  },
  listRelayShareDiscussion: { workspaceId, shareId: "share", direction: "newest-first" },
  appendRelayShareDiscussion: {
    workspaceId,
    shareId: "share",
    body: "Hello",
    idempotencyKey: "54df38bc-6863-46a7-964a-820d81e833aa",
  },
  deleteRelayShareDiscussionMessage: { workspaceId, shareId: "share", messageId: "message" },
  blockRelayShareDiscussionPrincipal: { workspaceId, shareId: "share", principalId: "principal" },
  unblockRelayShareDiscussionPrincipal: { workspaceId, shareId: "share", principalId: "principal" },
  pauseRelayShareDiscussion: { workspaceId, shareId: "share" },
  resumeRelayShareDiscussion: { workspaceId, shareId: "share" },
  promoteRelayShareGrant: {
    workspaceId,
    shareId: "share",
    grantId: "grant",
    expectedParentGrantId: "parent",
    expectedParentGeneration: 2,
  },
  revokeRelayShareGrant: { workspaceId, shareId: "share", grantId: "grant" },
  saveOwnerLiveRecoveryCopy: { workspaceId, path: "notes/a.md" },
} satisfies Record<keyof typeof relayShareOperations, unknown>;
const ownerRows = Object.entries(relayShareOperations).map(([name, row]) => ({
  name,
  row,
  input: ownerInputs[name as keyof typeof ownerInputs],
}));
const workspaceRows = ownerRows.filter(
  (
    entry,
  ): entry is typeof entry & { row: Extract<typeof entry.row, { guard: "active-workspace" }> } =>
    entry.row.guard === "active-workspace",
);

describe("owner operation admission", () => {
  it.each(workspaceRows)(
    "binds $name to the sender's workspace before remote access",
    async ({ row, input }) => {
      const h = harness();
      await expect(
        h.invoke(row.channel, { ...input, workspaceId: "another-workspace" }),
      ).rejects.toThrow(row.inactiveMessage);
      expect(h.remote).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.accountRequest).not.toHaveBeenCalled();
    },
  );

  it.each(workspaceRows)(
    "refuses $name in a shared view before remote access",
    async ({ row, input }) => {
      const h = harness();
      h.workspace.shareView = {};
      h.remote.mockRejectedValue(new Error("remote reached"));
      await expect(h.invoke(row.channel, input)).rejects.toThrow("original workspace");
      expect(h.remote).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    },
  );
});

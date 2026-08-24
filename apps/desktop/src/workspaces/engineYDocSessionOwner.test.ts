import { describe, expect, it, vi } from "vitest";

import {
  EngineYDocSessionOwner,
  type EngineYDocSessionOutbound,
  type EngineYDocSessionSignals,
} from "./engineYDocSessionOwner";

interface TestSender {
  readonly id: number;
  readonly label: string;
}

interface TestSession {
  close: (options?: { shuttingDown?: boolean }) => Promise<void>;
}

type TestOutbound = EngineYDocSessionOutbound<
  TestSender,
  string,
  string,
  string
>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createOwner(outbound: TestOutbound[] = []) {
  return new EngineYDocSessionOwner<
    TestSender,
    TestSession,
    string,
    string,
    string
  >({
    onOutbound: (message) => outbound.push(message),
  });
}

function openInput(input: {
  sender: TestSender;
  generation: number;
  sessionId?: string;
  workspaceId?: string;
  path?: string;
  openSession: (
    signals: EngineYDocSessionSignals<string, string, string>,
  ) => Promise<{ session: TestSession; value: string }>;
}) {
  return {
    sender: input.sender,
    generation: input.generation,
    sessionId: input.sessionId ?? "renderer-session-1",
    workspaceId: input.workspaceId ?? "workspace-1",
    path: input.path ?? "notes/a.md",
    openSession: input.openSession,
  };
}

describe("EngineYDocSessionOwner", () => {
  it("reserves a renderer session before awaiting its engine open", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const engineOpen = deferred<{ session: TestSession; value: string }>();
    const competingOpen = vi.fn(async () => ({
      session: { close: async () => undefined },
      value: "loser",
    }));

    const first = owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: () => engineOpen.promise,
      }),
    );
    const second = await owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: competingOpen,
      }),
    );

    expect(second).toEqual({ kind: "refused", reason: "session-in-use" });
    expect(competingOpen).not.toHaveBeenCalled();

    engineOpen.resolve({
      session: { close: async () => undefined },
      value: "winner",
    });
    await expect(first).resolves.toEqual({
      kind: "opened",
      value: "winner",
      lineageGeneration: 1,
    });
  });

  it("does not let a stale open clear the newer generation's winner", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "reused-web-contents" };
    const staleEngineOpen = deferred<{
      session: TestSession;
      value: string;
    }>();
    const staleOpenStarted = deferred<void>();
    const staleClose = vi.fn(async () => undefined);

    const stale = owner.open(
      openInput({
        sender,
        generation: 1,
        path: "notes/stale.md",
        openSession: () => {
          staleOpenStarted.resolve();
          return staleEngineOpen.promise;
        },
      }),
    );
    await staleOpenStarted.promise;
    const current = owner.open(
      openInput({
        sender,
        generation: 2,
        path: "notes/current.md",
        openSession: async () => ({
          session: { close: async () => undefined },
          value: "current",
        }),
      }),
    );

    await expect(current).resolves.toEqual({
      kind: "opened",
      value: "current",
      lineageGeneration: 1,
    });

    staleEngineOpen.resolve({
      session: { close: staleClose },
      value: "stale",
    });
    await expect(stale).resolves.toEqual({
      kind: "cancelled",
      reason: "superseded",
      release: { kind: "released" },
    });
    expect(staleClose).toHaveBeenCalledOnce();

    const delayedStaleOpen = vi.fn();
    await expect(
      owner.open(
        openInput({
          sender,
          generation: 1,
          path: "notes/delayed-stale.md",
          openSession: delayedStaleOpen,
        }),
      ),
    ).resolves.toEqual({
      kind: "cancelled",
      reason: "superseded",
      release: { kind: "released" },
    });
    expect(delayedStaleOpen).not.toHaveBeenCalled();

    const applied = owner.applyUpdate(
      {
        sender,
        generation: 2,
        sessionId: "renderer-session-1",
        lineageGeneration: 1,
      },
      () => "current still owns the slot",
    );
    expect(applied).toEqual({
      kind: "applied",
      value: "current still owns the slot",
    });
  });

  it("retires an older generation across different renderer session ids", async () => {
    const outbound: TestOutbound[] = [];
    const owner = createOwner(outbound);
    const sender = { id: 7, label: "reused-web-contents" };
    const staleEngineOpen = deferred<{
      session: TestSession;
      value: string;
    }>();
    const staleOpenStarted = deferred<void>();
    const staleClose = vi.fn(async () => undefined);
    let staleSignals!: EngineYDocSessionSignals<string, string, string>;
    let currentSignals!: EngineYDocSessionSignals<string, string, string>;

    const stale = owner.open(
      openInput({
        sender,
        generation: 1,
        sessionId: "stale-session",
        path: "notes/stale.md",
        openSession: (signals) => {
          staleSignals = signals;
          staleOpenStarted.resolve();
          return staleEngineOpen.promise;
        },
      }),
    );
    await staleOpenStarted.promise;

    await expect(
      owner.open(
        openInput({
          sender,
          generation: 2,
          sessionId: "current-session",
          path: "notes/current.md",
          openSession: async (signals) => {
            currentSignals = signals;
            return {
              session: { close: async () => undefined },
              value: "current",
            };
          },
        }),
      ),
    ).resolves.toEqual({
      kind: "opened",
      value: "current",
      lineageGeneration: 1,
    });

    staleSignals.emit("stale while its engine open is pending");
    expect(outbound).toEqual([]);

    staleEngineOpen.resolve({
      session: { close: staleClose },
      value: "stale",
    });
    await expect(stale).resolves.toEqual({
      kind: "cancelled",
      reason: "superseded",
      release: { kind: "released" },
    });
    expect(staleClose).toHaveBeenCalledOnce();
    expect(
      owner.applyUpdate(
        {
          sender,
          generation: 1,
          sessionId: "stale-session",
          lineageGeneration: 1,
        },
        () => "stale update",
      ),
    ).toEqual({ kind: "refused", reason: "session-unavailable" });
    staleSignals.emit("stale after its engine open settled");
    expect(outbound).toEqual([]);

    currentSignals.emit("current event");
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      generation: 2,
      sessionId: "current-session",
      message: { kind: "session-event", event: "current event" },
    });
    expect(
      owner.applyUpdate(
        {
          sender,
          generation: 2,
          sessionId: "current-session",
          lineageGeneration: 1,
        },
        () => "current update",
      ),
    ).toEqual({ kind: "applied", value: "current update" });
  });

  it("registers a pending open so exact sender retirement waits for and releases it", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const engineOpen = deferred<{ session: TestSession; value: string }>();
    const engineOpenStarted = deferred<void>();
    const close = vi.fn(async () => undefined);

    const opening = owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: () => {
          engineOpenStarted.resolve();
          return engineOpen.promise;
        },
      }),
    );
    await engineOpenStarted.promise;
    const retirement = owner.retireSender({ sender, generation: 1 });

    engineOpen.resolve({ session: { close }, value: "too late" });

    await expect(opening).resolves.toEqual({
      kind: "cancelled",
      reason: "sender-retired",
      release: { kind: "released" },
    });
    await expect(retirement).resolves.toEqual([{ kind: "released" }]);
    expect(close).toHaveBeenCalledOnce();

    const delayedEngineOpen = vi.fn();
    await expect(
      owner.open(
        openInput({
          sender,
          generation: 1,
          openSession: delayedEngineOpen,
        }),
      ),
    ).resolves.toEqual({
      kind: "cancelled",
      reason: "sender-retired",
      release: { kind: "released" },
    });
    expect(delayedEngineOpen).not.toHaveBeenCalled();
  });

  it("does not bind the same workspace path while a retired open is still pending", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "reused-web-contents" };
    const staleEngineOpen = deferred<{
      session: TestSession;
      value: string;
    }>();
    const staleOpenStarted = deferred<void>();
    const staleClose = vi.fn(async () => undefined);
    const currentEngineOpen = vi.fn(async () => ({
      session: { close: async () => undefined },
      value: "current",
    }));

    const stale = owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: () => {
          staleOpenStarted.resolve();
          return staleEngineOpen.promise;
        },
      }),
    );
    await staleOpenStarted.promise;
    const retirement = owner.retireSender({ sender, generation: 1 });
    const current = owner.open(
      openInput({
        sender,
        generation: 2,
        openSession: currentEngineOpen,
      }),
    );

    expect(currentEngineOpen).not.toHaveBeenCalled();
    staleEngineOpen.resolve({
      session: { close: staleClose },
      value: "stale",
    });

    await expect(stale).resolves.toMatchObject({ kind: "cancelled" });
    await expect(retirement).resolves.toEqual([{ kind: "released" }]);
    await expect(current).resolves.toEqual({
      kind: "opened",
      value: "current",
      lineageGeneration: 1,
    });
    expect(staleClose).toHaveBeenCalledOnce();
    expect(currentEngineOpen).toHaveBeenCalledOnce();
  });

  it("requires the exact sender object and renderer generation", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const reusedId = { id: 7, label: "window-b" };
    const close = vi.fn(async () => undefined);

    await owner.open(
      openInput({
        sender,
        generation: 4,
        openSession: async () => ({ session: { close }, value: "opened" }),
      }),
    );

    for (const caller of [
      { sender: reusedId, generation: 4 },
      { sender, generation: 5 },
    ]) {
      expect(
        owner.applyUpdate(
          {
            ...caller,
            sessionId: "renderer-session-1",
            lineageGeneration: 1,
          },
          () => "should not run",
        ),
      ).toEqual({ kind: "refused", reason: "session-unavailable" });
      expect(
        owner.acknowledgeLineageReplacement({
          ...caller,
          sessionId: "renderer-session-1",
          lineageGeneration: 2,
        }),
      ).toEqual({ kind: "refused", reason: "session-unavailable" });
      await expect(
        owner.release({
          ...caller,
          sessionId: "renderer-session-1",
        }),
      ).resolves.toEqual({
        kind: "refused",
        reason: "session-unavailable",
      });
    }
    expect(close).not.toHaveBeenCalled();

    await expect(
      owner.release({ sender, generation: 4, sessionId: "renderer-session-1" }),
    ).resolves.toEqual({ kind: "released" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses every outbound message as soon as release starts", async () => {
    const outbound: TestOutbound[] = [];
    const owner = createOwner(outbound);
    const sender = { id: 7, label: "window-a" };
    const closeGate = deferred<void>();
    let signals!: EngineYDocSessionSignals<string, string, string>;

    await owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: async (openedSignals) => {
          signals = openedSignals;
          return {
            session: {
              close: async () => {
                signals.emit("save-state-during-release");
                signals.remoteUpdate("remote-update-during-release");
                signals.replaceLineage("replacement-during-release");
                await closeGate.promise;
              },
            },
            value: "opened",
          };
        },
      }),
    );
    signals.emit("before-release");
    expect(outbound).toHaveLength(1);

    const release = owner.release({
      sender,
      generation: 1,
      sessionId: "renderer-session-1",
    });

    expect(outbound).toHaveLength(1);
    expect(
      owner.applyUpdate(
        {
          sender,
          generation: 1,
          sessionId: "renderer-session-1",
          lineageGeneration: 1,
        },
        () => "should not run",
      ),
    ).toEqual({ kind: "refused", reason: "session-unavailable" });

    closeGate.resolve();
    await expect(release).resolves.toEqual({ kind: "released" });
  });

  it("keeps valid empty lineage acknowledgements distinct from refusals", async () => {
    const outbound: TestOutbound[] = [];
    const owner = createOwner(outbound);
    const sender = { id: 7, label: "window-a" };
    const foreign = { id: 7, label: "window-b" };
    let signals!: EngineYDocSessionSignals<string, string, string>;

    await owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: async (openedSignals) => {
          signals = openedSignals;
          return {
            session: { close: async () => undefined },
            value: "opened",
          };
        },
      }),
    );

    signals.replaceLineage("winner");
    expect(outbound.at(-1)?.message).toEqual({
      kind: "lineage-replacement",
      replacement: "winner",
      lineageGeneration: 2,
    });
    expect(
      owner.acknowledgeLineageReplacement({
        sender: foreign,
        generation: 1,
        sessionId: "renderer-session-1",
        lineageGeneration: 2,
      }),
    ).toEqual({ kind: "refused", reason: "session-unavailable" });
    expect(
      owner.acknowledgeLineageReplacement({
        sender,
        generation: 1,
        sessionId: "renderer-session-1",
        lineageGeneration: 3,
      }),
    ).toEqual({ kind: "refused", reason: "lineage-transition" });
    expect(
      owner.acknowledgeLineageReplacement({
        sender,
        generation: 1,
        sessionId: "renderer-session-1",
        lineageGeneration: 2,
      }),
    ).toEqual({ kind: "applied", replacement: "winner", updates: [] });

    signals.replaceLineage("next winner");
    signals.remoteUpdate("buffered delta");
    expect(
      owner.acknowledgeLineageReplacement({
        sender,
        generation: 1,
        sessionId: "renderer-session-1",
        lineageGeneration: 3,
      }),
    ).toEqual({
      kind: "applied",
      replacement: "next winner",
      updates: ["buffered delta"],
    });
  });

  it("keeps exact-owner session access available through a failed release", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const foreign = { id: 7, label: "window-b" };
    let refuseRelease = true;

    await owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: async () => ({
          session: {
            close: async () => {
              if (refuseRelease) throw new Error("still held");
            },
          },
          value: "opened",
        }),
      }),
    );

    expect(
      owner.accessSession(
        { sender, generation: 1, sessionId: "renderer-session-1" },
        () => "pinned asset",
      ),
    ).toEqual({ kind: "available", value: "pinned asset" });
    expect(
      owner.accessSession(
        { sender: foreign, generation: 1, sessionId: "renderer-session-1" },
        () => "foreign asset",
      ),
    ).toEqual({ kind: "refused", reason: "session-unavailable" });

    await owner.release({
      sender,
      generation: 1,
      sessionId: "renderer-session-1",
    });
    expect(
      owner.accessSession(
        { sender, generation: 1, sessionId: "renderer-session-1" },
        () => "recovery asset",
      ),
    ).toEqual({ kind: "available", value: "recovery asset" });

    refuseRelease = false;
    await owner.release({
      sender,
      generation: 1,
      sessionId: "renderer-session-1",
    });
    expect(
      owner.accessSession(
        { sender, generation: 1, sessionId: "renderer-session-1" },
        () => "gone",
      ),
    ).toEqual({ kind: "refused", reason: "session-unavailable" });
  });

  it("exposes workspace-path ownership and visits only matching sessions", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const pendingOpen = deferred<{ session: TestSession; value: string }>();
    const pending = owner.open(
      openInput({
        sender,
        generation: 1,
        sessionId: "pending",
        path: "notes/pending.md",
        openSession: () => pendingOpen.promise,
      }),
    );

    expect(owner.ownsDocument("workspace-1", "notes/pending.md")).toBe(true);

    pendingOpen.resolve({
      session: { close: async () => undefined },
      value: "pending",
    });
    await pending;
    await owner.open(
      openInput({
        sender,
        generation: 1,
        sessionId: "nested",
        path: "notes/folder/nested.md",
        openSession: async () => ({
          session: { close: async () => undefined },
          value: "nested",
        }),
      }),
    );
    await owner.open(
      openInput({
        sender,
        generation: 1,
        sessionId: "other-workspace",
        workspaceId: "workspace-2",
        path: "notes/folder/foreign.md",
        openSession: async () => ({
          session: { close: async () => undefined },
          value: "foreign",
        }),
      }),
    );

    let visited = 0;
    owner.forEachSessionUnderPath("workspace-1", "notes/folder", () => {
      visited += 1;
    });

    expect(visited).toBe(1);
    expect(owner.ownsDocument("workspace-2", "notes/folder/foreign.md")).toBe(
      true,
    );
    expect(owner.ownsDocument("workspace-1", "notes/folder/foreign.md")).toBe(
      false,
    );
  });

  it("shuts down open and pending sessions with the quit-specific close", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const pendingOpen = deferred<{ session: TestSession; value: string }>();
    const openStarted = deferred<void>();
    const close = vi.fn(async () => undefined);
    const opening = owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: () => {
          openStarted.resolve();
          return pendingOpen.promise;
        },
      }),
    );

    await openStarted.promise;
    const shutdown = owner.shutdown();
    pendingOpen.resolve({ session: { close }, value: "too late" });

    await expect(opening).resolves.toEqual({
      kind: "cancelled",
      reason: "shutting-down",
      release: { kind: "released" },
    });
    await expect(shutdown).resolves.toEqual([{ kind: "released" }]);
    expect(close).toHaveBeenCalledWith({ shuttingDown: true });

    const afterShutdown = vi.fn();
    await expect(
      owner.open(
        openInput({
          sender,
          generation: 2,
          openSession: afterShutdown,
        }),
      ),
    ).resolves.toEqual({
      kind: "cancelled",
      reason: "shutting-down",
      release: { kind: "released" },
    });
    expect(afterShutdown).not.toHaveBeenCalled();
  });

  it("retains a failed release for an exact-owner retry and stays silent", async () => {
    const outbound: TestOutbound[] = [];
    const owner = createOwner(outbound);
    const sender = { id: 7, label: "window-a" };
    const releaseError = new Error("daemon retained the session");
    let refuseRelease = true;
    let signals!: EngineYDocSessionSignals<string, string, string>;

    await owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: async (openedSignals) => {
          signals = openedSignals;
          return {
            session: {
              close: async () => {
                signals.emit("during close");
                if (refuseRelease) throw releaseError;
              },
            },
            value: "opened",
          };
        },
      }),
    );

    await expect(
      owner.release({ sender, generation: 1, sessionId: "renderer-session-1" }),
    ).resolves.toEqual({ kind: "failed", error: releaseError });
    signals.emit("after failed close");
    expect(outbound).toEqual([]);

    const duplicateEngineOpen = vi.fn();
    await expect(
      owner.open(
        openInput({
          sender,
          generation: 1,
          openSession: duplicateEngineOpen,
        }),
      ),
    ).resolves.toEqual({
      kind: "refused",
      reason: "session-unreleased",
      error: releaseError,
    });
    expect(duplicateEngineOpen).not.toHaveBeenCalled();

    refuseRelease = false;
    await expect(
      owner.release({ sender, generation: 1, sessionId: "renderer-session-1" }),
    ).resolves.toEqual({ kind: "released" });
  });

  it("releases a session when its lineage replacement cannot be delivered", async () => {
    const closeGate = deferred<void>();
    const close = vi.fn(() => closeGate.promise);
    const sender = { id: 7, label: "window-a" };
    let signals!: EngineYDocSessionSignals<string, string, string>;
    const owner = new EngineYDocSessionOwner<
      TestSender,
      TestSession,
      string,
      string,
      string
    >({
      onOutbound: ({ message }) => {
        if (message.kind === "lineage-replacement") {
          throw new Error("renderer send failed");
        }
      },
    });

    await owner.open(
      openInput({
        sender,
        generation: 1,
        openSession: async (openedSignals) => {
          signals = openedSignals;
          return { session: { close }, value: "opened" };
        },
      }),
    );

    signals.replaceLineage("winner");
    expect(close).toHaveBeenCalledOnce();
    expect(
      owner.applyUpdate(
        {
          sender,
          generation: 1,
          sessionId: "renderer-session-1",
          lineageGeneration: 1,
        },
        () => "must not reach the undelivered winner",
      ),
    ).toEqual({ kind: "refused", reason: "session-unavailable" });

    const release = owner.release({
      sender,
      generation: 1,
      sessionId: "renderer-session-1",
    });
    closeGate.resolve();
    await expect(release).resolves.toEqual({ kind: "released" });
  });

  it("refuses a second bind until a failed release of that workspace path succeeds", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const releaseError = new Error("daemon retained the document");
    const close = vi.fn(async () => {
      throw releaseError;
    });
    const secondEngineOpen = vi.fn(async () => ({
      session: { close: async () => undefined },
      value: "must not open",
    }));

    await owner.open(
      openInput({
        sender,
        generation: 1,
        sessionId: "first",
        openSession: async () => ({ session: { close }, value: "first" }),
      }),
    );
    await owner.release({ sender, generation: 1, sessionId: "first" });

    await expect(
      owner.open(
        openInput({
          sender,
          generation: 1,
          sessionId: "second",
          openSession: secondEngineOpen,
        }),
      ),
    ).resolves.toEqual({
      kind: "refused",
      reason: "session-unreleased",
      error: releaseError,
    });
    expect(close).toHaveBeenCalledTimes(2);
    expect(secondEngineOpen).not.toHaveBeenCalled();
  });

  it("scopes failed-release discharge to one workspace", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const releaseError = new Error("daemon retained workspace-a");
    const close = vi.fn(async () => {
      throw releaseError;
    });
    const otherWorkspaceOpen = vi.fn(async () => ({
      session: { close: async () => undefined },
      value: "workspace-b",
    }));

    await owner.open(
      openInput({
        sender,
        generation: 1,
        sessionId: "workspace-a-session",
        workspaceId: "workspace-a",
        path: "notes/shared-name.md",
        openSession: async () => ({
          session: { close },
          value: "workspace-a",
        }),
      }),
    );
    await owner.release({
      sender,
      generation: 1,
      sessionId: "workspace-a-session",
    });

    await expect(
      owner.open(
        openInput({
          sender,
          generation: 1,
          sessionId: "workspace-b-session",
          workspaceId: "workspace-b",
          path: "notes/shared-name.md",
          openSession: otherWorkspaceOpen,
        }),
      ),
    ).resolves.toEqual({
      kind: "opened",
      value: "workspace-b",
      lineageGeneration: 1,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(otherWorkspaceOpen).toHaveBeenCalledOnce();
  });

  it("returns the capture refusal itself without translating it into flags", async () => {
    const owner = createOwner();
    const sender = { id: 7, label: "window-a" };
    const refusal = Object.assign(new Error("not in this version"), {
      code: "path-not-in-version",
    });

    await expect(
      owner.open(
        openInput({
          sender,
          generation: 1,
          openSession: async () => {
            throw refusal;
          },
        }),
      ),
    ).resolves.toEqual({
      kind: "refused",
      reason: "open-refused",
      error: refusal,
    });
  });
});

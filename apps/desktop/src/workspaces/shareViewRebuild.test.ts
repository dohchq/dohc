import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import {
  EngineRequestError,
  EngineWorkspaceRebuildingError,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import type { Request, Response } from "@dohc/workspace-engine-client";
import { RelayUnreachableError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import type { EngineYDocSessionReleaseOutcome } from "./engineYDocSessionOwner";
import {
  classifyShareViewRebuildError,
  closeLivePages,
  createShareViewRebuilds,
  holdShareViewCopy,
  isClosedCopyRefusal,
  LivePageUnkeptError,
  shareViewRebuildStop,
  type ShareViewRebuildAnswer,
  type ShareViewRebuildNotice,
  type ShareViewRebuildSteps,
} from "./shareViewRebuild";

type Reach = { signature: string; visibilitySignature: string };

class Unreachable extends Error {}
class Removed extends Error {}
class NotRebuilding extends Error {}

// One joined copy as main sees it: whether its window and engine sessions are
// open, what its view records, and what the engine's rebuild has done.
function copy(
  answers: Array<
    ShareViewRebuildAnswer<Reach> | Error | (() => Promise<ShareViewRebuildAnswer<Reach>>)
  >,
  listed: Reach[] = [{ signature: "r2", visibilitySignature: "v2" }],
) {
  const state = {
    open: true,
    held: false,
    view: {
      reach: { signature: "r1", visibilitySignature: "v1" } as Reach,
      rebuild: "rebuild-1" as string | undefined,
      saved: undefined as { folder: string; count: number } | undefined,
    },
    manifest: "closed" as "closed" | "converged" | "gone",
    notices: [] as ShareViewRebuildNotice[],
    slept: [] as number[],
    builtUnder: [] as Reach[],
    draftsRemoved: [] as string[],
    // How many installs fail before one lands, as a failed registry write does.
    installFails: 0,
    // The engine's answer once it converged, which it gives again until finish.
    converged: undefined as ShareViewRebuildAnswer<Reach> | undefined,
  };
  const steps: ShareViewRebuildSteps<Reach> = {
    hold: async () => {
      const reopen = state.open;
      state.held = true;
      state.open = false;
      return { reopen };
    },
    release: async (_id, reopen) => {
      state.held = false;
      if (reopen) state.open = true;
    },
    readReach: async () => (listed.length > 1 ? listed.shift()! : listed[0]!),
    rebuild: async (_id, rebuildId, reach) => {
      expect(state.held).toBe(true);
      expect(rebuildId).toBe(state.view.rebuild);
      if (state.manifest === "gone") throw new NotRebuilding();
      if (state.manifest === "converged" && state.converged) return state.converged;
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer");
      if (next instanceof Error) throw next;
      const answer = typeof next === "function" ? await next() : next;
      state.builtUnder.push(reach);
      if (answer.state === "rebuilt") {
        state.manifest = "converged";
        state.converged = answer;
      }
      return answer;
    },
    // Like the engine: a rebuild already finished has nothing left to delete.
    finish: async (_id, _rebuildId, savedDrafts) => {
      expect(state.manifest).not.toBe("closed");
      // Only once the view stored the result.
      expect(state.view.rebuild).toBeUndefined();
      state.manifest = "gone";
      state.draftsRemoved.push(...savedDrafts);
    },
    install: async (_id, rebuildId, result) => {
      if (state.installFails > 0) {
        state.installFails -= 1;
        throw new Error("the registry could not be written");
      }
      if (state.view.rebuild === rebuildId) {
        state.view = {
          reach: result?.reach ?? state.view.reach,
          rebuild: undefined,
          saved: result?.recovered ?? undefined,
        };
      }
    },
    notice: (_id, notice) => {
      state.notices.push(notice);
    },
    classify: (error) =>
      error instanceof Unreachable
        ? "unreachable"
        : error instanceof Removed
          ? "ended"
          : error instanceof NotRebuilding
            ? "finished"
            : "other",
    sleep: async (ms) => {
      state.slept.push(ms);
    },
  };
  return { state, rebuilds: createShareViewRebuilds(steps) };
}

const rebuilt = (
  reach: Reach,
  recovered = 0,
  savedDrafts: string[] = [],
): ShareViewRebuildAnswer<Reach> => ({
  state: "rebuilt",
  reach,
  recoveryFolder: recovered ? ".dohc/local/recovery/2026-11-16 10-00 UTC" : null,
  recovered,
  savedDrafts,
});

describe("rebuilding a joined copy", () => {
  it("reopens a clean copy under the reach it was rebuilt for", async () => {
    const { state, rebuilds } = copy([rebuilt({ signature: "r2", visibilitySignature: "v2" })]);
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toEqual({
      kind: "rebuilt",
      recoveryFolder: null,
      recovered: 0,
    });
    expect(state).toMatchObject({
      open: true,
      held: false,
      manifest: "gone",
      view: { reach: { signature: "r2", visibilitySignature: "v2" }, rebuild: undefined },
    });
    expect(state.notices).toEqual([{ kind: "running" }, { kind: "clear" }]);
  });

  it("says where files left out of reach were saved", async () => {
    const { state, rebuilds } = copy([rebuilt({ signature: "r2", visibilitySignature: "v2" }, 2)]);
    await rebuilds.run("w", "rebuild-1");
    // With the reach, in one write, so a restart can't lose the Notice.
    expect(state.view.saved).toEqual({
      folder: ".dohc/local/recovery/2026-11-16 10-00 UTC",
      count: 2,
    });
    expect(state.notices).toEqual([{ kind: "running" }, { kind: "clear" }]);
  });

  it("builds again under the newer reach when it moved during the build", async () => {
    const r2 = { signature: "r2", visibilitySignature: "v2" },
      r3 = { signature: "r3", visibilitySignature: "v3" };
    const { state, rebuilds } = copy([{ state: "reachMoved" }, rebuilt(r3)], [r2, r3]);
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({ kind: "rebuilt" });
    expect(state.builtUnder).toEqual([r2, r3]);
    expect(state.view.reach).toEqual(r3);
  });

  it("stops after the reach keeps moving, and keeps the copy closed", async () => {
    const { state, rebuilds } = copy(
      Array.from({ length: 10 }, () => ({ state: "reachMoved" as const })),
    );
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({ kind: "failed" });
    expect(state).toMatchObject({ open: false, held: false, view: { rebuild: "rebuild-1" } });
  });

  // The recovery folder holds each live draft the rebuild saved, so main
  // deletes those drafts only once the engine finished.
  it("deletes the live drafts the rebuild saved once it finished", async () => {
    const { state, rebuilds } = copy([
      rebuilt({ signature: "r2", visibilitySignature: "v2" }, 1, ["draft-1"]),
    ]);
    await rebuilds.run("w", "rebuild-1");
    expect(state).toMatchObject({ manifest: "gone", draftsRemoved: ["draft-1"] });
  });

  it("keeps the live drafts when the rebuild stops", async () => {
    const { state, rebuilds } = copy([new Error("share-view-rebuild-filesystems-differ")]);
    await rebuilds.run("w", "rebuild-1");
    expect(state.draftsRemoved).toEqual([]);
  });

  it("waits for the connection with growing pauses, then finishes", async () => {
    const { state, rebuilds } = copy([
      new Unreachable(),
      new Unreachable(),
      new Unreachable(),
      rebuilt({ signature: "r2", visibilitySignature: "v2" }),
    ]);
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({ kind: "rebuilt" });
    expect(state.slept).toEqual([1_000, 2_000, 5_000]);
    expect(state.notices).toEqual([
      { kind: "running" },
      { kind: "waiting" },
      { kind: "waiting" },
      { kind: "waiting" },
      { kind: "clear" },
    ]);
    expect(state.open).toBe(true);
  });

  it("hands an ended membership back without reopening the copy", async () => {
    const { state, rebuilds } = copy([new Removed()]);
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toEqual({ kind: "ended" });
    expect(state).toMatchObject({ open: false, held: false, view: { rebuild: "rebuild-1" } });
    expect(state.notices).toEqual([{ kind: "running" }, { kind: "ended" }]);
    expect(shareViewRebuildStop({ kind: "ended" })).toEqual({
      reason: "ended",
      detail: "Your membership ended. What arrived stays in this folder.",
    });
  });

  it("stops on any other failure with the copy closed", async () => {
    const failure = new Error("share-view-rebuild-filesystems-differ");
    const { state, rebuilds } = copy([failure]);
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toEqual({
      kind: "failed",
      error: failure,
    });
    expect(state).toMatchObject({ open: false, held: false, view: { rebuild: "rebuild-1" } });
    expect(state.notices).toEqual([{ kind: "running" }, { kind: "failed", error: failure }]);
  });

  // The engine no longer knows the rebuild, so nothing says which reach the
  // store was built under. The view keeps the reach it stored: a pull served
  // under another one closes the copy again.
  it("keeps the stored reach when the engine no longer holds the rebuild", async () => {
    const { state, rebuilds } = copy([]);
    state.manifest = "gone";
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({ kind: "rebuilt" });
    expect(state).toMatchObject({
      open: true,
      view: { reach: { signature: "r1" }, rebuild: undefined, saved: undefined },
    });
  });

  // The engine converged under r2, and storing that failed. The owner changes
  // visibility again before Try again. The view takes the reach the store was
  // built under, not the one listed now, which would hide that the store
  // still holds what r3 withholds.
  it("stores the reach the copy was built under when storing it failed and the reach moved again", async () => {
    const r2 = { signature: "r2", visibilitySignature: "v2" },
      r3 = { signature: "r3", visibilitySignature: "v3" };
    const { state, rebuilds } = copy([rebuilt(r2, 1)], [r2, r3]);
    state.installFails = 1;
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({ kind: "failed" });
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({
      kind: "rebuilt",
      recovered: 1,
    });
    expect(state).toMatchObject({
      manifest: "gone",
      view: {
        reach: r2,
        rebuild: undefined,
        saved: { folder: ".dohc/local/recovery/2026-11-16 10-00 UTC", count: 1 },
      },
    });
  });

  it("runs one rebuild per copy at a time", async () => {
    const gate = deferred<ShareViewRebuildAnswer<Reach>>();
    const { state, rebuilds } = copy([() => gate.promise]);
    const first = rebuilds.run("w", "rebuild-1"),
      second = rebuilds.run("w", "rebuild-1");
    expect(rebuilds.running("w")).toBe(true);
    gate.resolve(rebuilt({ signature: "r2", visibilitySignature: "v2" }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "rebuilt", recoveryFolder: null, recovered: 0 },
      { kind: "rebuilt", recoveryFolder: null, recovered: 0 },
    ]);
    expect(state.builtUnder).toHaveLength(1);
    expect(rebuilds.running("w")).toBe(false);
  });

  // Try again: the view drops the earlier stop as the new try starts, so
  // "Updating access" shows no failure while it runs.
  it("clears an earlier stop as soon as a new try starts", async () => {
    const gate = deferred<ShareViewRebuildAnswer<Reach>>();
    const { state, rebuilds } = copy([
      new Error("share-view-rebuild-rename-failed"),
      () => gate.promise,
    ]);
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({ kind: "failed" });
    expect(state.notices.at(-1)).toMatchObject({ kind: "failed" });
    const retried = rebuilds.run("w", "rebuild-1");
    await vi.waitFor(() => expect(state.held).toBe(true));
    expect(state.notices.at(-1)).toEqual({ kind: "running" });
    gate.resolve(rebuilt({ signature: "r2", visibilitySignature: "v2" }));
    await expect(retried).resolves.toMatchObject({ kind: "rebuilt" });
  });

  it("leaves the copy closed when its sessions can't be held", async () => {
    const { state } = copy([]);
    const held = new Error("a live note could not be saved");
    const failing = createShareViewRebuilds<Reach>({
      hold: async () => {
        throw held;
      },
      release: async () => undefined,
      readReach: async () => state.view.reach,
      rebuild: async () => {
        throw new Error("unreachable");
      },
      finish: async () => undefined,
      install: async () => undefined,
      notice: (_id, notice) => {
        state.notices.push(notice);
      },
      classify: () => "other",
      sleep: async () => undefined,
    });
    await expect(failing.run("w", "rebuild-1")).resolves.toEqual({ kind: "failed", error: held });
    expect(state.notices).toEqual([{ kind: "running" }, { kind: "failed", error: held }]);
  });

  // Main closes every joined live page of the copy and waits for each. A page
  // whose unsent edits could not be kept stops the close: nothing is rebuilt,
  // and Try again closes the pages again.
  it("stops the close with Try again when a live page can't keep its draft", async () => {
    const { state } = copy([rebuilt({ signature: "r2", visibilitySignature: "v2" })]);
    const unwritable = new Error("EACCES: the draft folder refused the write");
    let pages: EngineYDocSessionReleaseOutcome[] = [
      { kind: "released" },
      { kind: "failed", error: unwritable },
    ];
    let rebuiltCalls = 0;
    const rebuilds = createShareViewRebuilds<Reach>({
      hold: async () => {
        state.held = true;
        try {
          await closeLivePages(async () => pages);
        } catch (error) {
          state.held = false;
          throw error;
        }
        return { reopen: true };
      },
      release: async () => {
        state.held = false;
      },
      readReach: async () => state.view.reach,
      rebuild: async (_id, _rebuildId, reach) => {
        rebuiltCalls += 1;
        return rebuilt(reach);
      },
      finish: async () => undefined,
      install: async () => undefined,
      notice: (_id, notice) => {
        state.notices.push(notice);
      },
      classify: () => "other",
      sleep: async () => undefined,
    });
    const stopped = await rebuilds.run("w", "rebuild-1");
    expect(stopped).toMatchObject({ kind: "failed", error: expect.any(LivePageUnkeptError) });
    expect(rebuiltCalls).toBe(0);
    expect(state.held).toBe(false);
    const notice = state.notices.at(-1);
    expect(shareViewRebuildStop(notice!)).toEqual({
      reason: "failed",
      detail:
        "dohc could not keep the unsent edits of a page you had open, so access is not updated yet. Your edits are still open in dohc.",
    });

    pages = [{ kind: "released" }];
    await expect(rebuilds.run("w", "rebuild-1")).resolves.toMatchObject({ kind: "rebuilt" });
    expect(rebuiltCalls).toBe(1);
  });
});

// Main's hold, against the real session gate. The engine closed the copy
// before main holds it, so it refuses every request but close.
describe("holding a copy for its rebuild", () => {
  async function heldCopy(closeActivity: (run: () => Promise<unknown>) => Promise<void>) {
    const workspace = {
      workspaceId: "w",
      rootPath: await mkdtemp(join(tmpdir(), "dohc-hold-")),
      attachmentId: Symbol("window"),
    };
    let closedForAccess = false;
    const client = {
      close() {},
      sendRequest: async (request: Request): Promise<Response> => {
        if (closedForAccess && request.method !== "workspace.close") {
          throw new EngineRequestError(
            request.id,
            {
              code: "FORBIDDEN",
              message: "share-view-updating-access",
              retry: "no",
            } as ConstructorParameters<typeof EngineRequestError>[1],
            request.method,
          );
        }
        return {
          id: request.id,
          result: request.method === "workspace.open" ? { workspace: "handle" } : { closed: true },
        };
      },
    };
    const sessions = new EngineWorkspaceSessions(
      { currentClient: () => client },
      { sleep: async () => undefined },
    );
    await sessions.run(workspace, async () => undefined);
    closedForAccess = true;
    const hold = () =>
      holdShareViewCopy("w", {
        sessions,
        closeLivePages: async () => undefined,
        // The activity's last file reads go through the copy's session.
        closeActivity: () => closeActivity(() => sessions.run(workspace, async () => undefined)),
      });
    return { workspace, sessions, hold };
  }

  // A file the watcher saw last stays on disk, where the rebuild's plan reads it.
  it("holds the copy though the activity's last reads are refused", async () => {
    const { workspace, sessions, hold } = await heldCopy(async (read) => {
      await read();
    });
    await expect(hold()).resolves.toBeUndefined();
    await expect(sessions.run(workspace, async () => undefined)).rejects.toBeInstanceOf(
      EngineWorkspaceRebuildingError,
    );
    await sessions.closeAll();
  });

  it("stops on another failure of the close, and opens the sessions again", async () => {
    const full = new Error("ENOSPC: the disk is full");
    const { workspace, sessions, hold } = await heldCopy(async () => {
      throw full;
    });
    await expect(hold()).rejects.toBe(full);
    // Open again: the engine's own refusal answers, not the hold.
    await expect(sessions.run(workspace, async () => undefined)).rejects.toThrow(
      "share-view-updating-access",
    );
    await sessions.closeAll();
  });
});

describe("a closed copy's background reads", () => {
  it("knows the refusals a closed copy answers with", () => {
    expect(isClosedCopyRefusal(new EngineWorkspaceRebuildingError("w"))).toBe(true);
    expect(
      isClosedCopyRefusal(
        new EngineRequestError(
          1,
          {
            code: "FORBIDDEN",
            message: "share-view-updating-access",
            retry: "no",
          } as ConstructorParameters<typeof EngineRequestError>[1],
          "chat.list",
        ),
      ),
    ).toBe(true);
    expect(
      isClosedCopyRefusal(
        new EngineRequestError(
          1,
          {
            code: "FORBIDDEN",
            message: "share-view-not-member",
            retry: "no",
          } as ConstructorParameters<typeof EngineRequestError>[1],
          "chat.list",
        ),
      ),
    ).toBe(false);
    expect(isClosedCopyRefusal(new Error("share-view-updating-access"))).toBe(false);
  });
});

describe("what stopped a rebuild", () => {
  const refused = (code: string, message: string) =>
    new EngineRequestError(
      1,
      { code, message, retry: "no" } as ConstructorParameters<typeof EngineRequestError>[1],
      "share.view.rebuild",
    );

  it("waits for a relay it can't reach", () => {
    expect(classifyShareViewRebuildError(new RelayUnreachableError())).toBe("unreachable");
    expect(classifyShareViewRebuildError(new TypeError("fetch failed"))).toBe("unreachable");
    expect(
      classifyShareViewRebuildError(refused("WORKSPACE_UNAVAILABLE", "relay-unreachable")),
    ).toBe("unreachable");
  });

  it("ends a membership the relay no longer has", () => {
    expect(classifyShareViewRebuildError(new ShareUnavailableError())).toBe("ended");
    expect(classifyShareViewRebuildError(refused("SHARE_UNAVAILABLE", "share-unavailable"))).toBe(
      "ended",
    );
  });

  it("knows a rebuild the engine already finished", () => {
    expect(
      classifyShareViewRebuildError(refused("INVALID_PARAMS", "share-view-not-rebuilding")),
    ).toBe("finished");
  });

  it("stops on anything else", () => {
    expect(
      classifyShareViewRebuildError(refused("INTERNAL", "share-view-rebuild-filesystems-differ")),
    ).toBe("other");
    expect(
      classifyShareViewRebuildError(
        refused("WORKSPACE_UNAVAILABLE", "relay-workspace-unavailable"),
      ),
    ).toBe("other");
    expect(classifyShareViewRebuildError(new Error("Share request failed (500)"))).toBe("other");
  });
});

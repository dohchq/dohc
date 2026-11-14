import { describe, expect, it, vi } from "vitest";
import type { ChatWakeIntent } from "./chatWakeIntents";
import { createChatWakeNotices } from "./chatWakeNotices";

const FILE = "/state/chat-wakes.json";
const LEDGER = "/state/chat-runners.json";
const intent: ChatWakeIntent = {
  account: "A",
  userId: "ana",
  installId: "mac",
  wakeId: `wake-${"a".repeat(32)}`,
  generation: 1,
  workspaceId: "ws",
  threadId: "t1",
  messageId: "m1",
  prerequisiteMessageId: null,
  candidate: { installId: "mac", agentId: "default", label: "Mac", matched: { handle: "claude" } },
  phase: "won",
};

function setup(workspaces: () => readonly string[]) {
  const deps = {
    file: FILE,
    ledgerFile: LEDGER,
    workspaces,
    report: vi.fn(),
    clear: vi.fn(),
    log: vi.fn(),
  };
  return { deps, notices: createChatWakeNotices(deps) };
}

describe("wake rows in Notices", () => {
  it("files a wake's row in its own workspace with its IDs, and takes it back there", () => {
    const { deps, notices } = setup(() => ["ws", "other"]);
    notices.report("ws", "parked", intent);
    expect(deps.report).toHaveBeenCalledExactlyOnceWith(
      "ws",
      expect.objectContaining({
        reason: "wake-parked",
        threadId: "t1",
        messageId: "m1",
        wakeId: intent.wakeId,
      }),
    );
    notices.clear("ws", "parked");
    expect(deps.clear).toHaveBeenCalledExactlyOnceWith("ws", "wake-parked");
  });

  it("shows the unreadable file once in each synced workspace, including one that syncs later", () => {
    let workspaces: string[] = [];
    const { deps, notices } = setup(() => workspaces);
    notices.report(null, "unreadable", null);
    expect(deps.report).not.toHaveBeenCalled();
    workspaces = ["ws"];
    notices.report(null, "unreadable", null);
    notices.report(null, "unreadable", null);
    expect(deps.report).toHaveBeenCalledExactlyOnceWith(
      "ws",
      expect.objectContaining({ reason: "wake-unreadable", file: FILE }),
    );
    workspaces = ["ws", "later"];
    notices.report(null, "unreadable", null);
    expect(deps.report.mock.calls.map(([id]) => id)).toEqual(["ws", "later"]);
    notices.clear(null, "unreadable");
    expect(deps.clear.mock.calls).toEqual([
      ["ws", "wake-unreadable"],
      ["later", "wake-unreadable"],
    ]);
    // Once taken back, a new failure shows it again.
    notices.report(null, "unreadable", null);
    expect(deps.report).toHaveBeenCalledTimes(4);
  });

  it("never throws for the file's row: a workspace that could not take it is offered it next time", () => {
    const { deps, notices } = setup(() => ["ws", "other"]);
    const failure = new Error("That window is gone.");
    deps.report.mockImplementationOnce(() => {
      throw failure;
    });
    notices.report(null, "unreadable", null);
    expect(deps.report.mock.calls.map(([id]) => id)).toEqual(["ws", "other"]);
    expect(deps.log).toHaveBeenCalledWith(failure);
    notices.report(null, "unreadable", null);
    expect(deps.report.mock.calls.map(([id]) => id)).toEqual(["ws", "other", "ws"]);
  });

  it("never throws when the workspace list can't be read", () => {
    const failure = new Error("This workspace was closed.");
    const { deps, notices } = setup(() => {
      throw failure;
    });
    expect(() => notices.report(null, "unreadable", null)).not.toThrow();
    expect(deps.report).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(failure);
  });
});

describe("a refusal of this computer's agents", () => {
  it("files one row in the workspace naming the agent and the next step, and takes it back", () => {
    const { deps, notices } = setup(() => ["ws"]);
    notices.refused("ws", { reason: "same-name", agentId: "codex" });
    expect(deps.report).toHaveBeenCalledExactlyOnceWith("ws", {
      reason: "wake-runners-refused",
      message: "Two agents' names read as one name in chat. Rename one in Settings › Agents.",
      agentId: "codex",
    });
    notices.refused("ws", { reason: "too-many-agents" });
    expect(deps.report).toHaveBeenLastCalledWith(
      "ws",
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
    notices.accepted("ws");
    expect(deps.clear).toHaveBeenCalledExactlyOnceWith("ws", "wake-runners-refused");
  });
});

describe("an unreadable declarations ledger", () => {
  it("shows its file once in each synced workspace with the way to recover, and takes the rows back once it reads", () => {
    let workspaces = ["ws"];
    const { deps, notices } = setup(() => workspaces);
    notices.ledgerUnreadable();
    notices.ledgerUnreadable();
    expect(deps.report).toHaveBeenCalledExactlyOnceWith("ws", {
      reason: "wake-runners-unreadable",
      message:
        "Your phone cannot wake agents here until it can. dohc keeps trying. If this stays, restore or repair the file in Details.",
      file: LEDGER,
    });
    workspaces = ["ws", "later"];
    notices.ledgerUnreadable();
    expect(deps.report.mock.calls.map(([id]) => id)).toEqual(["ws", "later"]);
    // The intent file's row is another row.
    notices.clear(null, "unreadable");
    expect(deps.clear).not.toHaveBeenCalled();
    notices.clearLedgerUnreadable();
    expect(deps.clear.mock.calls).toEqual([
      ["ws", "wake-runners-unreadable"],
      ["later", "wake-runners-unreadable"],
    ]);
  });
});

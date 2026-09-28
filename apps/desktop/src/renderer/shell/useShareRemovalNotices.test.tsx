// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellError } from "./useShellError";
import {
  SHARE_UNDO_EXPIRED,
  useShareRemovalNotices,
  type ShareRemoval,
} from "./useShareRemovalNotices";

const bridgeMock = { undoRelayShare: vi.fn() };
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

const removal = (overrides: Partial<ShareRemoval> = {}): ShareRemoval => ({
  workspaceId: "ws-a",
  shareId: "share-1",
  undo: { undoId: "undo-1", expiresAtMs: Date.now() + 600_000 },
  message: "Removed ana@example.com from team.",
  restoredMessage: "Restored ana@example.com to team.",
  ...overrides,
});

function renderNotices(workspaceId = "ws-a") {
  return renderHook(
    ({ id }) => {
      const shell = useShellError(id);
      const notices = useShareRemovalNotices({
        workspaceId: id,
        showSuccessNotice: shell.showSuccessNotice,
        reportShellFailure: shell.reportShellFailure,
      });
      return { shell, notices };
    },
    { initialProps: { id: workspaceId } },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.undoRelayShare.mockResolvedValue({ shareId: "share-1" });
});
afterEach(cleanup);

describe("useShareRemovalNotices", () => {
  it("files an already-ended notice without an Undo action or deadline", () => {
    const { result } = renderNotices();
    act(() => result.current.notices.removed(removal({undo: undefined, message: "This share has already ended."})));
    expect(result.current.shell.shellErrors).toHaveLength(1);
    expect(result.current.shell.shellErrors[0]).toMatchObject({
      tone: "success", message: "This share has already ended.", retry: null,
    });
    expect(result.current.shell.shellErrors[0]?.action).toBeUndefined();
  });

  it("files a notice with Undo that states the 10 minutes and stays as a row after the toast closes", async () => {
    const restored = vi.fn();
    const { result } = renderNotices();
    act(() => result.current.notices.removed(removal({ restored })));

    const [notice] = result.current.shell.shellErrors;
    expect(notice).toMatchObject({
      tone: "success",
      message: "Removed ana@example.com from team. You can undo this for 10 minutes.",
      retry: null,
      action: { label: "Undo", ends: true },
      seen: false,
    });

    // Closing the toast keeps the row and its Undo.
    act(() => result.current.shell.hideShellError(notice!.id));
    expect(result.current.shell.shellErrors[0]).toMatchObject({ id: notice!.id, seen: true });

    await act(async () => result.current.shell.runShellErrorAction(notice!.id));
    expect(bridgeMock.undoRelayShare).toHaveBeenCalledWith({ shareId: "share-1", undoId: "undo-1" });
    expect(restored).toHaveBeenCalledTimes(1);
    expect(result.current.shell.shellErrors.map((error) => [error.tone, error.message])).toEqual([
      ["success", "Restored ana@example.com to team."],
    ]);
  });

  it("reports a failed Undo with Try again and the cause, and Try again asks the relay again", async () => {
    const restored = vi.fn();
    bridgeMock.undoRelayShare
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'desktop:undo-relay-share': DaemonRefusalError [SHARE_UNAVAILABLE]: grant row missing",
      ))
      .mockResolvedValueOnce({ shareId: "share-1" });
    const { result } = renderNotices();
    act(() => result.current.notices.removed(removal({ restored })));

    await act(async () => result.current.shell.runShellErrorAction(result.current.shell.shellErrors[0]!.id));
    const failure = result.current.shell.shellErrors[0]!;
    expect(failure.tone).toBeUndefined();
    expect(failure.message).toBe("dohc could not undo this removal. This share is no longer available.");
    expect(failure.retry).not.toBeNull();
    expect(failure.details).toEqual([
      ["Cause", "DaemonRefusalError [SHARE_UNAVAILABLE]: grant row missing"],
    ]);
    expect(restored).not.toHaveBeenCalled();

    await act(async () => result.current.shell.retryShellError(failure.id));
    expect(bridgeMock.undoRelayShare).toHaveBeenCalledTimes(2);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(result.current.shell.shellErrors.map((error) => error.message)).toEqual([
      "Restored ana@example.com to team.",
    ]);
  });

  it("explains an Undo after the receipt expired instead of asking the relay", async () => {
    const { result } = renderNotices();
    act(() => result.current.notices.removed(removal({ undo: { undoId: "undo-1", expiresAtMs: Date.now() - 1 } })));

    await act(async () => result.current.shell.runShellErrorAction(result.current.shell.shellErrors[0]!.id));
    expect(bridgeMock.undoRelayShare).not.toHaveBeenCalled();
    expect(result.current.shell.shellErrors).toHaveLength(1);
    expect(result.current.shell.shellErrors[0]).toMatchObject({ message: SHARE_UNDO_EXPIRED, retry: null });
  });

  it("ignores a removal from another workspace and an Undo that lands after a switch", async () => {
    let finish!: (value: { shareId: string }) => void;
    bridgeMock.undoRelayShare.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderNotices();
    act(() => result.current.notices.removed(removal({ workspaceId: "ws-other" })));
    expect(result.current.shell.shellErrors).toEqual([]);

    act(() => result.current.notices.removed(removal()));
    act(() => result.current.shell.runShellErrorAction(result.current.shell.shellErrors[0]!.id));
    rerender({ id: "ws-b" });
    await act(async () => finish({ shareId: "share-1" }));
    expect(result.current.shell.shellErrors).toEqual([]);
  });

  // A removal the relay refused: the words name what did not happen, the
  // error's words say why, Try again runs the removal again, and Copy has
  // the cause. A failure for another workspace is dropped like a removal.
  it("files a refused removal with Try again and the cause", () => {
    const retry = vi.fn();
    const cause = new Error(
      "Error invoking remote method 'desktop:revoke-relay-share': DaemonRefusalError [OVERLOADED]: busy",
    );
    const { result } = renderNotices();
    act(() => result.current.notices.failed({ workspaceId: "ws-other", message: "dohc could not end this share.", cause }));
    expect(result.current.shell.shellErrors).toEqual([]);

    act(() => result.current.notices.failed({ workspaceId: "ws-a", message: "dohc could not end this share.", cause, retry }));
    expect(result.current.shell.shellErrors[0]).toMatchObject({
      message: "dohc could not end this share. dohc is busy. Try again in a moment.",
      details: [["Cause", "DaemonRefusalError [OVERLOADED]: busy"]],
    });
    act(() => result.current.shell.retryShellError(result.current.shell.shellErrors[0]!.id));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.shell.shellErrors).toEqual([]);
  });
});

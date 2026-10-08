// @vitest-environment jsdom
import { act, cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureRecoveryStatusResult } from "../../ipc/bridgeContract";
import { deferred, type Deferred } from "../../testing/deferred";
import { CAPTURE_RECOVERY_TITLE, captureRecoveryMessage, useCaptureRecoveryNotices } from "./useCaptureRecoveryNotices";
import { useShellError } from "./useShellError";

// These wait on async bridge answers; every wait runs until its condition
// holds, within the test's own budget.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Recovery = CaptureRecoveryStatusResult["captureRecoveries"][number];
const RECOVERY: Recovery = {
  momentId: "moment-capture-recovery-a", versionId: "main", objectId: "object-a", path: "notes/rich.md", captureMomentId: "capture-a",
};
// What main sends when History Restore refuses a file whose live binding is
// active: the engine's refusal, as the capture layer words it.
const SHARED_REFUSAL = new Error(
  "Error invoking remote method 'desktop:restore-engine-moment-file': LiveDocumentMutationError: dohc could not restore notes/rich.md. This action is unavailable for shared live files. Continue editing at the current location.",
);

function harness(initial: Recovery[]) {
  let listed = initial;
  const bridge = {
    getCaptureRecoveryStatus: vi.fn(async (_input: { workspaceId: string }): Promise<CaptureRecoveryStatusResult> => ({ captureRecoveries: listed })),
    clearCaptureRecovery: vi.fn(async ({ momentId }: { workspaceId: string; momentId: string }): Promise<void> => {
      listed = listed.filter((recovery) => recovery.momentId !== momentId);
    }),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  const openRecovery = vi.fn<(momentId: string, path: string) => void>();
  const rendered = renderHook(({ workspaceId }) => {
    const errors = useShellError(workspaceId);
    const notices = useCaptureRecoveryNotices({
      workspaceId,
      workspaceIsReady: true,
      show: errors.showCaptureRecoveries,
      reportShellError: errors.reportShellError,
      openRecovery,
    });
    return { ...errors, notices };
  }, { initialProps: { workspaceId: "ws-a" } });
  return {
    bridge,
    openRecovery,
    rendered,
    result: rendered.result,
    list: (recoveries: Recovery[]) => { listed = recoveries; },
  };
}

const recoveryRows = (h: ReturnType<typeof harness>) =>
  h.result.current.shellErrors.filter((error) => error.kind === "capture-recovery");

describe("useCaptureRecoveryNotices", () => {
  it("raises one notice per kept typing, in these words, and one again on a later read", async () => {
    const h = harness([RECOVERY]);
    await waitFor(() => expect(recoveryRows(h)).toHaveLength(1));
    const row = recoveryRows(h)[0]!;
    expect(row.title).toBe("Typing kept in History");
    expect(row.title).toBe(CAPTURE_RECOVERY_TITLE);
    expect(row.message).toBe(
      'The file "notes/rich.md" changed outside dohc. Your typing is in History. Open the recovery change and choose Restore.',
    );
    expect(row.message).toBe(captureRecoveryMessage("notes/rich.md", false));
    expect(row.identity).toBe("capture-recovery:moment-capture-recovery-a");
    expect(row.action?.label).toBe("Open History");
    expect(row.retry).toBeNull();
    expect(row.seen).toBe(false);
    expect(row.details).toEqual([["File", "notes/rich.md", 13], ["Change id", "moment-capture-recovery-a"]]);
    expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledWith({ workspaceId: "ws-a" });

    // A later read of the same list keeps the row and its toast state.
    act(() => h.result.current.hideShellError(row.id));
    await act(() => h.result.current.notices.refresh());
    expect(recoveryRows(h)).toEqual([{ ...row, seen: true }]);

    act(() => h.result.current.runShellErrorAction(row.id));
    expect(h.openRecovery).toHaveBeenCalledExactlyOnceWith("moment-capture-recovery-a", "notes/rich.md");
  });

  it("clears a dismissed notice in the engine, and no later read raises it again", async () => {
    const h = harness([RECOVERY]);
    await waitFor(() => expect(recoveryRows(h)).toHaveLength(1));
    // A read already on its way still lists the recovery when it answers.
    const late = deferred<CaptureRecoveryStatusResult>();
    h.bridge.getCaptureRecoveryStatus.mockImplementationOnce(() => late.promise);
    const reading = h.result.current.notices.refresh();

    act(() => h.result.current.dismissShellError(recoveryRows(h)[0]!.id));
    await waitFor(() => expect(h.bridge.clearCaptureRecovery).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-a", momentId: "moment-capture-recovery-a",
    }));
    await act(async () => {
      late.resolve({ captureRecoveries: [RECOVERY] });
      await reading;
    });
    expect(recoveryRows(h)).toEqual([]);

    await act(() => h.result.current.notices.refresh());
    expect(h.result.current.shellErrors).toEqual([]);
  });

  it("reports a dismissal the engine did not save, with Try again", async () => {
    const h = harness([RECOVERY]);
    await waitFor(() => expect(recoveryRows(h)).toHaveLength(1));
    h.bridge.clearCaptureRecovery.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    act(() => h.result.current.dismissShellError(recoveryRows(h)[0]!.id));
    await waitFor(() => expect(h.result.current.shellErrors).toHaveLength(1));
    const failure = h.result.current.shellErrors[0]!;
    expect(failure.message).toBe('dohc could not remove the notice about "notes/rich.md". The workspace engine is not running.');
    // The dismissed row stays dismissed while the engine still lists it.
    await act(() => h.result.current.notices.refresh());
    expect(recoveryRows(h)).toEqual([]);
    // Until the person tries its History Restore and the engine refuses it.
    act(() => { h.result.current.notices.restoreRefused("notes/rich.md", SHARED_REFUSAL); });
    expect(recoveryRows(h).map((row) => row.message)).toEqual([captureRecoveryMessage("notes/rich.md", true)]);

    act(() => h.result.current.retryShellError(failure.id));
    await waitFor(() => expect(h.bridge.clearCaptureRecovery).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.result.current.shellErrors).toEqual([]));
  });

  it("drops the row once a restore cleared the recovery in the engine", async () => {
    const h = harness([RECOVERY]);
    await waitFor(() => expect(recoveryRows(h)).toHaveLength(1));
    h.list([]);
    await act(() => h.result.current.notices.refresh());
    expect(h.result.current.shellErrors).toEqual([]);
    expect(h.bridge.clearCaptureRecovery).not.toHaveBeenCalled();
  });

  it("answers every shared live refusal on the kept typing's one row, and keeps the recovery", async () => {
    const other: Recovery = { ...RECOVERY, momentId: "moment-capture-recovery-b", path: "notes/other.md" };
    const h = harness([RECOVERY, other]);
    await waitFor(() => expect(recoveryRows(h)).toHaveLength(2));
    const before = recoveryRows(h).find((row) => row.identity === "capture-recovery:moment-capture-recovery-a")!;
    expect(before.tone).toBe("warning");
    act(() => h.result.current.hideShellError(before.id));

    // Another failure, or a file with no kept typing, stays the caller's.
    expect(h.result.current.notices.restoreRefused("notes/rich.md", new Error("Could not read the current notes/rich.md on disk."))).toBe(false);
    expect(h.result.current.notices.restoreRefused("notes/none.md", SHARED_REFUSAL)).toBe(false);

    let took = false;
    act(() => { took = h.result.current.notices.restoreRefused("notes/rich.md", SHARED_REFUSAL); });
    expect(took).toBe(true);
    const shared = recoveryRows(h).find((row) => row.identity === "capture-recovery:moment-capture-recovery-a")!;
    expect(shared.message).toBe(
      'The file "notes/rich.md" changed outside dohc. Your typing is in History. The file is shared live, so replace its text with your version from the recovery change.',
    );
    expect(shared.message).not.toContain("Restore shared file");
    expect(shared.title).toBe(CAPTURE_RECOVERY_TITLE);
    expect(shared.tone).toBe("warning");
    expect(shared.action?.label).toBe("Open History");
    expect(shared.seen).toBe(false);
    expect(recoveryRows(h)).toHaveLength(2);
    expect(recoveryRows(h).find((row) => row.identity === "capture-recovery:moment-capture-recovery-b")!.message)
      .toBe(captureRecoveryMessage("notes/other.md", false));

    // A later refusal is answered too: the toast again, from the same one row.
    act(() => h.result.current.hideShellError(shared.id));
    act(() => { took = h.result.current.notices.restoreRefused("notes/rich.md", SHARED_REFUSAL); });
    expect(took).toBe(true);
    expect(recoveryRows(h)).toHaveLength(2);
    const again = recoveryRows(h).find((row) => row.identity === "capture-recovery:moment-capture-recovery-a")!;
    expect(again.seen).toBe(false);
    expect(again.message).toBe(shared.message);
    // A read in between raises nothing on its own.
    act(() => h.result.current.hideShellError(again.id));
    await act(() => h.result.current.notices.refresh());
    expect(recoveryRows(h).find((row) => row.identity === "capture-recovery:moment-capture-recovery-a")).toEqual({ ...again, seen: true });

    // Only a dismissal or a History Restore of the change clears it.
    await act(() => h.result.current.notices.refresh());
    expect(recoveryRows(h)).toHaveLength(2);
    expect(h.bridge.clearCaptureRecovery).not.toHaveBeenCalled();
  });

  it("words later kept typing at a file afresh once its refused recovery is gone", async () => {
    const h = harness([RECOVERY]);
    await waitFor(() => expect(recoveryRows(h)).toHaveLength(1));
    act(() => { h.result.current.notices.restoreRefused("notes/rich.md", SHARED_REFUSAL); });
    expect(recoveryRows(h)[0]!.message).toBe(captureRecoveryMessage("notes/rich.md", true));

    // Dismissed, then a later restart keeps new typing at the same file.
    act(() => h.result.current.dismissShellError(recoveryRows(h)[0]!.id));
    await waitFor(() => expect(h.bridge.clearCaptureRecovery).toHaveBeenCalledOnce());
    await waitFor(() => expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledTimes(2));
    h.list([{ ...RECOVERY, momentId: "moment-capture-recovery-later" }]);
    await act(() => h.result.current.notices.refresh());
    expect(recoveryRows(h).map((row) => [row.identity, row.message])).toEqual([
      ["capture-recovery:moment-capture-recovery-later", captureRecoveryMessage("notes/rich.md", false)],
    ]);
  });

  it("raises nothing for a status that answers after the workspace changed", async () => {
    const h = harness([]);
    const answers: Deferred<CaptureRecoveryStatusResult>[] = [];
    h.bridge.getCaptureRecoveryStatus.mockImplementation(() => {
      const answer = deferred<CaptureRecoveryStatusResult>();
      answers.push(answer);
      return answer.promise;
    });
    void h.result.current.notices.refresh();
    await waitFor(() => expect(answers).toHaveLength(1));

    h.rendered.rerender({ workspaceId: "ws-b" });
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenLastCalledWith({ workspaceId: "ws-b" });
    await act(async () => answers[0]!.resolve({ captureRecoveries: [RECOVERY] }));
    expect(h.result.current.shellErrors).toEqual([]);

    // The new workspace's own answer still raises its notice.
    await act(async () => answers[1]!.resolve({ captureRecoveries: [{ ...RECOVERY, momentId: "moment-capture-recovery-b" }] }));
    expect(recoveryRows(h).map((row) => row.identity)).toEqual(["capture-recovery:moment-capture-recovery-b"]);
  });
});

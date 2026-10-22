// @vitest-environment jsdom
import { act, cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureRecoveryStatusResult, ReadEngineMomentResult } from "../../ipc/bridgeContract";
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
  momentId: "moment-capture-recovery-a", versionId: "main", objectId: "object-a", path: "notes/rich.md", captureMomentId: "capture-a", deleted: false,
};
// What main sends when History Restore refuses a file whose live binding is
// active: the engine's refusal, as the capture layer words it.
const SHARED_REFUSAL = new Error(
  "Error invoking remote method 'desktop:restore-engine-moment-file': LiveDocumentMutationError: dohc could not restore notes/rich.md. This action is unavailable for shared live files. Continue editing at the current location.",
);

function harness(initial: Recovery[]) {
  let listed = initial;
  const bridge = {
    readEngineMoment: vi.fn(async ({momentId}: {workspaceId: string; momentId: string}): Promise<ReadEngineMomentResult> => ({moment: {
      id: momentId, versionId: "main", path: RECOVERY.path, recordedAtMs: 1,
      operation: "write", origin: "capture-recovery", correlationId: RECOVERY.captureMomentId,
      beforeText: "kept typing", afterText: "disk text",
    }})),
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
  it("uses the newest list before committing a Copy fallback, then follows an external restore", async () => {
    const h=harness([]);await waitFor(()=>expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledOnce());
    const stale=deferred<CaptureRecoveryStatusResult>();
    const moment=deferred<ReadEngineMomentResult>();
    h.bridge.getCaptureRecoveryStatus.mockImplementationOnce(()=>stale.promise);
    h.bridge.readEngineMoment.mockImplementationOnce(()=>moment.promise);
    const importing=h.result.current.notices.imported(RECOVERY.momentId,RECOVERY.path);
    h.list([RECOVERY]);
    await act(async()=>{await h.result.current.notices.refresh();stale.resolve({captureRecoveries:[]});});
    // If the superseded read still starts metadata reads, let them finish.
    await act(async()=>{moment.resolve({moment:{id:RECOVERY.momentId,versionId:"main",path:RECOVERY.path,
      recordedAtMs:1,operation:"write",origin:"capture-recovery",correlationId:RECOVERY.captureMomentId,
      beforeText:"kept typing",afterText:"disk text"}});await importing;});
    expect(recoveryRows(h)).toHaveLength(1);
    h.list([]);
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(0);
  });

  it("checks the latest list again when activity finishes during the moment reads", async () => {
    const h=harness([]);await waitFor(()=>expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledOnce());
    const answer=deferred<ReadEngineMomentResult>();
    h.bridge.readEngineMoment.mockImplementationOnce(()=>answer.promise);
    const importing=h.result.current.notices.imported(RECOVERY.momentId,RECOVERY.path);
    await waitFor(()=>expect(h.bridge.readEngineMoment).toHaveBeenCalledOnce());
    h.list([RECOVERY]);
    await act(async()=>{await h.result.current.notices.refresh();answer.resolve({moment:{id:RECOVERY.momentId,
      versionId:"main",path:RECOVERY.path,recordedAtMs:1,operation:"write",origin:"capture-recovery",
      correlationId:RECOVERY.captureMomentId,beforeText:"kept typing",afterText:"disk text"}});await importing;});
    h.list([]);
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(0);
  });

  it("lets two quick Copies on different moments both finish", async () => {
    const h=harness([]);await waitFor(()=>expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledOnce());
    const first=deferred<ReadEngineMomentResult>(),second=deferred<ReadEngineMomentResult>();
    h.bridge.readEngineMoment.mockImplementation(async({momentId})=>{
      if(momentId === "first") return first.promise;
      if(momentId === "second") return second.promise;
      return {moment:{id:momentId,versionId:"main",path:"notes/other.md",recordedAtMs:1,operation:"write",
        origin:"local-file",beforeText:"before",afterText:"after"}};
    });
    const one=h.result.current.notices.imported("first","first.md");
    const two=h.result.current.notices.imported("second","second.md");
    await waitFor(()=>expect(h.bridge.readEngineMoment).toHaveBeenCalledTimes(2));
    const detail=(id:string):ReadEngineMomentResult=>({moment:{id,versionId:"main",path:`${id}.md`,
      recordedAtMs:1,operation:"write",origin:"capture-recovery-cleared",correlationId:`capture-${id}`,
      beforeText:"kept typing",afterText:"disk text"}});
    await act(async()=>{second.resolve(detail("second"));await two;});
    await act(async()=>{first.resolve(detail("first"));await one;});
    expect(recoveryRows(h).map(row=>row.identity).sort()).toEqual(["capture-recovery:first","capture-recovery:second"]);
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(2);
  });

  it.each([false,true])("keeps one existing recovery row when Copy finds a recovery kept only in History, deleted=%s", async deleted => {
    const h=harness([{...RECOVERY,deleted}]);
    await waitFor(()=>expect(recoveryRows(h)).toHaveLength(1));const row=recoveryRows(h)[0]!;
    act(()=>h.result.current.hideShellError(row.id));
    await act(async()=>{await h.result.current.notices.imported(RECOVERY.momentId,RECOVERY.path);});
    expect(recoveryRows(h)).toHaveLength(1);
    expect(recoveryRows(h)[0]).toMatchObject({seen:false,message:captureRecoveryMessage(RECOVERY.path,false,deleted)});
    expect(h.bridge.readEngineMoment).not.toHaveBeenCalled();
    act(()=>h.result.current.runShellErrorAction(recoveryRows(h)[0]!.id));
    expect(h.openRecovery).toHaveBeenCalledExactlyOnceWith(RECOVERY.momentId,RECOVERY.path);
  });

  it.each([false, true])("keeps a cleared moment's normal words until its fallback is opened (deleted=%s)", async deleted => {
    const h=harness([]);await waitFor(()=>expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledOnce());
    h.bridge.readEngineMoment.mockImplementation(async ({momentId}) => ({moment: {
      id: momentId, versionId: "main", path: "deleted.md", recordedAtMs: 1,
      operation: momentId === RECOVERY.captureMomentId && deleted ? "delete" : "write",
      origin: "capture-recovery-cleared", correlationId: RECOVERY.captureMomentId,
      beforeText: "kept typing", afterText: "disk text",
    }}));
    await act(async()=>{await h.result.current.notices.imported(RECOVERY.momentId,"deleted.md");});
    const row=recoveryRows(h)[0]!;
    expect(row).toMatchObject({title:CAPTURE_RECOVERY_TITLE,seen:false,message:captureRecoveryMessage("deleted.md",false,deleted),action:{label:"Open History"}});
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(1);
    act(()=>h.result.current.runShellErrorAction(row.id));
    expect(h.openRecovery).toHaveBeenCalledExactlyOnceWith(RECOVERY.momentId,"deleted.md");
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(0);
    expect(h.bridge.clearCaptureRecovery).not.toHaveBeenCalled();
  });

  it("retires only the restored Copy fallback and keeps it through unrelated status refreshes", async () => {
    const h=harness([]);await waitFor(()=>expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledOnce());
    await act(async()=>{await h.result.current.notices.imported(RECOVERY.momentId,RECOVERY.path);});
    expect(recoveryRows(h)).toHaveLength(1);
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(1);
    act(()=>h.result.current.notices.restored("another-moment"));
    expect(recoveryRows(h)).toHaveLength(1);
    act(()=>h.result.current.notices.restored(RECOVERY.momentId));
    expect(recoveryRows(h)).toHaveLength(0);
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(0);
  });

  it("raises only the requested change when two recoveries have the same path", async () => {
    const other={...RECOVERY,momentId:"other-moment"};
    const h=harness([RECOVERY,other]);
    await waitFor(()=>expect(recoveryRows(h)).toHaveLength(2));
    for(const row of recoveryRows(h)) act(()=>h.result.current.hideShellError(row.id));
    await act(async()=>{await h.result.current.notices.imported(RECOVERY.momentId,RECOVERY.path);});
    expect(recoveryRows(h).find(row=>row.identity === `capture-recovery:${RECOVERY.momentId}`)?.seen).toBe(false);
    expect(recoveryRows(h).find(row=>row.identity === `capture-recovery:${other.momentId}`)?.seen).toBe(true);
  });

  it("keeps a dismissed Copy fallback closed through activity refreshes", async () => {
    const h=harness([]);await waitFor(()=>expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledOnce());
    await act(async()=>{await h.result.current.notices.imported(RECOVERY.momentId,RECOVERY.path);});
    act(()=>h.result.current.dismissShellError(recoveryRows(h)[0]!.id));
    await waitFor(()=>expect(h.bridge.clearCaptureRecovery).toHaveBeenCalledOnce());
    await act(async()=>{await h.result.current.notices.refresh();});
    expect(recoveryRows(h)).toHaveLength(0);
  });

  it("does not publish fallback metadata after a workspace switch", async () => {
    const h=harness([]);await waitFor(()=>expect(h.bridge.getCaptureRecoveryStatus).toHaveBeenCalledOnce());
    const answer=deferred<ReadEngineMomentResult>();
    h.bridge.readEngineMoment.mockImplementationOnce(()=>answer.promise);
    const importing=h.result.current.notices.imported(RECOVERY.momentId,RECOVERY.path);
    await waitFor(()=>expect(h.bridge.readEngineMoment).toHaveBeenCalledOnce());
    h.rendered.rerender({workspaceId:"ws-b"});
    await act(async()=>{answer.resolve({moment:null});await importing;});
    expect(recoveryRows(h)).toHaveLength(0);
    expect(h.openRecovery).not.toHaveBeenCalled();
  });

  it("raises one notice per kept typing, in these words, and one again on a later read", async () => {
    const h = harness([RECOVERY]);
    await waitFor(() => expect(recoveryRows(h)).toHaveLength(1));
    const row = recoveryRows(h)[0]!;
    expect(row.title).toBe("Text kept in History");
    expect(row.title).toBe(CAPTURE_RECOVERY_TITLE);
    expect(row.message).toBe(
      'The file "notes/rich.md" changed outside dohc. Your text is in History. Open the recovery change and choose Restore.',
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
      'The file "notes/rich.md" changed outside dohc. Your text is in History. The file is shared live, so replace its text with your version from the recovery change.',
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

it("names deletion and the recovery Restore that recreates the file", () => {
 expect(captureRecoveryMessage("notes/deleted.md",false,true)).toBe('The file "notes/deleted.md" was deleted. Your text is in History. Open the recovery change and choose Restore to recreate the file.');
});

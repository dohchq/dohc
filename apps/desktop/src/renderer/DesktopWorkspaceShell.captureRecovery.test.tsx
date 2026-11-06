// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CaptureRecoveryStatusResult, EngineMomentRecord, ListHistoryPayload, ReadEngineMomentResult } from "../ipc/bridgeContract";
import type { OwnerRestoreRequest } from "../ipc/ownerRestoreContract";
import { deferred, type Deferred } from "../testing/deferred";
import { timelinePage } from "../testing/historyPageFixture";
import { CAPTURE_RECOVERY_TITLE, captureRecoveryMessage } from "./shell/useCaptureRecoveryNotices";
import type { Workspace } from "./DesktopWorkspaceShell";
import { DesktopWorkspaceShell, OTHER_WORKSPACE, WORKSPACE, makeBridge, renderShell, shellBootstrapProps } from "./DesktopWorkspaceShell.testHarness";

const PATH = "notes/plan.md";
const RECOVERY = {
  momentId: "moment-capture-recovery-a", versionId: "main", objectId: "object-plan", path: PATH, captureMomentId: "capture-a", deleted: false,
};
const RECOVERY_MOMENT: EngineMomentRecord = {
  id: RECOVERY.momentId, versionId: "main", path: PATH, recordedAtMs: 100, operation: "write", origin: "capture-recovery", momentOrder: 2,
};
const page = (workspaceId: string, moments: EngineMomentRecord[]) =>
  timelinePage(moments.map((moment) => ({ kind: "file", moment })), { workspaceId });
// What main sends when History Restore refuses a file whose live binding is
// active, as on a replicated lineage: the engine's refusal in the capture
// layer's words.
const SHARED_REFUSAL = new Error(
  `Error invoking remote method 'desktop:restore-engine-moment-file': LiveDocumentMutationError: dohc could not restore ${PATH}. This action is unavailable for shared live files. Continue editing at the current location.`,
);

// A workspace whose engine lists one kept typing until something clears it.
function recoveryBridge() {
  const bridge = makeBridge(Promise.resolve(null));
  let listed: CaptureRecoveryStatusResult["captureRecoveries"] = [RECOVERY];
  bridge.getCaptureRecoveryStatus.mockImplementation(async () => ({ captureRecoveries: listed }));
  bridge.clearCaptureRecovery.mockImplementation(async ({ momentId }) => {
    listed = listed.filter((recovery) => recovery.momentId !== momentId);
  });
  bridge.listHistory = vi.fn(async ({ workspaceId }: ListHistoryPayload) => page(workspaceId, [RECOVERY_MOMENT]));
  bridge.readEngineMoment = vi.fn(async () => ({
    moment: { ...RECOVERY_MOMENT, beforeText: "Typing kept here.\n", afterText: "Written outside dohc.\n" },
  }));
  return { bridge, clear: () => { listed = []; } };
}

// Nothing failed, so the kept typing's toast is a notice, in the warning tone.
const NOTICE_TOAST = "workspace-shell-notice";

async function openRecoveryFromToast(user: ReturnType<typeof userEvent.setup>) {
  const toast = await screen.findByTestId(NOTICE_TOAST);
  const action = within(toast).getByTestId("workspace-shell-error-action");
  expect(action.textContent).toBe("Open History");
  await user.click(action);
  const diff = await screen.findByTestId("engine-moment-diff-page");
  expect(diff.getAttribute("data-moment-id")).toBe(RECOVERY.momentId);
  return diff;
}

const shownRows = () => screen.queryAllByRole("listitem").filter((row) => row.hasAttribute("data-notice-row"));

async function noticeRows(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("notice-center-toggle"));
  return shownRows();
}

describe("text kept in History", () => {
  it("keeps Copy's fallback through activity refreshes during and after the moment reads", async () => {
    const {bridge,clear}=recoveryBridge();clear();
    let copied=false;
    const restore=vi.fn(async()=>({restored:"text" as const,restoredMomentId:"restore-copy",path:PATH}));
    Object.assign(bridge,{typingRecovery:vi.fn(async(input:{action:string})=>{
      if(input.action === "copy") {copied=true;bridge.emitWorkspaceActivity();return {failures:[],outcome:"imported" as const,momentId:RECOVERY.momentId};}
      return {failures:copied ? [] : [{kind:"import" as const,path:PATH,detail:"invalid-author",reason:"invalid-author" as const,retryable:false,checkpointId:"copy-fallback"}]};
    }),restoreEngineMomentFile:restore});
    const answer=deferred<ReadEngineMomentResult>();
    bridge.readEngineMoment.mockImplementationOnce(()=>answer.promise);
    const user=userEvent.setup();renderShell(bridge);
    const toast=await screen.findByTestId("workspace-shell-error");
    const copy=within(toast).getByTestId("workspace-shell-error-action");
    expect(copy.textContent).toBe("Copy your typing");
    await user.click(copy);
    await waitFor(()=>expect(bridge.readEngineMoment).toHaveBeenCalledOnce());
    const duringReads=bridge.getCaptureRecoveryStatus.mock.calls.length;
    act(()=>bridge.emitWorkspaceActivity());
    await waitFor(()=>expect(bridge.getCaptureRecoveryStatus.mock.calls.length).toBeGreaterThan(duringReads));
    await act(async()=>{answer.resolve({moment:{...RECOVERY_MOMENT,correlationId:RECOVERY.captureMomentId,beforeText:"Typing kept here.\n",afterText:"Written outside dohc.\n"}});});
    await waitFor(()=>expect(screen.getByTestId(NOTICE_TOAST).textContent).toContain(CAPTURE_RECOVERY_TITLE));
    const afterCopy=bridge.getCaptureRecoveryStatus.mock.calls.length;
    act(()=>bridge.emitWorkspaceActivity());
    await waitFor(()=>expect(bridge.getCaptureRecoveryStatus.mock.calls.length).toBeGreaterThan(afterCopy));
    expect(screen.getByTestId(NOTICE_TOAST).textContent).toContain(CAPTURE_RECOVERY_TITLE);
    expect((await noticeRows(user)).filter(row=>row.textContent?.includes(CAPTURE_RECOVERY_TITLE))).toHaveLength(1);
    await user.click(screen.getByTestId("notice-center-toggle"));
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    await user.click(await screen.findByTestId("engine-diff-restore-file"));
    await waitFor(()=>expect(restore).toHaveBeenCalledWith({workspaceId:WORKSPACE.workspaceId,momentId:RECOVERY.momentId}));
    await waitFor(()=>expect(screen.queryByTestId(NOTICE_TOAST)).toBeNull());
    expect(await noticeRows(user)).toEqual([]);
  });

  it("raises its notice on open, and Open History opens History with the recovery change", async () => {
    const { bridge } = recoveryBridge();
    const user = userEvent.setup();
    renderShell(bridge);
    const toast = await screen.findByTestId(NOTICE_TOAST);
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.querySelector("svg.text-warning")).toBeTruthy();
    expect(toast.textContent).toContain(CAPTURE_RECOVERY_TITLE);
    expect(toast.textContent).toContain(
      'The file "notes/plan.md" changed outside dohc. Your text is in History. Open the recovery change and choose Restore.',
    );
    expect(within(toast).getByRole("button", { name: "Copy notice details" })).toBeTruthy();
    expect(within(toast).queryByTestId("workspace-shell-error-retry")).toBeNull();
    expect(bridge.getCaptureRecoveryStatus).toHaveBeenCalledWith({ workspaceId: WORKSPACE.workspaceId });

    await openRecoveryFromToast(user);
    expect(screen.getByTestId("activity-history").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId(`tab-dohc://moment-diff/${RECOVERY.momentId}`)).toBeTruthy();
    expect(screen.getByTestId("engine-diff-source").textContent).toBe("Text kept");
    expect(screen.getByTestId("engine-diff-lines").textContent).toContain("Typing kept here.");

    // The change gives the kept file back whole, beside the diff it shows.
    await user.click(screen.getByRole("button", { name: "Copy your version" }));
    expect(await navigator.clipboard.readText()).toBe("Typing kept here.\n");
  });

  it("opens History with the recovery change from its Notices row, as its Open History does", async () => {
    const { bridge } = recoveryBridge();
    const user = userEvent.setup();
    renderShell(bridge);
    await screen.findByTestId(NOTICE_TOAST);
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = within(screen.getByTestId("notice-center")).getByText(CAPTURE_RECOVERY_TITLE).closest("li")!;
    await user.click(row.querySelector<HTMLElement>("[data-notice-open]")!);
    await screen.findByTestId("engine-moment-diff-page");
    expect(screen.getByTestId("activity-history").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId(`tab-dohc://moment-diff/${RECOVERY.momentId}`)).toBeTruthy();
  });

  it("drops the notice once its Restore clears the recovery in the engine", async () => {
    const { bridge, clear } = recoveryBridge();
    Object.assign(bridge, {
      restoreEngineMomentFile: vi.fn(async () => {
        clear();
        return { restored: "text" as const, restoredMomentId: "restore-1", path: PATH };
      }),
    });
    const user = userEvent.setup();
    renderShell(bridge);
    await openRecoveryFromToast(user);
    await user.click(screen.getByTestId("engine-diff-restore-file"));
    expect((await screen.findByTestId("engine-diff-restore-status")).textContent).toBe(
      "Restored the earlier state. Undo restore is available here.",
    );
    await waitFor(() => expect(screen.queryByTestId(NOTICE_TOAST)).toBeNull());
    expect(await noticeRows(user)).toEqual([]);
    expect(bridge.clearCaptureRecovery).not.toHaveBeenCalled();
  });

  it("clears a dismissed notice in the engine, so neither the next read nor a relaunch raises it", async () => {
    const { bridge } = recoveryBridge();
    const user = userEvent.setup();
    const view = renderShell(bridge);
    await screen.findByTestId(NOTICE_TOAST);
    const [row] = await noticeRows(user);
    expect(row!.textContent).toContain(CAPTURE_RECOVERY_TITLE);
    expect(within(row!).getByRole("button", { name: "Copy notice details" })).toBeTruthy();
    await user.click(within(row!).getByRole("button", { name: "Dismiss notice" }));
    await waitFor(() => expect(bridge.clearCaptureRecovery).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE.workspaceId, momentId: RECOVERY.momentId,
    }));

    const reads = bridge.getCaptureRecoveryStatus.mock.calls.length;
    act(() => bridge.emitWorkspaceActivity());
    await waitFor(() => expect(bridge.getCaptureRecoveryStatus.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => {});
    expect(screen.queryByTestId(NOTICE_TOAST)).toBeNull();
    expect(shownRows()).toEqual([]);

    view.unmount();
    const relaunchReads = bridge.getCaptureRecoveryStatus.mock.calls.length;
    renderShell(bridge);
    await waitFor(() => expect(bridge.getCaptureRecoveryStatus.mock.calls.length).toBeGreaterThan(relaunchReads));
    await act(async () => {});
    expect(screen.queryByTestId(NOTICE_TOAST)).toBeNull();
    expect(await noticeRows(user)).toEqual([]);
  });

  // A shared live document's lineage is replicated, so History Restore
  // refuses it. Kept typing is in none of the host's accepted changes, so
  // the notice says to replace the file's text with the kept version.
  it("tells a replicated lineage's owner to put the kept version in, on every refusal", async () => {
    const { bridge } = recoveryBridge();
    const ownerRestore = vi.fn(async (input: OwnerRestoreRequest): Promise<unknown> => {
      if (input.action === "unfinished") return { restores: [], unreadable: 0, nextCursor: null };
      throw new Error(`Unexpected owner restore action ${input.action}.`);
    });
    const restoreEngineMomentFile = vi.fn(async (): Promise<never> => { throw SHARED_REFUSAL; });
    Object.assign(bridge, { ownerRestore, restoreEngineMomentFile });
    const user = userEvent.setup();
    renderShell(bridge);
    await openRecoveryFromToast(user);
    await user.click(screen.getByRole("button", { name: "Dismiss workspace notice" }));

    const refuse = async () => {
      await user.click(screen.getByTestId("engine-diff-restore-file"));
    };
    await refuse();
    const toast = await screen.findByTestId(NOTICE_TOAST);
    expect(toast.textContent).toContain(CAPTURE_RECOVERY_TITLE);
    expect(toast.textContent).toContain(
      'The file "notes/plan.md" changed outside dohc. Your text is in History. The file is shared live, so replace its text with your version from the recovery change.',
    );
    expect(toast.textContent).toContain(captureRecoveryMessage(PATH, true));
    expect(toast.textContent).not.toContain("Restore shared file");
    expect(restoreEngineMomentFile).toHaveBeenCalledOnce();
    // The refusal is this notice's, not a second row about the same restore.
    const rows = await noticeRows(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).not.toContain("Continue editing at the current location");
    await user.click(screen.getByTestId("notice-center-toggle"));

    // The route the notice names works: the kept version comes back whole.
    await user.click(screen.getByRole("button", { name: "Copy your version" }));
    expect(await navigator.clipboard.readText()).toBe("Typing kept here.\n");

    // A second refusal is answered too, from the same one row.
    await user.click(within(screen.getByTestId(NOTICE_TOAST)).getByRole("button", { name: "Dismiss workspace notice" }));
    expect(screen.queryByTestId(NOTICE_TOAST)).toBeNull();
    await refuse();
    await waitFor(() => expect(restoreEngineMomentFile).toHaveBeenCalledTimes(2));
    expect((await screen.findByTestId(NOTICE_TOAST)).textContent).toContain(captureRecoveryMessage(PATH, true));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(await noticeRows(user)).toHaveLength(1);
    await user.click(screen.getByTestId("notice-center-toggle"));

    // More offers no Restore shared file (#3090), so the notice's route is the way back.
    await user.click(screen.getByTestId("engine-diff-more"));
    expect(screen.queryByTestId("engine-diff-shared-restore")).toBeNull();
    expect(bridge.clearCaptureRecovery).not.toHaveBeenCalled();
  });

  it("raises nothing for a status that answers after the window changed workspaces", async () => {
    const bridge = makeBridge(Promise.resolve(null));
    const answers: Deferred<CaptureRecoveryStatusResult>[] = [];
    bridge.getCaptureRecoveryStatus.mockImplementation(() => {
      const answer = deferred<CaptureRecoveryStatusResult>();
      answers.push(answer);
      return answer.promise;
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const shell = (workspace: Workspace) => (
      <DesktopWorkspaceShell
        workspace={workspace}
        workspaces={[WORKSPACE, OTHER_WORKSPACE]}
        {...shellBootstrapProps(bridge)}
        onSwitchWorkspace={() => {}}
      />
    );
    const view = render(shell(WORKSPACE));
    await waitFor(() => expect(answers).toHaveLength(1));
    view.rerender(shell(OTHER_WORKSPACE));
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(bridge.getCaptureRecoveryStatus).toHaveBeenLastCalledWith({ workspaceId: OTHER_WORKSPACE.workspaceId });

    await act(async () => answers[0]!.resolve({ captureRecoveries: [RECOVERY] }));
    expect(screen.queryByText(CAPTURE_RECOVERY_TITLE)).toBeNull();
    await act(async () => answers[1]!.resolve({ captureRecoveries: [] }));
    expect(screen.queryByTestId(NOTICE_TOAST)).toBeNull();
  });
});

describe("History Restore on a shared live file", () => {
  // With no kept typing to take it, the refusal gets its own row. It says
  // where the text is and offers no Try again, since asking again gets the
  // same answer. What to do is the body, so a long path's title clamp never
  // hides it. A second press replaces the row.
  it.each([PATH, "Projects/Lisbon trip/itinerary.md"])("says where the text is in %s, offers no Try again, and keeps one row per file", async (path) => {
    const { bridge, clear } = recoveryBridge();
    clear();
    const change: EngineMomentRecord = { ...RECOVERY_MOMENT, id: "moment-plan", origin: "local-file", path };
    bridge.listHistory = vi.fn(async ({ workspaceId }: ListHistoryPayload) => page(workspaceId, [change]));
    bridge.readEngineMoment = vi.fn(async () => ({ moment: { ...change, beforeText: "Earlier plan.\n", afterText: "Shared plan.\n" } }));
    const restoreEngineMomentFile = vi.fn(async (): Promise<never> => { throw SHARED_REFUSAL; });
    Object.assign(bridge, { restoreEngineMomentFile });
    const user = userEvent.setup();
    renderShell(bridge);
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    const title = `dohc can't restore "${path}" because it has been shared live`;
    const body = "Copy the text you want from History into the file.";
    // The title and body as shown, with no Show more.
    const expectWords = (notice: HTMLElement) => {
      expect(notice.querySelector("[id$='-title']")?.textContent).toBe(title);
      expect(notice.querySelector("[id$='-body']")?.textContent).toBe(body);
      expect(notice.querySelector("[data-testid$='-more']")).toBeNull();
    };
    for (const press of [1, 2]) {
      await user.click(await screen.findByTestId("engine-diff-restore-file"));
      await waitFor(() => expect(restoreEngineMomentFile).toHaveBeenCalledTimes(press));
      const toast = await screen.findByTestId("workspace-shell-error");
      expectWords(toast);
      expect(toast.textContent).not.toContain("Continue editing at the current location");
      expect(within(toast).queryByTestId("workspace-shell-error-retry")).toBeNull();
      const rows = await noticeRows(user);
      expect(rows).toHaveLength(1);
      expectWords(rows[0]!);
      expect(within(rows[0]!).queryByRole("button", { name: "Try again" })).toBeNull();
      await user.click(screen.getByTestId("notice-center-toggle"));
    }
  });
});

describe("Unfinished shared restores", () => {
  // Retry on an unfinished shared restore says "File restored" but never
  // reaches the file, and Decline doesn't bring live editing back, so the
  // shell lists none and files no row (#3090).
  it("lists no unfinished shared restore and files no Notices row for one", async () => {
    const { bridge, clear } = recoveryBridge();
    clear();
    const ownerRestore = vi.fn(async (input: OwnerRestoreRequest): Promise<unknown> => {
      if (input.action === "unfinished") {
        return { restores: [{ operationId: "restore-old", path: PATH, phase: "native-fenced", proposalDigest: null }], unreadable: 0, nextCursor: null };
      }
      throw new Error(`Unexpected owner restore action ${input.action}.`);
    });
    Object.assign(bridge, { ownerRestore });
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.getCaptureRecoveryStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(ownerRestore).not.toHaveBeenCalled();
    expect(screen.queryByText("Restore waiting")).toBeNull();
    expect(await noticeRows(user)).toEqual([]);
  });
});

describe("History Restore on a page this computer owns live", () => {
  // The owner stops live editing in Live documents, then restores again.
  it("says to stop live editing, offers Try again and Live documents at the page's row", async () => {
    const { bridge, clear } = recoveryBridge();
    clear();
    const change: EngineMomentRecord = { ...RECOVERY_MOMENT, id: "moment-owned", origin: "local-file", path: PATH };
    bridge.listHistory = vi.fn(async ({ workspaceId }: ListHistoryPayload) => page(workspaceId, [change]));
    bridge.readEngineMoment = vi.fn(async () => ({ moment: { ...change, beforeText: "Earlier plan.\n", afterText: "Owned plan.\n" } }));
    const restoreEngineMomentFile = vi.fn(async (): Promise<never> => {
      throw new Error(`Error invoking remote method 'desktop:restore-engine-moment-file': LivePageOwnedError: dohc can't restore "${PATH}" while it has live editing on\nIn Live documents, stop live editing for this page, then restore it again.`);
    });
    bridge.listOwnerLiveDocuments = vi.fn(async () => ({ nextCursor: null, documents: [
      { path: PATH, objectId: "object-plan", status: "ready" as const, canResume: false }] }));
    Object.assign(bridge, { restoreEngineMomentFile });
    const user = userEvent.setup();
    renderShell(bridge);
    await user.click(screen.getByTestId("activity-history"));
    await user.click(await screen.findByTestId("engine-moment-open"));
    await user.click(await screen.findByTestId("engine-diff-restore-file"));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.querySelector("[id$='-title']")?.textContent).toBe(`dohc can't restore "${PATH}" while it has live editing on`);
    expect(toast.querySelector("[id$='-body']")?.textContent).toBe("In Live documents, stop live editing for this page, then restore it again.");
    expect(within(toast).queryByRole("button", { name: /Stop/u })).toBeNull();
    const rows = await noticeRows(user);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(within(rows[0]!).getByRole("button", { name: "Open Live documents" }));
    const dialog = await screen.findByTestId("live-documents-dialog");
    await waitFor(() => expect(within(dialog).getByTestId(`live-document-row-${PATH}`).getAttribute("aria-current")).toBe("true"));
  });
});

// @vitest-environment jsdom
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useShellError } from "./shell/useShellError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, useMemo, useRef, useState } from "react";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";
import { createAutomationButtons } from "./collections/useAutomationButtons";
import { collectionTabPath } from "./workbench/workbenchState";
import { serializeCollectionSchema } from "./collections/schemaAuthoring";
import * as recordFieldWrites from "./collections/recordFieldWrites";
import type { useShareDirectWrites } from "./shell/useShareDirectWrites";

const directWriteInput = vi.hoisted(() => ({ current: null as Parameters<typeof useShareDirectWrites>[0] | null }));
vi.mock("./shell/useShareDirectWrites", async importOriginal => {
  const original = await importOriginal<typeof import("./shell/useShareDirectWrites")>();
  return { ...original, useShareDirectWrites: (input: Parameters<typeof useShareDirectWrites>[0]) => {
    directWriteInput.current = input;
    original.useShareDirectWrites(input);
  } };
});
import {
  DesktopWorkspaceShell, SHARE_VIEW, makeShareBridge, shellBootstrapProps, storedStateWithTabs,
} from "./DesktopWorkspaceShell.testHarness";

const EDIT_SHARE: Workspace = {
  ...SHARE_VIEW,
  shareView: { ...SHARE_VIEW.shareView!, access: "edit" },
};
const ENDED_SHARE: Workspace = {
  ...EDIT_SHARE,
  shareView: { ...EDIT_SHARE.shareView!, ended: true },
};
const ENDED_SENTENCE = "This share was ended by granter@dohc.test. Your copy stays readable but won't update anymore.";

function collectionBridge() {
  const bridge = makeShareBridge(Promise.resolve(storedStateWithTabs([collectionTabPath("tasks")])));
  bridge.listWorkspaceFiles.mockResolvedValue({ visibility: { status: "ready" as const, rules: [] }, files: [{ path: "tasks/retained.md", kind: "file" }], folders: ["tasks"] });
  bridge.listCollections.mockResolvedValue({ collections: [{ path: "tasks", objectId: "schema", status: "valid", reasons: [] }] });
  bridge.getCollection.mockResolvedValue({
    path: "tasks", objectId: "schema", status: "valid", reasons: [], recordCount: 1,
    schema: { name: "Tasks", description: null, fields: [{ name: "Name", type: "text" }, { name: "Finish", type: "button" }], views: [] },
  });
  bridge.queryCollectionRecords.mockResolvedValue({
    collection: { path: "tasks", objectId: "schema", status: "valid", reasons: [] },
    records: [{ id: "retained", path: "tasks/retained.md", conflicted: false,
      values: [{ field: "Name", value: "Retained task", validation: { status: "valid" }, resolvedRelations: [] }] }],
    groups: null, nextCursor: null,
  });
  bridge.listAutomationButtons.mockResolvedValue({ buttons: [
    { field: "Finish", table: null, state: { kind: "ready", automationId: "collection:tasks#finish" } },
  ] });
  // Keep the cached Edit permission after revocation. The shell must gate it
  // before another automation read has a chance to replace this result.
  bridge.listCollectionAutomations.mockResolvedValue({ status: "shared", definitions: {
    contentHash: "a".repeat(64), canSwitch: true, sync: "accepted",
    file: { status: "read", entries: [{ status: "valid", canSwitch: true, enabledInFile: true,
      automation: { id: "finish", name: "Finish task", enabled: true, if: null,
        when: { kind: "button", field: "Finish", table: null },
        do: [{ kind: "set", values: [{ field: "Name", value: { kind: "literal", value: "Finished" } }], records: null, operation: null }] },
    }] },
  } });
  return bridge;
}

function RegistryShell({ bridge, workspace }: { bridge: ReturnType<typeof collectionBridge>; workspace: Workspace }) {
  const selection = useMemo(() => ({ workspace }), [workspace]);
  const current = useRef(selection);
  current.current = selection;
  const [registry, setRegistry] = useState<{ selection: typeof selection; workspace: Workspace } | null>(null);
  const bootstrap = useMemo(() => shellBootstrapProps(bridge, (workspaces) => {
    if (current.current !== selection) return;
    const entry = workspaces.find(entry => entry.workspaceId === workspace.workspaceId);
    if (entry) setRegistry({ selection, workspace: entry });
  }), [bridge, workspace, selection]);
  const shown = registry?.selection === selection ? registry.workspace : workspace;
  return <DesktopWorkspaceShell workspace={shown} workspaces={[shown]}
    {...bootstrap} onSwitchWorkspace={() => undefined} />;
}

function shell(bridge: ReturnType<typeof collectionBridge>, workspace: Workspace) {
  return <RegistryShell bridge={bridge} workspace={workspace} />;
}

function focusAfterMinimum() {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
  fireEvent.focus(window);
}

async function assertReadableAndReadOnly(bridge: ReturnType<typeof collectionBridge>) {
  await waitFor(() => expect(screen.getByTestId("shared-view-banner").textContent).toContain(ENDED_SENTENCE));
  expect(await screen.findByText("Retained task")).toBeTruthy();
  await waitFor(() => expect(screen.getAllByTestId("tree-row").find(row => row.dataset.path === "tasks")?.dataset.collection).toBe("true"));
  expect(screen.queryByTestId("share-changes-send")).toBeNull();
  expect(screen.queryByTestId("shared-view-refresh")).toBeNull();
  expect(screen.queryByTestId("collection-fields-button")).toBeNull();
  expect(screen.queryByTestId("collection-new-record")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retained task" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Finish for Retained task" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  const panel = screen.getByTestId("collection-automations-panel");
  expect(within(panel).getByText("Finish task")).toBeTruthy();
  expect(within(panel).queryByRole("switch")).toBeNull();
  expect(bridge.switchCollectionAutomation).not.toHaveBeenCalled();
  expect(bridge.createCollectionRecord).not.toHaveBeenCalled();
  expect(bridge.submitShareChanges).not.toHaveBeenCalled();
}

describe("ended Edit Collection shares", () => {
  it("ends the current registry snapshot when a pending refresh finds the share ended", async () => {
    const bridge = collectionBridge();
    const refresh = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockReturnValueOnce(refresh.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByTestId("collection-new-record");
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledOnce());
    const replaced = { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView!, sharerName: "Updated owner" } };
    view.rerender(shell(bridge, replaced));
    await act(async () => refresh.resolve({ ok: true, status: "ended", changedPaths: 0,
      excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null }));
    expect(screen.queryByTestId("collection-new-record")).toBeNull();
    expect(screen.queryByTestId("share-changes-send")).toBeNull();
    expect(screen.getByTestId("shared-view-banner").textContent).toContain("This share was ended");
  });

  it.each(["record creation", "Send"] as const)("uses the shell's ended refusal for retained %s after a damaged share also ends", async action => {
    const shellRefusal = vi.spyOn(recordFieldWrites, "setCollectionFieldWriteAccess");
    const bridge = collectionBridge();
    bridge.createCollectionRecord.mockResolvedValueOnce({
      kind: "partial", created: ["tasks/Untitled.md"], failedStage: "index", reason: "index unavailable",
      retry: { mode: "resume", recordId: "rec_abcdefghijklmnopqrstuvwxyz", instruction: "Try again to finish this record." },
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByTestId("collection-new-record");
    const send = directWriteInput.current!.sendShareChanges;
    if (action === "record creation") {
      fireEvent.click(screen.getByTestId("collection-new-record"));
      await screen.findByTestId("workspace-shell-error");
    }
    view.rerender(shell(bridge, { ...ENDED_SHARE, shareView: { ...ENDED_SHARE.shareView!, damaged: true } }));
    if (action === "record creation") {
      fireEvent.click(screen.getByTestId("notice-center-toggle"));
      fireEvent.click(within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }));
    } else await act(async () => send());
    const message = "Your access to this share ended.";
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(message);
    expect(shellRefusal).toHaveBeenLastCalledWith(EDIT_SHARE.workspaceId, message);
    expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(action === "record creation" ? 1 : 0);
    expect(bridge.submitShareChanges).not.toHaveBeenCalled();
    shellRefusal.mockRestore();
  });
  const offsets = {
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  };
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ObserverStub);
    vi.stubGlobal("IntersectionObserver", ObserverStub);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, descriptor] of Object.entries(offsets)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  });

  it("updates the capture Notice after narrowing and ending without remounting", async () => {
    const bridge = collectionBridge();
    const edit = { ...EDIT_SHARE, workspaceId: "live-capture-notice" };
    vi.stubGlobal("dohcDesktop", bridge);
    const mounted = vi.fn();
    const renderShell = (workspace: Workspace) => <Profiler id="live-share" onRender={(_id, phase) => {
      if (phase === "mount") mounted();
    }}>{shell(bridge, workspace)}</Profiler>;
    const view = render(renderShell(edit));
    await screen.findByRole("button", { name: "Retained task" });
    const narrowed: Workspace = { ...edit, shareView: { ...edit.shareView!, access: "view", unsavedPaths: ["tasks/locked.md"],
      unconfirmedChanges: { paths: ["tasks/automations.yaml"], unchecked: false, checked: 1 } } };
    view.rerender(renderShell(narrowed));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("A later change from the owner can replace these files.");
    expect(screen.queryByTestId("collection-new-record")).toBeNull();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByTestId("notice-center");
    expect(within(notices).getAllByText("Changes to copy now")).toHaveLength(1);
    expect(notices.textContent).toContain("tasks/automations.yaml");
    expect(notices.textContent).toContain("tasks/locked.md");
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const ended = { ...narrowed, shareView: { ...narrowed.shareView!, ended: true } };
    view.rerender(renderShell(ended));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("They are kept on this computer."));
    expect(screen.getByTestId("shared-view-banner").textContent).toContain(ENDED_SENTENCE);
    expect(screen.getAllByTestId("workspace-shell-error")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const endedNotices = screen.getByTestId("notice-center");
    expect(within(endedNotices).getAllByText("Changes kept on this computer")).toHaveLength(1);
    expect(within(endedNotices).queryByText("Changes to copy now")).toBeNull();
    view.rerender(renderShell({ ...ended, shareView: { ...ended.shareView! } }));
    expect(within(endedNotices).getAllByText("Changes kept on this computer")).toHaveLength(1);
    expect(mounted).toHaveBeenCalledOnce();
  });

  it("skips automatic remote dataset loading for a retained ended share", async () => {
    const bridge = collectionBridge();
    bridge.dataset.mockRejectedValue(new Error("This shared workspace is unavailable. Open its current share again."));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, ENDED_SHARE));
    await screen.findByText("Retained task");
    expect(bridge.dataset).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(document.body.textContent).not.toContain("unavailable");
  });

  it("removes remote Collections listed before access ends", async () => {
    const bridge = collectionBridge();
    bridge.dataset.mockResolvedValue({ kind: "list", datasets: [{
      datasetId: "00000000-0000-4000-8000-000000000001", datasetPath: "remote/dataset.json", name: "Remote", revision: 1,
      revisionSha256: "a".repeat(64), operations: [], tables: [{ tableId: "00000000-0000-4000-8000-000000000002", name: "Remote table", fields: [] }],
    }], nextCursor: null });
    // Home lists the Collections.
    bridge.getWorkspaceUiState.mockResolvedValue({ ...storedStateWithTabs([collectionTabPath("tasks")]), explorerMode: "home" });
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByText("Remote table");
    view.rerender(shell(bridge, ENDED_SHARE));
    await waitFor(() => expect(screen.queryByText("Remote table")).toBeNull());
    expect(screen.getByText("Retained task")).toBeTruthy();
    expect(bridge.dataset).toHaveBeenCalledOnce();
  });

  it.each(["end", "narrow"] as const)("finds the %s capture Notice on returning to a cached workspace", async restriction => {
    const bridge = collectionBridge();
    const cached = { ...EDIT_SHARE, workspaceId: `return-notice-${restriction}` };
    const other = { ...EDIT_SHARE, workspaceId: "other-workspace" };
    const committed: Workspace = { ...cached, shareView: { ...cached.shareView!, access: "view", ended: restriction === "end",
      unsavedPaths: ["tasks/locked.md"], unconfirmedChanges: { paths: ["tasks/automations.yaml"], unchecked: false, checked: 1 } } };
    const selected = (workspace: Workspace) => <div key={workspace.workspaceId}>{shell(bridge, workspace)}</div>;
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(selected(cached));
    await screen.findByRole("button", { name: "Retained task" });
    view.rerender(selected(other));
    await screen.findByRole("button", { name: "Retained task" });
    const check = deferred<Awaited<ReturnType<typeof bridge.checkSharedViewAccess>>>();
    bridge.checkSharedViewAccess.mockImplementation(async ({ workspaceId }) => workspaceId === cached.workspaceId
      ? check.promise : { status: "current", access: "edit" });
    view.rerender(selected(cached));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    await act(async () => undefined);
    const reads = bridge.getWorkspaceRegistry.mock.calls.length;
    bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [committed, other] });
    await act(async () => check.resolve(restriction === "end" ? { status: "ended" } : { status: "current", access: "view" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(bridge.getWorkspaceRegistry.mock.calls.length).toBeGreaterThan(reads);
    expect(toast.textContent).toContain(restriction === "end" ? "They are kept on this computer." : "A later change from the owner can replace these files.");
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByTestId("notice-center");
    expect(notices.textContent).toContain("tasks/automations.yaml");
    expect(within(notices).getAllByText(restriction === "end" ? "Changes kept on this computer" : "Changes to copy now")).toHaveLength(1);
  });

  it("removes recovered files from the live capture Notice", async () => {
    const bridge = collectionBridge();
    const workspace = { ...ENDED_SHARE, workspaceId: "recovered-path-notice", shareView: { ...ENDED_SHARE.shareView!, unsavedPaths: ["tasks/recovered.md", "tasks/locked.md"] } };
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, workspace));
    await screen.findByTestId("workspace-shell-error");
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByTestId("notice-center");
    expect(notices.textContent).toContain("tasks/recovered.md");
    view.rerender(shell(bridge, { ...workspace, shareView: { ...workspace.shareView, unsavedPaths: ["tasks/locked.md"] } }));
    await waitFor(() => expect(notices.textContent).not.toContain("tasks/recovered.md"));
    expect(notices.textContent).toContain("tasks/locked.md");
    expect(within(notices).getAllByText("Changes kept on this computer")).toHaveLength(1);
  });

  it("ignores a dataset read failure that arrives after access ends", async () => {
    const bridge = collectionBridge();
    const read = deferred<Awaited<ReturnType<typeof bridge.dataset>>>();
    bridge.dataset.mockReturnValueOnce(read.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await waitFor(() => expect(bridge.dataset).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, ENDED_SHARE));
    await act(async () => read.reject(new Error("Your access to this share ended.")));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(bridge.dataset).toHaveBeenCalledOnce();
  });

  it("keeps the capture Notice available after a dismissal fails and gives a next step", async () => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    bridge.dismissShareCaptureNotice.mockRejectedValue(new Error("registry unavailable"));
    const workspace = { ...ENDED_SHARE, workspaceId: `${ENDED_SHARE.workspaceId}-dismiss-failed`,
      shareView: { ...ENDED_SHARE.shareView!, unsavedPaths: [],
        unconfirmedChanges: { paths: ["tasks/local.yaml"], unchecked: false, checked: 1 } } };
    render(shell(bridge, workspace));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    fireEvent.click(within(notices).getByRole("button", { name: "Dismiss notice" }));
    await waitFor(() => expect(notices.textContent).toContain("dohc couldn't dismiss this Notice. Try dismissing it again in Notices."));
    expect(within(notices).getByText("Changes kept on this computer")).toBeTruthy();
    expect(bridge.dismissShareCaptureNotice).toHaveBeenCalledOnce();
  });

  it.each(["end", "narrow"] as const)("reports unconfirmed changes in one bounded Notice with path-only Copy after %s", async restriction => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const paths = ["tasks/automations.yaml", "tasks/draft.md", "tasks/e.yaml", "tasks/f.yaml", "tasks/g.yaml", "tasks/h.yaml", "tasks/i.yaml"];
    const workspace = { ...ENDED_SHARE, workspaceId: `${ENDED_SHARE.workspaceId}-notice-${restriction}`, shareView: { ...ENDED_SHARE.shareView!,
      ended: restriction === "end", access: "view" as const, unsavedPaths: [], unconfirmedChanges: { paths, unchecked: false, checked: 0 } } };
    const rendered = render(shell(bridge, workspace));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const message = restriction === "end"
      ? "dohc couldn't confirm these changes reached the share. They are kept on this computer. Copy these files to another workspace."
      : "dohc couldn't confirm these changes reached the share. A later change from the owner can replace these files. Your saved changes stay in History. Copy these files to another workspace now.";
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).not.toContain(paths[0]);
    expect(toast.textContent).not.toContain("could not save");
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(within(notices).getAllByText(message)).toHaveLength(1);
    expect(within(notices).getByText(restriction === "end" ? "Changes kept on this computer" : "Changes to copy now")).toBeTruthy();
    expect(within(notices).getByText(message).className).not.toMatch(/truncate|line-clamp/);
    expect(notices.textContent).toContain(paths[0]);
    expect(notices.textContent).toContain(paths[1]);
    expect(notices.textContent).not.toContain(paths[5]);
    expect(within(notices).getByText("2 more")).toBeTruthy();
    expect(notices.textContent).not.toContain("tasks/accepted.md");
    const copies = within(notices).getAllByRole("button", { name: "Copy file paths" });
    expect(copies).toHaveLength(1);
    fireEvent.click(copies[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]![0]).toBe(paths.join("\n"));
    const samePaths = { ...workspace, shareView: { ...workspace.shareView, unconfirmedChanges: { paths: [...paths].reverse(), unchecked: false, checked: 0 } } };
    rendered.rerender(shell(bridge, samePaths));
    expect(within(notices).getAllByText(message)).toHaveLength(1);
    let saved = JSON.parse(JSON.stringify(samePaths)) as Workspace;
    bridge.dismissShareCaptureNotice.mockImplementation(async ({ key }) => {
      saved = { ...saved, shareView: { ...saved.shareView!, unconfirmedChanges: { ...saved.shareView!.unconfirmedChanges!, dismissedKey: key } } };
    });
    fireEvent.click(within(notices).getByRole("button", { name: "Dismiss notice" }));
    await waitFor(() => expect(within(notices).queryByText(message)).toBeNull());
    expect(bridge.dismissShareCaptureNotice).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    rendered.unmount();
    // Forget renderer memory; the reopened shell must use the saved registry.
    const memory = renderHook(() => useShellError(workspace.workspaceId));
    act(() => memory.result.current.reportShareCapture(workspace.shareView.shareId!, []));
    memory.unmount();
    bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [JSON.parse(JSON.stringify(saved))] });
    const loaded = (await bridge.getWorkspaceRegistry()).workspaces[0] as Workspace;
    const reopened = render(shell(bridge, loaded));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(within(screen.getByTestId("notice-center")).queryByText(message)).toBeNull();
    bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [] });
    reopened.rerender(shell(bridge, { ...workspace, shareView: { ...workspace.shareView, unconfirmedChanges: { paths: [paths[0]!], unchecked: false, checked: 0 } } }));
    expect(within(screen.getByTestId("notice-center")).getAllByText(message)).toHaveLength(1);
    expect(within(screen.getByTestId("notice-center")).queryByRole("button", { name: "Try again" })).toBeNull();
    reopened.unmount();
  });

  it("explains reopening a received share with a damaged recipient pin", async () => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView!, damaged: true } }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    expect(screen.getByTestId("shared-view-banner").textContent).toContain("This share must be reopened");
    expect(screen.getByTestId("shared-view-banner").textContent).toContain("granter@dohc.test This share");
    expect(screen.getByTestId("shared-view-banner").textContent).not.toContain("dohc can't read what this share grants");
    expect(screen.queryByTestId("share-changes-send")).toBeNull();
    expect(bridge.checkSharedViewAccess).not.toHaveBeenCalled();
    expect(bridge.refreshSharedView).not.toHaveBeenCalled();
  });

  it("discovers an Edit-to-View downgrade and revocation on focus while the Collection stays open", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await screen.findByTestId("collection-new-record");
      await act(async () => undefined);
      const registryReads = bridge.getWorkspaceRegistry.mock.calls.length;
      bridge.refreshSharedView.mockResolvedValue({ ok: true, probed: true, status: "unchanged", changedPaths: 0,
        excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null });
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
      await act(async () => focusAfterMinimum());
      expect(bridge.getWorkspaceRegistry.mock.calls.length).toBe(registryReads + 1);
      expect(screen.queryByTestId("collection-new-record")).toBeNull();
      expect(screen.queryByTestId("collection-fields-button")).toBeNull();
      expect(screen.queryByTestId("collection-views-button")).toBeNull();
      expect(screen.queryByTestId("share-changes-send")).toBeNull();
      expect(screen.getByText("Retained task")).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      await act(async () => focusAfterMinimum());
      expect(bridge.getWorkspaceRegistry.mock.calls.length).toBe(registryReads + 1);
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "ended" });
      await act(async () => focusAfterMinimum());
      expect(bridge.getWorkspaceRegistry.mock.calls.length).toBe(registryReads + 2);
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      await act(async () => focusAfterMinimum());
      expect(bridge.getWorkspaceRegistry.mock.calls.length).toBe(registryReads + 2);
      expect(screen.getByTestId("shared-view-banner").textContent).toContain("This share was ended");
      expect(bridge.refreshSharedView).toHaveBeenCalledTimes(4);
      expect(screen.getByText("Retained task")).toBeTruthy();
      expect(bridge.checkSharedViewAccess).toHaveBeenCalled();
      for (const [payload] of bridge.checkSharedViewAccess.mock.calls) {
        expect(payload).toEqual({ workspaceId: EDIT_SHARE.workspaceId });
      }
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it.each(["edit", "view", "comment"] as const)("keeps unchanged %s access checks from reading the registry or rendering the shell again", async access => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access });
    vi.stubGlobal("dohcDesktop", bridge);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const rendered = vi.fn();
      const workspace = { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView!, access } };
      const view = render(<Profiler id="shell" onRender={rendered}>{shell(bridge, workspace)}</Profiler>);
      await screen.findByText("Retained task");
      await act(async () => {});
      bridge.refreshSharedView.mockResolvedValue({ ok: true, probed: true, status: "unchanged", changedPaths: 0, excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null });
      const before = rendered.mock.calls.length;
      const registryReads = bridge.getWorkspaceRegistry.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(15_000));
      await act(async () => focusAfterMinimum());
      expect(bridge.checkSharedViewAccess.mock.calls.length).toBe(2);
      expect(bridge.getWorkspaceRegistry.mock.calls.length).toBe(registryReads);
      expect(rendered.mock.calls.length).toBe(before);
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("shows the access-ended notice for a save after the owner stops sharing", async () => {
    const bridge = collectionBridge();
    bridge.readWorkspaceText.mockResolvedValue({
      text: serializeCollectionSchema({ name: "Tasks", description: null, fields: [{ name: "Name", type: "text" }], views: [] }),
      truncated: false, contentHash: "a".repeat(64),
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    fireEvent.click(await screen.findByTestId("collection-fields-button"));
    const dialog = await screen.findByTestId("collection-fields-dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Field name" }), { target: { value: "Extra" } });
    const write = deferred<Awaited<ReturnType<typeof bridge.writeWorkspaceText>>>();
    bridge.writeWorkspaceText.mockImplementationOnce(() => write.promise);
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "ended" });
    fireEvent.click(screen.getByTestId("collection-add-field"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());
    focusAfterMinimum();
    await waitFor(() => expect(screen.queryByTestId("collection-fields-dialog")).toBeNull());
    await act(async () => write.reject(new Error("Your access to this share ended.")));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Your access to this share ended."));
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).toContain("Your access to this share ended.");
  });

  it("makes one access recheck for one refused push", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    await screen.findByTestId("collection-fields-button");
    await act(async () => {});
    const before = bridge.checkSharedViewAccess.mock.calls.length;
    await act(async () => bridge.emitShareDirectWritesPushed({ workspaceId: EDIT_SHARE.workspaceId, result: {
      status: "pushed", writes: [{ result: "refused", paths: ["tasks/collection.yaml"], reason: "access changed" }],
    } }));
    expect(bridge.checkSharedViewAccess.mock.calls.length).toBe(before + 1);
  });

  it.each(["registry props", "registry refresh", "refresh outcome", "access check"] as const)(
    "keeps retained records and removes every write control when revocation arrives through %s while mounted",
    async (arrival) => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await screen.findByRole("button", { name: "Retained task" });
      expect(screen.getByTestId("share-changes-send")).toBeTruthy();
      expect(screen.getByTestId("collection-fields-button")).toBeTruthy();
      expect(screen.getByTestId("collection-new-record")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Finish for Retained task" })).toBeTruthy();
      fireEvent.click(screen.getByTestId("collection-automations-button"));
      await screen.findByRole("switch", { name: "Finish task" });
      // A cell editor open before revocation must also go away.
      fireEvent.click(screen.getByRole("button", { name: "Retained task" }));
      expect(screen.getByRole("textbox")).toBeTruthy();
      await waitFor(() => expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(false));
      if (arrival === "registry props") {
        view.rerender(shell(bridge, ENDED_SHARE));
      } else if (arrival === "access check") {
        bridge.checkSharedViewAccess.mockResolvedValue({ status: "ended" });
        focusAfterMinimum();
      } else {
        if (arrival === "registry refresh") bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [ENDED_SHARE] });
        else bridge.refreshSharedView.mockImplementation(async () => {
          bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [ENDED_SHARE] });
          return { ok: true, status: "ended", changedPaths: 0, excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null };
        });
        fireEvent.click(screen.getByTestId("shared-view-refresh"));
      }
      await assertReadableAndReadOnly(bridge);
      // An ordinary local activity read still succeeds after the transition.
      const reads = bridge.queryCollectionRecords.mock.calls.length;
      act(() => bridge.emitWorkspaceActivity({ paths: ["tasks/retained.md"] }));
      await waitFor(() => expect(bridge.queryCollectionRecords.mock.calls.length).toBeGreaterThan(reads));
      expect(screen.getByText("Retained task")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Retained task" }));
      const edit = await screen.findByTestId("markdown-edit-toggle");
      await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());
      expect(edit.hasAttribute("disabled")).toBe(true);
      act(() => bridge.emitMenuCommand("command-palette"));
      expect(screen.queryByText("New collection")).toBeNull();
    },
  );

  it.each(["fields", "views"])("removes an open %s dialog when the registry ends the share", async (kind) => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    fireEvent.click(await screen.findByTestId(`collection-${kind}-button`));
    await screen.findByTestId(`collection-${kind}-dialog`);
    view.rerender(shell(bridge, ENDED_SHARE));
    await waitFor(() => expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull());
    expect(screen.getByText("Retained task")).toBeTruthy();
    view.rerender(shell(bridge, { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView! } }));
    await screen.findByTestId(`collection-${kind}-button`);
    expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull();
  });

  it.each(["registry refresh", "refresh outcome"] as const)("restores the same share without reopening after %s ended it", async (arrival) => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByRole("button", { name: "Retained task" });
    await waitFor(() => expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(false));
    bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [ENDED_SHARE] });
    if (arrival === "refresh outcome") bridge.refreshSharedView.mockResolvedValue({
      ok: true, status: "ended", changedPaths: 0, excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null,
    });
    fireEvent.click(screen.getByTestId("shared-view-refresh"));
    await waitFor(() => expect(screen.queryByTestId("collection-new-record")).toBeNull());
    expect(screen.getByTestId("shared-view-banner").textContent).toContain(ENDED_SENTENCE);
    const restored = { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView! } };
    bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [restored] });
    bridge.refreshSharedView.mockResolvedValue({ ok: true, status: "unchanged", changedPaths: 0, excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null });
    view.rerender(shell(bridge, restored));
    await screen.findByRole("button", { name: "Retained task" });
    expect(screen.getByTestId("collection-new-record")).toBeTruthy();
    expect(screen.getByTestId("collection-fields-button")).toBeTruthy();
    expect(screen.getByTestId("shared-view-refresh")).toBeTruthy();
    expect(screen.getByTestId("share-changes-send")).toBeTruthy();
    expect(screen.getByTestId("shared-view-banner").textContent).not.toContain(ENDED_SENTENCE);
  });

  it.each(["open push", "background push"] as const)("reports an unavailable %s through the feedback lane after the same share ends", async (arrival) => {
    const bridge = collectionBridge();
    const push = deferred<Awaited<ReturnType<typeof bridge.pushShareDirectWrites>>>();
    if (arrival === "open push") bridge.pushShareDirectWrites.mockImplementationOnce(() => push.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await waitFor(() => expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, ENDED_SHARE));
    await act(async () => {
      if (arrival === "open push") push.resolve();
      bridge.emitShareDirectWritesPushed({ workspaceId: EDIT_SHARE.workspaceId, result: { status: "unavailable" } });
    });
    const message = "Your access to this share ended. Your unsent Collection changes stay in this workspace. Ask granter@dohc.test to share it again.";
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain(message));
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(within(screen.getByTestId("notice-center")).getByText(message)).toBeTruthy();
    expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce();
  });

  it("reports a Send as proposal notice action after the share ends", async () => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByRole("button", { name: "Retained task" });
    act(() => bridge.emitShareDirectWritesPushed({ workspaceId: EDIT_SHARE.workspaceId, result: {
      status: "pushed", writes: [{ result: "refused", paths: ["tasks/collection.yaml"], reason: "" }],
    } }));
    await screen.findByTestId("workspace-shell-error");
    view.rerender(shell(bridge, ENDED_SHARE));
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    fireEvent.click(within(screen.getByTestId("notice-center")).getByRole("button", { name: "Send as proposal" }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Your access to this share ended."));
    expect(bridge.submitShareChanges).not.toHaveBeenCalled();
  });

  it("reports a non-access creation error without waiting for an access check", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    bridge.createCollectionRecord.mockRejectedValueOnce(new Error("tasks/Untitled.md already exists. Choose another record name."));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    const create = await screen.findByTestId("collection-new-record");
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalledOnce());
    const pending = deferred<Awaited<ReturnType<typeof bridge.checkSharedViewAccess>>>();
    bridge.checkSharedViewAccess.mockReturnValue(pending.promise);
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("already exists"));
    expect(bridge.checkSharedViewAccess).toHaveBeenCalledOnce();
  });

  it.each([
    { error: "ShareUnavailableError: This share was ended, or the code does not match your account.", access: "ended" },
    { error: "This Collection does not have Edit access.", access: "changed" },
    { error: "RelayClaimRefusedError: The relay refused this change.", access: "changed" },
    { error: "TypeError: fetch failed", access: "ended" },
  ] as const)("rechecks creation failure $error and reports $access access", async ({ error, access }) => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    bridge.createCollectionRecord.mockRejectedValueOnce(new Error(error));
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    const create = await screen.findByTestId("collection-new-record");
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalledOnce());
    const pending = deferred<Awaited<ReturnType<typeof bridge.checkSharedViewAccess>>>();
    bridge.checkSharedViewAccess.mockReturnValueOnce(pending.promise);
    fireEvent.click(create);
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await act(async () => pending.resolve(access === "ended" ? { status: "ended" } : { status: "current", access: "view" }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain(`Your access to this share ${access}.`));
  });

  it("reports a record creation retry after the share ends", async () => {
    const bridge = collectionBridge();
    bridge.createCollectionRecord.mockResolvedValueOnce({
      kind: "partial", created: ["tasks/Untitled.md"], failedStage: "index", reason: "index unavailable",
      retry: { mode: "resume", recordId: "rec_abcdefghijklmnopqrstuvwxyz", instruction: "Try again to finish this record." },
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    fireEvent.click(await screen.findByTestId("collection-new-record"));
    await screen.findByTestId("workspace-shell-error");
    view.rerender(shell(bridge, ENDED_SHARE));
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    fireEvent.click(within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Your access to this share ended."));
    expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
  });

  it.each(["view", "comment"] as const)("blocks retained creation retries and draft delivery after access narrows to %s", async access => {
    const bridge = collectionBridge();
    bridge.queryCollectionRecords.mockResolvedValue({
      collection: { path: "tasks", objectId: "schema", status: "valid", reasons: [] },
      records: [{ id: "draft", path: "tasks/draft.md", conflicted: false, creationDelivery: "pending", creationCanDiscard: false,
        values: [{ field: "Name", value: "Created draft", validation: { status: "valid" }, resolvedRelations: [] }] }],
      groups: null, nextCursor: null,
    });
    bridge.createCollectionRecord.mockResolvedValueOnce({
      kind: "partial", created: ["tasks/Untitled.md"], failedStage: "index", reason: "index unavailable",
      retry: { mode: "resume", recordId: "rec_abcdefghijklmnopqrstuvwxyz", instruction: "Try again to finish this record." },
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    fireEvent.click(await screen.findByTestId("collection-new-record"));
    await screen.findByTestId("workspace-shell-error");
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access });
    focusAfterMinimum();
    await waitFor(() => expect(screen.queryByTestId("collection-new-record")).toBeNull());
    const drafts = screen.getByTestId("collection-record-drafts");
    expect(drafts.textContent).toContain("This draft cannot be sent with the current share access.");
    expect(within(drafts).queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    fireEvent.click(within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Your access to this share changed."));
    expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
    expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce();
  });

  it("keeps the reopen explanation on a retained creation retry after the recipient pin becomes unreadable", async () => {
    const bridge = collectionBridge();
    bridge.createCollectionRecord.mockResolvedValueOnce({
      kind: "partial", created: ["tasks/Untitled.md"], failedStage: "index", reason: "index unavailable",
      retry: { mode: "resume", recordId: "rec_abcdefghijklmnopqrstuvwxyz", instruction: "Try again to finish this record." },
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    fireEvent.click(await screen.findByTestId("collection-new-record"));
    await screen.findByTestId("workspace-shell-error");
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "needs-reopen" });
    focusAfterMinimum();
    await waitFor(() => expect(screen.queryByTestId("collection-new-record")).toBeNull());
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    fireEvent.click(within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("This share must be reopened."));
    expect(screen.getByTestId("workspace-shell-error").textContent).not.toContain("access to this share changed");
    expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
  });

  it.each(["fields", "views"] as const)("reports an in-flight %s save failure even after access returns and a new dialog opens", async (kind) => {
    const bridge = collectionBridge();
    bridge.readWorkspaceText.mockResolvedValue({
      text: serializeCollectionSchema({ name: "Tasks", description: null, fields: [{ name: "Name", type: "text" }], views: [] }),
      truncated: false, contentHash: "a".repeat(64),
    });
    const write = deferred<Awaited<ReturnType<typeof bridge.writeWorkspaceText>>>();
    bridge.writeWorkspaceText.mockImplementationOnce(() => write.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    fireEvent.click(await screen.findByTestId(`collection-${kind}-button`));
    const dialog = await screen.findByTestId(`collection-${kind}-dialog`);
    fireEvent.change(within(dialog).getByRole("textbox", { name: kind === "fields" ? "Field name" : "View name" }), { target: { value: "Extra" } });
    fireEvent.click(screen.getByTestId(kind === "fields" ? "collection-add-field" : "collection-add-view"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, ENDED_SHARE));
    await waitFor(() => expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull());
    view.rerender(shell(bridge, { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView! } }));
    await screen.findByTestId(`collection-${kind}-button`);
    expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull();
    fireEvent.click(screen.getByTestId(`collection-${kind}-button`));
    await screen.findByTestId(`collection-${kind}-dialog`);
    await act(async () => { write.reject(new Error("Your access to this share ended.")); });
    await waitFor(() => expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Your access to this share ended."));
    expect(within(screen.getByTestId(`collection-${kind}-dialog`)).queryByText("dohc could not update this collection. Your access to this share ended.")).toBeNull();
  });

  it("reopens an already ended Edit share with readable records and no write controls", async () => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, ENDED_SHARE));
    await screen.findByText("Retained task");
    fireEvent.click(screen.getByTestId("collection-automations-button"));
    await screen.findByText("Finish task");
    await assertReadableAndReadOnly(bridge);
    expect(bridge.refreshSharedView).not.toHaveBeenCalled();
    expect(bridge.listAutomationButtons).not.toHaveBeenCalled();
  });

  it("ignores an ended registry refresh from a retired selection, including A to B to A", async () => {
    const bridge = collectionBridge();
    const registry = deferred<{ workspaces: unknown[] }>();
    bridge.getWorkspaceRegistry.mockImplementationOnce(() => registry.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledOnce());
    await act(async () => undefined);
    fireEvent.click(screen.getByTestId("shared-view-refresh"));
    await waitFor(() => expect(bridge.getWorkspaceRegistry).toHaveBeenCalledOnce());
    const other = { ...EDIT_SHARE, workspaceId: "other-share" };
    view.rerender(shell(bridge, other));
    view.rerender(shell(bridge, EDIT_SHARE));
    await act(async () => registry.resolve({ workspaces: [ENDED_SHARE] }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    expect(screen.getByTestId("shared-view-banner").textContent).toContain("Markdown edits save to the live host");
    expect(screen.getByTestId("share-changes-send")).toBeTruthy();
  });

  it("pulls after Send changes completes without showing refresh loading", async () => {
    const bridge = collectionBridge(); vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByText("Retained task"); await act(async () => undefined);
    const before = bridge.refreshSharedView.mock.calls.length;
    const submit = deferred<Awaited<ReturnType<typeof bridge.submitShareChanges>>>();
    bridge.submitShareChanges.mockReturnValueOnce(submit.promise);
    fireEvent.click(screen.getByTestId("share-changes-send"));
    await act(async () => undefined);
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before);
    await act(async () => submit.resolve({ ok: true, submitted: 1, capturedLocalChanges: 0, skippedOutsideShare: 0, morePending: false }));
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before + 1);
    expect(bridge.refreshSharedView).toHaveBeenLastCalledWith({ workspaceId: EDIT_SHARE.workspaceId, trigger: "background" });
    expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  });

  it("keeps all relayed Button probes after the shell pulls changed files", async () => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", { ...bridge,
      onAutomationRunSettled: () => () => undefined,
      onAutomationRunWaiting: () => () => undefined,
      onCollectionAutomationsChanged: () => () => undefined,
      pressAutomationButton: async () => ({ busy: false, relayed: true }),
    });
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByText("Retained task"); await act(async () => undefined);
    bridge.refreshSharedView.mockClear();
    bridge.refreshSharedView.mockResolvedValue({ ok: true, status: "updated", changedPaths: 1,
      excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null });
    const buttons = createAutomationButtons({ workspaceId: EDIT_SHARE.workspaceId, of: { collectionPath: "tasks" } });
    vi.useFakeTimers();
    try {
      await act(async () => buttons.press("Finish", { id: "retained", label: "Retained task" }));
      expect(bridge.refreshSharedView).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(bridge.refreshSharedView).toHaveBeenCalledTimes(4);
      expect(bridge.refreshSharedView).toHaveBeenCalledWith({ workspaceId: EDIT_SHARE.workspaceId, trigger: "press-burst" });
      view.unmount(); buttons.close();
    } finally { vi.useRealTimers(); }
  });

  it("does not read sync status or the registry for a typed probe timeout", async () => {
    const bridge = collectionBridge(); vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByText("Retained task"); await act(async () => undefined);
    bridge.getSyncStatus.mockClear(); bridge.getWorkspaceRegistry.mockClear();
    bridge.refreshSharedView.mockResolvedValue({ ok: false, probed: true, errorKind: "transient",
      changedPaths: 0, errorMessage: "The shared view refresh timed out." });
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(bridge.getSyncStatus).not.toHaveBeenCalled();
    expect(bridge.getWorkspaceRegistry).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    view.unmount();
  });

  it("shows the reopen banner without a sign-in Notice during the opening access check", async () => {
    const bridge = collectionBridge(); vi.stubGlobal("dohcDesktop", bridge);
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "needs-reopen" });
    bridge.refreshSharedView.mockResolvedValue({ ok: true, probed: true, status: "unchanged", changedPaths: 0,
      excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null });
    const view = render(shell(bridge, EDIT_SHARE));
    await waitFor(() => expect(screen.getByTestId("shared-view-banner").textContent).toContain("This share must be reopened."));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    expect(document.body.textContent).not.toContain("Sign in to the account");
    view.unmount();
  });

  it("queues one manual refresh behind a background pull and keeps both single flight", async () => {
    const bridge = collectionBridge(); const pull = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockReturnValueOnce(pull.promise);
    vi.stubGlobal("dohcDesktop", bridge); const view = render(shell(bridge, EDIT_SHARE));
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledOnce());
    expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("shared-view-refresh"));
    fireEvent.click(screen.getByTestId("shared-view-refresh"));
    expect(bridge.refreshSharedView).toHaveBeenCalledOnce();
    await act(async () => pull.resolve({ ok: true, probed: true, status: "unchanged", changedPaths: 0,
      excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null }));
    expect(bridge.refreshSharedView).toHaveBeenCalledTimes(2);
    expect(bridge.refreshSharedView).toHaveBeenLastCalledWith({ workspaceId: EDIT_SHARE.workspaceId, trigger: "manual" });
    view.unmount();
  });

  it("shows a persistent background failure on the existing Notice surface after three attempts", async () => {
    const bridge = collectionBridge(); vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE)); await screen.findByText("Retained task"); await act(async () => undefined);
    bridge.refreshSharedView.mockResolvedValue({ ok: false, probed: true, errorKind: "transient", changedPaths: 0, errorMessage: "offline" });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => focusAfterMinimum());
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Couldn't refresh the shared view.");
      expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(false);
      view.unmount();
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it.each(["transient", "store refusal"])("does not read share records after thrown background failures (%s)", async kind => {
    const bridge = collectionBridge(); vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByText("Retained task"); await act(async () => undefined);
    bridge.getWorkspaceRegistry.mockClear(); bridge.refreshSharedView.mockClear();
    if (kind === "store refusal") {
      const status = await bridge.getSyncStatus();
      bridge.getSyncStatus.mockResolvedValue({ ...status, historyCaptureFailed: true,
        engineStoreRefused: "migrated-by-newer-build", engineStoreRefusedDetail: "a newer build ran migration 5" });
    }
    bridge.refreshSharedView.mockRejectedValue(new Error(kind));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();
    try {
      await act(async () => window.dispatchEvent(new Event("online")));
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(90_000));
      expect(bridge.refreshSharedView.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(bridge.getWorkspaceRegistry).not.toHaveBeenCalled();
      if (kind === "store refusal") expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      else expect(screen.getByTestId("workspace-shell-error").textContent).toContain("Couldn't refresh the shared view.");
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("drops a background pull's changed paths after the window switches workspaces", async () => {
    const bridge = collectionBridge(); const old = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockReturnValueOnce(old.promise);
    vi.stubGlobal("dohcDesktop", bridge); const view = render(shell(bridge, EDIT_SHARE));
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledOnce());
    const other = { ...EDIT_SHARE, workspaceId: "other-share" };
    view.rerender(shell(bridge, other));
    await waitFor(() => expect(bridge.refreshSharedView).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    const listings = bridge.listWorkspaceFiles.mock.calls.length;
    await act(async () => old.resolve({ ok: true, status: "updated", changedPaths: 2, excludedPaths: [],
      unjournalablePaths: [{ path: "old.md", reason: "local-collision" }], refusedOps: 0, refusedDetail: null }));
    expect(bridge.listWorkspaceFiles.mock.calls.length).toBe(listings);
    expect(screen.queryByTestId("shared-view-excluded")).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    view.unmount();
  });

  it("queues a background pull behind a manual refresh and pauses its own 401", async () => {
    const bridge = collectionBridge(); vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE)); await screen.findByText("Retained task"); await act(async () => undefined);
    const before = bridge.refreshSharedView.mock.calls.length;
    const manual = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockReturnValueOnce(manual.promise);
    bridge.refreshSharedView.mockResolvedValue({ ok: false, probed: true, errorKind: "unauthorized", changedPaths: 0, errorMessage: "Sign in again." });
    fireEvent.click(screen.getByTestId("shared-view-refresh"));
    await act(async () => focusAfterMinimum());
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before + 1);
    await act(async () => manual.resolve({ ok: true, status: "unchanged", changedPaths: 0,
      excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null }));
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before + 2);
    expect(bridge.refreshSharedView).toHaveBeenLastCalledWith({ workspaceId: EDIT_SHARE.workspaceId, trigger: "background" });
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before + 2);
    view.unmount();
  });

});

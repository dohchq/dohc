// @vitest-environment jsdom
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, useMemo, useRef, useState } from "react";
import type { Workspace } from "./DesktopWorkspaceShell";
import { deferred } from "../testing/deferred";
import { collectionTabPath } from "./workbench/workbenchState";
import { serializeCollectionSchema } from "./collections/schemaAuthoring";

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
  bridge.listCollections.mockResolvedValue({ collections: [{ path: "tasks", objectId: "schema", status: "valid", reasons: [] }], unclaimedDatasetFolders: [] });
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

  it(
    "keeps retained records and removes every write control when an access check finds revocation while mounted",
    async () => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      render(shell(bridge, EDIT_SHARE));
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
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "ended" });
      focusAfterMinimum();
      await assertReadableAndReadOnly(bridge);
      // An ordinary local activity read still succeeds after the transition.
      const reads = bridge.queryCollectionRecords.mock.calls.length;
      act(() => bridge.emitWorkspaceActivity({ paths: ["tasks/retained.md"] }));
      await waitFor(() => expect(bridge.queryCollectionRecords.mock.calls.length).toBeGreaterThan(reads));
      expect(screen.getByText("Retained task")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Retained task" }));
      const edit = await screen.findByTestId("markdown-edit-toggle");
      await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());
      expect(edit.hasAttribute("disabled") || edit.getAttribute("aria-disabled") === "true").toBe(true);
      act(() => bridge.emitMenuCommand("command-palette"));
      expect(screen.queryByText("New collection")).toBeNull();
    },
  );

  it.each(["view"] as const)("blocks retained creation retries and draft delivery after access narrows to %s", async access => {
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

  it.each(["fields"] as const)("reports an in-flight %s save failure even after access returns and a new dialog opens", async (kind) => {
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

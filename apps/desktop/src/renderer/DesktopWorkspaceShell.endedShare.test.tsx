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
  bridge.listWorkspaceFiles.mockResolvedValue({ files: [{ path: "tasks/retained.md", kind: "file" }], folders: ["tasks"] });
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
    for (const [name, descriptor] of Object.entries(offsets)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  });

  it("reports unsaved files in one Notice with Copy after access ends", async () => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const paths = ["tasks/locked.md", "tasks/another.md"];
    const workspace = { ...ENDED_SHARE, shareView: { ...ENDED_SHARE.shareView!, unsavedPaths: paths } };
    const rendered = render(shell(bridge, workspace));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    const message = "Your changes weren't sent and remain on this computer. Copy these files to another workspace.";
    expect(screen.getByTestId("workspace-shell-error").textContent).not.toContain(paths[0]);
    expect(screen.getByTestId("workspace-shell-error").textContent).not.toContain("could not save");
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    const notices = await screen.findByTestId("notice-center");
    expect(within(notices).getAllByText(message)).toHaveLength(1);
    const copies = within(notices).getAllByRole("button", { name: "Copy error details" });
    expect(copies).toHaveLength(1);
    fireEvent.click(copies[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]![0]).toContain("File: tasks/another.md\nFile: tasks/locked.md");
    const samePaths = { ...workspace, shareView: { ...workspace.shareView, unsavedPaths: [...paths].reverse() } };
    rendered.rerender(shell(bridge, samePaths));
    expect(within(notices).getAllByText(message)).toHaveLength(1);
    fireEvent.click(within(notices).getByRole("button", { name: "Dismiss notice" }));
    rendered.rerender(shell(bridge, { ...workspace, shareView: { ...workspace.shareView, unsavedPaths: [...paths] } }));
    expect(within(notices).queryByText(message)).toBeNull();
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    rendered.rerender(shell(bridge, { ...workspace, shareView: { ...workspace.shareView, unsavedPaths: [paths[0]!] } }));
    expect(within(notices).getAllByText(message)).toHaveLength(1);
    expect(within(notices).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(bridge.checkSharedViewAccess).not.toHaveBeenCalled();
    expect(bridge.refreshSharedView).not.toHaveBeenCalled();
    rendered.unmount();
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

  it("discovers an Edit-to-View downgrade and revocation while the Collection stays open", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await screen.findByTestId("collection-new-record");
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(screen.queryByTestId("collection-new-record")).toBeNull();
      expect(screen.queryByTestId("collection-fields-button")).toBeNull();
      expect(screen.queryByTestId("collection-views-button")).toBeNull();
      expect(screen.queryByTestId("share-changes-send")).toBeNull();
      expect(screen.getByText("Retained task")).toBeTruthy();
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "ended" });
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(screen.getByTestId("shared-view-banner").textContent).toContain("This share was ended");
      expect(bridge.refreshSharedView).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Retained task")).toBeTruthy();
      expect(bridge.checkSharedViewAccess).toHaveBeenCalled();
      for (const [payload] of bridge.checkSharedViewAccess.mock.calls) {
        expect(payload).toEqual({ workspaceId: EDIT_SHARE.workspaceId });
      }
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("keeps unchanged access checks from rendering the shell again", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    vi.stubGlobal("dohcDesktop", bridge);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const rendered = vi.fn();
      const view = render(<Profiler id="shell" onRender={rendered}>{shell(bridge, EDIT_SHARE)}</Profiler>);
      await screen.findByTestId("collection-new-record");
      await act(async () => {});
      const before = rendered.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(bridge.checkSharedViewAccess.mock.calls.length).toBeGreaterThanOrEqual(3);
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
    fireEvent.focus(window);
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
        fireEvent.focus(window);
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
    view.rerender(shell(bridge, restored));
    await screen.findByRole("button", { name: "Retained task" });
    expect(screen.getByTestId("collection-new-record")).toBeTruthy();
    expect(screen.getByTestId("collection-fields-button")).toBeTruthy();
    expect(screen.getByTestId("shared-view-refresh")).toBeTruthy();
    expect(screen.getByTestId("share-changes-send")).toBeTruthy();
    expect(screen.getByTestId("shared-view-banner").textContent).not.toContain(ENDED_SENTENCE);
  });

  it.each(["push response", "push event"] as const)("reports an unavailable %s arriving after the same share ends", async (arrival) => {
    const bridge = collectionBridge();
    const push = deferred<Awaited<ReturnType<typeof bridge.pushShareDirectWrites>>>();
    if (arrival === "push response") bridge.pushShareDirectWrites.mockImplementationOnce(() => push.promise);
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await waitFor(() => expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce());
    view.rerender(shell(bridge, ENDED_SHARE));
    await act(async () => {
      if (arrival === "push response") push.resolve({ status: "unavailable" });
      else bridge.emitShareDirectWritesPushed({ workspaceId: EDIT_SHARE.workspaceId, result: { status: "unavailable" } });
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
    await waitFor(() => expect(bridge.getWorkspaceRegistry).toHaveBeenCalledOnce());
    const other = { ...EDIT_SHARE, workspaceId: "other-share" };
    view.rerender(shell(bridge, other));
    view.rerender(shell(bridge, EDIT_SHARE));
    await act(async () => registry.resolve({ workspaces: [ENDED_SHARE] }));
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    expect(screen.getByTestId("shared-view-banner").textContent).toContain("Markdown edits save to the live host");
    expect(screen.getByTestId("share-changes-send")).toBeTruthy();
  });
});

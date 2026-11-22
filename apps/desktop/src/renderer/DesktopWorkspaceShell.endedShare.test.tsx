// @vitest-environment jsdom
import type { useShareDirectWrites } from "./shell/useShareDirectWrites";
import * as recordFieldWrites from "./collections/recordFieldWrites";
import { ObserverStub } from "./DesktopWorkspaceShell.testSupport";
import "./CollectionPage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, useMemo, useRef, useState } from "react";
import type { Workspace } from "./DesktopWorkspaceShell";
import { SHARE_EDITING_NOT_READY_MESSAGE } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { editorTabTestId } from "../testPins";

import { collectionTabPath } from "./workbench/workbenchState";
import { serializeCollectionSchema } from "./collections/schemaAuthoring";

import {
  DesktopWorkspaceShell,
  SHARE_VIEW,
  makeShareBridge,
  shellBootstrapProps,
  storedStateWithTabs,
} from "./DesktopWorkspaceShell.testHarness";
const directWriteInput = vi.hoisted(() => ({
  current: null as Parameters<typeof useShareDirectWrites>[0] | null,
}));
vi.mock("./shell/useShareDirectWrites", async (importOriginal) => {
  const original = await importOriginal<typeof import("./shell/useShareDirectWrites")>();
  return {
    ...original,
    useShareDirectWrites: (input: Parameters<typeof useShareDirectWrites>[0]) => {
      directWriteInput.current = input;
      original.useShareDirectWrites(input);
    },
  };
});

const EDIT_SHARE: Workspace = {
  ...SHARE_VIEW,
  shareView: { ...SHARE_VIEW.shareView!, access: "edit" },
};
const ENDED_SHARE: Workspace = {
  ...EDIT_SHARE,
  shareView: { ...EDIT_SHARE.shareView!, ended: true },
};
const ENDED_SENTENCE =
  "This share was ended by granter@dohc.test. Your copy stays readable but will not update anymore.";

function collectionBridge() {
  const bridge = makeShareBridge(
    Promise.resolve(storedStateWithTabs([collectionTabPath("tasks")])),
  );
  bridge.listWorkspaceFiles.mockResolvedValue({
    visibility: { status: "ready" as const, rules: [] },
    files: [{ path: "tasks/retained.md", kind: "file" }],
    folders: ["tasks"],
  });
  bridge.listCollections.mockResolvedValue({
    collections: [{ path: "tasks", objectId: "schema", status: "valid", reasons: [] }],
    unclaimedDatasetFolders: [],
  });
  bridge.getCollection.mockResolvedValue({
    path: "tasks",
    objectId: "schema",
    status: "valid",
    reasons: [],
    recordCount: 1,
    schema: {
      name: "Tasks",
      description: null,
      fields: [
        { name: "Name", type: "text" },
        { name: "Finish", type: "button" },
      ],
      views: [],
    },
  });
  bridge.queryCollectionRecords.mockResolvedValue({
    collection: { path: "tasks", objectId: "schema", status: "valid", reasons: [] },
    records: [
      {
        id: "retained",
        path: "tasks/retained.md",
        conflicted: false,
        values: [
          {
            field: "Name",
            value: "Retained task",
            validation: { status: "valid" },
            resolvedRelations: [],
          },
        ],
      },
    ],
    groups: null,
    nextCursor: null,
  });
  bridge.listAutomationButtons.mockResolvedValue({
    buttons: [
      {
        field: "Finish",
        table: null,
        state: { kind: "ready", automationId: "collection:tasks#finish" },
      },
    ],
  });
  // Keep the cached Edit permission after revocation. The shell must gate it
  // before another automation read has a chance to replace this result.
  bridge.listCollectionAutomations.mockResolvedValue({
    status: "shared",
    definitions: {
      contentHash: "a".repeat(64),
      canSwitch: true,
      sync: "accepted",
      file: {
        status: "read",
        entries: [
          {
            status: "valid",
            canSwitch: true,
            enabledInFile: true,
            automation: {
              id: "finish",
              name: "Finish task",
              enabled: true,
              if: null,
              when: { kind: "button", field: "Finish", table: null },
              do: [
                {
                  kind: "set",
                  values: [{ field: "Name", value: { kind: "literal", value: "Finished" } }],
                  records: null,
                  operation: null,
                },
              ],
            },
          },
        ],
      },
    },
  });
  return bridge;
}

function RegistryShell({
  bridge,
  workspace,
}: {
  bridge: ReturnType<typeof collectionBridge>;
  workspace: Workspace;
}) {
  const selection = useMemo(() => ({ workspace }), [workspace]);
  const current = useRef(selection);
  current.current = selection;
  const [registry, setRegistry] = useState<{
    selection: typeof selection;
    workspace: Workspace;
  } | null>(null);
  const bootstrap = useMemo(
    () =>
      shellBootstrapProps(bridge, (workspaces) => {
        if (current.current !== selection) return;
        const entry = workspaces.find((entry) => entry.workspaceId === workspace.workspaceId);
        if (entry) setRegistry({ selection, workspace: entry });
      }),
    [bridge, workspace, selection],
  );
  const shown = registry?.selection === selection ? registry.workspace : workspace;
  return (
    <DesktopWorkspaceShell
      workspace={shown}
      workspaces={[shown]}
      {...bootstrap}
      onSwitchWorkspace={() => undefined}
    />
  );
}

function shell(bridge: ReturnType<typeof collectionBridge>, workspace: Workspace) {
  return <RegistryShell bridge={bridge} workspace={workspace} />;
}

function focusAfterMinimum() {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
  fireEvent.focus(window);
}

function openCollectionActions() {
  if (!screen.queryByRole("menu", { name: "Collection actions" }))
    fireEvent.click(screen.getByRole("button", { name: "Collection actions" }));
}
function offersCollectionAction(testId: string): boolean {
  openCollectionActions();
  const offered = screen.queryByTestId(testId) !== null;
  fireEvent.click(screen.getByRole("button", { name: "Collection actions" }));
  return offered;
}
async function runCollectionAction(testId: string) {
  await screen.findByTestId("collection-new-record");
  openCollectionActions();
  fireEvent.click(screen.getByTestId(testId));
}

async function saveNewRow(name: string) {
  fireEvent.click(await screen.findByTestId("collection-new-record"));
  const input = document.querySelector<HTMLInputElement>("[data-cell-editor] input")!;
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}
async function noticeSays(text: string) {
  await waitFor(() =>
    expect(screen.getByTestId("workspace-shell-error").textContent).toContain(text),
  );
  expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
    "You typed: Name: Milk",
  );
  expect(document.querySelector("[data-new-record-status]")).toBeNull();
}
const PART_WAY = "dohc created the record file but could not finish the record.";

async function assertReadableAndReadOnly(bridge: ReturnType<typeof collectionBridge>) {
  await waitFor(() =>
    expect(screen.getByTestId("shared-view-banner").textContent).toContain(ENDED_SENTENCE),
  );
  expect(await screen.findByText("Retained task")).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getAllByTestId("tree-row").find((row) => row.dataset.path === "tasks")?.dataset
        .collection,
    ).toBe("true"),
  );
  expect(screen.queryByTestId("share-changes-send")).toBeNull();
  expect(screen.queryByTestId("shared-view-refresh")).toBeNull();
  expect(offersCollectionAction("collection-fields-button")).toBe(false);
  expect(screen.queryByTestId("collection-new-record")).toBeNull();
  expect(
    within(screen.getByTestId("collection-view-switcher"))
      .getByRole("button", { name: "Table" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: "Add a view" })).toBeNull();
  expect(screen.queryByRole("button", { name: "View actions" })).toBeNull();
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
  it.each(["record creation", "Send"] as const)(
    "uses the shell's ended refusal for retained %s after a damaged share also ends",
    async (action) => {
      const shellRefusal = vi.spyOn(recordFieldWrites, "setCollectionFieldWriteAccess");
      const bridge = collectionBridge();
      bridge.createCollectionRecord.mockResolvedValueOnce({
        kind: "partial",
        created: ["tasks/Untitled.md"],
        failedStage: "index",
        reason: "index unavailable",
        retry: {
          mode: "resume",
          recordId: "rec_abcdefghijklmnopqrstuvwxyz",
          instruction: "Try again to finish this record.",
        },
      });
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await screen.findByTestId("collection-new-record");
      const send = directWriteInput.current!.sendShareChanges;
      if (action === "record creation") {
        await saveNewRow("Milk");
        await noticeSays(PART_WAY);
      }
      view.rerender(
        shell(bridge, { ...ENDED_SHARE, shareView: { ...ENDED_SHARE.shareView!, damaged: true } }),
      );
      if (action === "record creation") {
        await waitFor(() =>
          expect(screen.getByTestId("workspace-shell-error").textContent).toContain(PART_WAY),
        );
        expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByTestId("notice-center-toggle"));
        fireEvent.click(
          within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }),
        );
      } else await act(async () => send());
      const message = "Your access to this share ended.";
      await waitFor(() =>
        expect(screen.getByTestId("workspace-shell-error").textContent).toContain(message),
      );
      if (action === "record creation")
        expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
          "You typed: Name: Milk",
        );
      expect(shellRefusal).toHaveBeenLastCalledWith(EDIT_SHARE.workspaceId, message);
      expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(
        action === "record creation" ? 1 : 0,
      );
      expect(bridge.submitShareChanges).not.toHaveBeenCalled();
      shellRefusal.mockRestore();
    },
  );
  const offsets = {
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  };
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ObserverStub);
    vi.stubGlobal("IntersectionObserver", ObserverStub);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 600,
    });
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
    const renderShell = (workspace: Workspace) => (
      <Profiler
        id="live-share"
        onRender={(_id, phase) => {
          if (phase === "mount") mounted();
        }}
      >
        {shell(bridge, workspace)}
      </Profiler>
    );
    const view = render(renderShell(edit));
    await screen.findByRole("button", { name: "Retained task" });
    const narrowed: Workspace = {
      ...edit,
      shareView: {
        ...edit.shareView!,
        access: "view",
        unsavedPaths: ["tasks/locked.md"],
        unconfirmedChanges: { paths: ["tasks/automations.yaml"], unchecked: false, checked: 1 },
      },
    };
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
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "They are kept on this computer.",
      ),
    );
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
      bridge.refreshSharedView.mockResolvedValue({
        ok: true,
        probed: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      });
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
      await act(async () => focusAfterMinimum());
      expect(bridge.getWorkspaceRegistry.mock.calls.length).toBe(registryReads + 1);
      expect(screen.queryByTestId("collection-new-record")).toBeNull();
      expect(offersCollectionAction("collection-fields-button")).toBe(false);
      expect(offersCollectionAction("collection-views-button")).toBe(false);
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
      expect(screen.getByTestId("shared-view-banner").textContent).toContain(
        "This share was ended",
      );
      expect(bridge.refreshSharedView).toHaveBeenCalledTimes(4);
      expect(screen.getByText("Retained task")).toBeTruthy();
      expect(bridge.checkSharedViewAccess).toHaveBeenCalled();
      for (const [payload] of bridge.checkSharedViewAccess.mock.calls) {
        expect(payload).toEqual({ workspaceId: EDIT_SHARE.workspaceId });
      }
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers editing after the owner raises the level, once the person returns to the window", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, SHARE_VIEW));
    await screen.findByText("Retained task");
    await act(async () => undefined);
    expect(screen.queryByTestId("collection-new-record")).toBeNull();
    const refreshes = () =>
      (bridge.refreshSharedView.mock.calls as unknown as Array<[{ trigger?: string }]>).map(
        ([payload]) => payload.trigger,
      );
    const fullRefreshes = () => refreshes().filter((trigger) => trigger === "manual").length;
    const returnToWindow = async () => {
      const checks = bridge.checkSharedViewAccess.mock.calls.length;
      const pulls = refreshes().length;
      focusAfterMinimum();
      await waitFor(() => {
        expect(bridge.checkSharedViewAccess.mock.calls.length).toBe(checks + 1);
        expect(refreshes().length).toBeGreaterThan(pulls);
      });
      await act(async () => undefined);
    };
    await returnToWindow();
    expect(fullRefreshes()).toBe(0);

    bridge.checkSharedViewAccess.mockResolvedValue({
      status: "current",
      access: "view",
      relayStatesMore: true,
    });
    await returnToWindow();
    await waitFor(() => expect(fullRefreshes()).toBe(1));
    expect(bridge.refreshSharedView).toHaveBeenLastCalledWith({
      workspaceId: SHARE_VIEW.workspaceId,
      trigger: "manual",
    });
    await waitFor(() =>
      expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(false),
    );

    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    view.rerender(shell(bridge, EDIT_SHARE));
    expect(await screen.findByTestId("collection-new-record")).toBeTruthy();
    expect(screen.getByTestId("share-changes-send")).toBeTruthy();
    await returnToWindow();
    expect(fullRefreshes()).toBe(1);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    view.unmount();
  });

  describe("the refresh a return asks for when the relay states more", () => {
    const unchanged = {
      ok: true as const,
      status: "unchanged" as const,
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    };
    async function viewShareTheRelayStatesMoreFor() {
      const bridge = collectionBridge();
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, SHARE_VIEW));
      await screen.findByText("Retained task");
      await act(async () => undefined);
      const fullRefreshes = () =>
        (bridge.refreshSharedView.mock.calls as unknown as Array<[{ trigger?: string }]>).filter(
          ([payload]) => payload.trigger === "manual",
        ).length;
      const first = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
      bridge.refreshSharedView.mockImplementation((async (payload: { trigger?: string }) =>
        payload.trigger === "manual" && fullRefreshes() === 1
          ? first.promise
          : unchanged) as unknown as typeof bridge.refreshSharedView);
      bridge.checkSharedViewAccess.mockResolvedValue({
        status: "current",
        access: "view",
        relayStatesMore: true,
      });
      return { bridge, view, fullRefreshes, first };
    }

    it("is one at a time: a return while it is under way starts no second one", async () => {
      const { bridge, view, fullRefreshes, first } = await viewShareTheRelayStatesMoreFor();
      const checks = bridge.checkSharedViewAccess.mock.calls.length;
      focusAfterMinimum();
      await waitFor(() => expect(fullRefreshes()).toBe(1));
      focusAfterMinimum();
      await waitFor(() => expect(bridge.checkSharedViewAccess.mock.calls.length).toBe(checks + 2));
      await act(async () => undefined);
      expect(fullRefreshes()).toBe(1);
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
      await act(async () => first.resolve(unchanged));
      await waitFor(() => expect(fullRefreshes()).toBe(2));
      await act(async () => undefined);
      expect(fullRefreshes()).toBe(2);
      view.unmount();
    });

    it("offers Try again when it fails", async () => {
      const { bridge, view, fullRefreshes, first } = await viewShareTheRelayStatesMoreFor();
      focusAfterMinimum();
      await waitFor(() => expect(fullRefreshes()).toBe(1));
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
      await act(async () =>
        first.resolve({
          ok: false,
          errorKind: "transient",
          changedPaths: 0,
          errorMessage:
            "dohc could not turn on editing for this share. Choose Refresh, or return to this window, to try again.",
        }),
      );
      const notice = await screen.findByTestId("workspace-shell-error");
      expect(notice.textContent).toContain(
        "dohc could not turn on editing for this share. Choose Refresh, or return to this window, to try again.",
      );
      expect(fullRefreshes()).toBe(1);
      fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(fullRefreshes()).toBe(2));
      view.unmount();
    });
  });

  describe("a share at View because editing could not be turned on", () => {
    const NOT_READY_SHARE: Workspace = {
      ...SHARE_VIEW,
      shareView: { ...SHARE_VIEW.shareView!, editingNotReady: true },
    };
    const fullRefreshes = (bridge: ReturnType<typeof collectionBridge>) =>
      (bridge.refreshSharedView.mock.calls as unknown as Array<[{ trigger?: string }]>).filter(
        ([payload]) => payload.trigger === "manual",
      ).length;
    const rowSaying = (words: string) => {
      if (!screen.queryByTestId("notice-center"))
        fireEvent.click(screen.getByTestId("notice-center-toggle"));
      return [
        ...screen
          .getByTestId("notice-center")
          .querySelectorAll<HTMLElement>('[data-testid^="notice-"]'),
      ]
        .filter(
          (candidate) =>
            candidate.textContent!.includes(words) &&
            within(candidate).queryAllByRole("button", { name: "Try again" }).length === 1,
        )
        .sort((a, b) => a.textContent!.length - b.textContent!.length)[0]!;
    };
    const rowsSaying = (words: string) => {
      if (!screen.queryByTestId("notice-center"))
        fireEvent.click(screen.getByTestId("notice-center-toggle"));
      return screen.getByTestId("notice-center").textContent!.split(words).length - 1;
    };

    it("says so with Try again on the refresh, and stops once editing is on", async () => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, NOT_READY_SHARE));
      await screen.findByText("Retained task");
      const notice = await screen.findByTestId("workspace-shell-error");
      expect(notice.textContent).toContain(SHARE_EDITING_NOT_READY_MESSAGE);
      expect(notice.textContent).not.toContain("refresh the shared view");
      await act(async () => undefined);
      const before = fullRefreshes(bridge);
      fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(fullRefreshes(bridge)).toBe(before + 1));
      expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(1);
      expect(
        within(rowSaying(SHARE_EDITING_NOT_READY_MESSAGE)).queryByRole("button", {
          name: "Dismiss notice",
        }),
      ).toBeNull();

      view.rerender(shell(bridge, EDIT_SHARE));
      expect(await screen.findByTestId("collection-new-record")).toBeTruthy();
      await waitFor(() => expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(0));
      view.unmount();
    });

    it("keeps one notice when a refresh answers that editing is still not on", async () => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, NOT_READY_SHARE));
      await screen.findByText("Retained task");
      await screen.findByTestId("workspace-shell-error");
      await act(async () => undefined);
      bridge.refreshSharedView.mockResolvedValue({
        ok: false,
        errorKind: "transient",
        changedPaths: 0,
        errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
        editingNotReady: true,
      });
      const before = fullRefreshes(bridge);
      fireEvent.click(screen.getByTestId("shared-view-refresh"));
      await waitFor(() => expect(fullRefreshes(bridge)).toBe(before + 1));
      await waitFor(() =>
        expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(1);
      expect(rowsSaying("refresh the shared view")).toBe(0);
      view.unmount();
    });

    it("keeps one row through background pulls that answer editing is still not on, and drops it when editing comes on", async () => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, NOT_READY_SHARE));
      await screen.findByText("Retained task");
      await act(async () => undefined);
      bridge.refreshSharedView.mockResolvedValue({
        ok: false,
        errorKind: "transient",
        changedPaths: 0,
        errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
        editingNotReady: true,
      });
      const before = bridge.refreshSharedView.mock.calls.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await act(async () => focusAfterMinimum());
        for (let pull = 0; pull < 6; pull++) await act(() => vi.advanceTimersByTimeAsync(40_000));
      } finally {
        vi.useRealTimers();
      }
      expect(bridge.refreshSharedView.mock.calls.length - before).toBeGreaterThanOrEqual(5);
      expect(fullRefreshes(bridge)).toBe(0);
      expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(1);
      expect(rowsSaying("refresh the shared view")).toBe(0);

      view.rerender(shell(bridge, EDIT_SHARE));
      expect(await screen.findByTestId("collection-new-record")).toBeTruthy();
      await waitFor(() => expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(0));
      view.unmount();
    });

    it("refuses a write with the same words, not with a request to ask for Edit access", async () => {
      const bridge = collectionBridge();
      const refusal = vi.spyOn(recordFieldWrites, "setCollectionFieldWriteAccess");
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
      bridge.createCollectionRecord.mockResolvedValueOnce({
        kind: "partial",
        created: ["tasks/Untitled.md"],
        failedStage: "index",
        reason: "index unavailable",
        retry: {
          mode: "resume",
          recordId: "rec_abcdefghijklmnopqrstuvwxyz",
          instruction: "Try again to finish this record.",
        },
      });
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await saveNewRow("Milk");
      await noticeSays(PART_WAY);

      bridge.checkSharedViewAccess.mockResolvedValue({
        status: "current",
        access: "view",
        relayStatesMore: true,
      });
      view.rerender(
        shell(bridge, {
          ...EDIT_SHARE,
          shareView: { ...EDIT_SHARE.shareView!, access: "view", editingNotReady: true },
        }),
      );
      await waitFor(() => expect(screen.queryByTestId("collection-new-record")).toBeNull());
      expect(refusal).toHaveBeenLastCalledWith(
        EDIT_SHARE.workspaceId,
        SHARE_EDITING_NOT_READY_MESSAGE,
      );
      await act(async () => focusAfterMinimum());
      expect(refusal).toHaveBeenLastCalledWith(
        EDIT_SHARE.workspaceId,
        SHARE_EDITING_NOT_READY_MESSAGE,
      );

      if (!screen.queryByTestId("notice-center"))
        fireEvent.click(screen.getByTestId("notice-center-toggle"));
      fireEvent.click(
        within(rowSaying("could not finish the record")).getByRole("button", { name: "Try again" }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
          SHARE_EDITING_NOT_READY_MESSAGE,
        ),
      );
      expect(rowsSaying("Ask for Edit access")).toBe(0);
      expect(rowsSaying("does not have Edit access")).toBe(0);
      expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
      view.unmount();
    });

    it("files nothing when editing came on while a refresh that answered not ready was repainting", async () => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, SHARE_VIEW));
      await screen.findByText("Retained task");
      await act(async () => undefined);
      bridge.refreshSharedView.mockResolvedValue({
        ok: false,
        errorKind: "transient",
        changedPaths: 1,
        errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
        editingNotReady: true,
      });
      const listing = await bridge.listWorkspaceFiles({ workspaceId: SHARE_VIEW.workspaceId });
      const repaint = deferred<typeof listing>();
      const listed = bridge.listWorkspaceFiles.mock.calls.length;
      bridge.listWorkspaceFiles.mockReturnValue(repaint.promise);
      fireEvent.click(screen.getByTestId("shared-view-refresh"));
      await waitFor(() =>
        expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(listed),
      );
      bridge.refreshSharedView.mockResolvedValue({
        ok: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      });
      bridge.listWorkspaceFiles.mockResolvedValue(listing);
      view.rerender(shell(bridge, EDIT_SHARE));
      expect(await screen.findByTestId("collection-new-record")).toBeTruthy();
      await act(async () => repaint.resolve(listing));
      await waitFor(() =>
        expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(0);
      view.unmount();
    });

    it("does not bring the notice back when a check cleared it while a refresh was repainting", async () => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, NOT_READY_SHARE));
      await screen.findByText("Retained task");
      await screen.findByTestId("workspace-shell-error");
      await act(async () => undefined);
      expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(1);
      bridge.refreshSharedView.mockResolvedValue({
        ok: false,
        errorKind: "transient",
        changedPaths: 1,
        errorMessage: SHARE_EDITING_NOT_READY_MESSAGE,
        editingNotReady: true,
      });
      const listing = await bridge.listWorkspaceFiles({ workspaceId: SHARE_VIEW.workspaceId });
      const repaint = deferred<typeof listing>();
      const listed = bridge.listWorkspaceFiles.mock.calls.length;
      bridge.listWorkspaceFiles.mockReturnValue(repaint.promise);
      fireEvent.click(screen.getByTestId("shared-view-refresh"));
      await waitFor(() =>
        expect(bridge.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(listed),
      );
      bridge.listWorkspaceFiles.mockResolvedValue(listing);
      view.rerender(shell(bridge, SHARE_VIEW));
      await waitFor(() => expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(0));
      await act(async () => repaint.resolve(listing));
      await waitFor(() =>
        expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(0);
      view.unmount();
    });

    it("says it for a copy a refresh narrowed, and nothing for a share the relay states at View", async () => {
      const bridge = collectionBridge();
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "view" });
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, SHARE_VIEW));
      await screen.findByText("Retained task");
      await act(async () => undefined);
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(0);

      view.rerender(shell(bridge, NOT_READY_SHARE));
      await waitFor(() => expect(rowsSaying(SHARE_EDITING_NOT_READY_MESSAGE)).toBe(1));
      view.unmount();
    });
  });

  it("shows the access-ended notice for a save after the owner stops sharing", async () => {
    const bridge = collectionBridge();
    bridge.readWorkspaceText.mockResolvedValue({
      text: serializeCollectionSchema({
        name: "Tasks",
        description: null,
        fields: [{ name: "Name", type: "text" }],
        views: [],
      }),
      truncated: false,
      contentHash: "a".repeat(64),
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    await runCollectionAction("collection-fields-button");
    const dialog = await screen.findByTestId("collection-fields-dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Field name" }), {
      target: { value: "Extra" },
    });
    const write = deferred<Awaited<ReturnType<typeof bridge.writeWorkspaceText>>>();
    bridge.writeWorkspaceText.mockImplementationOnce(() => write.promise);
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "ended" });
    fireEvent.click(screen.getByTestId("collection-add-field"));
    await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());
    focusAfterMinimum();
    await waitFor(() => expect(screen.queryByTestId("collection-fields-dialog")).toBeNull());
    await act(async () => write.reject(new Error("Your access to this share ended.")));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "Your access to this share ended.",
      ),
    );
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    expect(screen.getByTestId("notice-center").textContent).toContain(
      "Your access to this share ended.",
    );
  });

  it("makes one access recheck for one refused push", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    await screen.findByTestId("collection-new-record");
    await act(async () => {});
    const before = bridge.checkSharedViewAccess.mock.calls.length;
    await act(async () =>
      bridge.emitShareDirectWritesPushed({
        workspaceId: EDIT_SHARE.workspaceId,
        result: {
          status: "pushed",
          writes: [
            { result: "refused", paths: ["tasks/collection.yaml"], reason: "access changed" },
          ],
        },
      }),
    );
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
      expect(offersCollectionAction("collection-fields-button")).toBe(true);
      expect(screen.getByTestId("collection-new-record")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Finish for Retained task" })).toBeTruthy();
      fireEvent.click(screen.getByTestId("collection-automations-button"));
      await screen.findByRole("switch", { name: "Finish task" });
      fireEvent.click(screen.getByRole("button", { name: "Retained task" }));
      expect(screen.getByRole("textbox")).toBeTruthy();
      await waitFor(() =>
        expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      if (arrival === "registry props") {
        view.rerender(shell(bridge, ENDED_SHARE));
      } else if (arrival === "access check") {
        bridge.checkSharedViewAccess.mockResolvedValue({ status: "ended" });
        focusAfterMinimum();
      } else {
        if (arrival === "registry refresh")
          bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [ENDED_SHARE] });
        else
          bridge.refreshSharedView.mockImplementation(async () => {
            bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [ENDED_SHARE] });
            return {
              ok: true,
              status: "ended",
              changedPaths: 0,
              excludedPaths: [],
              unjournalablePaths: [],
              refusedOps: 0,
              refusedDetail: null,
            };
          });
        fireEvent.click(screen.getByTestId("shared-view-refresh"));
      }
      await assertReadableAndReadOnly(bridge);
      const reads = bridge.queryCollectionRecords.mock.calls.length;
      act(() => bridge.emitWorkspaceActivity({ paths: ["tasks/retained.md"] }));
      await waitFor(() =>
        expect(bridge.queryCollectionRecords.mock.calls.length).toBeGreaterThan(reads),
      );
      expect(screen.getByText("Retained task")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open Retained task" }));
      const record = await screen.findByRole("complementary", { name: "Retained task" });
      expect(
        within(within(record).getByRole("heading", { name: "Retained task" })).queryByRole(
          "button",
        ),
      ).toBeNull();
      const edit = await within(record).findByTestId("markdown-edit-toggle");
      await waitFor(() => expect(screen.queryByTestId("markdown-open-state")).toBeNull());
      expect(edit.hasAttribute("disabled") || edit.getAttribute("aria-disabled") === "true").toBe(
        true,
      );
      act(() => bridge.emitMenuCommand("command-palette"));
      expect(screen.queryByText("New collection")).toBeNull();
    },
  );

  it.each(["fields", "views"])(
    "removes an open %s dialog when the registry ends the share",
    async (kind) => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await runCollectionAction(`collection-${kind}-button`);
      await screen.findByTestId(`collection-${kind}-dialog`);
      view.rerender(shell(bridge, ENDED_SHARE));
      await waitFor(() => expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull());
      expect(screen.getByText("Retained task")).toBeTruthy();
      view.rerender(shell(bridge, { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView! } }));
      await screen.findByTestId("collection-new-record");
      expect(offersCollectionAction(`collection-${kind}-button`)).toBe(true);
      expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull();
    },
  );

  it.each(["registry refresh", "refresh outcome"] as const)(
    "restores the same share without reopening after %s ended it",
    async (arrival) => {
      const bridge = collectionBridge();
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await screen.findByRole("button", { name: "Retained task" });
      await waitFor(() =>
        expect((screen.getByTestId("shared-view-refresh") as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [ENDED_SHARE] });
      if (arrival === "refresh outcome")
        bridge.refreshSharedView.mockResolvedValue({
          ok: true,
          status: "ended",
          changedPaths: 0,
          excludedPaths: [],
          unjournalablePaths: [],
          refusedOps: 0,
          refusedDetail: null,
        });
      fireEvent.click(screen.getByTestId("shared-view-refresh"));
      await waitFor(() => expect(screen.queryByTestId("collection-new-record")).toBeNull());
      expect(screen.getByTestId("shared-view-banner").textContent).toContain(ENDED_SENTENCE);
      const restored = { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView! } };
      bridge.getWorkspaceRegistry.mockResolvedValue({ workspaces: [restored] });
      bridge.refreshSharedView.mockResolvedValue({
        ok: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      });
      view.rerender(shell(bridge, restored));
      await screen.findByRole("button", { name: "Retained task" });
      expect(screen.getByTestId("collection-new-record")).toBeTruthy();
      expect(offersCollectionAction("collection-fields-button")).toBe(true);
      expect(screen.getByTestId("shared-view-refresh")).toBeTruthy();
      expect(screen.getByTestId("share-changes-send")).toBeTruthy();
      expect(screen.getByTestId("shared-view-banner").textContent).not.toContain(ENDED_SENTENCE);
    },
  );

  it("reports a non-access creation error without waiting for an access check", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    bridge.createCollectionRecord.mockRejectedValueOnce(
      new Error("tasks/Untitled.md already exists. Choose another record name."),
    );
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    await screen.findByTestId("collection-new-record");
    await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalledOnce());
    const pending = deferred<Awaited<ReturnType<typeof bridge.checkSharedViewAccess>>>();
    bridge.checkSharedViewAccess.mockReturnValue(pending.promise);
    await saveNewRow("Milk");
    await noticeSays("already exists");
    expect(bridge.checkSharedViewAccess).toHaveBeenCalledOnce();
  });

  it.each([
    {
      error:
        "ShareUnavailableError: This share was ended, or the code does not match your account.",
      access: "ended",
    },
    { error: "This Collection does not have Edit access.", access: "changed" },
    { error: "RelayClaimRefusedError: The relay refused this change.", access: "changed" },
    { error: "TypeError: fetch failed", access: "ended" },
  ] as const)(
    "rechecks creation failure $error and reports $access access",
    async ({ error, access }) => {
      const bridge = collectionBridge();
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
      bridge.createCollectionRecord.mockRejectedValueOnce(new Error(error));
      vi.stubGlobal("dohcDesktop", bridge);
      render(shell(bridge, EDIT_SHARE));
      await screen.findByTestId("collection-new-record");
      await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalledOnce());
      const pending = deferred<Awaited<ReturnType<typeof bridge.checkSharedViewAccess>>>();
      bridge.checkSharedViewAccess.mockReturnValueOnce(pending.promise);
      await saveNewRow("Milk");
      await waitFor(() => expect(bridge.checkSharedViewAccess).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
      await act(async () =>
        pending.resolve(
          access === "ended" ? { status: "ended" } : { status: "current", access: "view" },
        ),
      );
      await waitFor(() =>
        expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
          `Your access to this share ${access}.`,
        ),
      );
    },
  );

  it("keeps what a recipient typed in a new row, with why, when the relay refuses the record, and opens no file tab", async () => {
    const bridge = collectionBridge();
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access: "edit" });
    const refused = {
      path: "tasks/Milk.md",
      recordId: "rec_abcdefghijklmnopqrstuvwxyz",
      delivery: "refused" as const,
      reason: "The owner's server did not accept this record.",
    };
    bridge.createCollectionRecord.mockResolvedValueOnce(refused);
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    await saveNewRow("Milk");
    await noticeSays("The owner's server did not accept this record.");

    expect(bridge.createCollectionRecord.mock.calls[0]![0]).toMatchObject({
      collectionPath: "tasks",
      name: "Milk",
    });
    expect(document.querySelector("[data-new-record]")?.textContent).toBe("");
    expect(screen.queryByTestId(editorTabTestId("tasks/Milk.md"))).toBeNull();

    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    fireEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(bridge.createCollectionRecord).toHaveBeenCalledTimes(2));
    expect(bridge.createCollectionRecord.mock.calls[1]![0]).toMatchObject({
      collectionPath: "tasks",
    });
    expect(screen.queryByTestId(editorTabTestId("tasks/Milk.md"))).toBeNull();
  });

  it("reports a record creation retry after the share ends", async () => {
    const bridge = collectionBridge();
    bridge.createCollectionRecord.mockResolvedValueOnce({
      kind: "partial",
      created: ["tasks/Untitled.md"],
      failedStage: "index",
      reason: "index unavailable",
      retry: {
        mode: "resume",
        recordId: "rec_abcdefghijklmnopqrstuvwxyz",
        instruction: "Try again to finish this record.",
      },
    });
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await saveNewRow("Milk");
    await noticeSays(PART_WAY);
    view.rerender(shell(bridge, ENDED_SHARE));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "You typed: Name: Milk",
      ),
    );
    expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    fireEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "Your access to this share ended.",
      ),
    );
    expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
  });

  it.each(["view", "comment"] as const)(
    "blocks retained creation retries and draft delivery after access narrows to %s",
    async (access) => {
      const bridge = collectionBridge();
      bridge.queryCollectionRecords.mockResolvedValue({
        collection: { path: "tasks", objectId: "schema", status: "valid", reasons: [] },
        records: [
          {
            id: "draft",
            path: "tasks/draft.md",
            conflicted: false,
            creationDelivery: "pending",
            creationCanDiscard: false,
            values: [
              {
                field: "Name",
                value: "Created draft",
                validation: { status: "valid" },
                resolvedRelations: [],
              },
            ],
          },
        ],
        groups: null,
        nextCursor: null,
      });
      bridge.createCollectionRecord.mockResolvedValueOnce({
        kind: "partial",
        created: ["tasks/Untitled.md"],
        failedStage: "index",
        reason: "index unavailable",
        retry: {
          mode: "resume",
          recordId: "rec_abcdefghijklmnopqrstuvwxyz",
          instruction: "Try again to finish this record.",
        },
      });
      vi.stubGlobal("dohcDesktop", bridge);
      render(shell(bridge, EDIT_SHARE));
      await saveNewRow("Milk");
      await noticeSays(PART_WAY);
      bridge.checkSharedViewAccess.mockResolvedValue({ status: "current", access });
      focusAfterMinimum();
      await waitFor(() => expect(screen.queryByTestId("collection-new-record")).toBeNull());
      const drafts = screen.getByTestId("collection-record-drafts");
      expect(drafts.textContent).toContain(
        "Your share access does not allow sending this draft. It is saved on this computer.",
      );
      expect(within(drafts).queryByRole("button", { name: "Try again" })).toBeNull();
      fireEvent.click(screen.getByTestId("notice-center-toggle"));
      fireEvent.click(
        within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
          "Your access to this share changed.",
        ),
      );
      expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
      expect(bridge.pushShareDirectWrites).toHaveBeenCalledOnce();
    },
  );

  it("keeps the reopen explanation on a retained creation retry after the recipient pin becomes unreadable", async () => {
    const bridge = collectionBridge();
    bridge.createCollectionRecord.mockResolvedValueOnce({
      kind: "partial",
      created: ["tasks/Untitled.md"],
      failedStage: "index",
      reason: "index unavailable",
      retry: {
        mode: "resume",
        recordId: "rec_abcdefghijklmnopqrstuvwxyz",
        instruction: "Try again to finish this record.",
      },
    });
    vi.stubGlobal("dohcDesktop", bridge);
    render(shell(bridge, EDIT_SHARE));
    await saveNewRow("Milk");
    await noticeSays(PART_WAY);
    bridge.checkSharedViewAccess.mockResolvedValue({ status: "needs-reopen" });
    focusAfterMinimum();
    await waitFor(() => expect(screen.queryByTestId("collection-new-record")).toBeNull());
    fireEvent.click(screen.getByTestId("notice-center-toggle"));
    fireEvent.click(
      within(screen.getByTestId("notice-center")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
        "This share must be reopened.",
      ),
    );
    expect(screen.getByTestId("workspace-shell-error").textContent).not.toContain(
      "access to this share changed",
    );
    expect(bridge.createCollectionRecord).toHaveBeenCalledOnce();
  });

  it.each(["fields", "views"] as const)(
    "reports an in-flight %s save failure even after access returns and a new dialog opens",
    async (kind) => {
      const bridge = collectionBridge();
      bridge.readWorkspaceText.mockResolvedValue({
        text: serializeCollectionSchema({
          name: "Tasks",
          description: null,
          fields: [{ name: "Name", type: "text" }],
          views: [],
        }),
        truncated: false,
        contentHash: "a".repeat(64),
      });
      const write = deferred<Awaited<ReturnType<typeof bridge.writeWorkspaceText>>>();
      bridge.writeWorkspaceText.mockImplementationOnce(() => write.promise);
      vi.stubGlobal("dohcDesktop", bridge);
      const view = render(shell(bridge, EDIT_SHARE));
      await runCollectionAction(`collection-${kind}-button`);
      const dialog = await screen.findByTestId(`collection-${kind}-dialog`);
      fireEvent.change(
        within(dialog).getByRole("textbox", {
          name: kind === "fields" ? "Field name" : "View name",
        }),
        { target: { value: "Extra" } },
      );
      fireEvent.click(
        screen.getByTestId(kind === "fields" ? "collection-add-field" : "collection-add-view"),
      );
      await waitFor(() => expect(bridge.writeWorkspaceText).toHaveBeenCalledOnce());
      view.rerender(shell(bridge, ENDED_SHARE));
      await waitFor(() => expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull());
      view.rerender(shell(bridge, { ...EDIT_SHARE, shareView: { ...EDIT_SHARE.shareView! } }));
      await screen.findByTestId("collection-new-record");
      expect(offersCollectionAction(`collection-${kind}-button`)).toBe(true);
      expect(screen.queryByTestId(`collection-${kind}-dialog`)).toBeNull();
      openCollectionActions();
      fireEvent.click(screen.getByTestId(`collection-${kind}-button`));
      await screen.findByTestId(`collection-${kind}-dialog`);
      await act(async () => {
        write.reject(new Error("Your access to this share ended."));
      });
      await waitFor(() =>
        expect(screen.getByTestId("workspace-shell-error").textContent).toContain(
          "Your access to this share ended.",
        ),
      );
      expect(
        within(screen.getByTestId(`collection-${kind}-dialog`)).queryByText(
          "dohc could not update this collection. Your access to this share ended.",
        ),
      ).toBeNull();
    },
  );

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
    expect(screen.getByTestId("shared-view-banner").textContent).toContain(
      "Pages save as you type",
    );
    expect(screen.getByTestId("share-changes-send")).toBeTruthy();
  });

  it("queues a background pull behind a manual refresh and pauses its own 401", async () => {
    const bridge = collectionBridge();
    vi.stubGlobal("dohcDesktop", bridge);
    const view = render(shell(bridge, EDIT_SHARE));
    await screen.findByText("Retained task");
    await act(async () => undefined);
    const before = bridge.refreshSharedView.mock.calls.length;
    const manual = deferred<Awaited<ReturnType<typeof bridge.refreshSharedView>>>();
    bridge.refreshSharedView.mockReturnValueOnce(manual.promise);
    bridge.refreshSharedView.mockResolvedValue({
      ok: false,
      probed: true,
      errorKind: "unauthorized",
      changedPaths: 0,
      errorMessage: "Sign in again.",
    });
    fireEvent.click(screen.getByTestId("shared-view-refresh"));
    await act(async () => focusAfterMinimum());
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before + 1);
    await act(async () =>
      manual.resolve({
        ok: true,
        status: "unchanged",
        changedPaths: 0,
        excludedPaths: [],
        unjournalablePaths: [],
        refusedOps: 0,
        refusedDetail: null,
      }),
    );
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before + 2);
    expect(bridge.refreshSharedView).toHaveBeenLastCalledWith({
      workspaceId: EDIT_SHARE.workspaceId,
      trigger: "background",
    });
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(bridge.refreshSharedView.mock.calls.length).toBe(before + 2);
    view.unmount();
  });
});

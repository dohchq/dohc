// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ListCollectionAutomationsResult,
  SwitchCollectionAutomationPayload,
  SwitchCollectionAutomationResult,
} from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { automationCount, AutomationsPanel, useCollectionAutomations, type AutomationFocus } from "./AutomationsPanel";
import type { SharedAutomationDefinitions } from "./SharedAutomationsPanel";
import type { Automation } from "./automationSentence";

const HASH = "a".repeat(64);
const NEXT = "b".repeat(64);
const PERSONAL = "This automation has a personal step and cannot be switched through a share.";
const stamp: Automation = {
  id: "stamp",
  name: "Stamp the finish date",
  enabled: true,
  when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" }, table: null },
  if: null,
  do: [{ kind: "set", values: [{ field: "Finished on", value: { kind: "formula", expression: "today()" } }], records: null, operation: null }],
};
const nudge: Automation = { ...stamp, id: "nudge", name: "Nudge the owner", enabled: false, when: { kind: "record-added", table: null } };

type Entry = Extract<SharedAutomationDefinitions["file"], { status: "read" }>["entries"][number];
const valid = (automation: Automation, overrides: Partial<Entry> = {}): Entry =>
  ({ status: "valid", automation, enabledInFile: automation.enabled, canSwitch: true, ...overrides }) as Entry;
const broken: Entry = {
  status: "invalid", id: "broken", name: "Broken", diagnostics: [{ code: "invalid-id", path: "/automations/1/id" }], raw: {},
  enabledInFile: null, canSwitch: false,
};

function shared(entries: Entry[], overrides: Partial<SharedAutomationDefinitions> = {}): ListCollectionAutomationsResult {
  return {
    status: "shared",
    definitions: {
      file: { status: "read", entries }, contentHash: HASH, canSwitch: true, sync: "accepted",
      ...overrides,
    },
  };
}

function makeBridge(first: ListCollectionAutomationsResult) {
  let current = first;
  const listeners = new Set<(event: { workspaceId: string }) => void>();
  const bridge = {
    listCollectionAutomations: vi.fn(async (): Promise<ListCollectionAutomationsResult> => current),
    listAutomationHolds: vi.fn(async () => ({ holds: [], unreadable: false })),
    switchCollectionAutomation: vi.fn(async (_payload: SwitchCollectionAutomationPayload): Promise<SwitchCollectionAutomationResult> =>
      ({ status: "written", contentHash: NEXT, sync: "pending" })),
    onCollectionAutomationsChanged: vi.fn((listener: (event: { workspaceId: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    // The owner's panel stands in while the list loads; a shared one reads no runs.
    listCollectionAutomationRuns: vi.fn(async () => ({ status: "listed" as const, runs: [], next: null })),
    onAutomationRunsChanged: vi.fn(() => () => undefined),
    onAutomationHoldsChanged: vi.fn(() => () => undefined),
    readScheduleHost: vi.fn(async () => ({ kind: "this-computer" as const })),
    onScheduleHostChanged: vi.fn(() => () => undefined),
    onCloudSessionChanged: vi.fn(() => () => undefined),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  return {
    bridge,
    replace: (next: ListCollectionAutomationsResult) => {
      current = next;
    },
    // Main says a shared file's change reached the relay, or the file changed.
    changed: (workspaceId: string) => act(() => {
      for (const listener of listeners) listener({ workspaceId });
    }),
  };
}

type ErrorReport = (fallback: string, error: unknown, retry?: (() => void) | null) => void;
const ignoreError: ErrorReport = () => undefined;

function Panel(props: {
  workspaceId?: string;
  focus?: AutomationFocus | null;
  onError?: ErrorReport;
  onOpenFile?: (path: string) => void;
  closeAsk?: number;
  onClose?: () => void;
}) {
  const onError = props.onError ?? ignoreError;
  const workspaceId = props.workspaceId ?? "ws-view";
  const automations = useCollectionAutomations(workspaceId, "Tasks", onError);
  return (
    <>
      <span data-testid="count">{automationCount(automations.file)}</span>
      <AutomationsPanel
        workspaceId={workspaceId}
        collectionPath="Tasks"
        automations={automations}
        fields={[]}
        focus={props.focus ?? null}
        closeAsk={props.closeAsk ?? 0}
        onClose={props.onClose ?? (() => undefined)}
        onOpenFile={props.onOpenFile ?? (() => undefined)}
        onOpenScheduleSettings={() => undefined}
        onError={onError}
        onNotice={() => undefined}
      />
    </>
  );
}

const switchOf = (id: string) => within(screen.getByTestId(`automation-${id}`)).getByRole("switch") as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the ⚡ panel of a Collection reached through a share", () => {
  it("lists each automation as the file says, with a switch only where the share allows one, and no runs", async () => {
    const { bridge } = makeBridge(shared([valid(stamp), valid(nudge, { canSwitch: false, switchReason: PERSONAL })]));
    render(<Panel />);
    const on = await screen.findByTestId("automation-stamp");
    expect(on.textContent).toContain("When Status becomes Done, set Finished on to today");
    expect(within(on).getByRole("switch", { name: "Stamp the finish date" }).getAttribute("aria-checked")).toBe("true");
    const off = screen.getByTestId("automation-nudge");
    expect(within(off).queryByRole("switch")).toBeNull();
    expect(within(off).getByText("Off")).toBeTruthy();
    expect(within(off).getByText(PERSONAL)).toBeTruthy();
    expect(screen.getByTestId("count").textContent).toBe("2");
    // Runs stay where they ran; the panel says so where the owner's shows them.
    expect(screen.getByText("Run history stays on the owner's computer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /actions$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New automation" })).toBeNull();
    expect(screen.queryByText(/No automations/)).toBeNull();
    expect(bridge.listCollectionAutomationRuns).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/running|stopped/i);
  });

  it("gives the share's reason beside each automation it cannot switch, and says when a change did not sync", async () => {
    const reason = "Open this share in its own workspace to switch automations.";
    makeBridge(shared(
      [valid(stamp, { canSwitch: false, switchReason: reason }), valid(nudge, { canSwitch: false, switchReason: reason })],
      { canSwitch: false, switchReason: reason, sync: "refused" },
    ));
    render(<Panel />);
    expect(await screen.findAllByText(reason)).toHaveLength(2);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(within(screen.getByTestId("automation-stamp")).getByText("On")).toBeTruthy();
    expect(within(screen.getByTestId("automation-nudge")).getByText("Off")).toBeTruthy();
    expect(screen.getByText("Your change to automations.yaml did not sync.")).toBeTruthy();
    expect(screen.queryByText("Waiting to sync")).toBeNull();
  });

  it("says which automation dohc cannot read and why, and offers the file", async () => {
    makeBridge(shared([valid(stamp, { canSwitch: false }), broken]));
    const onOpenFile = vi.fn();
    render(<Panel onOpenFile={onOpenFile} />);
    expect(await screen.findByText("dohc cannot read this automation.")).toBeTruthy();
    expect(screen.getByText("invalid-id at /automations/1/id")).toBeTruthy();
    expect(within(screen.getByTestId("automation-stamp")).queryByRole("switch")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledWith("Tasks/automations.yaml");
  });

  it("says when the file is missing or unreadable, without offering to add one", async () => {
    const { replace, changed } = makeBridge({ status: "shared", definitions: {
      file: { status: "missing" }, contentHash: null, canSwitch: true, sync: "accepted",
    } });
    render(<Panel />);
    expect(await screen.findByText("This Collection has no automations.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New automation" })).toBeNull();
    replace({ status: "shared", definitions: {
      file: { status: "unreadable", diagnostic: { code: "invalid-yaml", path: "", line: 3 } }, contentHash: HASH, canSwitch: true,
      sync: "accepted",
    } });
    changed("ws-view");
    expect(await screen.findByText("invalid-yaml on line 3")).toBeTruthy();
  });

  it("switches from the keyboard with the file's id, value, and hash, and says Waiting to sync until the relay takes it", async () => {
    const user = userEvent.setup();
    const { bridge, replace, changed } = makeBridge(shared([valid(stamp), valid(nudge)]));
    const sent = deferred<SwitchCollectionAutomationResult>();
    bridge.switchCollectionAutomation.mockReturnValueOnce(sent.promise);
    render(<Panel />);
    (await screen.findByRole("switch", { name: "Stamp the finish date" })).focus();
    await user.keyboard(" ");
    expect(bridge.switchCollectionAutomation).toHaveBeenCalledWith({
      workspaceId: "ws-view", collectionPath: "Tasks", automation: "stamp", enabled: false,
      expectedContentHash: HASH, reformat: false, submitId: expect.any(String),
    });
    // On its way, the switch shows where the person put it, and the others wait.
    expect(switchOf("stamp").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("automation-stamp").textContent).toContain("Waiting to sync");
    expect(switchOf("nudge").disabled).toBe(true);

    replace(shared([valid({ ...stamp, enabled: false }), valid(nudge)], { contentHash: NEXT, sync: "pending" }));
    await act(async () => sent.resolve({ status: "written", contentHash: NEXT, sync: "pending" }));
    await waitFor(() => expect(switchOf("nudge").disabled).toBe(false));
    expect(screen.getByTestId("automation-stamp").textContent).toContain("Waiting to sync");
    expect(screen.getByTestId("automation-nudge").textContent).not.toContain("Waiting to sync");
    expect(document.body.textContent).not.toMatch(/running|stopped/i);

    // Another workspace's change reads nothing; this one's reads the file again.
    replace(shared([valid({ ...stamp, enabled: false }), valid(nudge)], { contentHash: NEXT }));
    const reads = bridge.listCollectionAutomations.mock.calls.length;
    changed("ws-other");
    expect(bridge.listCollectionAutomations).toHaveBeenCalledTimes(reads);
    changed("ws-view");
    await waitFor(() => expect(screen.getByTestId("automation-stamp").textContent).not.toContain("Waiting to sync"));
    expect(switchOf("stamp").getAttribute("aria-checked")).toBe("false");
  });

  it("says Waiting to sync for a change saved before the panel opened", async () => {
    makeBridge(shared([valid(stamp)], { sync: "pending" }));
    render(<Panel />);
    await screen.findByTestId("automation-stamp");
    expect(screen.getAllByText("Waiting to sync")).toHaveLength(1);
  });

  it("reports a file that changed after it was read as a toast and a Notices row, reads it again, and Try again switches over it", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const { bridge, replace } = makeBridge(shared([valid(stamp)]));
    bridge.switchCollectionAutomation.mockResolvedValueOnce({ status: "conflict" });
    render(<Panel onError={onError} />);
    replace(shared([valid({ ...stamp, name: "Stamp the date" })], { contentHash: NEXT }));
    await user.click(await screen.findByRole("switch", { name: "Stamp the finish date" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(
      'automations.yaml changed after dohc read it, so dohc did not switch "Stamp the finish date" off.', null, expect.any(Function),
    ));
    // The panel shows the file as it is now, and nothing beside the entry.
    expect(switchOf("stamp").getAttribute("aria-label")).toBe("Stamp the date");
    expect(switchOf("stamp").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("automation-stamp").textContent).not.toMatch(/changed after|Waiting to sync/);
    act(() => (onError.mock.calls[0]?.[2] as () => void)());
    await waitFor(() => expect(bridge.switchCollectionAutomation).toHaveBeenCalledTimes(2));
    expect(bridge.switchCollectionAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, expectedContentHash: NEXT }));
  });

  it("keeps a saved switch and Waiting to sync when the read after it fails, until a read succeeds", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const { bridge, replace, changed } = makeBridge(shared([valid(stamp)]));
    render(<Panel onError={onError} />);
    await screen.findByTestId("automation-stamp");
    bridge.listCollectionAutomations.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    await user.click(switchOf("stamp"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not read this Collection's automations.", expect.any(Error), expect.any(Function)));
    await waitFor(() => expect(switchOf("stamp").disabled).toBe(false));
    expect(switchOf("stamp").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("automation-stamp").textContent).toContain("Waiting to sync");

    replace(shared([valid({ ...stamp, enabled: false })], { contentHash: NEXT }));
    changed("ws-view");
    await waitFor(() => expect(screen.getByTestId("automation-stamp").textContent).not.toContain("Waiting to sync"));
    expect(switchOf("stamp").getAttribute("aria-checked")).toBe("false");
  });

  it("asks before laying out a hand-formatted file, then switches with consent and a new submit id", async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge(shared([valid(stamp)]));
    bridge.switchCollectionAutomation.mockResolvedValueOnce({ status: "reformats" });
    render(<Panel />);
    await user.click(await screen.findByRole("switch", { name: "Stamp the finish date" }));
    expect((await screen.findByTestId("automations-reformat")).textContent).toContain("so you lose its comments and hand formatting.");
    await user.click(screen.getByTestId("automations-reformat-confirm"));
    await waitFor(() => expect(bridge.switchCollectionAutomation).toHaveBeenCalledTimes(2));
    const [first, second] = bridge.switchCollectionAutomation.mock.calls.map(([payload]) => payload);
    expect(second).toMatchObject({ automation: "stamp", enabled: false, expectedContentHash: HASH, reformat: true });
    expect(second?.submitId).not.toBe(first?.submitId);
  });

  it("reports a failed switch with Try again, which reads the file again and saves nothing once it already says so", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const { bridge, replace } = makeBridge(shared([valid(stamp)]));
    bridge.switchCollectionAutomation.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    render(<Panel onError={onError} />);
    await user.click(await screen.findByRole("switch", { name: "Stamp the finish date" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('dohc could not switch "Stamp the finish date" off.', expect.any(Error), expect.any(Function)));
    await waitFor(() => expect(switchOf("stamp").getAttribute("aria-checked")).toBe("true"));

    // Try again switches over the file as main reads it then.
    bridge.switchCollectionAutomation.mockResolvedValueOnce({ status: "unknown", submitId: "submit-2" });
    replace(shared([valid(stamp)], { contentHash: NEXT }));
    await act(async () => (onError.mock.calls[0]?.[2] as () => void)());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(bridge.switchCollectionAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, expectedContentHash: NEXT }));
    expect(onError).toHaveBeenLastCalledWith('dohc could not tell whether it switched "Stamp the finish date" off.', null, expect.any(Function));
    replace(shared([valid({ ...stamp, enabled: false })], { contentHash: NEXT }));
    await act(async () => (onError.mock.calls[1]?.[2] as () => void)());
    expect(bridge.switchCollectionAutomation).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("keeps Try again working from Notices after the panel closes and the file changes", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const { bridge, replace } = makeBridge(shared([valid(stamp)]));
    bridge.switchCollectionAutomation.mockResolvedValueOnce({ status: "conflict" });
    const { unmount } = render(<Panel onError={onError} />);
    await user.click(await screen.findByRole("switch", { name: "Stamp the finish date" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    unmount();
    replace(shared([valid(stamp)], { contentHash: NEXT }));
    bridge.switchCollectionAutomation.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    await act(async () => (onError.mock.calls[0]?.[2] as () => void)());
    expect(bridge.switchCollectionAutomation).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: "ws-view", collectionPath: "Tasks", automation: "stamp", enabled: false, expectedContentHash: NEXT,
    }));
    // Its outcome still reaches Notices with the panel closed.
    expect(onError).toHaveBeenLastCalledWith('dohc could not switch "Stamp the finish date" off.', expect.any(Error), expect.any(Function));
  });

  it("switches back a saved switch over the file main wrote when the read after it failed", async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge(shared([valid(stamp)]));
    render(<Panel />);
    await screen.findByTestId("automation-stamp");
    bridge.listCollectionAutomations.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    await user.click(switchOf("stamp"));
    await waitFor(() => expect(switchOf("stamp").disabled).toBe(false));
    expect(switchOf("stamp").getAttribute("aria-checked")).toBe("false");
    await user.click(switchOf("stamp"));
    await waitFor(() => expect(bridge.switchCollectionAutomation).toHaveBeenCalledTimes(2));
    expect(bridge.switchCollectionAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, expectedContentHash: NEXT }));
  });

  it("drops a switch's answer once the panel shows another workspace", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const { bridge } = makeBridge(shared([valid(stamp)]));
    const sent = deferred<SwitchCollectionAutomationResult>();
    bridge.switchCollectionAutomation.mockReturnValueOnce(sent.promise);
    const { rerender } = render(<Panel onError={onError} />);
    await user.click(await screen.findByRole("switch", { name: "Stamp the finish date" }));
    rerender(<Panel workspaceId="ws-2" onError={onError} />);
    await waitFor(() => expect(bridge.listCollectionAutomations).toHaveBeenCalledWith({ workspaceId: "ws-2", collectionPath: "Tasks" }));
    await act(async () => sent.resolve({ status: "refused-write", reason: "The share ended." }));
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByText("Waiting to sync")).toBeNull();
    expect(switchOf("stamp").disabled).toBe(false);
  });

  it("shows the panel while the list loads, and reports a failed read with Try again", async () => {
    const onError = vi.fn();
    const { bridge } = makeBridge(shared([valid(stamp)]));
    bridge.listCollectionAutomations.mockRejectedValueOnce(new Error("The workspace engine is not running."));
    render(<Panel onError={onError} />);
    expect(screen.getByRole("button", { name: "Close automations" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not read this Collection's automations.", expect.any(Error), expect.any(Function)));
    act(() => (onError.mock.calls[0]?.[2] as () => void)());
    expect(await screen.findByRole("switch", { name: "Stamp the finish date" })).toBeTruthy();
  });

  it("puts focus on the switch a notice names, on its row where no switch shows, and on Close once it is gone", async () => {
    makeBridge(shared([valid(nudge), valid({ ...stamp, enabled: false }), valid({ ...stamp, id: "wake", name: "Wake my agent" }, { canSwitch: false, switchReason: PERSONAL })]));
    const ask = (automationId: string, seq: number): AutomationFocus => ({ automationId, run: null, controls: true, seq });
    const { rerender } = render(<Panel focus={ask("stamp", 1)} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.queryByRole("switch", { name: "Stamp the finish date" })));
    rerender(<Panel focus={ask("wake", 2)} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("automation-wake")));
    rerender(<Panel focus={ask("gone", 3)} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close automations" })));
  });

  it("reads the file again for an automation a notice names that this panel has not read, then focuses its switch", async () => {
    const { bridge, replace } = makeBridge(shared([valid(nudge)]));
    const { rerender } = render(<Panel />);
    await screen.findByTestId("automation-nudge");
    const reads = bridge.listCollectionAutomations.mock.calls.length;
    // Main found it in a newer read of the file than the panel's.
    replace(shared([valid(nudge), valid({ ...stamp, enabled: false })], { contentHash: NEXT }));
    rerender(<Panel focus={{ automationId: "stamp", run: null, controls: true, seq: 1 }} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.queryByRole("switch", { name: "Stamp the finish date" })));
    expect(bridge.listCollectionAutomations).toHaveBeenCalledTimes(reads + 1);
  });

  it("closes when the page's button asks", async () => {
    makeBridge(shared([valid(stamp)]));
    const onClose = vi.fn();
    const { rerender } = render(<Panel onClose={onClose} />);
    await screen.findByTestId("automation-stamp");
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Panel onClose={onClose} closeAsk={1} />);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

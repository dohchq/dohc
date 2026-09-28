// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, ScheduleHostResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { ScheduleHostRow } from "./ScheduleHostRow";

const SEP_20 = new Date(2026, 8, 20, 12).getTime();
const SEP_25 = new Date(2026, 8, 25, 12).getTime();

const relay = (overrides: Partial<Extract<ScheduleHostResult, { kind: "relay" }>> = {}): ScheduleHostResult => ({
  kind: "relay",
  generation: 3,
  hostInstallId: "laptop",
  handoverFrom: null,
  computers: [
    { installId: "desk", kind: "computer", label: "Ice's desktop", lastSeenMs: SEP_25, thisComputer: true },
    { installId: "laptop", kind: "computer", label: "Ice's laptop", lastSeenMs: SEP_20, thisComputer: false },
  ],
  ...overrides,
});

type SessionListener = Parameters<DohcDesktopBridge["onCloudSessionChanged"]>[0];
const listeners: { session: SessionListener | null; host: ((workspaceId: string) => void) | null } = { session: null, host: null };

function install(fake: Partial<DohcDesktopBridge>) {
  window.dohcDesktop = {
    onCloudSessionChanged: (listener: SessionListener) => {
      listeners.session = listener;
      return () => { listeners.session = null; };
    },
    onScheduleHostChanged: (listener: (workspaceId: string) => void) => {
      listeners.host = listener;
      return () => { listeners.host = null; };
    },
    ...fake,
  } as DohcDesktopBridge;
}

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

describe("Schedules run on", () => {
  it("lists the owner's computers with when each was last seen, and marks the one that runs schedules", async () => {
    install({ readScheduleHost: vi.fn(async () => relay()) });
    render(<ScheduleHostRow workspaceId="ws" />);
    const laptop = await screen.findByTestId("schedule-host-laptop");
    expect(laptop.getAttribute("aria-pressed")).toBe("true");
    expect(laptop.textContent).toContain("Ice's laptop");
    expect(screen.getByTestId("schedule-host-desk").textContent).toContain("This computer");
    expect(screen.queryByTestId("schedule-host-handover")).toBeNull();
  });

  it("starts a handover when another computer is chosen, then waits for it", async () => {
    const chooseScheduleHost = vi.fn(async () => relay({ generation: 4, hostInstallId: "desk", handoverFrom: "laptop" }));
    install({ readScheduleHost: vi.fn(async () => relay()), chooseScheduleHost });
    render(<ScheduleHostRow workspaceId="ws" />);
    await userEvent.click(await screen.findByTestId("schedule-host-desk"));
    expect(chooseScheduleHost).toHaveBeenCalledWith({ workspaceId: "ws", installId: "desk", generation: 3 });
    const waiting = await screen.findByTestId("schedule-host-handover");
    expect(waiting.textContent).toContain(`Waiting for Ice's laptop to hand over. Last seen ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(SEP_20)}.`);
  });

  it("asks before taking over, and says a run can repeat", async () => {
    const takeOverScheduleHost = vi.fn(async () => relay({ generation: 5, hostInstallId: "desk" }));
    install({
      readScheduleHost: vi.fn(async () => relay({ generation: 4, hostInstallId: "desk", handoverFrom: "laptop" })),
      takeOverScheduleHost,
    });
    render(<ScheduleHostRow workspaceId="ws" />);
    const waiting = await screen.findByTestId("schedule-host-handover");
    await userEvent.click(within(waiting).getByRole("button", { name: "Take over now" }));
    expect(takeOverScheduleHost).not.toHaveBeenCalled();
    expect(within(waiting).getByRole("alert").textContent).toBe("If Ice's laptop is still on, a run can repeat.");
    await userEvent.click(within(waiting).getByRole("button", { name: "Cancel" }));
    expect(within(waiting).queryByRole("alert")).toBeNull();

    await userEvent.click(within(waiting).getByRole("button", { name: "Take over now" }));
    await userEvent.click(within(waiting).getByRole("button", { name: "Take over now" }));
    expect(takeOverScheduleHost).toHaveBeenCalledWith({ workspaceId: "ws", generation: 4 });
    expect(await screen.findByTestId("schedule-host-desk")).toBeTruthy();
    expect(screen.queryByTestId("schedule-host-handover")).toBeNull();
  });

  it("says why it cannot choose, shows this computer for a workspace that never synced, and hides for a shared view", async () => {
    install({ readScheduleHost: vi.fn(async (): Promise<ScheduleHostResult> => ({ kind: "note", message: "Sign in to the account that synced this workspace." })) });
    const { unmount } = render(<ScheduleHostRow workspaceId="ws" />);
    expect((await screen.findByTestId("schedule-host-note")).textContent).toBe("Sign in to the account that synced this workspace.");
    unmount();
    install({ readScheduleHost: vi.fn(async (): Promise<ScheduleHostResult> => ({ kind: "this-computer" })) });
    const local = render(<ScheduleHostRow workspaceId="ws" />);
    expect((await screen.findByTestId("schedule-host-note")).textContent).toBe("This computer");
    local.unmount();
    const read = deferred<ScheduleHostResult>();
    install({ readScheduleHost: vi.fn(() => read.promise) });
    render(<ScheduleHostRow workspaceId="ws" />);
    await act(async () => read.resolve({ kind: "none" }));
    expect(screen.queryByTestId("settings-row-schedule-host")).toBeNull();
  });

  it("checks again after a note, as when the connection comes back", async () => {
    const onError = vi.fn();
    const readScheduleHost = vi.fn()
      .mockResolvedValueOnce({ kind: "note", message: "dohc could not reach your server to check which computer runs schedules." })
      .mockResolvedValueOnce(relay());
    install({ readScheduleHost });
    render(<ScheduleHostRow workspaceId="ws" onError={onError} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(await screen.findByTestId("schedule-host-laptop")).toBeTruthy();
    expect(screen.queryByTestId("schedule-host-note")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failed read through the shell and offers Try again", async () => {
    const onError = vi.fn();
    const readScheduleHost = vi.fn()
      .mockRejectedValueOnce(new Error("dohc could not reach your server."))
      .mockResolvedValueOnce(relay());
    install({ readScheduleHost });
    render(<ScheduleHostRow workspaceId="ws" onError={onError} />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(onError).toHaveBeenCalledWith("dohc could not reach your server.");
    expect(await screen.findByTestId("schedule-host-laptop")).toBeTruthy();
  });

  it("starts over when the account changes, and never shows the old account's answer", async () => {
    const first = deferred<ScheduleHostResult>();
    const readScheduleHost = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(relay({ hostInstallId: "desk" }));
    install({ readScheduleHost });
    render(<ScheduleHostRow workspaceId="ws" />);
    act(() => listeners.session?.({ sessionKey: "bo", phase: "changing" }));
    await act(async () => first.resolve(relay()));
    expect(screen.queryByTestId("settings-row-schedule-host"), "the old account's answer").toBeNull();
    act(() => listeners.session?.({ sessionKey: "bo", phase: "ready" }));
    expect((await screen.findByTestId("schedule-host-desk")).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a handover that finished in the background", async () => {
    const readScheduleHost = vi.fn()
      .mockResolvedValueOnce(relay({ generation: 4, hostInstallId: "desk", handoverFrom: "laptop" }))
      .mockResolvedValueOnce(relay({ generation: 5, hostInstallId: "desk" }));
    install({ readScheduleHost });
    render(<ScheduleHostRow workspaceId="ws" />);
    await screen.findByTestId("schedule-host-handover");
    act(() => listeners.host?.("other-workspace"));
    expect(readScheduleHost).toHaveBeenCalledTimes(1);
    act(() => listeners.host?.("ws"));
    await vi.waitFor(() => expect(screen.queryByTestId("schedule-host-handover")).toBeNull());
  });

  it("moves focus into the confirmation and back, and ties the warning to its buttons", async () => {
    install({ readScheduleHost: vi.fn(async () => relay({ generation: 4, hostInstallId: "desk", handoverFrom: "laptop" })) });
    render(<ScheduleHostRow workspaceId="ws" />);
    const waiting = await screen.findByTestId("schedule-host-handover");
    await userEvent.click(within(waiting).getByRole("button", { name: "Take over now" }));
    const cancel = within(waiting).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    const warning = within(waiting).getByRole("alert");
    expect(cancel.getAttribute("aria-describedby")).toBe(warning.id);
    expect(within(waiting).getByRole("button", { name: "Take over now" }).getAttribute("aria-describedby")).toBe(warning.id);
    await userEvent.click(cancel);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(within(waiting).getByRole("button", { name: "Take over now" })));
  });

  it("gives the list one tab stop and moves between computers with the arrows, Home, and End", async () => {
    install({ readScheduleHost: vi.fn(async () => relay({
      computers: [
        { installId: "desk", kind: "computer", label: "Ice's desktop", lastSeenMs: SEP_25, thisComputer: true },
        { installId: "laptop", kind: "computer", label: "Ice's laptop", lastSeenMs: SEP_20, thisComputer: false },
        { installId: "mini", kind: "computer", label: "Studio mini", lastSeenMs: SEP_20, thisComputer: false },
      ],
    })) });
    render(<ScheduleHostRow workspaceId="ws" />);
    const laptop = await screen.findByTestId("schedule-host-laptop");
    const desk = screen.getByTestId("schedule-host-desk");
    const mini = screen.getByTestId("schedule-host-mini");
    expect([desk.tabIndex, laptop.tabIndex, mini.tabIndex], "the chosen computer holds the stop").toEqual([-1, 0, -1]);
    laptop.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(mini);
    expect([desk.tabIndex, laptop.tabIndex, mini.tabIndex], "the stop moves with focus").toEqual([-1, -1, 0]);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(desk);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(mini);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(laptop);
    expect(laptop.getAttribute("aria-pressed")).toBe("true");
  });
});

// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, ScheduleHostResult } from "../../ipc/bridgeContract";
import { scheduleHostNoticeText, useScheduleHostNotice } from "./useScheduleHostNotice";

type Shown = Parameters<Parameters<typeof useScheduleHostNotice>[0]["show"]>[0];

let changed: ((workspaceId: string) => void) | null = null;
function install(fake: Partial<DohcDesktopBridge>) {
  window.dohcDesktop = {
    onScheduleHostChanged: (listener: (workspaceId: string) => void) => {
      changed = listener;
      return () => { changed = null; };
    },
    ...fake,
  } as DohcDesktopBridge;
}

function Probe(props: { show: (notice: Shown) => void; report: () => void }) {
  useScheduleHostNotice({ workspaceId: "ws", ready: true, show: props.show, report: props.report });
  return null;
}

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

describe("where this workspace's schedules run, in Notices", () => {
  it("says which computer runs them only when this computer has schedules there", () => {
    const elsewhere = { kind: "another-computer", label: "Ice's laptop", sameName: false, waits: true } as const;
    expect(scheduleHostNoticeText(elsewhere)).toEqual({
      message: "This workspace's schedules and Group messages run on Ice's laptop, not this computer. If you take over while Ice's laptop is on, a run can repeat.",
      failed: false,
    });
    expect(scheduleHostNoticeText({ ...elsewhere, sameName: true })?.message).toBe(
      "This workspace's schedules and Group messages run on Ice's laptop, which has this computer's name. It may be an earlier installation of dohc here. If you take over while Ice's laptop is on, a run can repeat.",
    );
    expect(scheduleHostNoticeText({ ...elsewhere, waits: false }), "nothing here waits on it").toBeNull();
    expect(scheduleHostNoticeText({ kind: "this-computer" })).toBeNull();
    expect(scheduleHostNoticeText({ kind: "no-computer", message: "No computer runs this workspace's schedules.", cause: "EACCES" }))
      .toEqual({ message: "No computer runs this workspace's schedules.", failed: true, cause: "EACCES" });
  });

  it("reads without asking a relay, shows the row once schedules wait, and takes over from it", async () => {
    let state: ScheduleHostResult = { kind: "another-computer", label: "Ice's laptop", sameName: false, waits: false };
    const readScheduleHost = vi.fn(async () => state);
    const takeOverScheduleHost = vi.fn(async (): Promise<ScheduleHostResult> => ({ kind: "this-computer" }));
    install({ readScheduleHost, takeOverScheduleHost });
    const show = vi.fn<(notice: Shown) => void>();
    render(<Probe show={show} report={() => undefined} />);
    await waitFor(() => expect(show).toHaveBeenCalledWith(null));
    expect(readScheduleHost).toHaveBeenCalledWith({ workspaceId: "ws", localOnly: true });

    // A step here found schedules that the laptop runs.
    state = { ...state, waits: true };
    act(() => changed?.("ws"));
    await waitFor(() => expect(show.mock.lastCall?.[0]?.message).toContain("run on Ice's laptop"));
    const shown = show.mock.lastCall?.[0];
    show.mockClear();
    act(() => shown?.takeOver());
    await waitFor(() => expect(show).toHaveBeenCalledWith(null));
    expect(takeOverScheduleHost).toHaveBeenCalledWith({ workspaceId: "ws", generation: 0 });
  });
});

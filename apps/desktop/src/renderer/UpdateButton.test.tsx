// @vitest-environment jsdom
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStateEvent } from "../ipc/bridgeContract";
import {
  TitlebarUpdateButton,
  updateStatusLine,
  updateStep,
  useUpdateFailureNotices,
  type DesktopUpdate,
} from "./UpdateButton";

const BASE = { currentVersion: "1.2.3", channel: "latest" as const, canCheck: false, canInstall: false };
const idle: UpdateStateEvent = { ...BASE, status: "idle", message: "Updates have not been checked yet.", canCheck: true };
const available: UpdateStateEvent = { ...BASE, status: "available", message: "dohc 1.2.4 is available.", version: "1.2.4" };
const downloading: UpdateStateEvent = { ...BASE, status: "downloading", message: "Downloading update 1.2.4…", version: "1.2.4" };
const ready: UpdateStateEvent = { ...BASE, status: "ready", message: "Update 1.2.4 is ready.", version: "1.2.4", canInstall: true };

function update(state: UpdateStateEvent | null, run = vi.fn(async () => {})): DesktopUpdate {
  return { state, step: updateStep(state, null), run };
}

afterEach(cleanup);

describe("updateStep", () => {
  it("names each step a person can take, and only the found update's steps get an icon", () => {
    const step = (state: UpdateStateEvent, pending: "check" | "install" | null = null) => {
      const s = updateStep(state, pending)!;
      return { action: s.action, label: s.label, percent: s.percent, title: s.title, icon: s.Icon !== null };
    };
    expect(step(idle)).toEqual({ action: "check", label: "Check for updates", percent: undefined, title: "Check for updates", icon: false });
    expect(step(idle, "check")).toMatchObject({ action: null, label: "Checking…", icon: false });
    expect(step({ ...idle, canCheck: false })).toMatchObject({ action: null, label: "Check for updates" });
    expect(step(available)).toEqual({ action: "download", label: "Update", percent: undefined, title: "Download update 1.2.4", icon: true });
    expect(step(downloading)).toEqual({ action: null, label: "Downloading…", percent: undefined, title: "Downloading update 1.2.4", icon: true });
    expect(step({ ...downloading, percent: 41.6 })).toEqual({ action: null, label: "Downloading", percent: 42, title: "Downloading update 1.2.4, 42%", icon: true });
    expect(step(ready)).toEqual({ action: "install", label: "Restart to update", percent: undefined, title: "Restart to install update 1.2.4", icon: true });
    expect(step(ready, "install")).toMatchObject({ action: null, label: "Restarting…", icon: true });
    expect(updateStep(null, null)).toBeNull();
  });
});

describe("updateStatusLine", () => {
  it("leads a failure with the step that failed", () => {
    expect(updateStatusLine(available)).toBe("dohc 1.2.4 is available.");
    expect(updateStatusLine({ ...available, message: "socket hang up", failure: { step: "download", id: 2 } }))
      .toBe("dohc could not download update 1.2.4. socket hang up");
  });
});

describe("useUpdateFailureNotices", () => {
  it("reports each failure once, keeps a repeated one quiet, and clears the row once the step works", () => {
    const report = vi.fn();
    const clear = vi.fn();
    const failed: UpdateStateEvent = { ...idle, status: "error", message: "feed returned 500", failure: { step: "check", id: 1 } };
    const { rerender } = renderHook((props: { state: UpdateStateEvent }) =>
      useUpdateFailureNotices(update(props.state), "ws-1", report, clear), { initialProps: { state: failed } });

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      kind: "update",
      title: "dohc could not check for updates",
      message: "feed returned 500",
      details: [["Cause", "feed returned 500"]],
    }));

    // The same failure in a new state object, and a check that runs again.
    rerender({ state: { ...failed } });
    rerender({ state: { ...idle, status: "checking", message: "Checking for updates…" } });
    expect(report).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();

    rerender({ state: { ...failed, failure: { step: "check", id: 2 } } });
    expect(report).toHaveBeenCalledTimes(2);

    rerender({ state: available });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("files a failure it already toasted as a quiet row in the next workspace", () => {
    const report = vi.fn();
    const failed = { ...available, message: "socket hang up", failure: { step: "download" as const, id: 41 } };
    const first = renderHook(() => useUpdateFailureNotices(update(failed), "ws-1", report, () => {}));
    first.unmount();
    renderHook(() => useUpdateFailureNotices(update(failed), "ws-2", report, () => {}));
    expect(report.mock.calls.map(([failure]) => failure.quiet)).toEqual([false, true]);
  });

  it("retries the step that failed", () => {
    const run = vi.fn(async () => {});
    const report = vi.fn();
    const failed = { ...available, message: "socket hang up", failure: { step: "download" as const, id: 1 } };
    renderHook(() => useUpdateFailureNotices(update(failed, run), "ws-1", report, () => {}));

    report.mock.calls[0]![0].retry();
    expect(run).toHaveBeenCalledWith("download");
  });

  it("says an update a person chose did not install, and takes it back once Try again starts the download", () => {
    const run = vi.fn(async () => {});
    const report = vi.fn();
    const clear = vi.fn();
    const notInstalled: UpdateStateEvent = {
      ...available,
      version: "1.2.5",
      message: "dohc is still on version 1.2.3.",
      failure: { step: "download", id: 70, notInstalled: "1.2.4" },
    };
    const { rerender } = renderHook((props: { state: UpdateStateEvent }) =>
      useUpdateFailureNotices(update(props.state, run), "ws-1", report, clear), { initialProps: { state: notInstalled } });

    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      title: "dohc didn't install update 1.2.4",
      message: "dohc is still on version 1.2.3.",
      details: [],
    }));
    expect(updateStatusLine(notInstalled)).toBe("dohc didn't install update 1.2.4 and is still on version 1.2.3.");
    report.mock.calls[0]![0].retry();
    expect(run).toHaveBeenCalledWith("download");
    // The title bar shows the download from here on.
    rerender({ state: { ...downloading, version: "1.2.5" } });
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe("TitlebarUpdateButton", () => {
  it("shows nothing until an update is found", () => {
    render(<TitlebarUpdateButton update={update(idle)} />);
    expect(screen.queryByTestId("titlebar-update")).toBeNull();
  });

  it("downloads only when pressed, and cannot be pressed while it downloads", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => {});
    const { rerender } = render(<TitlebarUpdateButton update={update(available, run)} />);
    const button = screen.getByTestId("titlebar-update");
    expect(button.getAttribute("title")).toBe("Download update 1.2.4");
    expect(run).not.toHaveBeenCalled();

    await user.click(button);
    expect(run).toHaveBeenCalledWith("download");

    rerender(<TitlebarUpdateButton update={update({ ...downloading, percent: 42 }, run)} />);
    expect(screen.getByTestId("titlebar-update").getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByTestId("titlebar-update"));
    expect(run).toHaveBeenCalledOnce();

    rerender(<TitlebarUpdateButton update={update(ready, run)} />);
    await user.click(screen.getByTestId("titlebar-update"));
    expect(run).toHaveBeenLastCalledWith("install");
  });
});

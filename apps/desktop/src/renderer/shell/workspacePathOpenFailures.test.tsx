// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePathOpenFailure } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { ConnectionNotices, useConnectionNotices } from "./connectionNotices";
import {
  useHeldWorkspacePathOpenFailures,
  useWorkspacePathOpenFailures,
  WorkspacePathOpenFailures,
} from "./workspacePathOpenFailures";

// Main's side: it holds each failure for the window until a take, and
// pushes a ping the window may or may not hear.
let held: WorkspacePathOpenFailure[] = [];
let ping: () => void = () => undefined;
let order: string[] = [];
const retryWorkspacePathOpen = vi.fn(async (_payload: { attemptId: string }) => undefined);

// Main reports a failure: it holds it, then pings.
async function emit(failure: WorkspacePathOpenFailure) {
  held.push(failure);
  await act(async () => ping());
}

beforeEach(() => {
  held = [];
  ping = () => undefined;
  order = [];
  vi.stubGlobal("dohcDesktop", {
    platform: "win32",
    getUpdateState: () => new Promise(() => {}),
    onUpdateState: () => () => {},
    onWorkspacePathOpenFailed: (listener: () => void) => {
      order.push("listen");
      ping = listener;
      return () => {
        ping = () => undefined;
      };
    },
    takeWorkspacePathOpenFailures: async () => {
      order.push("take");
      return held.splice(0);
    },
    retryWorkspacePathOpen,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  retryWorkspacePathOpen.mockReset();
});

// A notice owner as the workspace manager is one: its own toasts and rows.
function Owner(props: { workspaceId: string | null }) {
  const notices = useConnectionNotices();
  useWorkspacePathOpenFailures(props.workspaceId, notices.reportFailure);
  return (
    <ConnectionNotices
      notices={notices.notices}
      reportFailure={notices.reportFailure}
      onRetry={notices.retryNotice}
      onHide={notices.hideNotice}
      onDismiss={notices.dismissNotice}
    />
  );
}

// The window's root: it holds failures whether or not an owner is mounted.
// Each workspace gets its own owner, as DesktopRoot keys the shell.
function Root(props: { owner: string | null | false }) {
  const holding = useHeldWorkspacePathOpenFailures();
  return (
    <WorkspacePathOpenFailures.Provider value={holding}>
      {props.owner === false ? null : <Owner key={String(props.owner)} workspaceId={props.owner} />}
    </WorkspacePathOpenFailures.Provider>
  );
}

function failure(cause: string, change: Partial<WorkspacePathOpenFailure> = {}): WorkspacePathOpenFailure {
  return { attemptId: "attempt-1", path: "C:\\work\\Trips", cause, workspaceId: null, ...change };
}

async function copied(toast: HTMLElement): Promise<string> {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await user.click(within(toast).getByRole("button", { name: "Copy error details" }));
  return String(writeText.mock.lastCall?.[0]);
}

describe("folders a launch could not open", () => {
  it.each([
    [
      "a reserved workspace ID",
      "ReservedWorkspaceIdError: Its workspace ID, link, is reserved. Change workspaceId in .dohc/manifest.json, then open the folder again.",
      "dohc could not open Trips. Its workspace ID, link, is reserved. Change workspaceId in .dohc/manifest.json, then open the folder again.",
      true,
    ],
    [
      "a damaged manifest",
      "WorkspaceManifestError [unreadable]: this folder has an invalid .dohc/manifest.json: manifest kind is invalid",
      "dohc could not open Trips. dohc can't read its .dohc/manifest.json. Fix the file, then try again.",
      true,
    ],
    [
      "a manifest from a newer dohc",
      "WorkspaceManifestError [newer-version]: this workspace was created by a newer version of dohc (manifest v2)",
      "dohc could not open Trips. It needs a newer version of dohc. Update dohc to open it.",
      false,
    ],
    [
      "a folder dohc may not use",
      "Error [EACCES]: EACCES: permission denied, mkdir 'C:\\work\\Trips\\.dohc'",
      "dohc could not open Trips. dohc does not have permission to use this file or folder.",
      true,
    ],
    [
      "an error with nothing a person can act on",
      "ZodError: [{\"code\":\"too_big\",\"path\":[\"workspaceId\"]}]",
      "dohc could not open Trips.",
      true,
    ],
  ])("names the folder and says why for %s, with the error behind Copy", async (_kind, cause, message, canRetry) => {
    render(<Root owner={null} />);
    await emit(failure(cause));

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(message);
    // The error as it arrived is for Copy only.
    expect(toast.textContent).not.toMatch(/Error|EACCES|manifest v2|kind is invalid/);
    expect(within(toast).queryByRole("button", { name: "Try again" }) !== null).toBe(canRetry);
    const details = await copied(toast);
    expect(details).toContain(`Error: ${message}`);
    expect(details).toContain("Folder: C:\\work\\Trips");
    expect(details).toContain(`Cause: ${cause}`);
  });

  it("shows folders main combined as one row, with each listed folder in Copy and no Try again", async () => {
    render(<Root owner={null} />);
    held.push({ attemptId: "more-1", paths: ["C:\\work\\Notes", "C:\\work\\Plans"], count: 3, workspaceId: null });
    await act(async () => ping());

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not open 3 more folders. Copy the details to list them.");
    expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
    const details = await copied(toast);
    expect(details).toContain("Folder: C:\\work\\Notes\nFolder: C:\\work\\Plans\nNot listed: 1 more, named in dohc's log");
  });

  it("shows a failed move to Applications with Try again, which asks main to move again", async () => {
    const user = userEvent.setup();
    render(<Root owner={null} />);
    await emit({ attemptId: "move-1", moveToApplications: true, cause: "Error: Failed to copy dohc.app", workspaceId: null });

    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain(
      "dohc could not move itself to Applications. Failed to copy dohc.app. To move it yourself, drag dohc into Applications in Finder.",
    );
    expect(await copied(toast)).toContain("Error: dohc could not move itself to Applications. Failed to copy dohc.app.");
    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    expect(retryWorkspacePathOpen).toHaveBeenCalledExactlyOnceWith({ attemptId: "move-1" });
  });

  it("keeps the row in Notices, with Try again and Copy, after the toast closes", async () => {
    const user = userEvent.setup();
    render(<Root owner={null} />);
    await emit(failure("Error [EBUSY]: EBUSY: resource busy or locked"));

    const toast = await screen.findByTestId("workspace-shell-error");
    await user.click(within(toast).getByRole("button", { name: "Dismiss workspace error" }));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = within(screen.getByTestId("notice-center"))
      .getByText("dohc could not open Trips. Another program is using this file or folder.")
      .closest("li")!;
    expect(within(row).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Copy error details" })).toBeTruthy();
  });

  it("shows a failure main held before this window listened, such as one reported while it loaded", async () => {
    // Main pinged before the page listened, so only a take can find it.
    held.push(failure("Error [EBUSY]: EBUSY: resource busy or locked"));
    render(<Root owner={null} />);

    expect(order).toEqual(["listen", "take"]);
    expect(await screen.findAllByTestId("workspace-shell-error")).toHaveLength(1);
    expect(held).toEqual([]);
  });

  it("holds a failure that arrives before any notice owner, then shows it once", async () => {
    const view = render(<Root owner={false} />);
    await emit(failure("Error [EBUSY]: EBUSY: resource busy or locked"));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    view.rerender(<Root owner={null} />);
    expect(await screen.findAllByTestId("workspace-shell-error")).toHaveLength(1);
    view.rerender(<Root owner="trips" />);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("drops a failure main tied to a workspace this window no longer shows", async () => {
    render(<Root owner="current" />);
    await emit(failure("Error [EBUSY]: EBUSY: resource busy or locked", { workspaceId: "previous" }));
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    await emit(failure("Error [EBUSY]: EBUSY: resource busy or locked", { workspaceId: "current" }));
    expect(await screen.findByTestId("workspace-shell-error")).toBeTruthy();
  });

  it("asks main to open the same attempt again, and shows main's next answer with its own Try again", async () => {
    const user = userEvent.setup();
    render(<Root owner={null} />);
    await emit(failure("WorkspaceManifestError [unreadable]: this folder has a corrupt .dohc/manifest.json"));

    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    expect(retryWorkspacePathOpen).toHaveBeenCalledExactlyOnceWith({ attemptId: "attempt-1" });
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();

    // Main reports the second failure with a new attempt, on the same row.
    await emit(failure("Error [ENOENT]: ENOENT: no such file or directory, stat 'C:\\work\\Trips'", {
      attemptId: "attempt-2",
    }));
    const toasts = await screen.findAllByTestId("workspace-shell-error");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("dohc could not open Trips. The file or folder is not there anymore.");
    await user.click(within(toasts[0]!).getByRole("button", { name: "Try again" }));
    expect(retryWorkspacePathOpen).toHaveBeenLastCalledWith({ attemptId: "attempt-2" });
  });

  it("says what to do when main refuses the attempt, without another Try again", async () => {
    const user = userEvent.setup();
    retryWorkspacePathOpen.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'desktop:retry-workspace-path-open': Error: Open the folder again.",
    ));
    render(<Root owner={null} />);
    await emit(failure("Error [EBUSY]: EBUSY: resource busy or locked"));

    await user.click(within(await screen.findByTestId("workspace-shell-error")).getByRole("button", { name: "Try again" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(toast.textContent).toContain("dohc could not open Trips. Open the folder again.");
    expect(within(toast).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("reports nothing when a Try again answers after its owner is gone", async () => {
    const refused = deferred<undefined>();
    retryWorkspacePathOpen.mockReturnValueOnce(refused.promise);
    const report = vi.fn<(failure: { retry?: (() => void) | null }) => void>();
    function SpyOwner() {
      useWorkspacePathOpenFailures(null, report);
      return null;
    }
    function SpyRoot(props: { mounted: boolean }) {
      const holding = useHeldWorkspacePathOpenFailures();
      return (
        <WorkspacePathOpenFailures.Provider value={holding}>
          {props.mounted ? <SpyOwner /> : null}
        </WorkspacePathOpenFailures.Provider>
      );
    }
    const view = render(<SpyRoot mounted />);
    await emit(failure("Error [EBUSY]: EBUSY: resource busy or locked"));
    expect(report).toHaveBeenCalledOnce();

    act(() => report.mock.calls[0]![0].retry?.());
    expect(retryWorkspacePathOpen).toHaveBeenCalledOnce();
    view.rerender(<SpyRoot mounted={false} />);
    await act(async () => refused.reject(new Error("Open the folder again.")));
    expect(report).toHaveBeenCalledOnce();
  });
});

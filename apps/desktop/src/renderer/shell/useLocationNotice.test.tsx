// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShellError } from "./useShellError";
import {
  forgetLocationNoticesForTests,
  locationNotice,
  useLocationNotice,
  type WorkspaceLocation,
} from "./useLocationNotice";

afterEach(() => {
  cleanup();
  forgetLocationNoticesForTests();
  localStorage.clear();
});

// The shell's error hook and the location notice, as the workspace shell
// wires them.
function mountShell(workspaceId: string, location: WorkspaceLocation | undefined, platform: NodeJS.Platform = "darwin") {
  return renderHook(
    (props: { location: WorkspaceLocation | undefined }) => {
      const shell = useShellError(workspaceId);
      const notice = useLocationNotice({ workspaceId, location: props.location, platform, report: shell.reportWorkspaceLocation });
      return { shell, notice };
    },
    { initialProps: { location } },
  );
}

// A later launch: this session's memory is gone, the profile's storage stays.
function relaunch(): void {
  forgetLocationNoticesForTests();
}

describe("useLocationNotice", () => {
  it("warns once with a toast and one row, across renders and remounts", () => {
    const first = mountShell("ws-nas", undefined);
    expect(first.result.current.shell.shellErrors).toHaveLength(0);

    first.rerender({ location: "network-share" });
    first.rerender({ location: "network-share" });
    const rows = first.result.current.shell.shellErrors;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tone: "warning",
      ...locationNotice("network-share", "darwin"),
      details: [["Detail", "network-share"]],
      kind: "workspace-location",
      retry: null,
      seen: false,
    });
    first.unmount();

    // A workspace switch remounts the shell: the row again, no second toast.
    const second = mountShell("ws-nas", "network-share");
    expect(second.result.current.shell.shellErrors).toMatchObject([{ kind: "workspace-location", seen: true }]);
    second.unmount();

    // Another workspace gets its own toast.
    const other = mountShell("ws-icloud", "icloud-drive");
    expect(other.result.current.shell.shellErrors).toMatchObject([
      { ...locationNotice("icloud-drive", "darwin"), details: [["Detail", "icloud-drive"]], seen: false },
    ]);
  });

  it("names the place that keeps History private on this computer", () => {
    const sentence = "Anyone who can read the share can read its History, including text deleted from its files.";
    for (const [platform, destination] of [
      ["darwin", "to this computer's disk"],
      ["linux", "to this computer's disk"],
      ["win32", "into your user folder on this computer"],
    ] as const) {
      const shell = mountShell(`ws-${platform}`, "network-share", platform);
      expect(shell.result.current.shell.shellErrors).toMatchObject([{
        title: "This workspace is on a network share",
        message: `${sentence} To keep History private, move the workspace ${destination}.`,
      }]);
      shell.unmount();
    }
    expect(locationNotice("icloud-drive", "win32")).toEqual(locationNotice("icloud-drive", "darwin"));
  });

  it("tells each workspace once per computer, not once per launch", () => {
    mountShell("ws-icloud", "icloud-drive").unmount();
    relaunch();
    expect(mountShell("ws-icloud", "icloud-drive").result.current.shell.shellErrors).toHaveLength(0);
  });

  it("tells again when the workspace moves somewhere else that limits it", () => {
    mountShell("ws-moved", "icloud-drive").unmount();
    relaunch();
    const moved = mountShell("ws-moved", "network-share");
    expect(moved.result.current.shell.shellErrors).toMatchObject([
      { ...locationNotice("network-share", "darwin"), seen: false },
    ]);
  });

  it("stays away for the session once the row is dismissed", () => {
    const first = mountShell("ws-nas", "network-share");
    const [row] = first.result.current.shell.shellErrors;
    act(() => {
      first.result.current.notice.noteDismissed();
      first.result.current.shell.dismissShellError(row!.id);
    });
    expect(first.result.current.shell.shellErrors).toHaveLength(0);
    first.unmount();

    expect(mountShell("ws-nas", "network-share").result.current.shell.shellErrors).toHaveLength(0);
  });

  it("tells again next launch when this computer's storage refuses to keep the fact", () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      mountShell("ws-full", "network-share").unmount();
      relaunch();
      expect(mountShell("ws-full", "network-share").result.current.shell.shellErrors).toMatchObject([{ seen: false }]);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShellError } from "./useShellError";
import { forgetNetworkShareNoticesForTests, networkShareNotice, useNetworkShareNotice } from "./useNetworkShareNotice";

afterEach(() => {
  cleanup();
  forgetNetworkShareNoticesForTests();
  localStorage.clear();
});

// The shell's error hook and the network-share notice, as the workspace
// shell wires them.
function mountShell(workspaceId: string, onNetworkShare: boolean, platform: NodeJS.Platform = "darwin") {
  return renderHook(
    (props: { onNetworkShare: boolean }) => {
      const shell = useShellError(workspaceId);
      const notice = useNetworkShareNotice({ workspaceId, onNetworkShare: props.onNetworkShare, platform, report: shell.reportNetworkShare });
      return { shell, notice };
    },
    { initialProps: { onNetworkShare } },
  );
}

// A later launch: this session's memory is gone, the profile's storage stays.
function relaunch(): void {
  forgetNetworkShareNoticesForTests();
}

describe("useNetworkShareNotice", () => {
  it("warns once with a toast and one row, across renders and remounts", () => {
    const first = mountShell("ws-nas", false);
    expect(first.result.current.shell.shellErrors).toHaveLength(0);

    first.rerender({ onNetworkShare: true });
    first.rerender({ onNetworkShare: true });
    const rows = first.result.current.shell.shellErrors;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tone: "warning",
      ...networkShareNotice("darwin"),
      details: [["Detail", "network-share"]],
      kind: "network-share",
      retry: null,
      seen: false,
    });
    first.unmount();

    // A workspace switch remounts the shell: the row again, no second toast.
    const second = mountShell("ws-nas", true);
    expect(second.result.current.shell.shellErrors).toMatchObject([{ kind: "network-share", seen: true }]);
    second.unmount();

    // Another workspace gets its own toast.
    const other = mountShell("ws-team", true);
    expect(other.result.current.shell.shellErrors).toMatchObject([{ ...networkShareNotice("darwin"), seen: false }]);
  });

  it("names the place that keeps History private on this computer", () => {
    const sentence = "Anyone who can read the share can read its History, including text deleted from its files.";
    for (const [platform, destination] of [
      ["darwin", "to this computer's disk"],
      ["linux", "to this computer's disk"],
      ["win32", "into your user folder on this computer"],
    ] as const) {
      const shell = mountShell(`ws-${platform}`, true, platform);
      expect(shell.result.current.shell.shellErrors).toMatchObject([{
        title: "This workspace is on a network share",
        message: `${sentence} To keep History private, move the workspace ${destination}.`,
      }]);
      shell.unmount();
    }
  });

  it("tells each workspace once per computer, not once per launch", () => {
    mountShell("ws-nas", true).unmount();
    relaunch();
    expect(mountShell("ws-nas", true).result.current.shell.shellErrors).toHaveLength(0);
  });

  it("stays away for the session once the row is dismissed", () => {
    const first = mountShell("ws-nas", true);
    const [row] = first.result.current.shell.shellErrors;
    act(() => {
      first.result.current.notice.noteDismissed();
      first.result.current.shell.dismissShellError(row!.id);
    });
    expect(first.result.current.shell.shellErrors).toHaveLength(0);
    first.unmount();

    expect(mountShell("ws-nas", true).result.current.shell.shellErrors).toHaveLength(0);
  });

  it("tells again next launch when this computer's storage refuses to keep the fact", () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      mountShell("ws-full", true).unmount();
      relaunch();
      expect(mountShell("ws-full", true).result.current.shell.shellErrors).toMatchObject([{ seen: false }]);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});

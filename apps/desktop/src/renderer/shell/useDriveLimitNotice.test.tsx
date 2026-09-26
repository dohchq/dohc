// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShellError } from "./useShellError";
import {
  DRIVE_LIMIT_MESSAGE,
  forgetDriveLimitNoticesForTests,
  useDriveLimitNotice,
} from "./useDriveLimitNotice";

afterEach(() => {
  cleanup();
  forgetDriveLimitNoticesForTests();
});

// The shell's error hook and the drive-limit notice, as the workspace shell
// wires them.
function mountShell(workspaceId: string, unavailable: boolean) {
  return renderHook(
    (props: { unavailable: boolean }) => {
      const shell = useShellError(workspaceId);
      const notice = useDriveLimitNotice({
        workspaceId,
        unavailable: props.unavailable,
        report: shell.reportDriveLimit,
      });
      return { shell, notice };
    },
    { initialProps: { unavailable } },
  );
}

describe("useDriveLimitNotice", () => {
  it("toasts once and keeps one row with copy details, across renders and remounts", () => {
    const first = mountShell("ws-usb", false);
    expect(first.result.current.shell.shellErrors).toHaveLength(0);

    first.rerender({ unavailable: true });
    first.rerender({ unavailable: true });
    const rows = first.result.current.shell.shellErrors;
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe(DRIVE_LIMIT_MESSAGE);
    expect(rows[0].seen).toBe(false);
    expect(rows[0].details).toEqual([["Detail", "no-atomic-placement"]]);
    first.unmount();

    // A workspace switch remounts the shell: the row again, no second toast.
    const second = mountShell("ws-usb", true);
    const again = second.result.current.shell.shellErrors;
    expect(again).toHaveLength(1);
    expect(again[0].seen).toBe(true);
    second.unmount();

    // Another workspace on another such drive gets its own toast.
    const other = mountShell("ws-share", true);
    expect(other.result.current.shell.shellErrors[0].seen).toBe(false);
  });

  it("stays away for the session once the row is dismissed", () => {
    const first = mountShell("ws-usb", true);
    const [row] = first.result.current.shell.shellErrors;
    act(() => {
      first.result.current.notice.noteDismissed();
      first.result.current.shell.dismissShellError(row.id);
    });
    expect(first.result.current.shell.shellErrors).toHaveLength(0);
    first.unmount();

    const second = mountShell("ws-usb", true);
    expect(second.result.current.shell.shellErrors).toHaveLength(0);
  });
});

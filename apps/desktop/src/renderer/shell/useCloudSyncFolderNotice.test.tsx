// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useShellError } from "./useShellError";
import {
  type CloudSyncFolderNoticeState,
  cloudSyncFolderNotice,
  forgetCloudSyncFolderNoticesForTests,
  useCloudSyncFolderNotice,
} from "./useCloudSyncFolderNotice";

afterEach(() => {
  cleanup();
  forgetCloudSyncFolderNoticesForTests();
  localStorage.clear();
});

function mountShell(
  workspaceId: string,
  cloudSyncFolder: CloudSyncFolderNoticeState | null | undefined,
) {
  return renderHook(
    (props: { cloudSyncFolder: CloudSyncFolderNoticeState | null | undefined }) => {
      const shell = useShellError(workspaceId);
      const notice = useCloudSyncFolderNotice({
        workspaceId,
        cloudSyncFolder: props.cloudSyncFolder,
        report: shell.reportCloudSyncFolder,
      });
      return { shell, notice };
    },
    { initialProps: { cloudSyncFolder } },
  );
}

function relaunch(): void {
  forgetCloudSyncFolderNoticesForTests();
}

describe("useCloudSyncFolderNotice", () => {
  it("warns once with a toast and one row, across renders and remounts", () => {
    const first = mountShell("ws-od", undefined);
    expect(first.result.current.shell.shellErrors).toHaveLength(0);

    first.rerender({ cloudSyncFolder: { service: "OneDrive" } });
    first.rerender({ cloudSyncFolder: { service: "OneDrive" } });
    const rows = first.result.current.shell.shellErrors;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tone: "warning",
      ...cloudSyncFolderNotice("OneDrive"),
      details: [
        ["Detail", "cloud-sync-folder"],
        ["Service", "OneDrive"],
      ],
      kind: "cloud-sync-folder",
      retry: null,
      seen: false,
    });
    first.unmount();

    const second = mountShell("ws-od", { service: "OneDrive" });
    expect(second.result.current.shell.shellErrors).toMatchObject([
      { kind: "cloud-sync-folder", seen: true },
    ]);
    second.unmount();

    const other = mountShell("ws-gd", { service: null });
    expect(other.result.current.shell.shellErrors).toMatchObject([
      {
        ...cloudSyncFolderNotice(null),
        details: [["Detail", "cloud-sync-folder"]],
        seen: false,
      },
    ]);
  });

  it("tells each workspace once per computer, not once per launch", () => {
    mountShell("ws-od", { service: "OneDrive" }).unmount();
    relaunch();
    expect(
      mountShell("ws-od", { service: "OneDrive" }).result.current.shell.shellErrors,
    ).toHaveLength(0);
  });

  it("suppresses the notice on open and future launches when the user already confirmed the folder", () => {
    mountShell("ws-confirmed", { service: "OneDrive", acknowledged: true }).unmount();
    relaunch();
    expect(
      mountShell("ws-confirmed", { service: "OneDrive" }).result.current.shell.shellErrors,
    ).toHaveLength(0);
  });

  it("stays away for the session once the row is dismissed", () => {
    const first = mountShell("ws-od", { service: "Dropbox" });
    const [row] = first.result.current.shell.shellErrors;
    act(() => {
      first.result.current.notice.noteDismissed();
      first.result.current.shell.dismissShellError(row!.id);
    });
    expect(first.result.current.shell.shellErrors).toHaveLength(0);
    first.unmount();

    expect(
      mountShell("ws-od", { service: "Dropbox" }).result.current.shell.shellErrors,
    ).toHaveLength(0);
  });

  it("tells again next launch when localStorage refuses to persist the dismissal", () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      mountShell("ws-full", { service: "OneDrive" }).unmount();
      relaunch();
      expect(
        mountShell("ws-full", { service: "OneDrive" }).result.current.shell.shellErrors,
      ).toMatchObject([{ seen: false }]);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});

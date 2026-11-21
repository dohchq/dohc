// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetRelayReceivedShareResult, ShareAccess } from "../../ipc/bridgeContract";
import type { MountedShare } from "../OpenSharedView";
import { deferred } from "../../testing/deferred";
import { addedShareNotice, editCopyAt, useOpenShareToEdit } from "./shareCopyEdit";

const bridgeMock = { getRelayReceivedShare: vi.fn() };
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

beforeEach(() => {
  vi.resetAllMocks();
});

function mounted(access: ShareAccess | null, alreadyAdded = false): MountedShare {
  return { shareId: "share-1", label: "ana", access, alreadyAdded, left: false };
}

function received(access: ShareAccess): GetRelayReceivedShareResult {
  return {
    found: true,
    share: {
      shareId: "share-1",
      granterEmail: "granter@dohc.test",
      genericChatWritable: false,
      grantId: "grant-1",
      generation: 1,
      createdAtMs: 1,
      shareCode: "dohc-share:share-1:http://localhost:1788",
      selector: { paths: ["docs"], versionId: null },
      access,
    },
  };
}

describe("the notice after adding a share", () => {
  it("says an Edit share was added as a read-only copy, and its Open to edit runs the open", () => {
    const openToEdit = vi.fn();
    const notice = addedShareNotice(mounted("edit"), openToEdit);

    expect(notice.message).toBe("Added ana to shared-with-me as a read-only copy.");
    expect(notice.action?.label).toBe("Open to edit");
    expect(openToEdit).not.toHaveBeenCalled();
    notice.action?.run();
    expect(openToEdit).toHaveBeenCalledOnce();
  });

  it.each(["view", "comment", null] as const)(
    "offers no Open to edit for a share at %s",
    (access) => {
      const notice = addedShareNotice(mounted(access), vi.fn());

      expect(notice.message).toBe(
        "Added ana to shared-with-me. Its files are read-only and stay up to date.",
      );
      expect(notice.action).toBeUndefined();
    },
  );

  it("offers Open to edit for an Edit share this workspace already has", () => {
    const notice = addedShareNotice(mounted("edit", true), vi.fn());

    expect(notice.message).toBe("ana is already in shared-with-me.");
    expect(notice.action?.label).toBe("Open to edit");
  });
});

describe("a file inside a read-only copy", () => {
  const mounts = [
    { shareId: "share-edit", label: "ana", granterEmail: null, access: "edit" as const },
    { shareId: "share-view", label: "ben", granterEmail: null, access: "view" as const },
    {
      shareId: "share-ended",
      label: "cy",
      granterEmail: null,
      access: "edit" as const,
      ended: true,
    },
  ];

  it("names the Edit share and the file's path inside it", () => {
    expect(editCopyAt("shared-with-me/ana/docs/plan.md", mounts, true)).toEqual({
      shareId: "share-edit",
      path: "docs/plan.md",
    });
    expect(editCopyAt("shared-with-me/ana", mounts, true)).toEqual({
      shareId: "share-edit",
      path: null,
    });
  });

  it.each([
    ["a View share", "shared-with-me/ben/docs/plan.md"],
    ["an Edit share that ended", "shared-with-me/cy/plan.md"],
    ["a share this workspace does not hold", "shared-with-me/dee/plan.md"],
    ["the person's own file", "docs/plan.md"],
  ])("offers nothing for a file in %s", (_place, path) => {
    expect(editCopyAt(path, mounts, true)).toBeNull();
  });

  it("offers nothing for a file in an Edit share while signed out", () => {
    expect(editCopyAt("shared-with-me/ana/docs/plan.md", mounts, false)).toBeNull();
  });
});

describe("Open to edit", () => {
  function setup() {
    const onOpenShare = vi.fn();
    const reportError = vi.fn();
    const { result } = renderHook(() =>
      useOpenShareToEdit({ workspaceId: "ws-1", onOpenShare, reportError }),
    );
    return { open: result.current, onOpenShare, reportError };
  }

  it("opens the share at Edit with the file the person was reading", async () => {
    bridgeMock.getRelayReceivedShare.mockResolvedValue(received("edit"));
    const { open, onOpenShare, reportError } = setup();

    await open({ shareId: "share-1", path: "docs/plan.md" });

    expect(bridgeMock.getRelayReceivedShare).toHaveBeenCalledExactlyOnceWith({
      shareId: "share-1",
    });
    expect(onOpenShare).toHaveBeenCalledExactlyOnceWith({
      resolvedShare: { shareId: "share-1", shareCode: "dohc-share:share-1:http://localhost:1788" },
      level: "edit",
      path: "docs/plan.md",
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    ["the share at Edit", async () => received("edit")],
    ["the owner's lowered level", async () => received("view")],
    [
      "a relay that cannot be reached",
      async (): Promise<GetRelayReceivedShareResult> => {
        throw new Error("offline");
      },
    ],
  ])("drops an answer of %s that lands after the file's tab closed", async (_case, answer) => {
    const lookup = deferred<void>();
    bridgeMock.getRelayReceivedShare.mockImplementation(async () => {
      await lookup.promise;
      return answer();
    });
    const { open, onOpenShare, reportError } = setup();
    let tabOpen = true;

    const opening = open({ shareId: "share-1", path: "docs/plan.md" }, () => tabOpen);
    tabOpen = false;
    lookup.resolve();
    await opening;

    expect(onOpenShare).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("opens from Try again after the file's tab closed", async () => {
    bridgeMock.getRelayReceivedShare.mockRejectedValueOnce(new Error("offline"));
    const { open, onOpenShare, reportError } = setup();
    let tabOpen = true;

    await open({ shareId: "share-1", path: "docs/plan.md" }, () => tabOpen);
    expect(reportError).toHaveBeenCalledOnce();
    tabOpen = false;
    bridgeMock.getRelayReceivedShare.mockResolvedValue(received("edit"));
    await act(async () => reportError.mock.calls[0]![2]!());

    expect(onOpenShare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: "docs/plan.md", level: "edit" }),
    );
  });

  it("opens from a file whose tab is still open when the answer lands", async () => {
    bridgeMock.getRelayReceivedShare.mockResolvedValue(received("edit"));
    const { open, onOpenShare } = setup();

    await open({ shareId: "share-1", path: "docs/plan.md" }, () => true);

    expect(onOpenShare).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "the owner lowered the level",
      async () => received("view"),
      "The owner changed your access to this share. It no longer opens to edit.",
    ],
    [
      "the share is gone",
      async (): Promise<GetRelayReceivedShareResult> => ({ found: false }),
      "dohc could not find this share in your account. The person who shared it may have ended it.",
    ],
    [
      "the relay cannot be reached",
      async () => {
        throw new Error("offline");
      },
      "dohc could not open this share.",
    ],
  ])("opens nothing and says why with Try again when %s", async (_case, answer, words) => {
    bridgeMock.getRelayReceivedShare.mockImplementation(answer);
    const { open, onOpenShare, reportError } = setup();

    await open({ shareId: "share-1", path: null });

    expect(onOpenShare).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      words,
      expect.any(Error),
      expect.any(Function),
    );

    bridgeMock.getRelayReceivedShare.mockResolvedValue(received("edit"));
    await (reportError.mock.calls[0]![2] as () => void)();
    await vi.waitFor(() => expect(onOpenShare).toHaveBeenCalledOnce());
  });
});

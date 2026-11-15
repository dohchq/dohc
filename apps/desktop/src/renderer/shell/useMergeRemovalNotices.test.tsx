// @vitest-environment jsdom
import { act, cleanup, configure, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureRecoveryStatusResult, ReadEngineMomentResult } from "../../ipc/bridgeContract";
import {
  MERGE_REMOVAL_TITLE,
  mergeRemovalWords,
  useMergeRemovalNotices,
} from "./useMergeRemovalNotices";
import { useShellError } from "./useShellError";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Removal = CaptureRecoveryStatusResult["mergeRemovals"][number];
const REMOVAL: Removal = {
  momentId: "moment-merge-removal-a",
  versionId: "main",
  objectId: "object-a",
  path: "notes/trip.md",
  text: " world",
  authorKnown: true,
};

// The engine's list outlives every hook: a restart reads the same records.
function engine(initial: Removal[]) {
  let listed = initial;
  const bridge = {
    getCaptureRecoveryStatus: vi.fn(
      async (_input: { workspaceId: string }): Promise<CaptureRecoveryStatusResult> => ({
        captureRecoveries: [],
        mergeRemovals: listed,
      }),
    ),
    readEngineMoment: vi.fn(
      async ({
        momentId,
      }: {
        workspaceId: string;
        momentId: string;
      }): Promise<ReadEngineMomentResult> => ({
        moment: {
          id: momentId,
          versionId: "main",
          path: REMOVAL.path,
          recordedAtMs: 1,
          operation: "write",
          origin: "merge-removal",
          liveAuthorName: "Ben",
          beforeText: REMOVAL.text,
          afterText: "Hello",
        },
      }),
    ),
    clearCaptureRecovery: vi.fn(
      async ({ momentId }: { workspaceId: string; momentId: string }): Promise<void> => {
        listed = listed.filter((removal) => removal.momentId !== momentId);
      },
    ),
  };
  vi.stubGlobal("dohcDesktop", bridge);
  return bridge;
}

function open() {
  return renderHook(() => {
    const errors = useShellError("ws-a");
    const notices = useMergeRemovalNotices({
      workspaceId: "ws-a",
      workspaceIsReady: true,
      show: errors.showMergeRemovals,
      reportShellError: errors.reportShellError,
    });
    return { ...errors, notices };
  });
}

const rows = (result: ReturnType<typeof open>["result"]) =>
  result.current.shellErrors.filter((error) => error.kind === "merge-removal");

describe("useMergeRemovalNotices", () => {
  it("shows one row per kept removal, in these words, and one again after a restart", async () => {
    const bridge = engine([REMOVAL]);
    const first = open();
    await waitFor(() => expect(rows(first.result)).toHaveLength(1));
    const row = rows(first.result)[0]!;
    expect(row).toMatchObject({
      title: "Text removed when two changes met",
      message: '" world"',
      lastLine: "Ben's change deleted the line it was in.",
      identity: "merge-removal:moment-merge-removal-a",
      tone: "warning",
      retry: null,
      seen: false,
      target: { to: "history-change", moment: REMOVAL.momentId, path: REMOVAL.path },
    });
    expect(row.title).toBe(MERGE_REMOVAL_TITLE);
    expect(row.action?.label).toBe("Copy text");
    expect(bridge.readEngineMoment).toHaveBeenCalledWith({
      workspaceId: "ws-a",
      momentId: REMOVAL.momentId,
    });
    await act(() => first.result.current.notices.refresh());
    expect(rows(first.result)).toEqual([row]);

    first.unmount();
    const second = open();
    await waitFor(() => expect(rows(second.result)).toHaveLength(1));
    await act(() => second.result.current.notices.refresh());
    expect(rows(second.result).map((shown) => shown.identity)).toEqual([
      "merge-removal:moment-merge-removal-a",
    ]);
  });

  it("names nobody when the engine did not know who deleted the line", async () => {
    const bridge = engine([{ ...REMOVAL, authorKnown: false }]);
    const shown = open();
    await waitFor(() => expect(rows(shown.result)).toHaveLength(1));
    expect(rows(shown.result)[0]!.lastLine).toBeUndefined();
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
  });

  it("copies all of the text, however much the row quotes", async () => {
    const text = `First line\n${"word ".repeat(80)}end`;
    engine([{ ...REMOVAL, text }]);
    const copied = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText: copied } });
    const shown = open();
    await waitFor(() => expect(rows(shown.result)).toHaveLength(1));
    const row = rows(shown.result)[0]!;
    expect(row.message).toBe(mergeRemovalWords(text, undefined).message);
    expect(row.message).toMatch(
      /^"First line\nword word .*…"\nAnd \d+ more characters\. Copy text copies all of it\.$/s,
    );
    act(() => shown.result.current.runShellErrorAction(row.id));
    expect(copied).toHaveBeenCalledExactlyOnceWith(text);
  });

  it("clears a dismissed removal in the engine, so a restart shows nothing", async () => {
    const bridge = engine([REMOVAL]);
    const first = open();
    await waitFor(() => expect(rows(first.result)).toHaveLength(1));
    act(() => first.result.current.dismissShellError(rows(first.result)[0]!.id));
    await waitFor(() =>
      expect(bridge.clearCaptureRecovery).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "ws-a",
        momentId: REMOVAL.momentId,
      }),
    );
    await act(() => first.result.current.notices.refresh());
    expect(rows(first.result)).toEqual([]);

    first.unmount();
    const second = open();
    await waitFor(() => expect(bridge.getCaptureRecoveryStatus).toHaveBeenCalledTimes(4));
    expect(rows(second.result)).toEqual([]);
  });

  it("brings the row back when the engine refuses a dismissal, and keeps it on refresh", async () => {
    const bridge = engine([REMOVAL]);
    bridge.clearCaptureRecovery.mockRejectedValueOnce(new Error("engine busy"));
    const shown = open();
    await waitFor(() => expect(rows(shown.result)).toHaveLength(1));
    act(() => shown.result.current.dismissShellError(rows(shown.result)[0]!.id));
    await waitFor(() => expect(rows(shown.result)).toHaveLength(1));
    expect(rows(shown.result)[0]!.identity).toBe("merge-removal:moment-merge-removal-a");
    await act(() => shown.result.current.notices.refresh());
    expect(rows(shown.result)).toHaveLength(1);
  });
});

it("cuts a long quote at six lines", () => {
  const text = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
  expect(mergeRemovalWords(text, "Ana")).toEqual({
    message: `"1\n2\n3\n4\n5\n6…"\nAnd 4 more characters. Copy text copies all of it.`,
    lastLine: "Ana's change deleted the line it was in.",
  });
});

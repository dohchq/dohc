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
  quote: " world",
  length: 6,
  authorKnown: true,
};

// The engine's list outlives every hook: a restart reads the same records.
function engine(initial: Removal[], kept: Record<string, string> = {}) {
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
          beforeText: kept[momentId] ?? REMOVAL.quote,
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
      lastLine: "A change by Ben deleted the line it was in.",
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

  it("copies all of the text from History when the engine sent only its start", async () => {
    const text = `First line\n${"word ".repeat(400)}end`;
    const removal = {
      ...REMOVAL,
      authorKnown: false,
      quote: text.slice(0, 1024),
      length: text.length,
    };
    const bridge = engine([removal], { [REMOVAL.momentId]: text });
    const copied = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText: copied } });
    const shown = open();
    await waitFor(() => expect(rows(shown.result)).toHaveLength(1));
    const row = rows(shown.result)[0]!;
    // The same words as for the whole text.
    expect(row.message).toBe(
      mergeRemovalWords({ quote: text, length: text.length }, undefined).message,
    );
    expect(row.message).toMatch(
      /^"First line\nword word .*…"\nAnd 1,734 more characters\. Copy text copies all of it\.$/s,
    );
    act(() => shown.result.current.runShellErrorAction(row.id));
    await waitFor(() => expect(copied).toHaveBeenCalledExactlyOnceWith(text));
    expect(bridge.readEngineMoment).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-a",
      momentId: REMOVAL.momentId,
    });
  });

  it("keeps the last Copy text clicked when an earlier one is still reading History", async () => {
    const text = "long ".repeat(400);
    const long = {
      ...REMOVAL,
      authorKnown: false,
      quote: text.slice(0, 1024),
      length: text.length,
    };
    const short = { ...REMOVAL, momentId: "moment-merge-removal-b", authorKnown: false };
    const bridge = engine([long, short], { [REMOVAL.momentId]: text });
    // History answers the first Copy only after the second has copied.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const read = bridge.readEngineMoment.getMockImplementation()!;
    let reading: Promise<unknown> = Promise.resolve();
    bridge.readEngineMoment.mockImplementationOnce(
      (input) => (reading = held.then(() => read(input))) as Promise<ReadEngineMomentResult>,
    );
    const copied = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText: copied } });
    const shown = open();
    await waitFor(() => expect(rows(shown.result)).toHaveLength(2));
    const [first, second] = rows(shown.result);
    act(() => shown.result.current.runShellErrorAction(first!.id));
    act(() => shown.result.current.runShellErrorAction(second!.id));
    release();
    await act(() => reading);
    expect(copied).toHaveBeenCalledExactlyOnceWith(" world");
    expect(rows(shown.result)).toHaveLength(2);
  });

  it("copies a short text as the engine sent it", async () => {
    const bridge = engine([{ ...REMOVAL, authorKnown: false }]);
    const copied = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText: copied } });
    const shown = open();
    await waitFor(() => expect(rows(shown.result)).toHaveLength(1));
    act(() => shown.result.current.runShellErrorAction(rows(shown.result)[0]!.id));
    expect(copied).toHaveBeenCalledExactlyOnceWith(" world");
    expect(bridge.readEngineMoment).not.toHaveBeenCalled();
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
  expect(mergeRemovalWords({ quote: text, length: text.length }, "Ana")).toEqual({
    message: `"1\n2\n3\n4\n5\n6…"\nAnd 4 more characters. Copy text copies all of it.`,
    lastLine: "A change by Ana deleted the line it was in.",
  });
});

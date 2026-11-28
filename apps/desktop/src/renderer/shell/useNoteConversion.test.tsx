// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ConvertNotesResult } from "@dohc/workspace-contracts/note-format";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, NoteConversionProgress } from "../../ipc/bridgeContract";
import { WorkspaceSessionProvider } from "../workspace/workspaceSession";
import { noteConversionNotice, useNoteConversion, type NoteConversion } from "./useNoteConversion";

const clean: ConvertNotesResult = {
  converted: 1980,
  unchanged: 6,
  skipped: [],
  doesNotFit: [],
  failed: [],
  sent: true,
};

type CloudSessionListener = Parameters<DohcDesktopBridge["onCloudSessionChanged"]>[0];
let progress: ((event: NoteConversionProgress) => void) | null = null;
let accounts: CloudSessionListener[] = [];
function install(
  convertNotes: DohcDesktopBridge["convertNotes"],
  readNoteConversionOffered: DohcDesktopBridge["readNoteConversionOffered"] = async () => ({
    offered: false,
  }),
) {
  window.dohcDesktop = {
    convertNotes,
    readNoteConversionOffered,
    onCloudSessionChanged: (listener: CloudSessionListener) => {
      accounts.push(listener);
      return () => {
        accounts = accounts.filter((each) => each !== listener);
      };
    },
    onNoteConversionProgress: (listener: (event: NoteConversionProgress) => void) => {
      progress = listener;
      return () => {
        progress = null;
      };
    },
  } as unknown as DohcDesktopBridge;
}

function held() {
  let settle!: { resolve: (result: ConvertNotesResult) => void; reject: (error: Error) => void };
  const promise = new Promise<ConvertNotesResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

function mount(workspaceId = "ws-a", ready = true) {
  const report = vi.fn();
  const success = vi.fn();
  const clear = vi.fn();
  let latest!: NoteConversion;
  function Probe(props: { workspaceId: string; ready: boolean }) {
    latest = useNoteConversion({
      workspaceId: props.workspaceId,
      ready: props.ready,
      report,
      success,
      clear,
    });
    return null;
  }
  let shownId = workspaceId;
  let shownReady = ready;
  const shown = () => (
    <WorkspaceSessionProvider workspaceId={shownId}>
      <Probe workspaceId={shownId} ready={shownReady} />
    </WorkspaceSessionProvider>
  );
  const view = render(shown());
  return {
    report,
    success,
    clear,
    conversion: () => latest,
    switchTo: (next: string) => {
      shownId = next;
      view.rerender(shown());
    },
    opened: () => {
      shownReady = true;
      view.rerender(shown());
    },
  };
}

afterEach(() => {
  cleanup();
  progress = null;
  accounts = [];
  delete window.dohcDesktop;
});

describe("the Notices row for notes a conversion left", () => {
  it("names every group with its paths, counts the rest, and copies every path", () => {
    const notice = noteConversionNotice({
      ...clean,
      converted: 12,
      skipped: [
        { path: "Trip/Day 1.md", reason: "open-here" },
        { path: "Trip/Day 2.md", reason: "open-elsewhere" },
        { path: "Trip/Day 3.md", reason: "open-elsewhere" },
        { path: "Trip/Day 4.md", reason: "open-elsewhere" },
        { path: "Trip/Day 5.md", reason: "open-elsewhere" },
        { path: "Budget.md", reason: "ydoc-artifact-pending" },
      ],
      doesNotFit: [{ path: "Huge.md" }],
      failed: [{ path: "", reason: "object_id must be non-empty and bounded" }],
    });

    expect(notice).toEqual({
      title: "8 notes were not converted",
      message:
        "Converted 12 notes. The rest stay as they were and can still be edited. Convert them once they close or finish syncing.",
      tone: "warning",
      rows: [
        "Open on this computer: Trip/Day 1.md",
        "Open elsewhere: Trip/Day 2.md, Trip/Day 3.md, Trip/Day 4.md and 1 more",
        "History incomplete: Budget.md",
        "Doesn't fit the new format: Huge.md",
        "Could not be read: (no path)",
      ],
      details: [
        ["Open on this computer", "Trip/Day 1.md"],
        ["Open elsewhere", "Trip/Day 2.md"],
        ["Open elsewhere", "Trip/Day 3.md"],
        ["Open elsewhere", "Trip/Day 4.md"],
        ["Open elsewhere", "Trip/Day 5.md"],
        ["History incomplete", "Budget.md"],
        ["Doesn't fit the new format", "Huge.md"],
        ["Could not be read", "(no path): object_id must be non-empty and bounded"],
      ],
    });
  });

  it("files nothing for a clean run, and warns when converted notes were not sent", () => {
    expect(noteConversionNotice(clean)).toBeNull();
    expect(noteConversionNotice({ ...clean, sent: false })).toEqual({
      message:
        "Converted 1,980 notes. dohc could not send them to the server yet. Try again to send them.",
      tone: "warning",
    });
    expect(
      noteConversionNotice({ ...clean, converted: 1, skipped: [{ path: "a.md", reason: "held" }] }),
    ).toMatchObject({
      title: "1 note was not converted",
      message: expect.stringMatching(/^Converted 1 note\. /),
    });
  });
});

describe("converting notes from this window", () => {
  it("checks open notes, shows progress, then fades a toast and clears earlier rows on a clean run", async () => {
    const call = held();
    const convertNotes = vi.fn(() => call.promise);
    install(convertNotes);
    const shell = mount();

    act(() => shell.conversion().start());
    expect(convertNotes).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
    expect(shell.conversion().state).toEqual({ status: "running", done: 0, total: 0 });

    act(() => progress?.({ workspaceId: "ws-b", done: 9, total: 10 }));
    act(() => progress?.({ workspaceId: "ws-a", done: 400, total: 2000 }));
    expect(shell.conversion().state).toEqual({ status: "running", done: 400, total: 2000 });

    await act(async () => call.resolve(clean));
    expect(shell.conversion().state).toEqual({ status: "done", converted: 1980, left: 0 });
    expect(shell.clear).toHaveBeenCalledWith("note-conversion");
    expect(shell.success).toHaveBeenCalledExactlyOnceWith(
      "Converted 1,980 notes",
      undefined,
      "note-conversion",
    );
    expect(shell.report).not.toHaveBeenCalled();
  });

  it("files the notes it left with Convert remaining, which runs it again", async () => {
    const convertNotes = vi
      .fn<DohcDesktopBridge["convertNotes"]>()
      .mockResolvedValueOnce({ ...clean, skipped: [{ path: "Day 1.md", reason: "open-here" }] })
      .mockResolvedValueOnce(clean);
    install(convertNotes);
    const shell = mount();

    await act(async () => shell.conversion().start());

    expect(shell.success).not.toHaveBeenCalled();
    expect(shell.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "1 note was not converted",
        kind: "note-conversion",
        retry: null,
        action: expect.objectContaining({ label: "Convert remaining" }),
      }),
    );
    await act(async () => shell.report.mock.calls[0]![0].action.run());
    expect(convertNotes).toHaveBeenCalledTimes(2);
    expect(shell.success).toHaveBeenCalledOnce();
  });

  it("reports a failed run with Try again", async () => {
    const convertNotes = vi
      .fn<DohcDesktopBridge["convertNotes"]>()
      .mockRejectedValueOnce(new Error("dohc could not reach the relay. Check your connection."))
      .mockResolvedValueOnce(clean);
    install(convertNotes);
    const shell = mount();

    await act(async () => shell.conversion().start());

    expect(shell.conversion().state).toEqual({ status: "failed" });
    expect(shell.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "dohc could not reach the relay. Check your connection.",
        kind: "note-conversion",
        retry: expect.any(Function),
      }),
    );
    await act(async () => shell.report.mock.calls[0]![0].retry());
    expect(convertNotes).toHaveBeenCalledTimes(2);
  });

  it("keeps the count of notes it could not send, and Try again runs Convert notes again", async () => {
    const convertNotes = vi
      .fn<DohcDesktopBridge["convertNotes"]>()
      .mockResolvedValueOnce({ ...clean, converted: 11, sent: false })
      .mockRejectedValueOnce(new Error("dohc could not reach your server."))
      .mockResolvedValueOnce({ ...clean, converted: 0 });
    install(convertNotes);
    const shell = mount();

    await act(async () => shell.conversion().start());
    expect(shell.conversion().state).toEqual({ status: "unsent", converted: 11, left: 0 });
    expect(shell.success).not.toHaveBeenCalled();
    expect(shell.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message:
          "Converted 11 notes. dohc could not send them to the server yet. Try again to send them.",
        kind: "note-conversion",
        retry: expect.any(Function),
      }),
    );

    await act(async () => shell.report.mock.calls[0]![0].retry());
    expect(convertNotes).toHaveBeenCalledTimes(2);
    expect(shell.conversion().state).toEqual({ status: "unsent", converted: 11, left: 0 });
    expect(shell.report.mock.calls[1]![0]).toMatchObject({
      kind: "note-conversion",
      message: "dohc could not reach your server.",
      retry: expect.any(Function),
    });

    await act(async () => shell.conversion().start());
    expect(convertNotes).toHaveBeenCalledTimes(3);
    expect(shell.conversion().state).toEqual({ status: "done", converted: 11, left: 0 });
    expect(shell.clear).toHaveBeenCalledWith("note-conversion");
    expect(shell.success).toHaveBeenCalledExactlyOnceWith(
      "Converted 11 notes",
      undefined,
      "note-conversion",
    );
  });

  it("keeps the notes a stopped run converted in the count, and adds them to the next run", async () => {
    const convertNotes = vi
      .fn<DohcDesktopBridge["convertNotes"]>()
      .mockResolvedValueOnce({ ...clean, converted: 11, sent: false })
      .mockResolvedValueOnce({
        ...clean,
        converted: 10,
        sent: false,
        stopped: "dohc could not reach your server.",
      })
      .mockResolvedValueOnce({ ...clean, converted: 4 });
    install(convertNotes);
    const shell = mount();

    await act(async () => shell.conversion().start());
    await act(async () => shell.report.mock.calls[0]![0].retry());
    expect(shell.conversion().state).toEqual({ status: "unsent", converted: 21, left: 0 });
    expect(shell.report.mock.calls[1]![0]).toMatchObject({
      kind: "note-conversion",
      message:
        "dohc could not reach your server. dohc converted 21 notes before it stopped. Try again to finish.",
      retry: expect.any(Function),
    });

    await act(async () => shell.report.mock.calls[1]![0].retry());
    expect(shell.conversion().state).toEqual({ status: "done", converted: 25, left: 0 });
    expect(shell.success).toHaveBeenCalledExactlyOnceWith(
      "Converted 25 notes",
      undefined,
      "note-conversion",
    );
  });

  it("runs once for a double click, from Settings or Notices, and keeps that run's result", async () => {
    const call = held();
    const convertNotes = vi
      .fn<DohcDesktopBridge["convertNotes"]>()
      .mockResolvedValueOnce({ ...clean, converted: 11, sent: false })
      .mockReturnValueOnce(call.promise);
    install(convertNotes);
    const shell = mount();
    await act(async () => shell.conversion().start());

    act(() => {
      shell.conversion().start();
      shell.report.mock.calls[0]![0].retry();
    });
    expect(convertNotes).toHaveBeenCalledTimes(2);

    await act(async () => call.resolve({ ...clean, converted: 3 }));
    expect(shell.conversion().state).toEqual({ status: "done", converted: 14, left: 0 });
    expect(shell.success).toHaveBeenCalledExactlyOnceWith(
      "Converted 14 notes",
      undefined,
      "note-conversion",
    );
  });

  it("offers Try again alone when it left notes and could not send, since a new run does both", async () => {
    install(
      vi.fn(async () => ({
        ...clean,
        sent: false,
        skipped: [{ path: "Day 1.md", reason: "open-here" }],
      })),
    );
    const shell = mount();

    await act(async () => shell.conversion().start());
    expect(shell.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ retry: expect.any(Function) }),
    );
    expect(shell.report.mock.calls[0]![0]).not.toHaveProperty("action");
    expect(shell.conversion().state).toEqual({ status: "unsent", converted: 1980, left: 1 });
  });

  it("counts the notes it left when it skipped every one", async () => {
    install(
      vi.fn(async () => ({
        ...clean,
        converted: 0,
        unchanged: 0,
        skipped: [
          { path: "Day 1.md", reason: "open-here" },
          { path: "Day 2.md", reason: "open-elsewhere" },
        ],
      })),
    );
    const shell = mount();

    await act(async () => shell.conversion().start());
    expect(shell.conversion().state).toEqual({ status: "done", converted: 0, left: 2 });
    expect(shell.success).not.toHaveBeenCalled();
  });

  it("shows nothing from workspace A's run once the window moves to workspace B", async () => {
    const call = held();
    install(vi.fn(() => call.promise));
    const shell = mount("ws-a");

    act(() => shell.conversion().start());
    shell.switchTo("ws-b");
    expect(shell.conversion().state).toEqual({ status: "idle" });
    act(() => progress?.({ workspaceId: "ws-a", done: 10, total: 20 }));
    await act(async () => call.resolve({ ...clean, skipped: [{ path: "a.md", reason: "held" }] }));

    expect(shell.conversion().state).toEqual({ status: "idle" });
    expect(shell.report).not.toHaveBeenCalled();
    expect(shell.success).not.toHaveBeenCalled();
    expect(shell.clear).not.toHaveBeenCalledWith("note-conversion");
  });
});

describe("whether Settings offers Convert notes", () => {
  it("asks main for this workspace and keeps its answer", async () => {
    const offered = vi.fn(async () => ({ offered: true }));
    install(vi.fn(), offered);
    const shell = mount("ws-a");

    await waitFor(() => expect(shell.conversion().offer.value).toBe(true));
    expect(offered).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
    expect(shell.conversion().offer.failed).toBe(false);
  });

  it("waits for the workspace to open, with no notice, then asks main", async () => {
    const offered = vi
      .fn<DohcDesktopBridge["readNoteConversionOffered"]>()
      .mockRejectedValue(new Error("Open this workspace to see whether it can convert its notes."));
    install(vi.fn(), offered);
    const shell = mount("ws-a", false);
    await act(async () => undefined);

    expect(offered).not.toHaveBeenCalled();
    expect(shell.report).not.toHaveBeenCalled();
    expect(shell.conversion().offer).toMatchObject({ value: undefined, failed: false });

    offered.mockResolvedValue({ offered: true });
    shell.opened();
    await waitFor(() => expect(shell.conversion().offer.value).toBe(true));
    expect(offered).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
    expect(shell.report).not.toHaveBeenCalled();
  });

  it("files a notice when main could not say, and its Try again asks again and clears it", async () => {
    const lost = new Error("dohc could not reach the engine.");
    const offered = vi
      .fn<DohcDesktopBridge["readNoteConversionOffered"]>()
      .mockRejectedValueOnce(lost)
      .mockResolvedValueOnce({ offered: true });
    install(vi.fn(), offered);
    const shell = mount("ws-a");

    await waitFor(() => expect(shell.conversion().offer.failed).toBe(true));
    expect(shell.report).toHaveBeenCalledExactlyOnceWith({
      message: "dohc could not reach the engine.",
      cause: lost,
      retry: expect.any(Function),
      kind: "note-conversion-offered",
    });
    const retry = shell.report.mock.calls[0]![0].retry as () => void;
    await act(async () => retry());

    expect(shell.conversion().offer).toMatchObject({ value: true, failed: false });
    expect(offered).toHaveBeenCalledTimes(2);
    expect(shell.clear).toHaveBeenCalledWith("note-conversion-offered");
  });

  it("forgets the answer while the account changes, and asks again once it is ready", async () => {
    const offered = vi.fn(async () => ({ offered: true }));
    install(vi.fn(), offered);
    const shell = mount("ws-a");
    await waitFor(() => expect(shell.conversion().offer.value).toBe(true));

    act(() => accounts.forEach((listener) => listener({ sessionKey: null, phase: "changing" })));
    expect(shell.conversion().offer.value).toBeUndefined();
    expect(offered).toHaveBeenCalledOnce();

    act(() => accounts.forEach((listener) => listener({ sessionKey: "b", phase: "ready" })));
    await waitFor(() => expect(shell.conversion().offer.value).toBe(true));
    expect(offered).toHaveBeenCalledTimes(2);
  });

  it("shows no answer from workspace A once the window moves to workspace B", async () => {
    let answerA!: (answer: { offered: boolean }) => void;
    const offered = vi.fn(({ workspaceId }: { workspaceId: string }) =>
      workspaceId === "ws-a"
        ? new Promise<{ offered: boolean }>((resolve) => (answerA = resolve))
        : Promise.resolve({ offered: false }),
    );
    install(vi.fn(), offered);
    const shell = mount("ws-a");
    await waitFor(() => expect(offered).toHaveBeenCalledWith({ workspaceId: "ws-a" }));

    shell.switchTo("ws-b");
    await waitFor(() => expect(shell.conversion().offer.value).toBe(false));
    await act(async () => answerA({ offered: true }));

    expect(shell.conversion().offer.value).toBe(false);
    expect(shell.report).not.toHaveBeenCalled();
  });
});

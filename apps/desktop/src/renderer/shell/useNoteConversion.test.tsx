// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import type { ConvertNotesResult } from "@dohc/workspace-contracts/note-format";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, NoteConversionProgress } from "../../ipc/bridgeContract";
import { noteConversionNotice, useNoteConversion, type NoteConversion } from "./useNoteConversion";

const clean: ConvertNotesResult = {
  converted: 1980,
  unchanged: 6,
  skipped: [],
  doesNotFit: [],
  failed: [],
  sent: true,
};

let progress: ((event: NoteConversionProgress) => void) | null = null;
function install(
  convertNotes: DohcDesktopBridge["convertNotes"],
  sendConvertedNotes: DohcDesktopBridge["sendConvertedNotes"] = vi.fn(async () => null),
) {
  window.dohcDesktop = {
    convertNotes,
    sendConvertedNotes,
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

function mount(workspaceId = "ws-a") {
  const report = vi.fn();
  const success = vi.fn();
  const clear = vi.fn();
  let latest!: NoteConversion;
  function Probe(props: { workspaceId: string }) {
    latest = useNoteConversion({ workspaceId: props.workspaceId, report, success, clear });
    return null;
  }
  const view = render(<Probe workspaceId={workspaceId} />);
  return {
    report,
    success,
    clear,
    conversion: () => latest,
    switchTo: (next: string) => view.rerender(<Probe workspaceId={next} />),
  };
}

afterEach(() => {
  cleanup();
  progress = null;
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
    expect(shell.conversion().state).toEqual({ status: "done", converted: 1980 });
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

  it("keeps the count of notes it could not send, and Try again only sends them", async () => {
    const convertNotes = vi.fn<DohcDesktopBridge["convertNotes"]>(async () => ({
      ...clean,
      converted: 11,
      sent: false,
    }));
    const sendConvertedNotes = vi
      .fn<DohcDesktopBridge["sendConvertedNotes"]>()
      .mockRejectedValueOnce(new Error("dohc could not reach your server."))
      .mockResolvedValueOnce(null);
    install(convertNotes, sendConvertedNotes);
    const shell = mount();

    await act(async () => shell.conversion().start());
    expect(shell.conversion().state).toEqual({ status: "unsent", converted: 11 });
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
    expect(sendConvertedNotes).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
    expect(shell.conversion().state).toEqual({ status: "unsent", converted: 11 });
    expect(shell.report).toHaveBeenCalledTimes(2);
    expect(shell.report.mock.calls[1]![0]).toMatchObject({
      kind: "note-conversion",
      cause: expect.objectContaining({ message: "dohc could not reach your server." }),
      retry: expect.any(Function),
    });

    await act(async () => shell.conversion().send());
    expect(sendConvertedNotes).toHaveBeenCalledTimes(2);
    expect(convertNotes).toHaveBeenCalledOnce();
    expect(shell.conversion().state).toEqual({ status: "done", converted: 11 });
    expect(shell.clear).toHaveBeenCalledWith("note-conversion");
    expect(shell.success).toHaveBeenCalledExactlyOnceWith(
      "Converted 11 notes",
      undefined,
      "note-conversion",
    );
  });

  it("keeps Convert remaining beside Try again when it left notes and could not send", async () => {
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
      expect.objectContaining({
        retry: expect.any(Function),
        action: expect.objectContaining({ label: "Convert remaining" }),
      }),
    );
    await act(async () => shell.report.mock.calls[0]![0].retry());
    expect(shell.report).toHaveBeenCalledTimes(2);
    expect(shell.report.mock.calls[1]![0]).toMatchObject({
      title: "1 note was not converted",
      retry: null,
      action: expect.objectContaining({ label: "Convert remaining" }),
    });
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
    expect(shell.clear).not.toHaveBeenCalled();
  });
});

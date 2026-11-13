// @vitest-environment jsdom
import { liveStopError, liveStopWaitingError } from "../ipc/liveEditingStop";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import {
  LiveDocumentsDialog,
  type LiveDocumentPage,
  type LiveDocumentRow,
  type LiveDocumentStopResult,
  type LiveDocumentStopRunning,
  type LiveRefusalPage,
  type LiveRefusalRow,
  type LiveStopWaitingNotice,
} from "./LiveDocumentsDialog";
import { formatShortTime } from "./time";

// The server names each row's document; here, after its path.
function row(path: string, overrides: Partial<LiveDocumentRow> = {}): LiveDocumentRow {
  return { path, objectId: `object:${path}`, status: "ready", canResume: false, ...overrides };
}

function page(
  documents: LiveDocumentRow[],
  nextCursor: string | null = null,
): LiveDocumentPage {
  return { documents, nextCursor };
}

function refusal(shareId: string, paths: string[] = [`${shareId}.md`]): LiveRefusalRow {
  return { shareId, paths, code: "quota_exceeded", message: "Service host enrollment capacity is full." };
}

function refusalPage(
  refusals: LiveRefusalRow[],
  nextCursor: string | null = null,
): LiveRefusalPage {
  return { refusals, nextCursor };
}

function harness() {
  return {
    load: vi.fn((workspaceId: string, retiredAfter?: string) => Promise.resolve(page([]))),
    stop: vi.fn((workspaceId: string, path: string, objectId: string): Promise<LiveDocumentStopResult> => Promise.resolve({ keptEdits: "none" })),
    onStopped: vi.fn((path: string, keptEdits: "recovered" | "kept") => {}),
    resume: vi.fn((workspaceId: string, path: string) => Promise.resolve()),
    loadRefusals: vi.fn((workspaceId: string, after?: string) =>
      Promise.resolve(refusalPage([])),
    ),
    retryRefusal: vi.fn((workspaceId: string, shareId: string) => Promise.resolve()),
    onClose: vi.fn(),
    onError: vi.fn((message: string, error: unknown, retry: () => boolean, waiting?: LiveStopWaitingNotice) => {}),
    saveRecoveryCopy: vi.fn(async (workspaceId: string, path: string, incident?: string) => {}),
    readKeptEdits: vi.fn(async (workspaceId: string, objectId: string, incident: string) => {}),
  };
}

function actions(path: string): string[] {
  return within(screen.getByTestId(`live-document-row-${path}`))
    .queryAllByRole("button")
    .map((button) => button.textContent);
}

// Resume tries again now. The words promise no start, because some histories never start.
it("shows a document whose edit history the server can't check, with Resume and Stop", async () => {
  const h = harness(), user = userEvent.setup();
  h.load.mockResolvedValue(page([row("docs/long.md", {status: "unavailable", reason: "live-history-over-budget", canResume: true})]));
  render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
  const long = await screen.findByTestId("live-document-row-docs/long.md");
  expect(long.children[1]?.textContent).toBe("History too long");
  expect(within(long).getByText("This document's edit history is too long for the server to check, so live editing can't start. You can keep editing it in dohc and your edits keep syncing, but people you shared it with can't edit it live. Resume live editing to try again.")).toBeDefined();
  expect(actions("docs/long.md").filter(name => name?.endsWith("live editing"))).toEqual(["Resume live editing", "Stop live editing"]);
  await user.click(within(long).getByRole("button", {name: "Resume live editing for docs/long.md"}));
  expect(h.resume).toHaveBeenCalledWith("ws-1", "docs/long.md");
});

// The server keeps trying it; the row says why in the server's word, and Resume tries now.
it("shows a document whose live start keeps failing, with the server's reason to copy, Resume and Stop", async () => {
  const h = harness(), user = userEvent.setup();
  const since = "2026-11-13T01:00:00.000Z";
  h.load.mockResolvedValue(page([row("docs/failing.md", {status: "unavailable", reason: "live-start-failing", failure: {word: "engine-refused", since}, canResume: true})]));
  render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
  const failing = await screen.findByTestId("live-document-row-docs/failing.md");
  expect(failing.children[1]?.textContent).toBe("Can't start");
  expect(within(failing).getByText("The server can't start live editing for this document. It keeps trying. You can keep editing it in dohc and your edits keep syncing, but people you shared it with can't edit it live until it starts.")).toBeDefined();
  const line = `Server's reason: engine-refused, since ${formatShortTime(Date.parse(since))}`;
  expect(within(failing).getByText(line)).toBeDefined();
  await user.click(within(failing).getByRole("button", {name: "Copy the server's reason"}));
  expect(await navigator.clipboard.readText()).toBe(line);
  expect(actions("docs/failing.md").filter(name => name?.endsWith("live editing"))).toEqual(["Resume live editing", "Stop live editing"]);
  await user.click(within(failing).getByRole("button", {name: "Resume live editing for docs/failing.md"}));
  expect(h.resume).toHaveBeenCalledWith("ws-1", "docs/failing.md");
});

// The server's reason line belongs to the row form, so another reason that carries one shows it under its own sentence.
it("shows the server's reason on any row that carries one", async () => {
  const h = harness();
  const since = "2026-11-13T01:00:00.000Z";
  h.load.mockResolvedValue(page([row("docs/refused.md", {status: "unavailable", reason: "session-host-refused", failure: {word: "relay-error", since}, canResume: true})]));
  render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
  const refused = await screen.findByTestId("live-document-row-docs/refused.md");
  expect(within(refused).getByText(`Server's reason: relay-error, since ${formatShortTime(Date.parse(since))}`)).toBeDefined();
  expect(within(refused).getByRole("button", {name: "Copy the server's reason"})).toBeDefined();
});

function paths(): string[] {
  return screen
    .getAllByTestId(/^live-document-row-/)
    .map((element) => element.getAttribute("data-testid")!);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LiveDocumentsDialog", () => {
  it.each([
    [{status: "paused", canResume: true}, "Paused"],
  ] as const)("offers Resume alone after a pending Stop on %j", async (overrides, label) => {
    const h = harness();
    h.load.mockResolvedValueOnce(page([row("a.md", overrides)])).mockResolvedValue(page([row("a.md")]));
    h.stop.mockRejectedValueOnce(liveStopError({code: "edits-pending"}));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    fireEvent.click(await screen.findByRole("button", {name: "Stop live editing for a.md"}));
    const note = "Live editing didn't stop. Recent edits haven't reached the server yet. Resume live editing to send them, then stop it.";
    await screen.findByText(note);
    const live = screen.getByTestId("live-document-row-a.md");
    expect(live.children[1]?.textContent).toBe(label);
    expect(live.querySelectorAll("p")).toHaveLength(1);
    expect(actions("a.md")).toEqual(["Resume live editing"]);
    const resume = within(live).getByRole("button", {name: "Resume live editing for a.md"});
    expect(document.activeElement).toBe(resume);
    fireEvent.click(resume);
    await screen.findByRole("button", {name: "Stop live editing for a.md"});
    expect(h.resume).toHaveBeenCalledExactlyOnceWith("ws", "a.md");
    expect(screen.queryByText(note)).toBeNull();
  });

  it("keeps an edits-pending Stop in its Live row, focuses Try again, and stops on retry", async () => {
    const h = harness(), stopping = deferred<LiveDocumentStopResult>();
    h.load.mockResolvedValueOnce(page([row("a.md")]))
      .mockResolvedValue(page([row("a.md", {status: "retired", canResume: true})]));
    h.stop.mockReturnValueOnce(stopping.promise);
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    fireEvent.click(await screen.findByRole("button", {name: "Stop live editing for a.md"}));
    const live = screen.getByTestId("live-document-row-a.md");
    expect(screen.getByRole("status").textContent).toBe("Stopping live editing for a.md…");
    expect(within(live).getAllByText("Stopping live editing…")).toHaveLength(1);
    expect(within(live).queryByText("Stopping live editing for a.md…")).toBeNull();
    expect(screen.getByRole("status").firstElementChild?.className).toBe("sr-only");
    expect(within(live).getAllByRole("button").every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
    const retry = await screen.findByRole("button", {name: "Try again to stop live editing for a.md"});
    expect(document.activeElement).toBe(retry);
    expect(live.children[1]?.textContent).toBe("Live");
    expect(live.textContent).toContain("Live editing didn't stop. The server hasn't finished applying edits to this document. Try again in a moment.");
    expect(actions("a.md")).toEqual(["Try again"]);
    expect(h.onError).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalledTimes(2));
    expect(h.stop.mock.lastCall).toEqual(["ws", "a.md", "object:a.md"]);
    await vi.waitFor(() => expect(screen.getByTestId("live-document-row-a.md").children[1]?.textContent).toBe("Stopped"));
    expect(screen.queryByText("Live editing didn't stop. The server hasn't finished applying edits to this document. Try again in a moment.")).toBeNull();
  });
  it("keeps each restore queue beside the live note and offers only its own recovery copy", async () => {
    const h = harness();
    h.load.mockResolvedValue(page([row("note.md"), ...["old-1", "old-2"].map(incident =>
      row("note.md", {quarantine: "paused", saveOnly: true, storedOn: "this-computer", incident}))], "next"));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const first = await screen.findByTestId("live-document-row-note.md-old-1");
    expect(actions("note.md")).toEqual(["Stop live editing"]);
    expect(within(first).queryAllByRole("button").map(button => button.textContent)).toEqual(["Save recovery copy"]);
    // It holds none of the note's current edits, so the note stays editable and the row never says Paused.
    expect(within(first).getByText("Not written")).toBeTruthy();
    expect(first.textContent).toContain("dohc kept your unsent edits, but could not write them to your file. Save a recovery copy to get them back.");
    await userEvent.setup().click(within(first).getByRole("button", {name: "Save recovery copy of note.md"}));
    expect(h.saveRecoveryCopy).toHaveBeenCalledExactlyOnceWith("ws", "note.md", "old-1");
    expect(screen.getByTestId("live-document-row-note.md-old-2")).toBeTruthy();
  });
  it("lists the edits a restore set aside when it cannot read the server's list", async () => {
    const h = harness();
    const failure = new Error("relay unreachable");
    h.load.mockRejectedValueOnce(failure).mockResolvedValueOnce(page([row("a.md")]));
    const setAside = [row("note.md", {status: "paused", quarantine: "paused", saveOnly: true, storedOn: "this-computer", incident: "old-1"})];
    render(<LiveDocumentsDialog workspaceId="ws" {...h} setAside={setAside} />);
    const kept = await screen.findByTestId("live-document-row-note.md-old-1");
    expect(screen.getByText("dohc could not load the server's list. These edits are kept on this computer.")).toBeTruthy();
    // The toast keeps the cause.
    expect(h.onError).toHaveBeenCalledExactlyOnceWith("dohc could not load the live documents for this workspace.", failure, expect.any(Function));
    await userEvent.setup().click(within(kept).getByRole("button", {name: "Save recovery copy of note.md"}));
    expect(h.saveRecoveryCopy).toHaveBeenCalledExactlyOnceWith("ws", "note.md", "old-1");
    // Once the server's list reads, it is the list, set-aside rows included.
    await act(async () => { h.onError.mock.calls[0]![2](); });
    expect(await screen.findByTestId("live-document-row-a.md")).toBeTruthy();
    expect(screen.queryByTestId("live-document-row-note.md-old-1")).toBeNull();
    expect(screen.queryByText("dohc could not load the server's list. These edits are kept on this computer.")).toBeNull();
  });
  // Proves: a document whose server copy is missing an owner edit offers Resume,
  // alone and with a deferred Stop, through the same path, with one Resume sentence each.
  it("offers Resume on a document whose server copy is missing an edit, with and without a deferred Stop", async () => {
    const h=harness(), reason="live-edit-unadmitted" as const;
    h.load.mockResolvedValue(page([
      row("deferred.md",{status:"unavailable",reason,canResume:true,deferredStop:{unsentEdits:2,editable:true}}),
      row("edited.md",{status:"unavailable",reason,canResume:true}),
    ]));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const deferred=await screen.findByTestId("live-document-row-deferred.md");
    expect(deferred.textContent).toContain("Live editing stopped. 2 unsent edits remain on this computer. Resume live editing to try sending them. You can keep editing.");
    const held="The server hasn't applied an edit to this document. Resume live editing to try again.";
    expect(screen.getAllByText(held)).toHaveLength(1);
    expect(screen.getByTestId("live-document-row-edited.md").textContent).toContain(held);
    for (const path of ["deferred.md","edited.md"]) {
      const document=screen.getByTestId(`live-document-row-${path}`);
      expect(document.children[1]?.textContent).toBe("Server copy is missing an edit");
      expect(document.textContent!.split("Resume live editing to").length-1).toBe(1);
    }
    // A deferred Stop has already run, so only the other row still offers Stop.
    expect(actions("deferred.md")).toEqual(["Resume live editing"]);
    expect(actions("edited.md")).toEqual(["Resume live editing","Stop live editing"]);
    fireEvent.click(within(deferred).getByRole("button",{name:"Resume live editing for deferred.md"}));
    await vi.waitFor(() => expect(h.resume).toHaveBeenCalledWith("ws","deferred.md"));
    // The list reloads after a Resume, and its controls wait until it has.
    await vi.waitFor(() => expect((screen.getByRole("button",{name:"Resume live editing for edited.md"}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"Resume live editing for edited.md"}));
    await vi.waitFor(() => expect(h.resume).toHaveBeenCalledWith("ws","edited.md"));
    expect(h.resume).toHaveBeenCalledTimes(2);
  });
  it("reports a Stop with no answer through Notices by its error name, with its title and document, and keeps its retry available", async () => {
    const h = harness(); h.load.mockResolvedValue(page([row("a.md")]));
    // As it crosses Electron's IPC, which keeps only the name and message.
    const error = new Error(`Error invoking remote method 'stopOwnerLiveDocument': ${String(liveStopWaitingError(new Error("fetch failed")))}`);
    h.stop.mockRejectedValueOnce(error);
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    fireEvent.click(await screen.findByRole("button", {name: "Stop live editing for a.md"}));
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    const [message, reported, retry, waiting] = h.onError.mock.calls[0]!;
    expect([message, reported, waiting]).toEqual(["dohc is waiting for the server to stop live editing and will keep trying.", error,
      {title: "Stopping live editing for a.md", objectId: "object:a.md"}]);
    expect(retry()).toBe(true);
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalledTimes(2));
  });

  it("drops stale errors and retired retry actions after a workspace switch", async () => {
    const h = harness();
    h.load.mockRejectedValueOnce(new Error("old failure"));
    const view = render(<LiveDocumentsDialog workspaceId="ws-a" {...h} />);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    const oldRetry = h.onError.mock.calls[0]![2];
    const late = deferred<LiveDocumentPage>();
    h.load.mockReturnValueOnce(late.promise);
    view.rerender(<LiveDocumentsDialog workspaceId="ws-b" {...h} />);
    view.rerender(<LiveDocumentsDialog workspaceId="ws-c" {...h} />);
    await act(async () => late.reject(new Error("stale failure")));
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(oldRetry()).toBe(false);
  });

  it("labels every status and offers only the actions it supports", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(
      page([
        row("docs/live.md"),
        row("docs/preparing.md", { status: "preparing" }),
        row("docs/paused.md", { status: "paused", canResume: true }),
        row("docs/paused-locked.md", { status: "paused" }),
        row("docs/moved.md", {
          status: "unavailable",
          reason: "document-unavailable",
          canResume: false,
        }),
        row("docs/elsewhere.md", {
          status: "unavailable",
          reason: "workspace-changed",
          canResume: false,
        }),
        row("docs/refused.md", {
          status: "unavailable",
          reason: "session-host-refused",
          canResume: true,
        }),
        row("docs/unopened.md", {
          status: "unavailable",
          reason: "live-document-without-lineage",
          canResume: true,
        }),
        row("docs/diverged.md", {
          status: "unavailable",
          reason: "session-host-diverged",
          canResume: false,
        }),
        row("docs/edited.md", {
          status: "unavailable",
          reason: "live-edit-unadmitted",
          canResume: true,
        }),
        row("docs/stopped.md", { status: "retired", canResume: true }),
        row("docs/held.md", {
          status: "unavailable",
          reason: "conflict-parent-withheld",
          canResume: false,
        }),
        row("docs/stopped-gone.md", { status: "retired" }),
      ]),
    );
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
    await screen.findByTestId("live-document-row-docs/live.md");

    const labels = screen
      .getAllByTestId(/^live-document-row-/)
      .map((element) => element.children[1]?.textContent);
    expect(labels).toEqual([
      "Live",
      "Preparing",
      "Paused",
      "Paused",
      "File moved or removed",
      "Workspace changed",
      "Stopped by the server",
      "Not started",
      "Server copy doesn't match",
      "Server copy is missing an edit",
      "Can't resume",
      "Stopped",
      "Stopped",
    ]);
    // Only a document whose server copy is missing an owner edit says so, and
    // that a Resume tries it again.
    const edited =
      "The server hasn't applied an edit to this document. Resume live editing to try again.";
    expect(screen.getAllByText(edited)).toHaveLength(1);
    expect(screen.getByTestId("live-document-row-docs/edited.md").textContent).toContain(edited);
    expect(actions("docs/edited.md")).toEqual([
      "Resume live editing",
      "Stop live editing",
    ]);
    const held = "A conflict in this file was resolved, so live editing can't resume for it. People with the link can still read the last shared version. You can keep editing it in dohc, but your edits may not reach them.";
    expect(screen.getAllByText(held)).toHaveLength(1);
    expect(screen.getByTestId("live-document-row-docs/held.md").textContent).toContain(held);
    expect(actions("docs/held.md")).toEqual(["Stop live editing"]);
    // Only a document whose server copy diverged sends its owner to the server's operator.
    const operator =
      "The server's copy of this workspace no longer matches the synced one. Contact the server's operator.";
    expect(screen.getAllByText(operator)).toHaveLength(1);
    expect(screen.getByTestId("live-document-row-docs/diverged.md").textContent).toContain(operator);
    // A Stop cannot finish on a diverged copy either.
    expect(actions("docs/diverged.md")).toEqual([]);
    // Only the document dohc has never opened says to open it before Resume.
    const openFirst =
      "Live editing can't start until you open this document once in dohc. After you open it, resume live editing. A note larger than 256 KB doesn't open as a document in dohc. Make it smaller or split it, then open it.";
    expect(screen.getAllByText(openFirst)).toHaveLength(1);
    expect(screen.getByTestId("live-document-row-docs/unopened.md").textContent).toContain(openFirst);

    expect(actions("docs/live.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/preparing.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/paused.md")).toEqual([
      "Resume live editing",
      "Stop live editing",
    ]);
    expect(actions("docs/paused-locked.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/moved.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/elsewhere.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/refused.md")).toEqual([
      "Resume live editing",
      "Stop live editing",
    ]);
    expect(actions("docs/unopened.md")).toEqual([
      "Resume live editing",
      "Stop live editing",
    ]);
    expect(actions("docs/stopped.md")).toEqual(["Resume live editing"]);
    expect(actions("docs/stopped-gone.md")).toEqual([]);
  });

  it("loads the next stopped page and keeps the newest row for a repeated path", async () => {
    const h = harness();
    h.load
      .mockResolvedValueOnce(
        page(
          [row("docs/a.md"), row("docs/old.md", { status: "retired", canResume: true })],
          "retired-page-2",
        ),
      )
      .mockResolvedValueOnce(
        page([
          row("docs/a.md", { status: "paused", canResume: true }),
          row("docs/older.md", { status: "retired", canResume: true }),
          row("docs/a.md", { status: "retired", canResume: true }),
        ]),
      );
    const user = userEvent.setup();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    expect(h.load).toHaveBeenCalledWith("ws-1", undefined);
    await user.click(screen.getByTestId("live-documents-more"));

    expect(h.load).toHaveBeenNthCalledWith(2, "ws-1", "retired-page-2");
    await vi.waitFor(() => {
      expect(screen.getByTestId("live-document-row-docs/older.md")).toBeTruthy();
    });
    expect(paths()).toEqual([
      "live-document-row-docs/a.md",
      "live-document-row-docs/old.md",
      "live-document-row-docs/older.md",
    ]);
    expect(actions("docs/a.md")).toEqual(["Resume live editing", "Stop live editing"]);
    expect(screen.queryByTestId("live-documents-more")).toBeNull();
  });

  it("blocks a second action while one is running", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(page([row("docs/a.md")]));
    const stopping = deferred<LiveDocumentStopResult>();
    h.stop.mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    const stopButton = screen.getByRole("button", {
      name: "Stop live editing for docs/a.md",
    });
    await user.click(stopButton);

    expect(screen.getByRole("status").textContent).toBe(
      "Stopping live editing for docs/a.md…",
    );
    expect((stopButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByTestId("live-documents-reload") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(stopButton);
    fireEvent.click(screen.getByTestId("live-documents-reload"));

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledTimes(1);
    await act(async () => {
      stopping.resolve({ keptEdits: "none" });
      await stopping.promise;
    });
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("never paints a load that finished after the workspace changed", async () => {
    const h = harness();
    const first = deferred<LiveDocumentPage>();
    const second = deferred<LiveDocumentPage>();
    h.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<LiveDocumentsDialog workspaceId="ws-a" {...h} />);

    view.rerender(<LiveDocumentsDialog workspaceId="ws-b" {...h} />);
    expect(h.load).toHaveBeenNthCalledWith(2, "ws-b", undefined);
    await act(async () => {
      first.resolve(page([row("docs/a-only.md")]));
      await first.promise;
    });

    expect(screen.queryByTestId("live-document-row-docs/a-only.md")).toBeNull();
    await act(async () => {
      second.resolve(page([row("docs/b-only.md")]));
      await second.promise;
    });
    expect(paths()).toEqual(["live-document-row-docs/b-only.md"]);
  });

  it("drops a mutation that finished after the workspace changed", async () => {
    const h = harness();
    h.load.mockResolvedValue(page([row("docs/a.md")]));
    const stopping = deferred<LiveDocumentStopResult>();
    h.stop.mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup();
    const view = render(<LiveDocumentsDialog workspaceId="ws-a" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    await user.click(screen.getByRole("button", { name: "Stop live editing for docs/a.md" }));
    view.rerender(<LiveDocumentsDialog workspaceId="ws-b" {...h} />);
    await act(async () => {
      stopping.resolve({ keptEdits: "recovered" });
      await stopping.promise;
    });

    expect(h.stop).toHaveBeenCalledWith("ws-a", "docs/a.md", "object:docs/a.md");
    // Workspace A's Stop never reports into workspace B.
    expect(h.onStopped).not.toHaveBeenCalled();
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.load).toHaveBeenNthCalledWith(2, "ws-b", undefined);
  });

  // A share whose live editing never started is not a live document. It gets
  // its own section, its own words, and one Try again per share.
  describe("refused shares", () => {

    it("does not display or copy arbitrary server text", async () => {
      const h = harness();
      h.loadRefusals.mockResolvedValueOnce(refusalPage([{
        ...refusal("share-1"), code: "bad_request", message: "Authorization: Bearer private-token",
      }]));
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
      const rowEl = await screen.findByTestId("live-refusal-row-share-1");
      expect(rowEl.textContent).toContain("The server could not accept this share for live editing.");
      expect(rowEl.textContent).not.toContain("private-token");
      await user.click(within(rowEl).getByRole("button", { name: "Copy details for share-1.md" }));
      const copied = await navigator.clipboard.readText();
      expect(copied).toContain("Reason code: bad_request");
      expect(copied).not.toContain("private-token");
    });

    it("drops a retry and its refresh when the workspace changes mid-flight", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md")]));
      h.loadRefusals.mockResolvedValueOnce(
        refusalPage([refusal("share-1", ["docs/a.md"])]),
      );
      const retrying = deferred();
      h.retryRefusal.mockReturnValueOnce(retrying.promise);
      const user = userEvent.setup();
      const view = render(<LiveDocumentsDialog workspaceId="ws-a" {...h} />);

      await screen.findByTestId("live-refusal-row-share-1");
      await user.click(
        screen.getByRole("button", { name: "Retry live editing for docs/a.md" }),
      );
      view.rerender(<LiveDocumentsDialog workspaceId="ws-b" {...h} />);
      await act(async () => {
        retrying.resolve();
        await retrying.promise;
      });

      expect(h.retryRefusal).toHaveBeenCalledWith("ws-a", "share-1");
      // Only the two mounts read: the refresh for the workspace that left
      // never ran, and nothing it would have painted is on screen.
      expect(h.load).toHaveBeenCalledTimes(2);
      expect(h.load).toHaveBeenNthCalledWith(2, "ws-b", undefined);
      expect(h.loadRefusals).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("live-refusal-row-share-1")).toBeNull();
      expect(h.onError).not.toHaveBeenCalled();
    });

    // The share was already asked. Its recovery re-reads both lists and must
    // never enrol it a second time.
    it("recovers read-only when the refresh fails after a successful retry", async () => {
      const h = harness();
      h.load
        .mockResolvedValueOnce(page([row("docs/a.md")]))
        .mockRejectedValueOnce(new Error("the engine did not answer"))
        .mockResolvedValueOnce(page([row("docs/b.md")]));
      h.loadRefusals.mockResolvedValue(
        refusalPage([refusal("share-1", ["docs/a.md"])]),
      );
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      await screen.findByTestId("live-refusal-row-share-1");
      await user.click(
        screen.getByRole("button", { name: "Retry live editing for docs/a.md" }),
      );

      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
      expect(h.onError.mock.calls[0]![0]).toBe(
        "dohc could not load the live documents for this workspace.",
      );
      // A half-finished refresh claims neither list.
      expect(
        screen.getByText(
          "This list is not current. Reload to see this workspace's live documents.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText("This list is not current. Reload to check these shares again."),
      ).toBeTruthy();

      await act(async () => {
        expect(h.onError.mock.calls[0]![2]()).toBe(true);
      });
      expect(h.retryRefusal).toHaveBeenCalledTimes(1);
      expect(h.load).toHaveBeenCalledTimes(3);
      expect(await screen.findByTestId("live-document-row-docs/b.md")).toBeTruthy();
    });
  });

  describe("edits the server refused", () => {

    it("offers Try again and a recovery copy for edits a Stop took but could not write", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { status: "retired", quarantine: "not-written", objectId: "object-a" })]));
      h.stop.mockResolvedValueOnce({ keptEdits: "recovered" });
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const kept = await screen.findByTestId("live-document-row-docs/a.md");
      expect(within(kept).getByText("Stopped")).toBeTruthy();
      expect(kept.textContent).toContain("When live editing stopped, dohc kept your unsent edits but could not write them to your file. Save a recovery copy to get them back.");
      expect(actions("docs/a.md")).toEqual(["Try again", "Save recovery copy"]);
      await userEvent.setup().click(within(kept).getByRole("button", { name: "Try again to write your kept edits to docs/a.md" }));
      await vi.waitFor(() => expect(h.onStopped).toHaveBeenCalledExactlyOnceWith("docs/a.md", "recovered"));
      // Try again names the row's document: another document may now have its path.
      expect(h.stop).toHaveBeenCalledExactlyOnceWith("ws", "docs/a.md", "object-a", { objectId: "object-a", recovery: "not-written" });
    });

    // Save needs the queue head dohc could not read; Try again reads it again,
    // and a refusal leaves the row as the last read proved it.
    it("keeps a row for edits dohc could not read, with Try again and Save disabled, beside a usable one", async () => {
      const h = harness();
      const unreadable = row("docs/a.md", { quarantine: "unreadable", incident: "unreadable:outbox", objectId: "object-a" });
      h.load.mockResolvedValue(page([unreadable, row("docs/b.md", { quarantine: "paused", incident: "outbox-b:delivery:0" })]));
      const refused = new Error("owner-outbox-accepted-state-incomplete");
      h.readKeptEdits.mockRejectedValueOnce(refused);
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const kept = await screen.findByTestId("live-document-row-docs/a.md");
      expect(within(kept).getByText("Can't read edits")).toBeTruthy();
      expect(kept.textContent).toContain("dohc kept edits on this computer but could not read them. Try again to read them.");
      expect(actions("docs/a.md")).toEqual(["Stop live editing", "Try again", "Save recovery copy"]);
      expect(within(kept).getByRole("button", { name: "Save recovery copy of docs/a.md" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Save recovery copy of docs/b.md" })).toHaveProperty("disabled", false);
      const user = userEvent.setup();
      await user.click(within(kept).getByRole("button", { name: "Try again to read your kept edits for docs/a.md" }));
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledExactlyOnceWith("dohc could not read the edits it kept for docs/a.md.", refused, expect.any(Function)));
      expect(h.readKeptEdits).toHaveBeenCalledExactlyOnceWith("ws", "object-a", "unreadable:outbox");
      expect(screen.getByTestId("live-document-row-docs/a.md")).toBeTruthy();
      // Read: the list reads again and shows the queue as it is now.
      h.load.mockResolvedValue(page([{ ...unreadable, quarantine: "paused", incident: "outbox:delivery:0" }]));
      act(() => { expect(h.onError.mock.calls[0]![2]()).toBe(true); });
      await vi.waitFor(() => expect(within(screen.getByTestId("live-document-row-docs/a.md")).getByText("Paused")).toBeTruthy());
      expect(h.readKeptEdits).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Save recovery copy of docs/a.md" })).toHaveProperty("disabled", false);
    });
  });
});

it("shows a Stop that answered while a closed opening loaded in the next opening's row", async () => {
  const h = harness(), user = userEvent.setup(), stopping = deferred<LiveDocumentStopResult>(), loading = deferred<LiveDocumentPage>();
  const onStopPending = vi.fn();
  const stopRunning: { current: LiveDocumentStopRunning | null } = { current: null };
  h.load.mockResolvedValueOnce(page([row("a.md")])).mockReturnValueOnce(loading.promise).mockResolvedValue(page([row("a.md")]));
  h.stop.mockReturnValueOnce(stopping.promise);
  const opening = () => render(<LiveDocumentsDialog workspaceId="ws" {...h} onStopPending={onStopPending} stopRunning={stopRunning} />);
  const first = opening();
  await user.click(await screen.findByRole("button", {name: "Stop live editing for a.md"}));
  first.unmount();
  const second = opening();
  await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(2));
  await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
  second.unmount();
  opening();
  const live = await screen.findByTestId("live-document-row-a.md");
  await act(async () => loading.resolve(page([row("a.md")])));
  expect(onStopPending).not.toHaveBeenCalled();
  await within(live).findByText("Live editing didn't stop. The server hasn't finished applying edits to this document. Try again in a moment.");
  expect(onStopPending).not.toHaveBeenCalled();
  expect(h.onError).not.toHaveBeenCalled();
  expect(stopRunning.current).toBeNull();
  expect(h.stop).toHaveBeenCalledOnce();
});

it("reports a Stop that answers while Live documents is closed once, and shows its row as usual after", async () => {
  const h = harness(), user = userEvent.setup(), stopping = deferred<LiveDocumentStopResult>();
  const onStopPending = vi.fn();
  const stopRunning: { current: LiveDocumentStopRunning | null } = { current: null };
  h.load.mockResolvedValue(page([row("a.md")]));
  h.stop.mockReturnValueOnce(stopping.promise);
  const opening = () => render(<LiveDocumentsDialog workspaceId="ws" {...h} onStopPending={onStopPending} stopRunning={stopRunning} />);
  const first = opening();
  await user.click(await screen.findByRole("button", {name: "Stop live editing for a.md"}));
  first.unmount();
  await act(async () => stopping.reject(liveStopError({code: "edits-pending"})));
  await vi.waitFor(() => expect(onStopPending).toHaveBeenCalledExactlyOnceWith("ws", "a.md", "object:a.md",
    expect.objectContaining({code: "edits-pending"})));
  expect(stopRunning.current).toBeNull();
  opening();
  await screen.findByRole("button", {name: "Stop live editing for a.md"});
  expect(onStopPending).toHaveBeenCalledOnce();
  expect(h.onError).not.toHaveBeenCalled();
  expect(h.stop).toHaveBeenCalledOnce();
});

it("focuses the withheld conflict cause once after Stop refuses, without retry or Resume", async () => {
  const h = harness();
  h.load.mockResolvedValue(page([row("held.md", {status: "unavailable", reason: "conflict-parent-withheld"})]));
  h.stop.mockRejectedValueOnce(liveStopError({code: "edits-pending"}));
  render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
  fireEvent.click(await screen.findByRole("button", {name: "Stop live editing for held.md"}));
  const words = "Live editing didn't stop. A conflict in this file was resolved, so live editing can't resume for it. People with the link can still read the last shared version. You can keep editing it in dohc, but your edits may not reach them.";
  const note = await screen.findByText(words);
  const live = screen.getByTestId("live-document-row-held.md");
  expect(document.activeElement).toBe(note);
  expect(live.children[1]?.textContent).toBe("Can't resume");
  expect(live.querySelectorAll("p")).toHaveLength(1);
  expect(actions("held.md")).toEqual([]);
});
it.each((["paused", "unreadable"] as const).map(quarantine => ({
  quarantine,
  expectation: quarantine === "unreadable" ? "hides the unreadable note and read action, then restores them after retry"
    : `keeps the ${quarantine} note and recovery copy`,
})))("$expectation after a non-resumable Stop refuses", async ({quarantine}) => {
  const h = harness(), user = userEvent.setup();
  h.load.mockResolvedValue(page([row("held.md", {quarantine, incident: "kept-1"})]));
  h.stop.mockRejectedValueOnce(liveStopError({code: "edits-pending"}));
  render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
  const live = await screen.findByTestId("live-document-row-held.md");
  const cause = live.querySelector("p")!.textContent;
  fireEvent.click(within(live).getByRole("button", {name: "Stop live editing for held.md"}));
  const note = await within(live).findByText("Live editing didn't stop. The server hasn't finished applying edits to this document. Try again in a moment.");
  expect(document.activeElement).toBe(within(live).getByRole("button", {name: "Try again to stop live editing for held.md"}));
  expect(within(live).queryByRole("button", {name: /Resume live/})).toBeNull();
  expect([...live.querySelectorAll("p")].map(p => p.textContent)).toEqual(
    quarantine === "unreadable" ? [note.textContent] : [note.textContent, cause]);
  if (quarantine === "unreadable") {
    expect(live.children[1]?.textContent).toBe("Can't read edits");
    expect(within(live).queryByRole("button", {name: "Try again to read your kept edits for held.md"})).toBeNull();
    await user.click(within(live).getByRole("button", {name: "Try again to stop live editing for held.md"}));
    await within(live).findByText(cause!);
    expect(within(live).getByRole("button", {name: "Try again to read your kept edits for held.md"})).toBeTruthy();
  }
  const save = within(live).getByRole("button", {name: "Save recovery copy of held.md"}) as HTMLButtonElement;
  expect(save.disabled).toBe(quarantine === "unreadable");
  if (!save.disabled) {
    await user.click(save);
    expect(h.saveRecoveryCopy).toHaveBeenCalledExactlyOnceWith("ws", "held.md", "kept-1");
  }
});

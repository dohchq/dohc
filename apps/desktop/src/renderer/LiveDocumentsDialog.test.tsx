// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import {
  LiveDocumentsDialog,
  type LiveDocumentPage,
  type LiveDocumentRow,
  type LiveDocumentStopResult,
  type LiveRefusalPage,
  type LiveRefusalRow,
} from "./LiveDocumentsDialog";

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
    onError: vi.fn((message: string, error: unknown, retry: () => boolean) => {}),
    saveRecoveryCopy: vi.fn(async (workspaceId: string, path: string, incident?: string) => {}),
    readKeptEdits: vi.fn(async (workspaceId: string, objectId: string, incident: string) => {}),
  };
}

function actions(path: string): string[] {
  return within(screen.getByTestId(`live-document-row-${path}`))
    .queryAllByRole("button")
    .map((button) => button.textContent);
}

it("keeps a retired held note's explanation and offers no Resume or Stop, like a retired diverged note", async () => {
  const h = harness();
  h.load.mockResolvedValue(page([
    row("docs/held.md", {status: "retired", reason: "conflict-parent-withheld"}),
    row("docs/diverged.md", {status: "retired", reason: "session-host-diverged"}),
  ]));
  render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
  const held = await screen.findByTestId("live-document-row-docs/held.md");
  expect(held.children[1]?.textContent).toBe("Can't resume");
  expect(held.textContent).toContain("A conflict in this file was resolved, so live editing can't resume for it. People with the link can still read the last shared version. You can keep editing it in dohc, but your edits may not reach them.");
  expect(actions("docs/held.md")).toEqual([]);
  expect(actions("docs/diverged.md")).toEqual([]);
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
  it("offers Resume on a live row with a deferred Stop after local clear failed", async () => {
    const h=harness();
    h.load.mockResolvedValue(page([{...row("a.md"),status:"ready",canResume:true,deferredStop:{unsentEdits:1,editable:true}}]));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    expect((await screen.findByTestId("live-document-row-a.md")).textContent).toContain("Live editing resumed.");
    expect(actions("a.md")).toEqual(["Resume live editing"]);
    fireEvent.click(await screen.findByRole("button",{name:"Resume live editing for a.md"}));
    await vi.waitFor(() => expect(h.resume).toHaveBeenCalledWith("ws","a.md"));
  });
  it.each([true, false])("uses IPC Resume availability on a ready row: %s", async canResume => {
    const h = harness();
    h.load.mockResolvedValue(page([row("a.md", {canResume})]));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const document = await screen.findByTestId("live-document-row-a.md");
    expect(!!within(document).queryByRole("button", {name:"Resume live editing for a.md"})).toBe(canResume);
  });
  it.each([0,1])("describes a deferred queue of %s edits", async unsentEdits => {
    const h=harness();
    h.load.mockResolvedValue(page([row("a.md",{status:"retired",canResume:true,deferredStop:{unsentEdits,editable:true}})]));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const stopped=await screen.findByTestId("live-document-row-a.md");
    expect(stopped.textContent).toContain(unsentEdits===0 ? "Resume live editing to finish syncing." : "1 unsent edit remains on this computer.");
    expect(stopped.textContent).not.toContain("1 unsent edits");
    expect(stopped.textContent).not.toContain("They are not in History");
  });
  // Proves: a document stopped on a diverged server copy keeps the operator's
  // explanation, and its deferred Stop keeps its facts without a Resume to try.
  it.each([0, 2])("sends a document stopped on a diverged copy, with %s unsent edits, to the server's operator", async unsentEdits => {
    const h=harness(), reason="session-host-diverged" as const;
    h.load.mockResolvedValue(page([
      row("deferred.md",{status:"retired",reason,deferredStop:{unsentEdits,editable:true}}),
      row("stopped.md",{status:"retired",reason}),
    ]));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const deferred=await screen.findByTestId("live-document-row-deferred.md");
    expect(deferred.textContent).toContain("The server's copy of this workspace no longer matches the synced one. Contact the server's operator.");
    expect(deferred.textContent).toContain(unsentEdits===0 ? "Live editing stopped. You can keep editing." : "Live editing stopped. 2 unsent edits remain on this computer. You can keep editing.");
    expect(deferred.textContent).not.toContain("Resume");
    expect(screen.getByTestId("live-document-row-stopped.md").textContent).toContain("Contact the server's operator.");
    for (const path of ["deferred.md","stopped.md"]) {
      expect(screen.getByTestId(`live-document-row-${path}`).children[1]?.textContent).toBe("Server copy doesn't match");
      expect(actions(path)).toEqual([]);
    }
  });
  it.each([0, 2])("does not suggest Resume for a conflict hold with %s deferred edits", async unsentEdits => {
    const h = harness();
    h.load.mockResolvedValue(page([row("held.md", {status: "unavailable", reason: "conflict-parent-withheld",
      canResume: false, deferredStop: {unsentEdits, editable: true}})]));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const held = await screen.findByTestId("live-document-row-held.md");
    expect(held.children[1]?.textContent).toBe("Can't resume");
    expect(held.textContent).toContain("your edits may not reach them.");
    expect(held.textContent).not.toContain("Resume");
    expect(actions("held.md")).toEqual([]);
  });
  it.each([true, false])("shows deferred unsent edits and truthful editability: %s", async editable => {
    const h=harness();
    h.load.mockResolvedValue(page([row("a.md", {status:"retired",canResume:true,deferredStop:{unsentEdits:65,editable}})]));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const stopped=await screen.findByTestId("live-document-row-a.md");
    expect(stopped.textContent).toContain("65 unsent edits remain on this computer.");
    expect(stopped.textContent).toContain("Resume live editing to try sending them.");
    expect(stopped.textContent).toContain(editable ? "You can keep editing." : "Editing is paused.");
    fireEvent.click(within(stopped).getByRole("button",{name:"Resume live editing for a.md"}));
    await vi.waitFor(() => expect(h.resume).toHaveBeenCalledWith("ws","a.md"));
  });
  it("reports a waiting Stop through Notices and keeps its retry available", async () => {
    const h = harness(); h.load.mockResolvedValue(page([row("a.md")]));
    const error = new Error("Stop live editing is waiting. You can keep editing.");
    h.stop.mockRejectedValueOnce(error);
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    fireEvent.click(await screen.findByRole("button", {name: "Stop live editing for a.md"}));
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    expect(h.onError.mock.calls[0]!.slice(0,2)).toEqual(["Stop live editing for a.md is waiting for a connection or restore.", error]);
    expect(h.onError.mock.calls[0]![2]()).toBe(true);
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalledTimes(2));
  });
  it("stands lines in for the first page, and keeps the words while a Reload keeps the list", async () => {
    const h = harness();
    const first = deferred<LiveDocumentPage>();
    h.load.mockReturnValueOnce(first.promise);
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    const status = screen.getByRole("status");
    expect(status.querySelector(".sr-only")?.textContent).toBe("Loading live documents…");
    expect(screen.getByTestId("live-documents-dialog").querySelector(".dohc-reveal-if-slow")).toBeTruthy();
    await act(async () => first.resolve(page([row("a.md")])));
    const reload = deferred<LiveDocumentPage>();
    h.load.mockReturnValueOnce(reload.promise);
    fireEvent.click(screen.getByTestId("live-documents-reload"));
    expect(status.textContent).toBe("Loading live documents…");
    expect(status.querySelector(".sr-only")).toBeNull();
    expect(screen.getByTestId("live-document-row-a.md")).toBeTruthy();
    expect(screen.getByTestId("live-documents-dialog").querySelector(".dohc-reveal-if-slow")).toBeNull();
    await act(async () => reload.resolve(page([row("a.md")])));
  });

  it("runs a retry queued during a paged read instead of silently dropping it", async () => {
    const h = harness(), reading = deferred<LiveDocumentPage>();
    h.load.mockResolvedValue(page([row("a.md")], "cursor"));
    h.stop.mockRejectedValueOnce(new Error("not stopped"));
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    fireEvent.click(await screen.findByRole("button", {name:"Stop live editing for a.md"}));
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    h.load.mockReturnValueOnce(reading.promise);
    fireEvent.click(screen.getByTestId("live-documents-more"));
    expect(h.onError.mock.calls[0]![2]()).toBe(true);
    expect(h.stop).toHaveBeenCalledTimes(1);
    await act(async () => reading.resolve(page([row("a.md")])));
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalledTimes(2));
  });

  it("accepts a retry invoked synchronously by the error reporter", async () => {
    const h = harness();
    h.load.mockRejectedValueOnce(new Error("offline"));
    h.onError.mockImplementation((_message, _error, retry) => { expect(retry()).toBe(true); });
    render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
    await screen.findByText("No live documents in this workspace.");
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it("loads after a Strict Mode remount and keeps retry usable", async () => {
    const h = harness();
    h.load.mockRejectedValue(new Error("offline"));
    render(<StrictMode><LiveDocumentsDialog workspaceId="ws-1" {...h} /></StrictMode>);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
    h.load.mockResolvedValue(page([row("recovered.md")]));
    await act(async () => { expect(h.onError.mock.calls[0]![2]()).toBe(true); });
    expect(await screen.findByText("recovered.md")).toBeTruthy();
  });

  it("drops a failed read after closing without waiting for the parent to unmount", async () => {
    const h = harness(), pending = deferred<LiveDocumentPage>();
    h.load.mockReturnValue(pending.promise);
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => pending.reject(new Error("late failure")));
    expect(h.onError).not.toHaveBeenCalled();
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

  it("drops absent active rows on the next page but retains previously loaded stopped rows", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(page([row("active.md"), row("older.md", {status:"retired"})], "older.md"))
      .mockResolvedValueOnce(page([row("latest.md", {status:"retired"})]));
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
    fireEvent.click(await screen.findByTestId("live-documents-more"));
    await screen.findByText("latest.md");
    expect(screen.queryByText("active.md")).toBeNull();
    expect(screen.getByText("older.md")).toBeTruthy();
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
          canResume: false,
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
      "Can't resume",
      "Can't resume",
      "Stopped",
      "Stopped",
    ]);
    // Only a document edited while live editing was off says why it can't
    // resume, and that its file still takes edits. It offers no Resume.
    const edited =
      "This file changed while live editing was off, so live editing can't resume for it. You can keep editing it in dohc.";
    expect(screen.getAllByText(edited)).toHaveLength(1);
    expect(screen.getByTestId("live-document-row-docs/edited.md").textContent).toContain(edited);
    expect(actions("docs/edited.md")).toEqual(["Stop live editing"]);
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
      "Live editing can't start until you open this document once in dohc. After you open it, resume live editing.";
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

  it("states the empty list and what makes a document appear", async () => {
    const h = harness();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    expect(await screen.findByText("No live documents in this workspace.")).toBeTruthy();
    expect(screen.getByText("Reload after a document starts live editing.")).toBeTruthy();
    expect(
      screen.getByText(
        "Stopping live editing keeps the file and its history. Share permissions stay unchanged.",
      ),
    ).toBeTruthy();
  });

  // The warning is on screen before any Stop runs.
  it("warns before a Stop that editing the stopped file keeps live editing from resuming", async () => {
    const h = harness();
    h.load.mockResolvedValue(page([row("docs/a.md")]));
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
    await screen.findByRole("button", { name: "Stop live editing for docs/a.md" });
    expect(screen.getByTestId("live-documents-stop-warning").textContent).toBe(
      "If you edit a file while its live editing is stopped, live editing can't resume for it.",
    );
    expect(h.stop).not.toHaveBeenCalled();
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

  // A read answers with the stopped documents first, so a path it catches
  // mid-resume arrives in that half carrying the current record. The list a
  // person reads is what this workspace is editing now, then its history.
  it("lists the current documents above the stopped ones", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(
      page([
        row("docs/gone.md", { status: "retired", canResume: true }),
        row("docs/resumed.md"),
        row("docs/live.md"),
      ]),
    );
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/live.md");
    expect(paths()).toEqual([
      "live-document-row-docs/resumed.md",
      "live-document-row-docs/live.md",
      "live-document-row-docs/gone.md",
    ]);
  });

  it("keeps a resumed document above the stopped history after the next page", async () => {
    const h = harness();
    h.load
      .mockResolvedValueOnce(
        page(
          [
            row("docs/live.md"),
            row("docs/gone.md", { status: "retired" }),
            row("docs/resumed.md", { status: "retired", canResume: true }),
          ],
          "docs/resumed.md",
        ),
      )
      .mockResolvedValueOnce(
        page([
          row("docs/live.md"),
          row("docs/resumed.md"),
          row("docs/older.md", { status: "retired" }),
        ]),
      );
    const user = userEvent.setup();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/live.md");
    await user.click(screen.getByTestId("live-documents-more"));

    await vi.waitFor(() => {
      expect(screen.getByTestId("live-document-row-docs/older.md")).toBeTruthy();
    });
    expect(paths()).toEqual([
      "live-document-row-docs/live.md",
      "live-document-row-docs/resumed.md",
      "live-document-row-docs/gone.md",
      "live-document-row-docs/older.md",
    ]);
    // The newest record still wins in place: one row for the resumed path.
    expect(actions("docs/resumed.md")).toEqual(["Stop live editing"]);
  });

  it("stops a document and replaces the list with the reloaded first page", async () => {
    const h = harness();
    h.load
      .mockResolvedValueOnce(page([row("docs/a.md")], "retired-page-2"))
      .mockResolvedValueOnce(page([row("docs/a.md", { status: "retired", canResume: true })]));
    const user = userEvent.setup();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    await user.click(screen.getByRole("button", { name: "Stop live editing for docs/a.md" }));

    expect(h.stop).toHaveBeenCalledWith("ws-1", "docs/a.md", "object:docs/a.md");
    await vi.waitFor(() => {
      expect(actions("docs/a.md")).toEqual(["Resume live editing"]);
    });
    expect(h.load).toHaveBeenNthCalledWith(2, "ws-1", undefined);
    expect(screen.queryByTestId("live-documents-more")).toBeNull();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("resumes a stopped document and reloads the list", async () => {
    const h = harness();
    h.load
      .mockResolvedValueOnce(page([row("docs/a.md", { status: "retired", canResume: true })]))
      .mockResolvedValueOnce(page([row("docs/a.md")]));
    const user = userEvent.setup();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    await user.click(screen.getByRole("button", { name: "Resume live editing for docs/a.md" }));

    expect(h.resume).toHaveBeenCalledWith("ws-1", "docs/a.md");
    await vi.waitFor(() => {
      expect(actions("docs/a.md")).toEqual(["Stop live editing"]);
    });
    expect(h.load).toHaveBeenNthCalledWith(2, "ws-1", undefined);
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

  it("reports a failed load to the shell and retries it in place", async () => {
    const h = harness();
    const failure = new Error("relay refused the read");
    h.load.mockRejectedValueOnce(failure).mockResolvedValueOnce(page([row("docs/a.md")]));
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await vi.waitFor(() => {
      expect(h.onError).toHaveBeenCalledTimes(1);
    });
    expect(h.onError.mock.calls[0]![0]).toBe(
      "dohc could not load the live documents for this workspace.",
    );
    expect(h.onError.mock.calls[0]![1]).toBe(failure);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText("This list is not current. Reload to see this workspace's live documents."),
    ).toBeTruthy();

    await act(async () => {
      expect(h.onError.mock.calls[0]![2]()).toBe(true);
    });
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId("live-document-row-docs/a.md")).toBeTruthy();
  });

  it("reports a failed stop and refuses its retry once the dialog is gone", async () => {
    const h = harness();
    h.load.mockResolvedValueOnce(page([row("docs/a.md")]));
    const failure = new Error("the session host is offline");
    h.stop.mockRejectedValueOnce(failure);
    const user = userEvent.setup();
    const view = render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    await user.click(screen.getByRole("button", { name: "Stop live editing for docs/a.md" }));

    await vi.waitFor(() => {
      expect(h.onError).toHaveBeenCalledTimes(1);
    });
    expect(h.onError.mock.calls[0]![0]).toBe("dohc could not stop live editing for docs/a.md.");
    expect(h.onError.mock.calls[0]![1]).toBe(failure);
    expect(screen.queryByRole("alert")).toBeNull();

    view.unmount();
    expect(h.onError.mock.calls[0]![2]()).toBe(false);
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("reloads instead of replaying a stop the user has already moved past", async () => {
    const h = harness();
    h.load.mockResolvedValue(
      page([row("docs/a.md"), row("docs/b.md", { status: "retired", canResume: true })]),
    );
    h.stop.mockRejectedValueOnce(new Error("the session host is offline"));
    const user = userEvent.setup();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    await user.click(screen.getByRole("button", { name: "Stop live editing for docs/a.md" }));
    await vi.waitFor(() => {
      expect(h.onError).toHaveBeenCalledTimes(1);
    });
    await user.click(screen.getByRole("button", { name: "Resume live editing for docs/b.md" }));
    await vi.waitFor(() => {
      expect(h.resume).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      expect(h.onError.mock.calls[0]![2]()).toBe(true);
    });
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenLastCalledWith("ws-1", undefined);
  });

  it("closes on Escape and on the Close action", async () => {
    const h = harness();
    const user = userEvent.setup();
    render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

    const dialog = await screen.findByRole("dialog", { name: "Live documents" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);

    await user.keyboard("{Escape}");
    expect(h.onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  // A share whose live editing never started is not a live document. It gets
  // its own section, its own words, and one Try again per share.
  describe("refused shares", () => {
    it("disables Reload until a refusal page finishes", async () => {
      const h = harness();
      const pending = deferred<LiveRefusalPage>();
      h.loadRefusals.mockResolvedValueOnce(refusalPage([refusal("share-1")], "share-1"))
        .mockReturnValueOnce(pending.promise);
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
      await user.click(await screen.findByTestId("live-refusals-more"));
      const reload = screen.getByTestId("live-documents-reload") as HTMLButtonElement;
      expect(reload.disabled).toBe(true);
      await user.click(reload);
      expect(h.load).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(refusalPage([refusal("share-2")])));
      expect(reload.disabled).toBe(false);
      await user.click(reload);
      expect(h.loadRefusals).toHaveBeenLastCalledWith("ws-1", undefined);
    });

    it("says nothing about refusals when the page is proven empty", async () => {
      const h = harness();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      await screen.findByText("No live documents in this workspace.");
      expect(h.loadRefusals).toHaveBeenCalledWith("ws-1", undefined);
      expect(screen.queryByTestId("live-refusals")).toBeNull();
    });

    it("names the files and maps a known server limit to recovery steps", async () => {
      const h = harness();
      h.loadRefusals.mockResolvedValueOnce(
        refusalPage([
          refusal("share-1", [
            "a.md",
            "b.md",
            "c.md",
            "d.md",
            "e.md",
            "f.md",
            "g.md",
          ]),
        ]),
      );
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      const rowEl = await screen.findByTestId("live-refusal-row-share-1");
      expect(rowEl.textContent).toContain(
        "This share could not start live editing automatically.",
      );
      // Bounded: five files identify the share, the rest are counted.
      expect(within(rowEl).getByText("a.md")).toBeTruthy();
      expect(within(rowEl).getByText("e.md")).toBeTruthy();
      expect(within(rowEl).queryByText("f.md")).toBeNull();
      expect(within(rowEl).getByText("and 2 more files")).toBeTruthy();

      await user.click(
        within(rowEl).getByRole("button", { name: "Copy details for a.md" }),
      );
      const copied = await navigator.clipboard.readText();
      expect(copied).toContain("Files: a.md, b.md");
      expect(copied).toContain("Workspace id: ws-1");
      expect(rowEl.textContent).toContain("A server limit is preventing live editing.");
      expect(copied).toContain("Reason code: quota_exceeded");
      expect(copied).toContain("Server detail: Service host enrollment capacity is full.");
    });

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

    // The cursor is the only word on whether more pages exist. An empty page
    // proves nothing about the next one.
    it("keeps Load more for an empty page that still has a cursor", async () => {
      const h = harness();
      h.loadRefusals
        .mockResolvedValueOnce(refusalPage([], "share-2"))
        .mockResolvedValueOnce(refusalPage([refusal("share-3")]));
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      expect(
        await screen.findByText("No refused shares on this page. Continue to the next page."),
      ).toBeTruthy();
      await user.click(screen.getByTestId("live-refusals-more"));

      expect(h.loadRefusals).toHaveBeenNthCalledWith(2, "ws-1", "share-2");
      expect(await screen.findByTestId("live-refusal-row-share-3")).toBeTruthy();
      expect(screen.queryByTestId("live-refusals-more")).toBeNull();
    });

    it("replaces the page it shows instead of growing the list", async () => {
      const h = harness();
      h.loadRefusals
        .mockResolvedValueOnce(refusalPage([refusal("share-1")], "share-1"))
        .mockResolvedValueOnce(refusalPage([refusal("share-2")], "share-2"));
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      await screen.findByTestId("live-refusal-row-share-1");
      await user.click(screen.getByTestId("live-refusals-more"));

      expect(await screen.findByTestId("live-refusal-row-share-2")).toBeTruthy();
      expect(screen.queryByTestId("live-refusal-row-share-1")).toBeNull();
    });

    it("keeps an empty final page visible and Reload returns to the first page", async () => {
      const h = harness();
      h.loadRefusals.mockResolvedValueOnce(refusalPage([refusal("share-1")], "share-1"))
        .mockResolvedValueOnce(refusalPage([]))
        .mockResolvedValueOnce(refusalPage([refusal("share-1")], "share-1"));
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);
      await user.click(await screen.findByRole("button", {
        name: "Next page of shares that could not start live editing",
      }));
      expect(await screen.findByText(
        "No refused shares on this page. Reload to return to the first page.",
      )).toBeTruthy();
      expect(screen.queryByTestId("live-refusals-more")).toBeNull();
      await user.click(screen.getByTestId("live-documents-reload"));
      expect(await screen.findByTestId("live-refusal-row-share-1")).toBeTruthy();
      expect(h.loadRefusals).toHaveBeenLastCalledWith("ws-1", undefined);
    });

    it("retries one share and refreshes the page that share came from", async () => {
      const h = harness();
      h.loadRefusals
        .mockResolvedValueOnce(refusalPage([refusal("share-1")], "share-1"))
        .mockResolvedValueOnce(refusalPage([refusal("share-2", ["docs/b.md"])]))
        .mockResolvedValueOnce(refusalPage([]));
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      await screen.findByTestId("live-refusal-row-share-1");
      await user.click(screen.getByTestId("live-refusals-more"));
      await screen.findByTestId("live-refusal-row-share-2");

      await user.click(
        screen.getByRole("button", { name: "Retry live editing for docs/b.md" }),
      );
      expect(h.retryRefusal).toHaveBeenCalledWith("ws-1", "share-2");
      // The same page is read again, not the first one.
      await vi.waitFor(() =>
        expect(h.loadRefusals).toHaveBeenNthCalledWith(3, "ws-1", "share-1"),
      );
      await screen.findByText("No refused shares on this page. Reload to return to the first page.");
      expect(h.onError).not.toHaveBeenCalled();
    });

    // Enrolling a share changes the live documents too, so the retry is not
    // finished until both lists have been read again.
    it("refreshes the live documents after a successful retry", async () => {
      const h = harness();
      h.load
        .mockResolvedValueOnce(page([row("docs/old.md")]))
        .mockResolvedValueOnce(page([row("docs/new.md")]));
      h.loadRefusals
        .mockResolvedValueOnce(refusalPage([refusal("share-1", ["docs/new.md"])]))
        .mockResolvedValueOnce(refusalPage([]));
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      await screen.findByTestId("live-document-row-docs/old.md");
      await user.click(
        screen.getByRole("button", { name: "Retry live editing for docs/new.md" }),
      );

      expect(h.retryRefusal).toHaveBeenCalledWith("ws-1", "share-1");
      expect(await screen.findByTestId("live-document-row-docs/new.md")).toBeTruthy();
      expect(screen.queryByTestId("live-document-row-docs/old.md")).toBeNull();
      expect(h.load).toHaveBeenNthCalledWith(2, "ws-1", undefined);
      expect(screen.queryByTestId("live-refusals")).toBeNull();
      expect(h.onError).not.toHaveBeenCalled();
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

    // Two lists in one dialog: the panel is what scrolls, so the footer and
    // both Load more controls stay reachable however long either list is.
    it("bounds the whole dialog to the viewport with one scroller", async () => {
      const h = harness();
      h.load.mockResolvedValueOnce(page([row("docs/a.md")]));
      h.loadRefusals.mockResolvedValueOnce(refusalPage([refusal("share-1")]));
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      const dialog = await screen.findByTestId("live-documents-dialog");
      await screen.findByTestId("live-refusal-row-share-1");
      expect(dialog.className).toContain("max-h-[calc(100vh-112px)]");
      expect(dialog.className).toContain("overflow-y-auto");
      for (const list of [
        screen.getByRole("list", { name: "Live documents" }),
        screen.getByRole("list", { name: "Shares that could not start live editing" }),
      ]) {
        expect(list.className).not.toMatch(/max-h-\[|overflow-y-auto/);
      }
    });

    it("reports a refused retry, keeps the page, and retries it in place", async () => {
      const h = harness();
      h.loadRefusals.mockResolvedValue(refusalPage([refusal("share-1", ["docs/a.md"])]));
      const failure = new Error("the relay refused the request");
      h.retryRefusal.mockRejectedValueOnce(failure);
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      await screen.findByTestId("live-refusal-row-share-1");
      await user.click(
        screen.getByRole("button", { name: "Retry live editing for docs/a.md" }),
      );

      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
      expect(h.onError.mock.calls[0]![0]).toBe(
        "dohc could not retry live editing for docs/a.md.",
      );
      expect(h.onError.mock.calls[0]![1]).toBe(failure);
      // A refused ask leaves the page it was read from on screen.
      expect(screen.getByTestId("live-refusal-row-share-1")).toBeTruthy();

      await act(async () => {
        expect(h.onError.mock.calls[0]![2]()).toBe(true);
      });
      expect(h.retryRefusal).toHaveBeenCalledTimes(2);
    });

    it("reports a failed refusal read and offers the list as not current", async () => {
      const h = harness();
      const failure = new Error("the engine did not answer");
      h.loadRefusals
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(refusalPage([refusal("share-1")]));
      render(<LiveDocumentsDialog workspaceId="ws-1" {...h} />);

      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
      expect(h.onError.mock.calls[0]![0]).toBe(
        "dohc could not load the shares that could not start live editing.",
      );
      expect(h.onError.mock.calls[0]![1]).toBe(failure);
      expect(
        screen.getByText("This list is not current. Reload to check these shares again."),
      ).toBeTruthy();

      await act(async () => {
        expect(h.onError.mock.calls[0]![2]()).toBe(true);
      });
      expect(await screen.findByTestId("live-refusal-row-share-1")).toBeTruthy();
    });

    it("never paints refusals that answered after the workspace changed", async () => {
      const h = harness();
      const first = deferred<LiveRefusalPage>();
      const second = deferred<LiveRefusalPage>();
      h.loadRefusals.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const view = render(<LiveDocumentsDialog workspaceId="ws-a" {...h} />);

      view.rerender(<LiveDocumentsDialog workspaceId="ws-b" {...h} />);
      expect(h.loadRefusals).toHaveBeenNthCalledWith(2, "ws-b", undefined);
      await act(async () => {
        first.resolve(refusalPage([refusal("share-a-only")]));
        await first.promise;
      });
      expect(screen.queryByTestId("live-refusal-row-share-a-only")).toBeNull();

      await act(async () => {
        second.resolve(refusalPage([refusal("share-b-only")]));
        await second.promise;
      });
      expect(screen.getByTestId("live-refusal-row-share-b-only")).toBeTruthy();
    });

    it("refuses a stale refusal retry after the workspace changed", async () => {
      const h = harness();
      h.loadRefusals.mockRejectedValueOnce(new Error("old failure"));
      const view = render(<LiveDocumentsDialog workspaceId="ws-a" {...h} />);

      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledTimes(1));
      const staleRetry = h.onError.mock.calls[0]![2];
      view.rerender(<LiveDocumentsDialog workspaceId="ws-b" {...h} />);

      expect(staleRetry()).toBe(false);
      expect(h.loadRefusals).toHaveBeenCalledTimes(2);
    });
  });

  describe("edits the server refused", () => {
    it("reveals the asked-for row with its Stop, and promises only the recovery copy", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/other.md"), row("docs/a.md", { quarantine: "paused", incident: "outbox:delivery:0" })]));
      render(<LiveDocumentsDialog workspaceId="ws" reveal="docs/a.md" {...h} />);
      const stop = await screen.findByRole("button", { name: "Stop live editing for docs/a.md" });
      await vi.waitFor(() => expect(document.activeElement).toBe(stop));
      const revealed = screen.getByTestId("live-document-row-docs/a.md");
      expect(revealed.getAttribute("aria-current")).toBe("true");
      expect(screen.getByTestId("live-document-row-docs/other.md").getAttribute("aria-current")).toBeNull();
      expect(within(revealed).getByText("Paused")).toBeTruthy();
      expect(revealed.textContent).toContain(
        "The server could not accept your edits. dohc kept them on this computer. Save a recovery copy to get them back.",
      );
      expect(revealed.textContent).not.toContain("writes them into your file");
      expect(actions("docs/a.md")).toEqual(["Stop live editing", "Save recovery copy"]);
      await userEvent.setup().click(within(revealed).getByRole("button", { name: "Save recovery copy of docs/a.md" }));
      // Save names the kept edits the row shows.
      expect(h.saveRecoveryCopy).toHaveBeenCalledExactlyOnceWith("ws", "docs/a.md", "outbox:delivery:0");
    });

    it("reads on through later pages to reveal a stopped row, each page once", async () => {
      const h = harness();
      h.load.mockImplementation(async (_workspaceId, retiredAfter) => retiredAfter === undefined
        ? page([row("docs/live.md"), row("docs/b.md", { status: "retired" })], "docs/b.md")
        : retiredAfter === "docs/b.md" ? page([row("docs/c.md", { status: "retired" })], "docs/c.md")
        : page([row("docs/z.md", { status: "retired", quarantine: "not-written", objectId: "object-z" })]));
      render(<LiveDocumentsDialog workspaceId="ws" reveal="docs/z.md" {...h} />);
      const again = await screen.findByRole("button", { name: "Try again to write your kept edits to docs/z.md" });
      await vi.waitFor(() => expect(document.activeElement).toBe(again));
      expect(h.load.mock.calls.map((call) => call[1])).toEqual([undefined, "docs/b.md", "docs/c.md"]);
      expect(screen.getByTestId("live-document-row-docs/z.md").getAttribute("aria-current")).toBe("true");
    });

    it("stops reading on when a later page fails, and waits for its Try again", async () => {
      const h = harness();
      h.load.mockImplementation(async (_workspaceId, retiredAfter) => {
        if (retiredAfter !== undefined) throw new Error("offline");
        return page([row("docs/b.md", { status: "retired" })], "docs/b.md");
      });
      render(<LiveDocumentsDialog workspaceId="ws" reveal="docs/z.md" {...h} />);
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
      // Idle again, with the page it could not read still unread.
      await vi.waitFor(() => expect((screen.getByTestId("live-documents-reload") as HTMLButtonElement).disabled).toBe(false));
      expect(h.load).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("live-document-row-docs/b.md")).toBeTruthy();
    });

    it("says a requested Stop is waiting, keeps its Stop, and offers the recovery copy", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { quarantine: "stopping" })]));
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const waiting = await screen.findByTestId("live-document-row-docs/a.md");
      expect(within(waiting).getByText("Stopping")).toBeTruthy();
      expect(waiting.textContent).toContain("dohc is waiting for the server to stop live editing. Your unsent edits stay on this computer.");
      expect(waiting.textContent).not.toContain("Live editing stopped");
      expect(actions("docs/a.md")).toEqual(["Stop live editing", "Save recovery copy"]);
    });

    it("says the server keeps a hosted document's refused edits until a recovery copy is saved", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { quarantine: "paused", storedOn: "server" }),
        row("docs/b.md", { quarantine: "copied", storedOn: "server" })]));
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const paused = await screen.findByTestId("live-document-row-docs/a.md");
      expect(paused.textContent).toContain("The server could not accept your edits. dohc kept them on the server. Save a recovery copy to get them back.");
      expect(paused.textContent).not.toContain("this computer");
      const copied = screen.getByTestId("live-document-row-docs/b.md");
      expect(within(copied).getByText("Paused")).toBeTruthy();
      // The copy may be on another of the owner's computers.
      expect(copied.textContent).toContain("A recovery copy of them is saved, so the server may now release them.");
      expect(copied.textContent).not.toContain("this computer");
      expect(actions("docs/a.md")).toEqual(["Stop live editing", "Save recovery copy"]);
      expect(actions("docs/b.md")).toEqual(["Stop live editing", "Save recovery copy"]);
    });

    it("says the server kept edits in an earlier copy of the workspace, and offers a recovery copy of them but never Try again", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { quarantine: "paused", earlier: true, storedOn: "server" }),
        row("docs/b.md", { quarantine: "copied", earlier: true, storedOn: "server" })]));
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const kept = await screen.findByTestId("live-document-row-docs/a.md");
      expect(within(kept).getByText("Kept on the server")).toBeTruthy();
      expect(kept.textContent).toContain("It kept them in an earlier copy of this workspace. Save a recovery copy to get them back.");
      expect(actions("docs/a.md")).toEqual(["Stop live editing", "Save recovery copy"]);
      const copied = screen.getByTestId("live-document-row-docs/b.md");
      expect(within(copied).getByText("Paused")).toBeTruthy();
      expect(copied.textContent).toContain("A recovery copy of them is saved, so the server may now release them.");
      expect(actions("docs/b.md")).toEqual(["Stop live editing", "Save recovery copy"]);
    });

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

    it("offers only a recovery copy once dohc can't finish writing the edits, and Stop for a document live again", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { status: "retired", quarantine: "cannot-write" }), row("docs/b.md", { quarantine: "cannot-write" }),
        row("docs/c.md", { quarantine: "not-written", objectId: "object-c" })]));
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const kept = await screen.findByTestId("live-document-row-docs/a.md");
      expect(within(kept).getByText("Stopped")).toBeTruthy();
      expect(kept.textContent).toContain("When live editing stopped, dohc kept your unsent edits but can't finish writing them to your file. Save a recovery copy to get them back.");
      expect(actions("docs/a.md")).toEqual(["Save recovery copy"]);
      // A document live again reads as live; only its note describes the earlier Stop's edits.
      for (const path of ["docs/b.md", "docs/c.md"]) {
        const live = screen.getByTestId(`live-document-row-${path}`);
        expect(within(live).getByText("Live")).toBeTruthy();
        expect(live.textContent).not.toContain("Stopped");
      }
      expect(actions("docs/b.md")).toEqual(["Stop live editing", "Save recovery copy"]);
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

    it("disables a row's Save recovery copy while its save runs", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { status: "retired", quarantine: "not-written", objectId: "object-a" })]));
      const saving = deferred();
      h.saveRecoveryCopy.mockReturnValueOnce(saving.promise);
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const save = await screen.findByRole("button", { name: "Save recovery copy of docs/a.md" });
      await userEvent.setup().click(save);
      expect(h.saveRecoveryCopy).toHaveBeenCalledExactlyOnceWith("ws", "docs/a.md", undefined);
      expect(save).toHaveProperty("disabled", true);
      await act(async () => { saving.resolve(); await saving.promise; });
      expect(save).toHaveProperty("disabled", false);
    });

    // The server prepares the earlier copy of the workspace that holds the edits before the copy reads them.
    it("reads Preparing recovery copy on an earlier copy's row while its save runs", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { quarantine: "paused", earlier: true, storedOn: "server" })]));
      const saving = deferred();
      h.saveRecoveryCopy.mockReturnValueOnce(saving.promise);
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const save = await screen.findByRole("button", { name: "Save recovery copy of docs/a.md" });
      await userEvent.setup().click(save);
      expect(save.textContent).toBe("Preparing recovery copy…");
      expect(save).toHaveProperty("disabled", true);
      expect(save.getAttribute("aria-busy")).toBe("true");
      await act(async () => { saving.resolve(); await saving.promise; });
      expect(save.textContent).toBe("Save recovery copy");
      expect(save.getAttribute("aria-busy")).toBeNull();
    });

    it.each(["recovered", "kept"] as const)("reports a Stop that %s the refused edits only after it answers", async (keptEdits) => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { quarantine: "paused" })]));
      const stopping = deferred<LiveDocumentStopResult>();
      h.stop.mockReturnValueOnce(stopping.promise);
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      await userEvent.setup().click(await screen.findByRole("button", { name: "Stop live editing for docs/a.md" }));
      expect(h.onStopped).not.toHaveBeenCalled();
      await act(async () => {
        stopping.resolve({ keptEdits });
        await stopping.promise;
      });
      expect(h.onStopped).toHaveBeenCalledExactlyOnceWith("docs/a.md", keptEdits);
    });

    it("tells nothing for a Stop that had no refused edits, or that failed", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md"), row("docs/b.md", { quarantine: "paused" })]));
      h.stop.mockRejectedValueOnce(new Error("release failed"));
      const user = userEvent.setup();
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      await user.click(await screen.findByRole("button", { name: "Stop live editing for docs/b.md" }));
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
      await user.click(await screen.findByRole("button", { name: "Stop live editing for docs/a.md" }));
      await vi.waitFor(() => expect(h.stop).toHaveBeenCalledTimes(2));
      // The refused Stop keeps the list; the finished one reads it again.
      await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(2));
      expect(h.onStopped).not.toHaveBeenCalled();
    });

    it("keeps a Stop that could not write the edits truthful, and keeps Resume and the recovery copy", async () => {
      const h = harness();
      h.load.mockResolvedValue(page([row("docs/a.md", { status: "retired", canResume: true, quarantine: "stopped-kept",
        deferredStop: { unsentEdits: 2, editable: false } })]));
      render(<LiveDocumentsDialog workspaceId="ws" {...h} />);
      const kept = await screen.findByTestId("live-document-row-docs/a.md");
      expect(kept.textContent).toContain(
        "Live editing stopped. dohc kept your unsent edits, but could not write them to your file. Save a recovery copy to get them back.",
      );
      expect(kept.textContent).not.toContain("written");
      expect(kept.textContent).not.toContain("unsent edits remain");
      expect(actions("docs/a.md")).toEqual(["Resume live editing", "Save recovery copy"]);
    });
  });
});

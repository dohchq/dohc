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
  type LiveRefusalPage,
  type LiveRefusalRow,
} from "./LiveDocumentsDialog";

function row(path: string, overrides: Partial<LiveDocumentRow> = {}): LiveDocumentRow {
  return { path, status: "ready", canResume: false, ...overrides };
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
    stop: vi.fn((workspaceId: string, path: string) => Promise.resolve()),
    resume: vi.fn((workspaceId: string, path: string) => Promise.resolve()),
    loadRefusals: vi.fn((workspaceId: string, after?: string) =>
      Promise.resolve(refusalPage([])),
    ),
    retryRefusal: vi.fn((workspaceId: string, shareId: string) => Promise.resolve()),
    onClose: vi.fn(),
    onError: vi.fn((message: string, error: unknown, retry: () => boolean) => {}),
  };
}

function actions(path: string): string[] {
  return within(screen.getByTestId(`live-document-row-${path}`))
    .queryAllByRole("button")
    .map((button) => button.textContent);
}

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
          canResume: true,
        }),
        row("docs/elsewhere.md", {
          status: "unavailable",
          reason: "workspace-changed",
          canResume: true,
        }),
        row("docs/stopped.md", { status: "retired", canResume: true }),
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
      "Stopped",
      "Stopped",
    ]);

    expect(actions("docs/live.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/preparing.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/paused.md")).toEqual([
      "Resume live editing",
      "Stop live editing",
    ]);
    expect(actions("docs/paused-locked.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/moved.md")).toEqual(["Stop live editing"]);
    expect(actions("docs/elsewhere.md")).toEqual(["Stop live editing"]);
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

    expect(h.stop).toHaveBeenCalledWith("ws-1", "docs/a.md");
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
    const stopping = deferred();
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
      stopping.resolve();
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
    const stopping = deferred();
    h.stop.mockReturnValueOnce(stopping.promise);
    const user = userEvent.setup();
    const view = render(<LiveDocumentsDialog workspaceId="ws-a" {...h} />);

    await screen.findByTestId("live-document-row-docs/a.md");
    await user.click(screen.getByRole("button", { name: "Stop live editing for docs/a.md" }));
    view.rerender(<LiveDocumentsDialog workspaceId="ws-b" {...h} />);
    await act(async () => {
      stopping.resolve();
      await stopping.promise;
    });

    expect(h.stop).toHaveBeenCalledWith("ws-a", "docs/a.md");
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
        await screen.findByText("No refused shares on this page. Load more to keep looking."),
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
      await vi.waitFor(() => expect(screen.queryByTestId("live-refusals")).toBeNull());
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
});

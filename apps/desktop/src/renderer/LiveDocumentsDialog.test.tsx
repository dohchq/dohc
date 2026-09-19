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

function harness() {
  return {
    load: vi.fn((workspaceId: string, retiredAfter?: string) => Promise.resolve(page([]))),
    stop: vi.fn((workspaceId: string, path: string) => Promise.resolve()),
    resume: vi.fn((workspaceId: string, path: string) => Promise.resolve()),
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
});

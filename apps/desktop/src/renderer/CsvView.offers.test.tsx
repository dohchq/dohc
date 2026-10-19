// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { CsvView } from "./CsvView";
import { documentVersionKey } from "./documentVersionKey";
import { resetOrphanedDrafts } from "./orphanedDrafts";
import { acquireSharedLocalDocument, resetSharedLocalDocumentsForTests } from "./sharedLocalDocument";
import { errorDetails } from "./shell/copyDetails";
import { useShellError } from "./shell/useShellError";
import { NoticeCenter } from "./workbench/NoticeCenter";

type ImportResult = Awaited<ReturnType<DohcDesktopBridge["importToDatabase"]>>;
type UndoResult = Awaited<ReturnType<DohcDesktopBridge["undoDatabaseImport"]>>;
const importToDatabase = vi.fn<DohcDesktopBridge["importToDatabase"]>();
const undoDatabaseImport = vi.fn<DohcDesktopBridge["undoDatabaseImport"]>();
const releases: Array<() => void> = [];
const buffers: Array<ReturnType<typeof acquireSharedLocalDocument>["buffer"]> = [];
const noop = () => undefined;

const OVER_CAP = "name\n" + Array.from({ length: 501 }, (_, row) => `row ${row}`).join("\n");
const IMPORTED: ImportResult = { operationId: "dohc-operation:import-1", path: "data.sqlite", tableName: "data", rowCount: 501 };
const UNDONE: UndoResult = { trashed: true };
// What the renderer receives when main rejects: Electron prefixes the channel.
const rejected = (channel: string, text: string) =>
  new Error(`Error invoking remote method '${channel}': Error: ${text}`);

// A CSV as FileInspector hands it to its view: a workspace's own file.
function csvFile(path: string, body: string) {
  const { buffer, release } = acquireSharedLocalDocument(documentVersionKey("ws-1", path, undefined));
  releases.push(release);
  buffers.push(buffer);
  const contentReadTicket = buffer.beginRead();
  buffer.initializeRead(body, `${path}-hash`, contentReadTicket);
  return {
    workspaceId: "ws-1", path, body, contentHash: `${path}-hash`, contentReadTicket,
    contentRequestId: 1, latestContentRequestId: 1, switchReadPending: false, switchUnresyncedRef: { current: false },
    refreshAfterConflict: vi.fn(), localBuffer: buffer, csvSource: "workspace-file" as const,
  };
}

// The shell's notices, as it shows them: toasts and Notices rows, with a
// notice's action (Undo) and Try again.
function Shell(props: { workspaceId?: string; children: (shell: ReturnType<typeof useShellError>) => ReactNode }) {
  const workspaceId = props.workspaceId ?? "ws-1";
  const shell = useShellError(workspaceId);
  return (
    <>
      <NoticeCenter
        workspaceId={workspaceId} host="corner" syncStatus={null} agentActive={false} conflictSummaries={[]}
        onOpenHistory={noop} onOpenConflicts={noop} onRefreshShareView={noop} onOpenSettings={noop} onRebuildEngineStore={noop}
        workspaceErrors={shell.shellErrors.map((error) => ({
          id: error.id,
          ...(error.tone ? { tone: error.tone } : {}),
          message: error.message,
          details: errorDetails(error.details ?? []),
          atMs: error.atMs,
          canRetry: error.retry !== null,
          ...(error.action ? { actionLabel: error.action.label } : {}),
          seen: error.seen,
        }))}
        onRetryWorkspaceError={shell.retryShellError}
        onWorkspaceErrorAction={shell.runShellErrorAction}
        onHideWorkspaceError={shell.hideShellError}
        onDismissWorkspaceError={shell.dismissShellError}
      />
      {props.children(shell)}
    </>
  );
}

function renderCsv(overrides: Partial<ComponentProps<typeof CsvView>> = {}, body = OVER_CAP) {
  const calls: string[] = [];
  const onOpenPath = vi.fn((path: string) => calls.push(`open ${path}`));
  const onClosePath = vi.fn((path: string) => calls.push(`close ${path}`));
  undoDatabaseImport.mockImplementation(async (input) => {
    calls.push(`undo ${input.operationId}`);
    return UNDONE;
  });
  render(
    <Shell>
      {(shell) => (
        <CsvView
          {...csvFile("data.csv", body)}
          onOpenPath={onOpenPath}
          onClosePath={onClosePath}
          onError={shell.reportButtonError}
          onNotice={shell.showSuccessNotice}
          {...overrides}
        />
      )}
    </Shell>,
  );
  return { calls, onOpenPath, onClosePath };
}

const boundImport = () => screen.queryByTestId("csv-bound-import");

describe("the CSV offer on the preview's bound", () => {
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", {
      platform: "win32",
      importToDatabase,
      undoDatabaseImport,
      writeWorkspaceText: vi.fn(async () => ({ status: "written", contentHash: "hash-2" })),
      onEngineYDocSaveState: () => () => {},
      getUpdateState: () => new Promise(() => {}),
      onUpdateState: () => () => {},
    });
  });

  afterEach(async () => {
    await act(async () => {
      cleanup();
      await Promise.all(buffers.splice(0).map((buffer) => buffer.settled()));
    });
    for (const release of releases.splice(0)) release();
    resetSharedLocalDocumentsForTests();
    resetOrphanedDrafts();
    vi.unstubAllGlobals();
    importToDatabase.mockReset();
    undoDatabaseImport.mockReset();
  });

  it("offers Import to SQLite on a workspace CSV past the cap, beside the count", () => {
    renderCsv();
    const bound = screen.getByTestId("csv-preview-bound");
    expect(bound.textContent).toBe("Showing the first 500 of 501 rows.Import to SQLite");
    expect(within(bound).getByRole("button", { name: "Import to SQLite" })).toBe(boundImport());
    // The tab row keeps its own Import.
    expect(screen.getByTestId("csv-import-sqlite")).toBeTruthy();
  });

  it.each([
    ["a received share's CSV", { csvSource: "received-share" as const }],
    ["a CSV of unknown source", { csvSource: undefined }],
    ["a CSV the read cut short", { truncated: true }],
    ["a view that cannot open the database", { onOpenPath: undefined }],
  ])("offers nothing on %s, and the bound names the way to the rest", (_, overrides) => {
    renderCsv(overrides);
    expect(boundImport()).toBeNull();
    expect(screen.getByTestId("csv-preview-bound").textContent).toContain("import to SQLite to work with all of them.");
  });

  it("has no bound, and no offer, at the cap", () => {
    renderCsv({}, "name\n" + Array.from({ length: 500 }, (_, row) => `row ${row}`).join("\n"));
    expect(screen.queryByTestId("csv-preview-bound")).toBeNull();
    expect(boundImport()).toBeNull();
  });

  it("runs the tab row's import: busy in both places, focus kept, one import, then the database opens", async () => {
    const user = userEvent.setup();
    const answer = deferred<ImportResult>();
    importToDatabase.mockReturnValue(answer.promise);
    const { onOpenPath } = renderCsv();

    const button = boundImport()!;
    const header = screen.getByTestId("csv-import-sqlite");
    await user.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(header.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Import to SQLite");
    expect(within(header.parentElement!).getByRole("status").textContent).toBe("Importing to SQLite…");
    await user.click(button);
    await user.click(header);
    expect(importToDatabase).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1", sourceRelativePath: "data.csv", databaseRelativePath: "data.sqlite", tableName: "data",
    });

    await act(async () => answer.resolve(IMPORTED));
    expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data.sqlite");
    expect(boundImport()!.hasAttribute("aria-busy")).toBe(false);
  });

  it("says what the import made, with Undo, which closes the database's tabs before main removes it", async () => {
    const user = userEvent.setup();
    importToDatabase.mockResolvedValue(IMPORTED);
    const { calls } = renderCsv();

    await user.click(boundImport()!);
    const toast = await screen.findByTestId("workspace-shell-notice");
    expect(within(toast).getByText("Imported 501 rows to data.sqlite.")).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(undoDatabaseImport).toHaveBeenCalledOnce());
    expect(undoDatabaseImport).toHaveBeenCalledWith({ workspaceId: "ws-1", operationId: "dohc-operation:import-1" });
    expect(calls).toEqual(["open data.sqlite", "close data.sqlite", "undo dohc-operation:import-1"]);
    // The Undo's row goes, so it runs once.
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    expect(within(screen.getByRole("dialog", { name: "Notices" })).queryByText(/Imported 501 rows/)).toBeNull();
  });

  it("files a refused Undo's reason once, with Try again, which closes the tabs and asks again", async () => {
    const user = userEvent.setup();
    importToDatabase.mockResolvedValue(IMPORTED);
    const { calls } = renderCsv();
    undoDatabaseImport.mockRejectedValueOnce(rejected(
      "desktop:undo-database-import",
      "Cannot undo this import. data.sqlite-wal exists. Close programs using the database, then try again.",
    ));

    await user.click(boundImport()!);
    await user.click(within(await screen.findByTestId("workspace-shell-notice")).getByRole("button", { name: "Undo" }));
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(
      "Cannot undo this import. data.sqlite-wal exists. Close programs using the database, then try again.",
    )).toBeTruthy();

    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByRole("dialog", { name: "Notices" });
    expect(within(notices).getAllByText(/data\.sqlite-wal exists/)).toHaveLength(1);
    await user.click(within(notices).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(undoDatabaseImport).toHaveBeenCalledTimes(2));
    expect(calls).toEqual(["open data.sqlite", "close data.sqlite", "close data.sqlite", "undo dohc-operation:import-1"]);
    expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  });

  it("files a failed import from the bound as the tab row does, and its Try again ends in the same notice", async () => {
    const user = userEvent.setup();
    importToDatabase.mockRejectedValueOnce(rejected("desktop:import-to-database", "Database already exists: data.sqlite"));
    importToDatabase.mockResolvedValueOnce(IMPORTED);
    const { onOpenPath } = renderCsv();

    await user.click(boundImport()!);
    const toast = await screen.findByTestId("workspace-shell-error");
    expect(within(toast).getByText(
      "dohc could not import this file to data.sqlite. That file already exists. Rename or move it, then try again.",
    )).toBeTruthy();
    await user.click(within(toast).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledExactlyOnceWith("data.sqlite"));
    expect(within(await screen.findByTestId("workspace-shell-notice")).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  // Why main's refusal after a switch offers no retry: the shell remounts for
  // each workspace (DesktopRoot keys it), and its Notices go with it.
  it("loses the import's Undo row when the window switches workspaces", async () => {
    const user = userEvent.setup();
    importToDatabase.mockResolvedValue(IMPORTED);
    const file = csvFile("data.csv", OVER_CAP);
    const shell = (workspaceId: string) => (
      <Shell key={workspaceId} workspaceId={workspaceId}>
        {(hooks) => workspaceId === "ws-1" ? (
          <CsvView {...file} onOpenPath={vi.fn()} onClosePath={vi.fn()} onError={hooks.reportButtonError} onNotice={hooks.showSuccessNotice} />
        ) : null}
      </Shell>
    );
    const view = render(shell("ws-1"));
    await user.click(boundImport()!);
    expect(within(await screen.findByTestId("workspace-shell-notice")).getByRole("button", { name: "Undo" })).toBeTruthy();

    view.rerender(shell("ws-2"));
    expect(screen.queryByTestId("workspace-shell-notice")).toBeNull();
    await user.click(screen.getByTestId("notice-center-toggle"));
    const notices = screen.getByRole("dialog", { name: "Notices" });
    expect(within(notices).queryByText(/Imported 501 rows/)).toBeNull();
    expect(within(notices).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(undoDatabaseImport).not.toHaveBeenCalled();
  });
});

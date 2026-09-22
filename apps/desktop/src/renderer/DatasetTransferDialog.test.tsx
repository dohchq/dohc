// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import type { DatasetCsvTransferDialogProps } from "./DatasetCsvTransferDialog";
import { DatasetTransferDialog } from "./DatasetTransferDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const baseProps: DatasetCsvTransferDialogProps = {
  workspaceId: "workspace-a", tableId: id(2), dataset: {
    datasetId: id(1), name: "People", revision: 1, revisionSha256: "a".repeat(64), tables: [{ tableId: id(2), name: "People", fields: [{ fieldId: id(3), name: "Name", type: "text", required: true, unique: false }] }],
    operations: [{ operationId: id(4), name: "create", label: "Create person", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(3)] }],
  }, invoke: vi.fn(async () => ({ result: null })), onSave: vi.fn(async () => undefined), onClose: vi.fn(), onError: vi.fn(),
};

describe("DatasetTransferDialog", () => {
  afterEach(() => { cleanup(); delete window.dohcDesktop; vi.clearAllMocks(); });

  it("copies a selected SQLite table only after preview and approved create", async () => {
    window.dohcDesktop = {
      listCollections: vi.fn(async () => ({ collections: [] })),
      listWorkspaceFiles: vi.fn(async () => ({ files: [{ kind: "database", path: "contacts.sqlite" }] })),
      readWorkspaceDatabase: vi.fn(async () => ({ path: "contacts.sqlite", tables: [{ name: "people", columns: [{ name: "Name", type: "text" }], rows: [{ Name: "Ada" }], nextOffset: 1 }] })),
      readWorkspaceDatabasePage: vi.fn(async () => ({ path: "contacts.sqlite", table: "people", offset: 1, rows: [{ Name: "Grace" }], nextOffset: null })),
    } as unknown as DohcDesktopBridge;
    render(<DatasetTransferDialog {...baseProps} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "CSV or saved import report" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(screen.getByLabelText("Copy from this workspace"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose table" }));
    await screen.findByLabelText("SQLite table");
    fireEvent.click(screen.getByRole("button", { name: "Preview table" }));
    await screen.findByText("2 rows · 0 rows with input errors");
    expect(baseProps.invoke).not.toHaveBeenCalled();
    expect(window.dohcDesktop.readWorkspaceDatabasePage).toHaveBeenCalledWith({ workspaceId: "workspace-a", relativePath: "contacts.sqlite", table: "people", offset: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Save retry report and import" }));
    await waitFor(() => expect(baseProps.invoke).toHaveBeenCalledTimes(2));
    expect(baseProps.onSave).toHaveBeenCalledOnce();
    expect(baseProps.invoke).toHaveBeenNthCalledWith(1, expect.objectContaining({ operationId: id(4), input: { values: { [id(3)]: "Ada" } } }), expect.any(AbortSignal));
  });

  it("does not repaint a new workspace with a delayed source list", async () => {
    let finish!: (result: { collections: Array<{ path: string; status: "valid"; reasons: [] }> }) => void;
    const slow = new Promise<{ collections: Array<{ path: string; status: "valid"; reasons: [] }> }>(resolve => { finish = resolve; });
    window.dohcDesktop = {
      listCollections: vi.fn(({ workspaceId }: { workspaceId: string }) => workspaceId === "workspace-a" ? slow : Promise.resolve({ collections: [] })),
      listWorkspaceFiles: vi.fn(async () => ({ files: [] })),
    } as unknown as DohcDesktopBridge;
    const view = render(<DatasetTransferDialog {...baseProps} />);
    view.rerender(<DatasetTransferDialog {...baseProps} workspaceId="workspace-b" />);
    await screen.findByText("No document Collections or SQLite files. Add one to this workspace, or choose CSV.");
    await act(async () => { finish({ collections: [{ path: "private-a", status: "valid", reasons: [] }] }); await slow; });
    expect(screen.queryByRole("option", { name: /private-a/ })).toBeNull();
    expect(baseProps.onError).not.toHaveBeenCalled();
  });
});

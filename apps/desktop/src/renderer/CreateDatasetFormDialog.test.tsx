// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { deferred } from "../testing/deferred";
import { CreateDatasetFormDialog, type CreateDatasetFormDialogProps } from "./CreateDatasetFormDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function dataset(): DatasetDescription { return { datasetId: id(1), name: "Fundraiser", revision: 3, revisionSha256: "a".repeat(64), tables: [{ tableId: id(2), name: "Registrations", fields: [
  { fieldId: id(3), name: "Record ID", type: "text", required: true, unique: true }, { fieldId: id(4), name: "Name", type: "text", required: true, unique: false },
  { fieldId: id(5), name: "Note", type: "text", required: false, unique: false }, { fieldId: id(6), name: "Receipt", type: "attachment", required: false, unique: false },
] }], operations: [{ operationId: id(7), name: "records.create", label: "Create", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4), id(5), id(6)] }] }; }
function setup(overrides: Partial<CreateDatasetFormDialogProps> = {}) {
  const onCreate = vi.fn<CreateDatasetFormDialogProps["onCreate"]>(async () => undefined), onError = vi.fn<CreateDatasetFormDialogProps["onError"]>();
  const props = { workspaceId: "workspace-a", dataset: dataset(), tableId: id(2), onClose: vi.fn(), onCreate, onError, ...overrides };
  return { onCreate, onError, props, ...render(<CreateDatasetFormDialog {...props} />) };
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create form" }));
afterEach(cleanup);
describe("CreateDatasetFormDialog", () => {
  it("locks required approved fields and sends the source destination and presentation subset", async () => {
    const { onCreate } = setup();
    expect((screen.getByLabelText("Name") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Record ID")).toBeNull();
    expect(screen.getByText("Fields not shown remain accepted by the approved create action.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Note")); fireEvent.change(screen.getByLabelText("App folder"), { target: { value: "apps/fundraiser-form" } }); submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ datasetId: id(1), revision: 3, tableId: id(2), createOperationId: id(7), appRoot: "apps/fundraiser-form", fieldIds: [id(4), id(6)] });
  });
  it.each(["../outside", "apps/../outside", "apps//form", ".dohc/form", "apps\\form", "/form"])("refuses unsafe destination %s", async root => {
    const { onCreate } = setup(); fireEvent.change(screen.getByLabelText("App folder"), { target: { value: root } }); submit();
    expect(screen.getByRole("alert").textContent).toContain("workspace folder"); expect(onCreate).not.toHaveBeenCalled();
  });
  it("refuses an empty field selection", () => {
    const description = dataset(); description.tables[0]!.fields[1]!.required = false;
    const { onCreate } = setup({ dataset: description });
    for (const label of ["Name", "Note", "Receipt"]) fireEvent.click(screen.getByLabelText(label)); submit();
    expect(screen.getByRole("alert").textContent).toContain("1 to 24"); expect(onCreate).not.toHaveBeenCalled();
  });
  it("resets fields when choosing another approved public create action", async () => {
    const description = dataset(); description.operations.push({ ...description.operations[0]!, operationId: id(8), label: "Quick note", fieldIds: [id(5)] });
    const { onCreate } = setup({ dataset: description }); fireEvent.change(screen.getByLabelText("Create action"), { target: { value: id(8) } });
    expect(screen.queryByLabelText("Name")).toBeNull(); submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce()); expect(onCreate.mock.calls[0]![0]).toMatchObject({ createOperationId: id(8), fieldIds: [id(5)] });
  });
  it("refuses more than one file and required related-record fields", () => {
    const description = dataset(); description.tables[0]!.fields[2]!.type = "attachment";
    const result = setup({ dataset: description }); submit(); expect(screen.getByRole("alert").textContent).toContain("1 file field");
    const related = dataset(); related.tables[0]!.fields[1]!.type = "relation";
    result.rerender(<CreateDatasetFormDialog {...result.props} dataset={related} />); submit(); expect(screen.getByRole("alert").textContent).toContain("related records"); expect(result.onCreate).not.toHaveBeenCalled();
  });
  it("reports failures through Notices and retries the captured request", async () => {
    const failure = new Error("Source folder exists.");
    const onCreate = vi.fn<CreateDatasetFormDialogProps["onCreate"]>().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const { onError } = setup({ onCreate }); submit();
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]!.slice(0, 2)).toEqual(["dohc could not create this form.", failure]); expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Form title"), { target: { value: "Changed draft" } });
    await act(async () => onError.mock.calls[0]![2]!());
    expect(onCreate.mock.calls[1]![0]).toEqual(onCreate.mock.calls[0]![0]);
  });
  it("aborts stale work and drops its error after workspace changes", async () => {
    const pending = deferred<void>(); const onCreate = vi.fn<CreateDatasetFormDialogProps["onCreate"]>(() => pending.promise);
    const { props, rerender, onError } = setup({ onCreate }); submit();
    rerender(<CreateDatasetFormDialog {...props} workspaceId="workspace-b" />);
    expect(onCreate.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => pending.reject(new Error("Old failure"))); expect(onError).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Create form" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

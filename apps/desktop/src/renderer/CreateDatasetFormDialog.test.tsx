// @vitest-environment jsdom
import { CreationPartialError } from "@dohc/cli/creation";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { datasetColumnFields, type DatasetDescription } from "@dohc/security-contract/dataset";
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
  it("previews the selected field order, types, and defaults without accepting responses", () => {
    const description = dataset();
    description.tables[0]!.fields[2] = { ...datasetColumnFields(description.tables[0]!)[2]!, type: "select", options: ["New", "Reviewed"], default: "New" };
    setup({ dataset: description });
    const preview = within(screen.getByRole("region", { name: "Form preview" }));
    fireEvent.change(screen.getByLabelText("Form title"), { target: { value: "Pickleball registration" } });
    expect(preview.getByRole("heading").textContent).toBe("Pickleball registration");
    const select = preview.getByLabelText("Preview Note") as HTMLSelectElement;
    expect(select.value).toBe("New");
    expect(select.disabled).toBe(true);
    expect(preview.getByText("Choose file")).toBeTruthy();
    expect(preview.queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByLabelText("Note"));
    expect(preview.queryByLabelText("Preview Note")).toBeNull();
    fireEvent.click(screen.getByLabelText("Note"));
    const region = screen.getByRole("region", { name: "Form preview" });
    expect(region.textContent!.indexOf("Receipt")).toBeLessThan(region.textContent!.indexOf("Note"));
  });

  it("opens the source folder when its hidden value needs correction", () => {
    setup();
    const folder = screen.getByLabelText("App folder");
    const disclosure = folder.closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.change(folder, { target: { value: "../outside" } });
    submit();
    expect(disclosure.open).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("workspace folder");
  });

  it("locks required approved fields and sends the source destination and presentation subset", async () => {
    const { onCreate } = setup();
    expect((screen.getByLabelText("Name") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Record ID")).toBeNull();
    expect(screen.getByText("This form can submit only these fields.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Note")); fireEvent.change(screen.getByLabelText("App folder"), { target: { value: "apps/fundraiser-form" } }); submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ datasetId: id(1), revision: 3, tableId: id(2), createOperationId: id(7), appRoot: "apps/fundraiser-form", fieldIds: [id(4), id(6)] });
  });
  it.each(["../outside", "apps/../outside", "apps//form", ".dohc/form", "apps\\form", "/form"])("refuses unsafe destination %s", async root => {
    const { onCreate } = setup(); fireEvent.change(screen.getByLabelText("App folder"), { target: { value: root } }); submit();
    expect(screen.getByRole("alert").textContent).toContain("workspace folder"); expect(onCreate).not.toHaveBeenCalled();
  });
  it("refuses an empty field selection", () => {
    const description = dataset(); datasetColumnFields(description.tables[0]!)[1]!.required = false;
    const { onCreate } = setup({ dataset: description });
    for (const label of ["Name", "Note", "Receipt"]) fireEvent.click(screen.getByLabelText(label)); submit();
    expect(screen.getByRole("alert").textContent).toContain("1 to 128"); expect(onCreate).not.toHaveBeenCalled();
  });
  it("resets fields when choosing another approved public create action", async () => {
    const description = dataset(); description.operations.push({ ...description.operations[0]!, operationId: id(8), label: "Quick note", fieldIds: [id(5)] });
    const { onCreate } = setup({ dataset: description }); fireEvent.change(screen.getByLabelText("Create action"), { target: { value: id(8) } });
    expect(screen.queryByLabelText("Name")).toBeNull(); submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce()); expect(onCreate.mock.calls[0]![0]).toMatchObject({ createOperationId: id(8), fieldIds: [id(5)] });
  });
  it("accepts multiple file fields and refuses relations without explicit public choices", async () => {
    const description = dataset(); description.tables[0]!.fields[2]!.type = "attachment";
    const result = setup({ dataset: description }); submit(); await waitFor(() => expect(result.onCreate).toHaveBeenCalledOnce());
    const related = dataset(); related.tables[0]!.fields[1]!.type = "relation";
    result.rerender(<CreateDatasetFormDialog {...result.props} dataset={related} />); submit(); expect(screen.getByRole("alert").textContent).toContain("related-record"); expect(result.onCreate).toHaveBeenCalledOnce();
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
  it("requires explicit public choice selection, discloses the complete action, and exposes source review", async () => {
    const description = dataset();
    description.tables[0]!.fields[2] = { ...datasetColumnFields(description.tables[0]!)[2]!, type: "relation", relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } };
    description.operations.push({ operationId: id(8), name: "choices", label: "Read choices", tableId: id(2), kind: "read", access: "link", readOnly: true, fieldIds: [id(3), id(4)] });
    description.operations.push({ operationId: id(9), name: "private", label: "Private read", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] });
    const onLoadSource = vi.fn(async () => ({ path: "approved/actions.js", source: "globalThis.operations = {};", sha256: "b".repeat(64) }));
    const { onCreate } = setup({ dataset: description, onLoadSource });
    fireEvent.click(screen.getByLabelText("Note")); submit();
    expect(onCreate).not.toHaveBeenCalled(); expect(screen.getByRole("alert").textContent).toContain("public read");
    expect(screen.queryByRole("option", { name: /Private read/ })).toBeNull();
    expect(screen.getByText(/complete output/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review action source" }));
    await waitFor(() => expect(screen.getByText("globalThis.operations = {};")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Public choices for Note"), { target: { value: `${id(8)}:${id(4)}` } }); submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]![0].relationChoices).toEqual([{ fieldId: id(5), operationId: id(8), labelFieldId: id(4) }]);
  });
  it("offers reviewed public-choice creation and preserves the selected label in retries", async () => {
    const description = dataset();
    description.tables[0]!.fields[2] = { ...datasetColumnFields(description.tables[0]!)[2]!, type: "relation", relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } };
    const onPrepareChoices = vi.fn<NonNullable<CreateDatasetFormDialogProps["onPrepareChoices"]>>().mockRejectedValue(new Error("Host unavailable"));
    const { onError } = setup({ dataset: description, onPrepareChoices });
    fireEvent.click(screen.getByLabelText("Note"));
    expect(screen.getByText(/every related record/)).toBeTruthy();
    expect(screen.getByText(/Existing apps need review/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Public label for Note"), { target: { value: id(4) } });
    fireEvent.click(screen.getByRole("button", { name: "Review public choices" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onPrepareChoices.mock.calls[0]![0]).toEqual({ fieldId: id(5), labelFieldId: id(4) });
    fireEvent.change(screen.getByLabelText("Public label for Note"), { target: { value: id(3) } });
    await act(async () => onError.mock.calls[0]![2]!());
    expect(onPrepareChoices.mock.calls[1]![0]).toEqual(onPrepareChoices.mock.calls[0]![0]);
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

it("sends partial facts to Notices and retries the same form", async () => {
  const partial = { kind: "partial" as const, created: ["forms/frontend.js"], failedStage: "capture" as const, reason: "capture unavailable",
    retry: { mode: "resume" as const, instruction: "Try again with the same settings." } };
  const failure = new CreationPartialError(partial);
  const onCreate = vi.fn<CreateDatasetFormDialogProps["onCreate"]>().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const { onError } = setup({ onCreate });
  submit();
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(onError.mock.calls[0]![1]).toBe(failure);
  expect(failure.message).toContain("Created: forms/frontend.js");
  expect(failure.message).toContain("could not capture");
  await act(async () => onError.mock.calls[0]![2]!());
  expect(onCreate.mock.calls[1]![0]).toEqual(onCreate.mock.calls[0]![0]);
});

it.each(["会议", "Команда", "हिन्दी"])("creates a form folder from %s", async name => {
  const description = dataset(); description.name = name;
  const { onCreate } = setup({ dataset: description });
  expect((screen.getByLabelText("App folder") as HTMLInputElement).value).toBe(name.toLowerCase() + "-form");
  submit();
  await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
  expect(onCreate.mock.calls[0]![0].appRoot).toBe(name.toLowerCase() + "-form");
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { datasetColumnFields, type DatasetDescription, type DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetMigrationPreparation } from "@dohc/cli/dataset";
import { CollectionFieldsDialog, type CollectionFieldsDialogProps } from "./CollectionFieldsDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset: DatasetDescription = { datasetId: id(1), name: "People", revision: 1, revisionSha256: "a".repeat(64), operations: [],
  tables: [{ tableId: id(2), name: "People", fields: [{ fieldId: id(3), name: "Name", type: "text", required: false, unique: false }] }] };
function preparation(): DatasetMigrationPreparation {
  const revision: DatasetRevision = { datasetId: id(1), revision: 1, revisionSha256: dataset.revisionSha256, definitionSha256: "b".repeat(64), schemaSha256: "c".repeat(64), operationsSha256: "d".repeat(64),
    definition: { formatVersion: 1, datasetId: id(1), name: "People", schemaPath: "people/schema.sql", operationsPath: "people/operations.js", operations: [{operationId:id(12),name:"read",label:"Read",tableId:id(2),kind:"read",access:"owner",readOnly:true,fieldIds:[id(3)]}],
      tables: [{ ...dataset.tables[0]!, sqlName: "people", primaryKey: "name", fields: [{ ...datasetColumnFields(dataset.tables[0]!)[0]!, sqlColumn: "name",unique:true,required:true }] }] } };
  const next = structuredClone(revision); next.revision = 2; next.revisionSha256 = "e".repeat(64);
  next.definition.tables[0]!.fields.push({ fieldId: id(4), name: "Note", type: "text", required: false, unique: false, sqlColumn: "note" });
  const expected = { workspaceId: "w", datasetId: id(1), hostEpoch: "epoch", revision: 4, digest: "f".repeat(64), approvedRevisionHash: dataset.revisionSha256 };
  return { preparationId: id(9), previousRevision: revision, revision: next, expected,
    sourceDigest: "a".repeat(64), approvalDigest: "b".repeat(64), schemaSql: "schema", operationSource: "source", migrationSql: "ALTER TABLE people ADD note TEXT;", expiresAtMs: Date.now() + 600_000,
    candidate: {candidateId: id(10), expected, approvedRevisionHash: next.revisionSha256, checkpointSha256: "a".repeat(64), expiresAtMs: Date.now() + 600_000,
      preview: {tables: [{table: "people", beforeRows: 0, afterRows: 0, changedRows: 0}], firstPage: {changes: [], nextCursor: null}}} };
}
function setup(overrides: Partial<CollectionFieldsDialogProps> = {}) {
  const props: CollectionFieldsDialogProps = { workspaceId: "w", dataset, tableId: id(2), onPrepare: vi.fn(async () => preparation()), onApprove: vi.fn(async () => {}),
    onDiscard: vi.fn(async () => {}), onLoadPreview: vi.fn(async () => ({changes: [], nextCursor: null})), onClose: vi.fn(), onError: vi.fn(), onReviewSource: vi.fn(), ...overrides };
  return { props, ...render(<CollectionFieldsDialog {...props} />) };
}
afterEach(cleanup);

it("adds a field without source paths and approves only the captured revision", async () => {
  const { props } = setup();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Note" } });
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await screen.findByText("People · Note");
  expect(props.onPrepare).toHaveBeenCalledWith({ kind: "addField", tableId: id(2), field: { name: "Note", type: "text", required: false, unique: false } }, expect.any(AbortSignal));
  expect(screen.queryByLabelText("Collection definition")).toBeNull();
  expect(screen.getByText(/Approval applies this exact result/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this change/ }));
  fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
  await waitFor(() => expect(props.onApprove).toHaveBeenCalledWith({ workspaceId: "w", preparationId: id(9), revisionSha256: "e".repeat(64), approvalDigest: "b".repeat(64) }, expect.any(AbortSignal)));
});

it("renames using the existing field ID and offers source review", async () => {
  const { props } = setup();
  fireEvent.change(screen.getByLabelText("Change"), { target: { value: "renameField" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Full name" } });
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await waitFor(() => expect(props.onPrepare).toHaveBeenCalledWith({ kind: "renameField", tableId: id(2), fieldId: id(3), name: "Full name" }, expect.any(AbortSignal)));
  cleanup(); const next = setup(); fireEvent.click(screen.getByRole("button", { name: "Review source change" })); expect(next.props.onReviewSource).toHaveBeenCalledOnce();
});

it("validates required defaults before capture and keeps retry on Notices", async () => {
  const onPrepare = vi.fn().mockRejectedValueOnce(new Error("Custom actions")).mockResolvedValue(preparation());
  const { props } = setup({ onPrepare });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Note" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Required" }));
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  expect(screen.getByRole("alert").textContent).toContain("needs a default"); expect(onPrepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Required" }));
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).toBeNull();
  const retry = vi.mocked(props.onError).mock.calls[0]![2]!;
  await act(async () => retry());
  await screen.findByText("People · Note");
});

it("discards stale review responses after workspace switching", async () => {
  let resolve!: (value: DatasetMigrationPreparation) => void;
  const onPrepare = vi.fn<CollectionFieldsDialogProps["onPrepare"]>(() => new Promise(res => { resolve = res; }));
  const { props, rerender } = setup({ onPrepare });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Note" } }); fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  rerender(<CollectionFieldsDialog {...props} workspaceId="other" />);
  await act(async () => resolve(preparation()));
  expect(onPrepare.mock.calls[0]![1].aborted).toBe(true);
  expect(screen.queryByText("People · Note")).toBeNull();
  expect(props.onError).not.toHaveBeenCalled();
});

it("reviews a type and required change using the stable field identity", async () => {
  const {props}=setup();
  fireEvent.change(screen.getByLabelText("Change"),{target:{value:"changeField"}});
  expect(screen.queryByLabelText("Name")).toBeNull();
  expect(screen.getByLabelText("Type")).toHaveProperty("value","text");
  fireEvent.change(screen.getByLabelText("Type"),{target:{value:"number"}});
  fireEvent.click(screen.getByRole("checkbox",{name:"Required"}));
  fireEvent.click(screen.getByRole("button",{name:"Review change"}));
  await waitFor(()=>expect(props.onPrepare).toHaveBeenCalledWith({kind:"changeField",tableId:id(2),fieldId:id(3),type:"number",required:true},expect.any(AbortSignal)));
});

it("keeps a label-only review short and does not demand a destructive-change confirmation", async () => {
  const review=preparation();
  review.revision.definition=structuredClone(review.previousRevision.definition);
  review.revision.definition.tables[0]!.fields[0]!.name="Full name";
  const {props}=setup({onPrepare:vi.fn(async()=>review)});
  fireEvent.change(screen.getByLabelText("Change"),{target:{value:"renameField"}});
  fireEvent.change(screen.getByLabelText("Name"),{target:{value:"Full name"}});
  fireEvent.click(screen.getByRole("button",{name:"Review change"}));
  await screen.findByText("People · Full name");
  expect(screen.queryByRole("checkbox",{name:/reviewed this change/})).toBeNull();
  expect(screen.queryByText("Show migration SQL")).toBeNull();
  expect(screen.getByText(/Existing shared apps keep working/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Approve change"}));
  await waitFor(()=>expect(props.onApprove).toHaveBeenCalledOnce());
});

it("adds an action as a button, and after approval opens what runs it; a button nothing uses offers Choose what it does", async () => {
  const withAction: DatasetDescription = { ...dataset,
    operations: [{ operationId: id(13), name: "people.welcome", label: "Welcome", tableId: id(2), kind: "action", access: "owner", readOnly: false, fieldIds: [] }],
    tables: [{ ...dataset.tables[0]!, fields: [...dataset.tables[0]!.fields, { fieldId: id(14), name: "Archive", type: "button" }] }] };
  const onButtonAdded = vi.fn(), onChooseButton = vi.fn();
  const { props } = setup({ dataset: withAction, onButtonAdded, onChooseButton, buttonStates: new Map([["Archive", { kind: "no-automation", reason: "No automation uses this button." }]]) });
  fireEvent.click(screen.getByRole("button", { name: "Choose what it does: Archive" }));
  expect(onChooseButton).toHaveBeenCalledWith("Archive");
  fireEvent.click(screen.getByRole("button", { name: "Add as button: Welcome" }));
  await waitFor(() => expect(props.onPrepare).toHaveBeenCalledWith({ kind: "addButton", tableId: id(2), name: "Welcome" }, expect.any(AbortSignal)));
  fireEvent.click(await screen.findByRole("checkbox", { name: /I reviewed this change/ }));
  fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
  await waitFor(() => expect(onButtonAdded).toHaveBeenCalledWith("Welcome"));
  expect(props.onApprove).toHaveBeenCalledOnce();
});

it("offers no button for an action a field is already named for", () => {
  const named: DatasetDescription = { ...dataset,
    operations: [{ operationId: id(13), name: "people.welcome", label: "Name", tableId: id(2), kind: "action", access: "owner", readOnly: false, fieldIds: [] }] };
  setup({ dataset: named, onButtonAdded: vi.fn() });
  expect(screen.queryByRole("button", { name: /^Add as button/ })).toBeNull();
});

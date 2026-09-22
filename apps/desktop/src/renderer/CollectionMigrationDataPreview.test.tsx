// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { deferred } from "../testing/deferred";
import { CollectionMigrationDataPreview, type MigrationDataPreviewProps, type MigrationPreviewPage } from "./CollectionMigrationDataPreview";

afterEach(cleanup);
const revision = { definition: { tables: [{ sqlName: "people", name: "Registrations", fields: [{ sqlColumn: "name", name: "Name" }, { sqlColumn: "id", name: "Registration" }] }] } } as DatasetRevision;
function fixture(): MigrationDataPreviewProps {
  return { workspaceId: "workspace-a", preparationId: "review-a", previousRevision: revision, revision,
    preview: { tables: [{table: "people", beforeRows: 2, afterRows: 2, changedRows: 2}], firstPage: { changes: [{ table: "people", kind: "update", key: { id: "first" }, before: {name: "Before", amount: {type: "integer", value: "9007199254740993"}}, after: {name: "After", amount: null} }], nextCursor: "next" } },
    onLoad: vi.fn<MigrationDataPreviewProps["onLoad"]>(async () => ({ changes: [{ table: "people", kind: "delete", key: {id: "last"}, before: {name: "Removed"}, after: null }], nextCursor: null })), onError: vi.fn() };
}
it("shows exact changed values and loads bounded pages on request", async () => {
  const props = fixture(); render(<CollectionMigrationDataPreview {...props} />);
  expect(screen.getByText('"Before"')).toBeTruthy(); expect(screen.getByText('"After"')).toBeTruthy();
  expect(screen.getByText("9007199254740993")).toBeTruthy(); expect(screen.getByText("Empty")).toBeTruthy();
  expect(props.onLoad).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "More changes"})); await screen.findByText('"Removed"');
  expect(props.onLoad).toHaveBeenCalledWith({workspaceId: "workspace-a", preparationId: "review-a", after: "next", limit: 50}, expect.any(AbortSignal));
  expect(screen.getByText("Field absent")).toBeTruthy(); expect(screen.queryByText('"Before"')).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Previous changes"})); await screen.findByText('"Before"');
  expect(props.onLoad).toHaveBeenCalledTimes(1);
});
it("keeps binary values inspectable without rounding or replacing them", () => {
  const props = fixture(); props.preview.firstPage.changes[0]!.after = {name: "", data: {type: "blob", base64: "AAEC/w=="}};
  render(<CollectionMigrationDataPreview {...props} />);
  expect(screen.getByText('""')).toBeTruthy(); expect(screen.getByText("AAEC/w==")).toBeTruthy(); expect(screen.getByText("Binary value")).toBeTruthy();
});
it("rejects a cursor loop and reports through the shell without discarding the current page", async () => {
  const props = fixture(); props.onLoad = vi.fn(async () => ({changes: props.preview.firstPage.changes, nextCursor: "next"}));
  render(<CollectionMigrationDataPreview {...props} />); fireEvent.click(screen.getByRole("button", {name: "More changes"}));
  await waitFor(() => expect(props.onError).toHaveBeenCalledOnce()); expect(screen.getByText('"Before"')).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
it("ignores a late page when another Collection review opens", async () => {
  const props = fixture(), pending = deferred<MigrationPreviewPage>(); props.onLoad = vi.fn(() => pending.promise);
  const view = render(<CollectionMigrationDataPreview {...props} />); fireEvent.click(screen.getByRole("button", {name: "More changes"}));
  const onLoad = props.onLoad as ReturnType<typeof vi.fn<MigrationDataPreviewProps["onLoad"]>>;
  view.rerender(<CollectionMigrationDataPreview {...props} workspaceId="workspace-b" preparationId="review-b" />);
  expect(onLoad.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => pending.resolve({changes: [{table: "people", kind: "insert", key: {id: "old"}, before: null, after: {name: "Stale"}}], nextCursor: null}));
  expect(screen.queryByText('"Stale"')).toBeNull(); expect(props.onError).not.toHaveBeenCalled();
});

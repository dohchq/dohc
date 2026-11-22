// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { deferred } from "../testing/deferred";
import {
  CollectionMigrationDataPreview,
  type MigrationDataPreviewProps,
  type MigrationPreviewPage,
} from "./CollectionMigrationDataPreview";

afterEach(cleanup);
const revision = {
  definition: {
    tables: [
      {
        tableId: "t-people",
        sqlName: "people",
        name: "Registrations",
        primaryKey: "id",
        fields: [
          { fieldId: "f-name", sqlColumn: "name", name: "Name" },
          { fieldId: "f-id", sqlColumn: "id", name: "Registration" },
          { fieldId: "f-amount", sqlColumn: "amount", name: "Amount" },
        ],
      },
    ],
  },
} as DatasetRevision;
function fixture(): MigrationDataPreviewProps {
  return {
    workspaceId: "workspace-a",
    preparationId: "review-a",
    previousRevision: revision,
    revision,
    preview: {
      tables: [
        {
          table: "people",
          beforeRows: 2,
          afterRows: 1,
          changedRows: 2,
          deletedRows: 1,
          beforeValues: { id: 2, name: 2, amount: 2 },
          afterValues: { id: 1, name: 1, amount: 0 },
          clearedValues: { id: 0, name: 0, amount: 1 },
        },
      ],
      firstPage: {
        changes: [
          {
            table: "people",
            kind: "update",
            key: { id: "first" },
            before: { name: "Old name", amount: { type: "integer", value: "9007199254740993" } },
            after: { name: "New name", amount: null },
          },
        ],
        nextCursor: "next",
      },
    },
    onLoad: vi.fn<MigrationDataPreviewProps["onLoad"]>(async () => ({
      changes: [
        {
          table: "people",
          kind: "delete",
          key: { id: "last" },
          before: { name: "Removed" },
          after: null,
        },
      ],
      nextCursor: null,
    })),
    onError: vi.fn(),
  };
}
it("shows plain-English summary, exact changed values, and loads bounded pages on request", async () => {
  const props = fixture();
  render(<CollectionMigrationDataPreview {...props} />);
  expect(screen.getByRole("columnheader", { name: "Records in" })).toBeTruthy();
  expect(screen.getByTestId("migration-preview-summary").textContent).toContain(
    "1 record updated and 1 record removed (2 records before, 1 record after).",
  );
  expect(screen.getByTestId("migration-preview-summary").textContent).toContain(
    "Clears existing values in Amount (1).",
  );
  expect(screen.getByText("Old name")).toBeTruthy();
  expect(screen.getByText("New name")).toBeTruthy();
  expect(screen.getByText("9007199254740993")).toBeTruthy();
  expect(screen.getByText("Empty")).toBeTruthy();
  expect(props.onLoad).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "More changes" }));
  await screen.findByText("Removed");
  expect(props.onLoad).toHaveBeenCalledWith(
    { workspaceId: "workspace-a", preparationId: "review-a", after: "next", limit: 50 },
    expect.any(AbortSignal),
  );
  expect(screen.getByText("Field absent")).toBeTruthy();
  expect(screen.queryByText("Old name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Previous changes" }));
  await screen.findByText("Old name");
  expect(props.onLoad).toHaveBeenCalledTimes(1);
});
it("preserves type distinctions, escapes control, ignorable, and odd-space characters, and handles prototype keys", () => {
  const props = fixture();
  props.preview.firstPage.changes = [
    {
      table: "people",
      kind: "update",
      key: { id: "row-1" },
      before: {
        count: "1",
        real: { type: "integer", value: "1" },
        big: "9007199254740993",
        flag: "true",
        note: "Empty",
        padded: " Alice ",
        quoted: '"hi"',
        hidden: "a\u202eb",
        delChar: "x\u007fy",
        zwsp: "a\u200bb",
        nbsp: "\u00a0a",
        cgj: "a\u034fb",
        thin: "a\u2009b",
      },
      after: {
        count: { type: "integer", value: "1" },
        real: 1,
        big: { type: "integer", value: "9007199254740993" },
        flag: "yes",
        note: null,
        padded: "Alice",
        quoted: "hi",
        hidden: "ab",
        delChar: "xy",
        zwsp: "ab",
        nbsp: "a",
        cgj: "ab",
        thin: "a b",
        toString: "safe",
      },
    },
  ];
  props.preview.firstPage.nextCursor = null;
  render(<CollectionMigrationDataPreview {...props} />);
  expect(screen.getByText('"1"')).toBeTruthy();
  expect(screen.getAllByText("1").length).toBe(2);
  expect(screen.getByText("1.0")).toBeTruthy();
  expect(screen.getByText('"9007199254740993"')).toBeTruthy();
  expect(screen.getByText("9007199254740993")).toBeTruthy();
  expect(screen.getByText('"true"')).toBeTruthy();
  expect(screen.getByText("yes")).toBeTruthy();
  expect(screen.getByText('"Empty"')).toBeTruthy();
  expect(screen.getByText("Empty")).toBeTruthy();
  expect(screen.getByText('" Alice "')).toBeTruthy();
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.getByText('"\\"hi\\""')).toBeTruthy();
  expect(screen.getByText("hi")).toBeTruthy();
  expect(screen.getByText('"a\\u202eb"')).toBeTruthy();
  expect(screen.getByText('"x\\u007fy"')).toBeTruthy();
  expect(screen.getByText('"a\\u200bb"')).toBeTruthy();
  expect(screen.getByText('"\\u00a0a"')).toBeTruthy();
  expect(screen.getByText('"a\\u034fb"')).toBeTruthy();
  expect(screen.getByText('"a\\u2009b"')).toBeTruthy();
  expect(screen.getByText("Field absent")).toBeTruthy();
  expect(screen.getByText("safe")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "More changes" })).toBeNull();
});
it("summarizes mixed updates, additions, removals, and cleared values without double-counting", () => {
  const props = fixture();
  props.preview.tables = [
    {
      table: "people",
      beforeRows: 4,
      afterRows: 5,
      changedRows: 5,
      deletedRows: 1,
      beforeValues: { id: 4, name: 4 },
      afterValues: { id: 5, name: 3 },
      clearedValues: { id: 0, name: 2 },
    },
  ];
  props.preview.firstPage.nextCursor = null;
  render(<CollectionMigrationDataPreview {...props} />);
  const summary = screen.getByTestId("migration-preview-summary");
  expect(summary.textContent).toContain(
    "2 records updated, 2 records added, and 1 record removed (4 records before, 5 records after).",
  );
  expect(summary.textContent).toContain("Clears existing values in Name (2).");
  expect(screen.getByText("(1 removed)")).toBeTruthy();
});
it("uses singular grammar, classifies renames strictly by fieldId, and flags dropped columns even when another column is added", () => {
  const single = fixture();
  single.preview.tables = [
    {
      table: "people",
      beforeRows: 1,
      afterRows: 1,
      changedRows: 0,
      deletedRows: 0,
      beforeValues: { id: 1, name: 1 },
      afterValues: { id: 1, name: 1 },
      clearedValues: { id: 0, name: 0 },
    },
  ];
  single.preview.firstPage = { changes: [], nextCursor: null };
  render(<CollectionMigrationDataPreview {...single} />);
  expect(screen.getByTestId("migration-preview-summary").textContent).toBe(
    "The 1 record stays unchanged.",
  );
  cleanup();

  // Real column rename (same fieldId, different sqlColumn) with a 1-value shortfall.
  const renamed = fixture();
  renamed.revision = {
    definition: {
      tables: [
        {
          tableId: "t-people",
          sqlName: "people",
          name: "Registrations",
          primaryKey: "id",
          fields: [
            { fieldId: "f-name", sqlColumn: "full_name", name: "Name" },
            { fieldId: "f-id", sqlColumn: "id", name: "Registration" },
          ],
        },
      ],
    },
  } as DatasetRevision;
  renamed.preview.tables = [
    {
      table: "people",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 2,
      deletedRows: 0,
      beforeValues: { id: 2, name: 2 },
      afterValues: { id: 2, full_name: 1 },
      clearedValues: { id: 0, name: 2 },
    },
  ];
  renamed.preview.firstPage.nextCursor = null;
  render(<CollectionMigrationDataPreview {...renamed} />);
  const renamedSummary = screen.getByTestId("migration-preview-summary").textContent;
  expect(renamedSummary).toContain("Clears existing values in Name (at least 1).");
  expect(renamedSummary).toContain(
    "Name renames column name to full_name (1 unverified value). Check the records below to confirm none were cleared or overwritten.",
  );
  cleanup();

  // Dropped column alongside a brand-new populated column (different fieldId) is confirmed loss.
  const droppedWithNew = fixture();
  droppedWithNew.revision = {
    definition: {
      tables: [
        {
          tableId: "t-people",
          sqlName: "people",
          name: "Registrations",
          primaryKey: "id",
          fields: [
            { fieldId: "f-id", sqlColumn: "id", name: "Registration" },
            { fieldId: "f-status", sqlColumn: "status", name: "Status" },
          ],
        },
      ],
    },
  } as DatasetRevision;
  droppedWithNew.preview.tables = [
    {
      table: "people",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 2,
      deletedRows: 0,
      beforeValues: { id: 2, name: 2 },
      afterValues: { id: 2, status: 2 },
      clearedValues: { id: 0, name: 2 },
    },
  ];
  droppedWithNew.preview.firstPage.nextCursor = null;
  render(<CollectionMigrationDataPreview {...droppedWithNew} />);
  const droppedSummary = screen.getByTestId("migration-preview-summary").textContent;
  expect(droppedSummary).toContain("Clears existing values in Name (2).");
  expect(droppedSummary).not.toContain("moves from column");
});
it("distinguishes dropped tables, added tables, unmatched keys with matching row badges, and multi-table cleared columns", () => {
  const props = fixture();
  props.previousRevision = {
    definition: {
      tables: [
        {
          tableId: "t-people",
          sqlName: "people",
          name: "Registrations",
          primaryKey: "id",
          fields: [
            { fieldId: "f-id", sqlColumn: "id", name: "Registration" },
            { fieldId: "f-name", sqlColumn: "name", name: "Name" },
          ],
        },
        {
          tableId: "t-legacy",
          sqlName: "legacy",
          name: "Legacy",
          primaryKey: "id",
          fields: [{ fieldId: "f-lid", sqlColumn: "id", name: "ID" }],
        },
        {
          tableId: "t-tasks",
          sqlName: "tasks",
          name: "Tasks",
          primaryKey: "id",
          fields: [
            { fieldId: "f-tid", sqlColumn: "id", name: "Task ID" },
            { fieldId: "f-tname", sqlColumn: "name", name: "Name" },
          ],
        },
      ],
    },
  } as DatasetRevision;
  props.revision = {
    definition: {
      tables: [
        {
          tableId: "t-people",
          sqlName: "people",
          name: "Registrations",
          primaryKey: "email",
          fields: [
            { fieldId: "f-id", sqlColumn: "email", name: "Email" },
            { fieldId: "f-name", sqlColumn: "name", name: "Name" },
          ],
        },
        {
          tableId: "t-invites",
          sqlName: "invites",
          name: "Invites",
          primaryKey: "id",
          fields: [{ fieldId: "f-iid", sqlColumn: "id", name: "Invite ID" }],
        },
        {
          tableId: "t-tasks",
          sqlName: "tasks",
          name: "Tasks",
          primaryKey: "id",
          fields: [
            { fieldId: "f-tid", sqlColumn: "id", name: "Task ID" },
            { fieldId: "f-tname", sqlColumn: "name", name: "Name" },
          ],
        },
      ],
    },
  } as DatasetRevision;
  props.preview.tables = [
    {
      table: "people",
      beforeRows: 5,
      afterRows: 5,
      changedRows: 10,
      deletedRows: 5,
      beforeValues: { id: 5, name: 5 },
      afterValues: { email: 5, name: 5 },
      clearedValues: {},
    },
    {
      table: "legacy",
      beforeRows: 3,
      afterRows: 0,
      changedRows: 3,
      deletedRows: 3,
      beforeValues: { id: 3 },
      afterValues: {},
      clearedValues: {},
    },
    {
      table: "invites",
      beforeRows: 0,
      afterRows: 2,
      changedRows: 2,
      deletedRows: 0,
      beforeValues: {},
      afterValues: { id: 2 },
      clearedValues: {},
    },
    {
      table: "tasks",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 2,
      deletedRows: 0,
      beforeValues: { id: 2, name: 2 },
      afterValues: { id: 2, name: 0 },
      clearedValues: { id: 0, name: 2 },
    },
  ];
  props.preview.firstPage = {
    changes: [
      {
        table: "people",
        kind: "delete",
        key: { id: "old-1" },
        before: { id: "old-1", name: "Alice" },
        after: null,
      },
      {
        table: "people",
        kind: "insert",
        key: { email: "alice@example.com" },
        before: null,
        after: { email: "alice@example.com", name: "Alice" },
      },
    ],
    nextCursor: null,
  };
  render(<CollectionMigrationDataPreview {...props} />);
  const summary = screen.getByTestId("migration-preview-summary").textContent;
  expect(summary).toContain("2 records updated");
  expect(summary).toContain("2 records added");
  expect(summary).toContain("3 records removed");
  expect(summary).toContain(
    "5 records in Registrations replaced with 5 records without a key match",
  );
  expect(summary).toContain("Clears existing values in Tasks · Name (2).");
  expect(screen.getByText("10 entries")).toBeTruthy();
  expect(screen.getByText("(not matched by key)")).toBeTruthy();
  expect(screen.getByText("Previous record (not matched by key)")).toBeTruthy();
  expect(screen.getByText("New record (not matched by key)")).toBeTruthy();
  expect(screen.queryByText("Record removed")).toBeNull();
  expect(screen.getByText("(3 removed)")).toBeTruthy();
});
it("does not hide records when a renamed table's old SQL name is reused by a new table", () => {
  const props = fixture();
  props.previousRevision = {
    definition: {
      tables: [
        {
          tableId: "t-people",
          sqlName: "people",
          name: "People",
          primaryKey: "id",
          fields: [{ fieldId: "f-id", sqlColumn: "id", name: "ID" }],
        },
      ],
    },
  } as DatasetRevision;
  props.revision = {
    definition: {
      tables: [
        {
          tableId: "t-people",
          sqlName: "archive",
          name: "Archive",
          primaryKey: "id",
          fields: [{ fieldId: "f-id", sqlColumn: "id", name: "ID" }],
        },
        {
          tableId: "t-new-people",
          sqlName: "people",
          name: "People",
          primaryKey: "id",
          fields: [{ fieldId: "f-nid", sqlColumn: "id", name: "ID" }],
        },
      ],
    },
  } as DatasetRevision;
  props.preview.tables = [
    {
      table: "people",
      beforeRows: 5,
      afterRows: 3,
      changedRows: 8,
      deletedRows: 5,
      beforeValues: { id: 5 },
      afterValues: { id: 3 },
      clearedValues: { id: 0 },
    },
    {
      table: "archive",
      beforeRows: 0,
      afterRows: 5,
      changedRows: 5,
      deletedRows: 0,
      beforeValues: {},
      afterValues: { id: 5 },
      clearedValues: {},
    },
  ];
  props.preview.firstPage = { changes: [], nextCursor: null };
  render(<CollectionMigrationDataPreview {...props} />);
  const summary = screen.getByTestId("migration-preview-summary").textContent;
  expect(summary).toContain(
    "8 records added and 5 records removed (5 records before, 8 records after).",
  );
});
it("keeps binary values inspectable without rounding or replacing them", () => {
  const props = fixture();
  props.preview.firstPage.changes[0]!.after = {
    name: "",
    data: { type: "blob", base64: "AAEC/w==" },
  };
  render(<CollectionMigrationDataPreview {...props} />);
  expect(screen.getByText('""')).toBeTruthy();
  expect(screen.getByText("AAEC/w==")).toBeTruthy();
  expect(screen.getByText("Binary value")).toBeTruthy();
});
it("puts changed values first and retains unchanged fields in a disclosure", () => {
  const props = fixture();
  const change = props.preview.firstPage.changes[0]!;
  change.before = { id: "same-id", name: "Old name" };
  change.after = { id: "same-id", name: "New name" };
  render(<CollectionMigrationDataPreview {...props} />);
  const retained = screen.getByText("same-id");
  expect(retained.closest("details")?.open).toBe(false);
  expect(screen.getByText("Old name").closest("details")).toBeNull();
  expect(screen.getByText("New name").closest("details")).toBeNull();
  expect(screen.getByText("1 unchanged field")).toBeTruthy();
});
it("rejects a cursor loop and reports through the shell without discarding the current page", async () => {
  const props = fixture();
  props.onLoad = vi.fn(async () => ({
    changes: props.preview.firstPage.changes,
    nextCursor: "next",
  }));
  render(<CollectionMigrationDataPreview {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "More changes" }));
  await waitFor(() => expect(props.onError).toHaveBeenCalledOnce());
  expect(screen.getByText("Old name")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
it("ignores a late page when another Collection review opens", async () => {
  const props = fixture(),
    pending = deferred<MigrationPreviewPage>();
  props.onLoad = vi.fn(() => pending.promise);
  const view = render(<CollectionMigrationDataPreview {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "More changes" }));
  const onLoad = props.onLoad as ReturnType<typeof vi.fn<MigrationDataPreviewProps["onLoad"]>>;
  view.rerender(
    <CollectionMigrationDataPreview
      {...props}
      workspaceId="workspace-b"
      preparationId="review-b"
    />,
  );
  expect(onLoad.mock.calls[0]![1].aborted).toBe(true);
  await act(async () =>
    pending.resolve({
      changes: [
        {
          table: "people",
          kind: "insert",
          key: { id: "old" },
          before: null,
          after: { name: "Stale" },
        },
      ],
      nextCursor: null,
    }),
  );
  expect(screen.queryByText("Stale")).toBeNull();
  expect(props.onError).not.toHaveBeenCalled();
});

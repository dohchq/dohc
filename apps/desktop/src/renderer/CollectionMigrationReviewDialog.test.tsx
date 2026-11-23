// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetMigrationPreparation } from "@dohc/cli/dataset";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import {
  CollectionMigrationReviewDialog,
  type CollectionMigrationReviewDialogProps,
} from "./CollectionMigrationReviewDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function prep(): DatasetMigrationPreparation {
  const base: DatasetDefinition = {
    formatVersion: 1,
    datasetId: id(1),
    name: "Fundraiser",
    schemaPath: "schema.sql",
    operationsPath: "operations.js",
    tables: [
      {
        tableId: id(2),
        name: "Registrations",
        sqlName: "registrations",
        primaryKey: "name",
        fields: [
          {
            fieldId: id(3),
            name: "Name",
            sqlColumn: "name",
            type: "text",
            required: true,
            unique: true,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(12),
        name: "read",
        label: "Read",
        tableId: id(2),
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(3)],
      },
    ],
  };
  const next = structuredClone(base);
  next.tables[0]!.fields.push({
    fieldId: id(4),
    name: "Receipt",
    sqlColumn: "receipt",
    type: "attachment",
    required: false,
    unique: false,
  });
  const revision = (definition: DatasetDefinition, number: number): DatasetRevision => ({
    datasetId: definition.datasetId,
    definition,
    revision: number,
    revisionSha256: `${number}`.repeat(64),
    definitionSha256: "b".repeat(64),
    schemaSha256: "c".repeat(64),
    operationsSha256: "d".repeat(64),
  });
  const expected = {
    workspaceId: "workspace-a",
    datasetId: id(1),
    hostEpoch: "epoch",
    approvedRevisionHash: "a".repeat(64),
    revision: 1,
    digest: "e".repeat(64),
  };
  return {
    preparationId: id(10),
    previousRevision: revision(base, 1),
    revision: revision(next, 2),
    expected,
    sourceDigest: "f".repeat(64),
    approvalDigest: "1".repeat(64),
    schemaSql: "CREATE TABLE registrations...",
    operationSource: "export function create() {}",
    migrationSql: "ALTER TABLE registrations ADD receipt TEXT;",
    expiresAtMs: Date.now() + 30_000,
    candidate: {
      candidateId: id(11),
      expected,
      approvedRevisionHash: "2".repeat(64),
      checkpointSha256: "c".repeat(64),
      changeSha256: "d".repeat(64),
      expiresAtMs: Date.now() + 30_000,
      preview: {
        tables: [
          {
            table: "registrations",
            beforeRows: 2,
            afterRows: 2,
            changedRows: 2,
            deletedRows: 0,
            beforeValues: {},
            afterValues: {},
            clearedValues: {},
          },
        ],
        firstPage: {
          changes: [
            {
              table: "registrations",
              kind: "update",
              key: { id: "one" },
              before: { name: "Old name" },
              after: { name: "New name" },
            },
          ],
          nextCursor: "next",
        },
      },
    },
  };
}
function setup(overrides: Partial<CollectionMigrationReviewDialogProps> = {}) {
  const onPrepare = vi.fn<CollectionMigrationReviewDialogProps["onPrepare"]>(async () => prep()),
    onApprove = vi.fn<CollectionMigrationReviewDialogProps["onApprove"]>(async () => undefined),
    onDiscard = vi.fn<CollectionMigrationReviewDialogProps["onDiscard"]>(async () => undefined),
    onError = vi.fn(),
    onClose = vi.fn();
  const props = {
    workspaceId: "workspace-a",
    datasetId: id(1),
    onClose,
    onPrepare,
    onApprove,
    onDiscard,
    onLoadPreview: vi.fn(async () => ({ changes: [], nextCursor: null })),
    onError,
    ...overrides,
  };
  return {
    onPrepare,
    onApprove,
    onDiscard,
    onError,
    onClose,
    props,
    ...render(<CollectionMigrationReviewDialog {...props} />),
  };
}
afterEach(cleanup);
describe("CollectionMigrationReviewDialog", () => {
  it("requires fresh preparation after an uncertain approval instead of replaying migration SQL", async () => {
    const onApprove = vi
      .fn<CollectionMigrationReviewDialogProps["onApprove"]>()
      .mockRejectedValue(new Error("Collection changed"));
    const { onPrepare, onError } = setup({ onApprove });
    fireEvent.change(screen.getByLabelText("Migration file"), {
      target: { value: "migrations/002.sql" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByText("Registrations · Receipt");
    expect(
      (screen.getByRole("button", { name: "Approve change" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed this change/i }));
    fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Approve change" })).toBeNull();
    await act(async () => onError.mock.calls[0]![2]());
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onPrepare).toHaveBeenCalledTimes(2);
    expect(
      ((await screen.findByRole("button", { name: "Approve change" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("captures two source paths, shows before/after fields and approves the exact review", async () => {
    const { onPrepare, onApprove, onClose } = setup();
    fireEvent.change(screen.getByLabelText("Migration file"), {
      target: { value: "migrations/002.sql" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByText("Registrations · Receipt");
    expect(onPrepare.mock.calls[0]![0]).toMatchObject({
      workspaceId: "workspace-a",
      datasetId: id(1),
      datasetPath: "dataset.json",
      migrationPath: "migrations/002.sql",
    });
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getByText("ALTER TABLE registrations ADD receipt TEXT;")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed this change/i }));
    fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledOnce());
    expect(onApprove.mock.calls[0]![0]).toEqual({
      workspaceId: "workspace-a",
      preparationId: id(10),
      revisionSha256: "2".repeat(64),
      approvalDigest: "1".repeat(64),
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("requires safe distinct paths inline", () => {
    const { onPrepare } = setup();
    fireEvent.change(screen.getByLabelText("Migration file"), {
      target: { value: "dataset.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(screen.getByRole("alert").textContent).toContain("separate");
    expect(onPrepare).not.toHaveBeenCalled();
  });
  it("reports prepare failure through Notices and retries the same paths", async () => {
    const error = new Error("Collection changed");
    const onPrepare = vi
      .fn<CollectionMigrationReviewDialogProps["onPrepare"]>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(prep());
    const { onError } = setup({ onPrepare });
    fireEvent.change(screen.getByLabelText("Migration file"), {
      target: { value: "migrations/002.sql" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => onError.mock.calls[0]![2]!());
    await screen.findByText("Registrations · Receipt");
    expect(onPrepare.mock.calls[1]![0]).toEqual(onPrepare.mock.calls[0]![0]);
  });
  it("aborts stale preparation after the workspace changes", async () => {
    let resolve!: (value: DatasetMigrationPreparation) => void;
    const onPrepare = vi.fn<CollectionMigrationReviewDialogProps["onPrepare"]>(
      (_input, signal) =>
        new Promise<DatasetMigrationPreparation>((res, _reject) => {
          resolve = res;
          signal.addEventListener("abort", () => undefined);
        }),
    );
    const { props, rerender, onError } = setup({ onPrepare });
    fireEvent.change(screen.getByLabelText("Migration file"), {
      target: { value: "migrations/002.sql" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    rerender(<CollectionMigrationReviewDialog {...props} workspaceId="workspace-b" />);
    resolve(prep());
    await act(async () => undefined);
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByText("Registrations · Receipt")).toBeNull();
  });
  it("requests cleanup when closing a prepared review", async () => {
    const { onDiscard, onClose } = setup();
    fireEvent.change(screen.getByLabelText("Migration file"), {
      target: { value: "migrations/002.sql" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByText("Registrations · Receipt");
    fireEvent.click(screen.getByRole("button", { name: "Discard review" }));
    await waitFor(() =>
      expect(onDiscard).toHaveBeenCalledWith(
        { workspaceId: "workspace-a", preparationId: id(10) },
        expect.any(AbortSignal),
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
  it.each(["offline", "expired"])("dismisses without waiting for %s cleanup", async (reason) => {
    let reject!: (error: Error) => void;
    const onDiscard = vi.fn<CollectionMigrationReviewDialogProps["onDiscard"]>(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const initialPreparation = prep();
    if (reason === "expired") initialPreparation.expiresAtMs = Date.now() - 1;
    const { onClose, onError, unmount } = setup({ initialPreparation, onDiscard });
    if (reason === "offline")
      fireEvent.click(screen.getByRole("button", { name: "Discard review" }));
    else fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(onDiscard).toHaveBeenCalledOnce());
    unmount();
    await act(async () => reject(new Error(reason)));
    expect(onError).not.toHaveBeenCalled();
  });
  it("lets another review start while failed cleanup finishes", async () => {
    const onDiscard = vi
      .fn<CollectionMigrationReviewDialogProps["onDiscard"]>()
      .mockRejectedValue(new Error("review expired"));
    const { onClose, onError } = setup({ initialPreparation: prep(), onDiscard });
    fireEvent.click(screen.getByRole("button", { name: "Review another change" }));
    expect(screen.getByRole("button", { name: "Review change" }).hasAttribute("disabled")).toBe(
      false,
    );
    await waitFor(() => expect(onDiscard).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it("shows a Collection rename in the captured review", () => {
    const initialPreparation = prep();
    initialPreparation.revision.definition.name = "Community tournament";
    setup({ initialPreparation, generatedChange: true });
    expect(screen.getByText("Collection name changed")).toBeTruthy();
    expect(screen.getByText("Fundraiser")).toBeTruthy();
    expect(screen.getAllByText("Community tournament").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Collection definition")).toBeNull();
  });
  it("shows an added button by its name and type, and a renamed button by its name", () => {
    const added = prep();
    added.revision.definition.tables[0]!.fields.push({
      fieldId: id(5),
      name: "Send receipt",
      type: "button",
    });
    setup({ initialPreparation: added, generatedChange: true });
    expect(screen.getByText("Send receipt · button")).toBeTruthy();
    cleanup();
    const renamed = prep();
    renamed.previousRevision.definition.tables[0]!.fields.push({
      fieldId: id(5),
      name: "Send receipt",
      type: "button",
    });
    renamed.revision.definition.tables[0]!.fields.push({
      fieldId: id(5),
      name: "Email receipt",
      type: "button",
    });
    setup({ initialPreparation: renamed, generatedChange: true });
    expect(screen.getByText("Name: Send receipt")).toBeTruthy();
    expect(screen.getByText("Name: Email receipt")).toBeTruthy();
  });
  it("shows actual record changes and pages the exact preparation", async () => {
    const onLoadPreview = vi.fn<CollectionMigrationReviewDialogProps["onLoadPreview"]>(
      async () => ({
        changes: [
          {
            table: "registrations",
            kind: "update",
            key: { id: "two" },
            before: { name: "Second old" },
            after: { name: "Second new" },
          },
        ],
        nextCursor: null,
      }),
    );
    setup({ initialPreparation: prep(), onLoadPreview });
    expect(screen.getByText("Old name")).toBeTruthy();
    expect(screen.getByText("New name")).toBeTruthy();
    expect(screen.queryByTestId("migration-destructive-warning")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More changes" }));
    await screen.findByText("Second new");
    expect(onLoadPreview).toHaveBeenCalledWith(
      { workspaceId: "workspace-a", preparationId: id(10), after: "next", limit: 50 },
      expect.any(AbortSignal),
    );
  });
  it("warns clearly, uses DangerButton, and names Export recovery on confirmed data loss even when another column is added", () => {
    const destructive = prep();
    destructive.previousRevision.definition.tables[0]!.fields.push({
      fieldId: id(9),
      name: "Notes",
      sqlColumn: "notes",
      type: "text",
      required: false,
      unique: false,
    });
    destructive.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 3,
      afterRows: 2,
      changedRows: 3,
      deletedRows: 1,
      beforeValues: { name: 3, notes: 2 },
      afterValues: { name: 2, receipt: 2 },
      clearedValues: { name: 0, notes: 2 },
    };
    setup({ initialPreparation: destructive });
    const warning = screen.getByTestId("migration-destructive-warning");
    expect(warning.textContent).toContain(
      "This change removes 1 record, clears 2 existing values, and removes 1 field.",
    );
    expect(warning.textContent).toContain("Export recovery");
    expect(screen.getByRole("button", { name: "Approve change" }).className).toContain(
      "bg-danger-fill",
    );
    expect(screen.queryByText(/reverse rule changes/i)).toBeNull();
    expect(screen.getAllByText(/Collection History cannot restore/).length).toBe(1);
  });
  it("reports unmatched primary-key changes honestly without claiming confirmed removal", () => {
    const rekeyed = prep();
    rekeyed.revision.definition.tables[0] = {
      ...rekeyed.previousRevision.definition.tables[0]!,
      primaryKey: "email",
      fields: [
        {
          fieldId: id(3),
          name: "Email",
          sqlColumn: "email",
          type: "text",
          required: true,
          unique: true,
        },
      ],
    };
    rekeyed.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 5,
      afterRows: 5,
      changedRows: 10,
      deletedRows: 5,
      beforeValues: { name: 5 },
      afterValues: { email: 5 },
      clearedValues: {},
    };
    setup({ initialPreparation: rekeyed });
    const warning = screen.getByTestId("migration-destructive-warning");
    expect(warning.textContent).toContain(
      "This change replaces 5 records in Registrations with 5 records (not matched by key).",
    );
    expect(warning.textContent).not.toContain("removes 5 records");
    expect(warning.textContent).toContain("Export recovery");
    expect(screen.getByRole("button", { name: "Approve change" }).className).not.toContain(
      "bg-danger-fill",
    );
  });
  it("keeps non-destructive History copy honest and does not mislabel data-only migrations or button removals", () => {
    const dataOnly = prep();
    dataOnly.revision.definition = structuredClone(dataOnly.previousRevision.definition);
    dataOnly.revision.schemaSha256 = dataOnly.previousRevision.schemaSha256;
    dataOnly.revision.operationsSha256 = dataOnly.previousRevision.operationsSha256;
    setup({ initialPreparation: dataOnly });
    expect(screen.queryByText(/Only names or source locations changed/)).toBeNull();
    expect(
      screen.getByText(/Existing shared apps keep working and access stays unchanged/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Collection History can reverse name, button, and action changes\. It cannot reverse record changes\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve change" }).className).not.toContain(
      "bg-danger-fill",
    );
    cleanup();

    const schemaChanged = prep();
    schemaChanged.previousRevision.definition.tables[0]!.fields[0]!.name = "Guest";
    schemaChanged.revision.definition.tables[0]!.fields[0]!.name = "Guest Name";
    schemaChanged.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 2,
      deletedRows: 0,
      beforeValues: { name: 2 },
      afterValues: { name: 2, receipt: 0 },
      clearedValues: { name: 0 },
      replacedValues: { name: 0 },
    };
    setup({ initialPreparation: schemaChanged });
    expect(screen.queryByTestId("migration-destructive-warning")).toBeNull();
    expect(
      screen.getByText(
        /Collection History cannot reverse field, constraint, action, or record changes\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Collection History can rename/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Approve change" }).className).not.toContain(
      "bg-danger-fill",
    );
    cleanup();

    const actionAdded = prep();
    actionAdded.revision.definition = structuredClone(actionAdded.previousRevision.definition);
    actionAdded.revision.schemaSha256 = actionAdded.previousRevision.schemaSha256;
    actionAdded.revision.definition.operations.push({
      operationId: id(13),
      name: "list_all",
      label: "List all",
      tableId: actionAdded.revision.definition.tables[0]!.tableId,
      kind: "read",
      access: "helper",
      readOnly: true,
      fieldIds: [actionAdded.revision.definition.tables[0]!.fields[0]!.fieldId],
    });
    actionAdded.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 0,
      deletedRows: 0,
      beforeValues: { name: 2 },
      afterValues: { name: 2 },
      clearedValues: { name: 0 },
      replacedValues: { name: 0 },
    };
    actionAdded.candidate.preview.firstPage = { changes: [], nextCursor: null };
    setup({ initialPreparation: actionAdded });
    expect(screen.queryByTestId("migration-destructive-warning")).toBeNull();
    expect(
      screen.getByText(
        /Collection History cannot reverse field, constraint, action, or record changes\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Collection History can reverse/i)).toBeNull();
    cleanup();

    const buttonRemoved = prep();
    buttonRemoved.revision.definition = structuredClone(buttonRemoved.previousRevision.definition);
    buttonRemoved.revision.schemaSha256 = buttonRemoved.previousRevision.schemaSha256;
    buttonRemoved.previousRevision.definition.tables[0]!.fields.push({
      fieldId: id(5),
      name: "Send receipt",
      type: "button",
    });
    buttonRemoved.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 0,
      deletedRows: 0,
      beforeValues: { name: 2 },
      afterValues: { name: 2 },
      clearedValues: { name: 0 },
    };
    buttonRemoved.candidate.preview.firstPage = { changes: [], nextCursor: null };
    setup({ initialPreparation: buttonRemoved, generatedChange: true });
    expect(screen.queryByTestId("migration-destructive-warning")).toBeNull();
    expect(screen.queryByText(/Only names or source locations changed/)).toBeNull();
    expect(screen.getByText(/Collection History can reverse name and button changes/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve change" }).className).not.toContain(
      "bg-danger-fill",
    );
  });
  it("treats renamed columns with existing values as unverified and uses DangerButton", () => {
    const renamed = prep();
    renamed.previousRevision.definition.tables[0]!.fields.push({
      fieldId: id(9),
      name: "Notes",
      sqlColumn: "notes",
      type: "text",
      required: false,
      unique: false,
    });
    renamed.revision.definition.tables[0]!.fields = [
      ...renamed.previousRevision.definition.tables[0]!.fields.slice(0, 1),
      {
        fieldId: id(9),
        name: "Notes",
        sqlColumn: "summary",
        type: "text",
        required: false,
        unique: false,
      },
    ];
    renamed.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 2,
      afterRows: 4,
      changedRows: 4,
      deletedRows: 0,
      beforeValues: { name: 2, notes: 2 },
      afterValues: { name: 4, summary: 2 },
      clearedValues: { name: 0, notes: 2 },
    };
    setup({ initialPreparation: renamed });
    const warning = screen.getByTestId("migration-destructive-warning");
    expect(warning.textContent).toContain("renames a column holding 2 unverified values");
    expect(warning.textContent).not.toContain("moves 2");
    expect(screen.getByRole("button", { name: "Approve change" }).className).toContain(
      "bg-danger-fill",
    );
  });
  it("warns, names Export recovery, and uses DangerButton when populated values are overwritten", () => {
    const overwritten = prep();
    overwritten.revision.definition = structuredClone(overwritten.previousRevision.definition);
    overwritten.revision.schemaSha256 = overwritten.previousRevision.schemaSha256;
    overwritten.revision.operationsSha256 = overwritten.previousRevision.operationsSha256;
    overwritten.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 2,
      deletedRows: 0,
      beforeValues: { name: 2 },
      afterValues: { name: 2 },
      clearedValues: { name: 0 },
      replacedValues: { name: 2 },
    };
    setup({ initialPreparation: overwritten });
    const warning = screen.getByTestId("migration-destructive-warning");
    expect(warning.textContent).toContain("This change replaces 2 existing values.");
    expect(warning.textContent).toContain("Export recovery");
    expect(screen.getByRole("button", { name: "Approve change" }).className).toContain(
      "bg-danger-fill",
    );
  });
  it("refuses approval when the preview belongs to another checkpoint", () => {
    const initialPreparation = prep();
    initialPreparation.candidate.expected = {
      ...initialPreparation.expected,
      digest: "0".repeat(64),
    };
    const { onApprove } = setup({ initialPreparation });
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed this change/i }));
    expect(screen.getByRole("button", { name: "Approve change" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByText(/no matching data preview/)).toBeTruthy();
    expect(onApprove).not.toHaveBeenCalled();
  });
  it("requires a new preview after its candidate expires", async () => {
    const initialPreparation = prep();
    initialPreparation.candidate.expiresAtMs = Date.now() - 1;
    const { onApprove } = setup({ initialPreparation });
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed this change/i }));
    fireEvent.click(screen.getByRole("button", { name: "Approve change" }));
    expect(await screen.findByText("This review expired. Prepare the change again.")).toBeTruthy();
    expect(onApprove).not.toHaveBeenCalled();
  });
  it("lists affected connected apps with plain-English reasons and shows incomplete notice even when empty", () => {
    const withApps = prep();
    withApps.boundApps = [
      {
        scope: "local",
        publicationId: "a".repeat(64),
        authorityRevision: 1,
        appRoot: "apps/dashboard",
        alias: "fundraiser",
        pinnedRevision: 1,
        pinnedRevisionSha256: "1".repeat(64),
        operationIds: [id(12)],
        status: "needs-refresh",
      },
      {
        scope: "link",
        publicationId: "b".repeat(64),
        authorityRevision: 2,
        appRoot: "apps/public-signup",
        shareId: "share-1",
        grantId: "grant-1",
        pinnedRevision: 1,
        pinnedRevisionSha256: "1".repeat(64),
        operationIds: [id(12)],
        status: "incompatible",
        reasons: ['Action "Read" would expose new fields (Receipt) on share links.'],
      },
    ];
    setup({ initialPreparation: withApps });
    const section = screen.getByRole("region", { name: "Connected apps" });
    expect(section.textContent).toContain("Connected apps (2)");
    expect(section.textContent).toContain("apps/dashboard");
    expect(section.textContent).toContain("Local");
    expect(section.textContent).toContain("Needs approval again");
    expect(section.textContent).toContain("apps/public-signup");
    expect(section.textContent).toContain("Share link");
    expect(section.textContent).toContain("Needs update");
    expect(section.textContent).toContain(
      'Action "Read" would expose new fields (Receipt) on share links.',
    );

    cleanup();
    const incompleteOnly = prep();
    incompleteOnly.boundAppsIncomplete = true;
    setup({ initialPreparation: incompleteOnly });
    expect(screen.getByText(/Some connected apps could not be checked right now/)).toBeTruthy();
  });
  it("does not claim apps keep working on a rename-only change when pre-existing stale apps exist", () => {
    const staleRename = prep();
    staleRename.revision.definition = structuredClone(staleRename.previousRevision.definition);
    staleRename.revision.definition.name = "Renamed Fundraiser";
    staleRename.revision.schemaSha256 = staleRename.previousRevision.schemaSha256;
    staleRename.revision.operationsSha256 = staleRename.previousRevision.operationsSha256;
    staleRename.candidate.preview.tables[0] = {
      table: "registrations",
      beforeRows: 2,
      afterRows: 2,
      changedRows: 0,
      deletedRows: 0,
      beforeValues: {},
      afterValues: {},
      clearedValues: {},
    };
    staleRename.boundApps = [
      {
        scope: "local",
        publicationId: "c".repeat(64),
        authorityRevision: 1,
        appRoot: "apps/stale",
        pinnedRevision: 1,
        pinnedRevisionSha256: "1".repeat(64),
        operationIds: [id(12)],
        status: "needs-refresh",
      },
    ];
    setup({ initialPreparation: staleRename, generatedChange: true });
    expect(screen.queryByText(/Existing shared apps keep working/)).toBeNull();
    expect(screen.getByText(/connected apps listed above still need review/)).toBeTruthy();

    cleanup();
    const incompleteRename = structuredClone(staleRename);
    delete incompleteRename.boundApps;
    incompleteRename.boundAppsIncomplete = true;
    setup({ initialPreparation: incompleteRename, generatedChange: true });
    expect(screen.queryByText(/Existing shared apps keep working/)).toBeNull();
    expect(
      screen.getByText(
        /keeps current access rules, though some connected apps could not be checked right now/,
      ),
    ).toBeTruthy();
  });
});

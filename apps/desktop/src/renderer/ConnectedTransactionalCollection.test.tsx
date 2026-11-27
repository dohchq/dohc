// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { deferred } from "../testing/deferred";
import type { ReactElement, ReactNode } from "react";
import type {
  AutomationRunSettledEvent,
  FindDatasetCollectionResult,
  ListCollectionAutomationsResult,
} from "../ipc/bridgeContract";
import { ConnectedTransactionalCollection } from "./ConnectedTransactionalCollection";
import { WorkspaceSessionProvider } from "./workspace/workspaceSession";
import { resetAutomationButtonsForTests } from "./collections/useAutomationButtons";
import { resetKeptAutomationDraftsForTests } from "./collections/AutomationsPanel";
import type {
  TransactionalButtons,
  TransactionalViewControls,
} from "./TransactionalCollectionPage";
import type { CollectionTableView } from "./collectionTableViews";
import type { TransactionalCollectionPageProps } from "./TransactionalCollectionPage";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openPersistentAppBackend } from "../../../../packages/app-backend-runtime/src/persistent";

// The page reads inside the shell's workspace session.
const render = (ui: ReactElement) =>
  renderBare(ui, {
    wrapper: ({ children }) => (
      <WorkspaceSessionProvider workspaceId="workspace-a">{children}</WorkspaceSessionProvider>
    ),
  });

const backend = vi.hoisted(() => ({
  dataset: vi.fn(),
  createWorkspaceFile: vi.fn(),
  deleteWorkspacePath: vi.fn(async (_input: { workspaceId: string; relativePath: string }) => ({
    trashed: true,
  })),
  listCollections: vi.fn(),
  // The owner's page reads the table's saved views. Unless a test saves some, the workspace has no views file.
  readWorkspaceText: vi.fn(
    async (_input: {
      relativePath: string;
    }): Promise<{ text: string; contentHash: string; truncated: boolean }> => {
      throw Error("missing");
    },
  ),
  listWorkspaceFiles: vi.fn(async (_input: unknown) => ({ files: [] as Array<{ path: string }> })),
  writeWorkspaceText: vi.fn(),
  listAutomationButtons: vi.fn(),
  pressAutomationButton: vi.fn(),
  onCollectionAutomationsChanged: vi.fn(
    (_listener: (event: { workspaceId: string }) => void) => () => undefined,
  ),
  findDatasetCollection: vi.fn(async (): Promise<FindDatasetCollectionResult> => ({
    status: "unavailable",
  })),
  listCollectionAutomations: vi.fn(),
  listAutomationHolds: vi.fn(async () => ({ holds: [], stops: [], unreadable: false })),
  onAutomationRunsChanged: vi.fn(
    (_listener: (event: { workspaceId: string }) => void) => () => undefined,
  ),
  onAutomationHoldsChanged: vi.fn(() => () => undefined),
  onCollectionRulesChanged: vi.fn(
    (_listener: (event: { workspaceId: string; datasetId: string }) => void) => () => undefined,
  ),
  onCollectionCopyChanged: vi.fn(
    (_listener: (event: { workspaceId: string; datasetId?: string }) => void) => () => undefined,
  ),
  settled: [] as Array<(event: AutomationRunSettledEvent) => void>,
  onAutomationRunSettled: vi.fn(),
  onAutomationRunWaiting: vi.fn(() => () => undefined),
  checkCollectionAutomation: vi.fn(async () => ({
    diagnostics: [],
    formulaProblems: [],
    findProblems: [],
    cannotRun: null,
    missingFiles: [],
  })),
  listAutomationGroups: vi.fn(async () => ({ groups: [] })),
  listAutomationTargets: vi.fn(async () => ({ collections: [] })),
  listAutomationPeople: vi.fn(async () => ({ status: "listed", people: [] })),
  readScheduleHost: vi.fn(async () => ({ kind: "this-computer" })),
  onScheduleHostChanged: vi.fn(() => () => undefined),
  onCloudSessionChanged: vi.fn(() => () => undefined),
  writeCollectionAutomations: vi.fn(),
  listRelayShares: vi.fn(),
}));
vi.mock("./bridge", () => ({ bridge: () => backend }));
const pageInvoke = vi.hoisted(() => ({
  current: null as TransactionalCollectionPageProps["invoke"] | null,
}));
const pageResolveRelation = vi.hoisted(() => ({
  current: null as TransactionalCollectionPageProps["resolveRelation"] | null,
}));
const formDialog = vi.hoisted(() => ({ outcomes: [] as string[] }));
const handoff = vi.hoisted(() => ({ opened: 0 }));
vi.mock("./CreateDatasetFormDialog", () => ({
  CreateDatasetFormDialog: (props: {
    onApproveChoices?(
      input: {
        workspaceId: string;
        preparationId: string;
        revisionSha256: string;
        approvalDigest: string;
      },
      signal: AbortSignal,
    ): Promise<void>;
  }) => (
    <button
      onClick={() =>
        void props.onApproveChoices!(
          {
            workspaceId: "workspace-a",
            preparationId: "choices",
            revisionSha256: "a".repeat(64),
            approvalDigest: "d".repeat(64),
          },
          new AbortController().signal,
        ).then(
          () => formDialog.outcomes.push("approved"),
          (error: Error) => formDialog.outcomes.push(error.message),
        )
      }
    >
      Approve public choices
    </button>
  ),
}));
vi.mock("./TransactionalCollectionPage", () => ({
  TransactionalCollectionPage: (props: {
    invoke: TransactionalCollectionPageProps["invoke"];
    automations?: { open: boolean; count: number; onToggle(): void; close(then: () => void): void };
    panel?: ReactNode;
    views?: TransactionalViewControls;
    activeView?: CollectionTableView | null;
    onOpenSource?(): void;
    dataset?: DatasetDescription;
    recordsVersion?: number;
    recordsChanged?: number;
    buttons?: TransactionalButtons;
    rulesStatus?: ReactNode;
    rulesNotice?: ReactNode;
    onRefresh?(): void;
    onCreateForm?(): void;
    onHistory?(): void;
    onReviewSchema?(): void;
    onTransferCsv?(): void;
    onPendingResponses?(): void;
    onExportRecovery?(): void;
    onCustomize?(): void;
    onManageAccess?(): void;
    onCustomAction?(operationId: string): void;
    resolveRelation?: TransactionalCollectionPageProps["resolveRelation"];
  }) => {
    pageInvoke.current = props.invoke;
    pageResolveRelation.current = props.resolveRelation ?? null;
    return (
      <>
        {props.automations && (
          <button
            data-testid="collection-automations-button"
            aria-pressed={props.automations.open}
            onClick={props.automations.onToggle}
          >
            Automations{props.automations.count > 0 ? props.automations.count : null}
          </button>
        )}
        {props.automations && (
          <button
            onClick={() =>
              props.automations!.close(() => {
                handoff.opened += 1;
              })
            }
          >
            Open a record
          </button>
        )}
        {props.panel}
        {props.rulesStatus}
        {props.rulesNotice}
        {props.onOpenSource && <button onClick={props.onOpenSource}>Open source</button>}
        {props.views && (
          <section aria-label="View tabs">
            <output aria-label="Open view">{props.activeView?.name ?? "All records"}</output>
            {props.views.list.map((view) => (
              <span key={view.viewId}>
                <button onClick={() => props.views!.select(view.viewId)}>Open {view.name}</button>
                <button onClick={() => props.views!.edit(view.viewId)}>Edit {view.name}</button>
              </span>
            ))}
            <button disabled={props.views.busy} onClick={props.views.manage}>
              Views
            </button>
            <button
              onClick={() => {
                void props.views!.create({ name: "Everything", kind: "table" });
              }}
            >
              Add view
            </button>
          </section>
        )}
        {props.buttons?.fields.map((field) => (
          <span key={field}>
            {props.buttons!.render(field, { id: 12, version: 1, values: {} })}
          </span>
        ))}
        <input
          aria-label="Collection view state"
          data-fields={props.dataset?.tables[0]?.fields.map((field) => field.name).join(",")}
          data-records-version={props.recordsVersion}
          data-records-changed={props.recordsChanged}
          defaultValue=""
        />
        <button onClick={props.onRefresh}>Refresh records</button>
        {props.onCreateForm && <button onClick={props.onCreateForm}>Create form</button>}
        {props.onHistory && <button onClick={props.onHistory}>History</button>}
        {props.onReviewSchema && <button onClick={props.onReviewSchema}>Fields and names</button>}
        {props.onTransferCsv && <button onClick={props.onTransferCsv}>Import or export CSV</button>}
        {props.onPendingResponses && (
          <button onClick={props.onPendingResponses}>Pending responses</button>
        )}
        {props.onExportRecovery && (
          <button onClick={props.onExportRecovery}>Export recovery</button>
        )}
        {props.onCustomize && <button onClick={props.onCustomize}>Customize…</button>}
        {props.onManageAccess && <button onClick={props.onManageAccess}>Manage access</button>}
        {props.dataset?.operations
          .filter((operation) => operation.kind === "action")
          .map((operation) => (
            <button
              key={operation.operationId}
              onClick={() => props.onCustomAction?.(operation.operationId)}
            >
              {operation.label}
            </button>
          ))}
      </>
    );
  },
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dataset: DatasetDescription = {
  datasetId: id(1),
  name: "Fundraiser",
  revision: 1,
  revisionSha256: "a".repeat(64),
  tables: [
    {
      tableId: id(2),
      name: "Registrations",
      fields: [{ fieldId: id(3), name: "Name", type: "text", required: true, unique: false }],
    },
  ],
  operations: [
    {
      operationId: id(4),
      tableId: id(2),
      name: "create",
      label: "Create",
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [id(3)],
    },
  ],
};
const ownerApproval = {
  kind: "approval",
  revisionSha256: dataset.revisionSha256,
  approvedBy: null,
  needsOwnerConfirmation: false,
};
// A builder left with changes keeps its draft for the next panel, so each test starts with none.
afterEach(() => {
  cleanup();
  resetAutomationButtonsForTests();
  resetKeptAutomationDraftsForTests();
  vi.clearAllMocks();
  backend.settled.length = 0;
  handoff.opened = 0;
});

it("shows no path above the page, and opens the Collection's file from Open source", async () => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset });
  const onOpenFile = vi.fn();
  const { container } = render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={onOpenFile}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open source" }));
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("data/dataset.json");
  expect(container.textContent).not.toContain("data/dataset.json");
});

describe("a dataset table's saved views", () => {
  const readable: DatasetDescription = {
    ...dataset,
    operations: [
      ...dataset.operations,
      {
        operationId: id(5),
        tableId: id(2),
        name: "read",
        label: "Read",
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [id(3)],
      },
    ],
  };
  const unpaid: CollectionTableView = {
    viewId: id(20),
    name: "Unpaid",
    kind: "table",
    search: "Pending",
    filters: [],
    sort: null,
  };
  const viewsPath = `collection-views/${id(1)}/${id(2)}.json`;
  const saved = (views: CollectionTableView[]) => ({
    text: JSON.stringify({ formatVersion: 1, datasetId: id(1), tableId: id(2), views }),
    contentHash: "c".repeat(64),
    truncated: false,
  });
  afterEach(() => {
    backend.readWorkspaceText.mockImplementation(async () => {
      throw Error("missing");
    });
    localStorage.clear();
  });
  const renderPage = (owner: boolean, onError = vi.fn()) =>
    render(
      <ConnectedTransactionalCollection
        role={owner ? "owner" : "member"}
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onNotice={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );

  it("gives the owner the table's saved views, opens the one chosen, and opens the existing editor from Edit view…", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset: readable });
    backend.readWorkspaceText.mockResolvedValue(saved([unpaid]));
    const onError = vi.fn();
    renderPage(true, onError);
    const open = await screen.findByRole("button", { name: "Open Unpaid" });
    expect(backend.readWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      relativePath: viewsPath,
    });
    expect(screen.getByLabelText("Open view").textContent).toBe("All records");
    fireEvent.click(open);
    expect(screen.getByLabelText("Open view").textContent).toBe("Unpaid");
    fireEvent.click(screen.getByRole("button", { name: "Edit Unpaid" }));
    const editor = within(screen.getByRole("region", { name: "Collection views" }));
    expect(editor.getByLabelText<HTMLInputElement>("View name").value).toBe("Unpaid");
    expect(editor.getByLabelText<HTMLInputElement>("View search").value).toBe("Pending");
    fireEvent.click(editor.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: "Collection views" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(
      within(screen.getByRole("region", { name: "Collection views" })).getByRole("button", {
        name: "Edit view Unpaid",
      }),
    ).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it("writes a view added from the tabs to the table's file, naming the hash it read", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset: readable });
    backend.readWorkspaceText.mockResolvedValue(saved([unpaid]));
    backend.writeWorkspaceText.mockResolvedValue({
      status: "written",
      contentHash: "d".repeat(64),
    });
    renderPage(true);
    await screen.findByRole("button", { name: "Open Unpaid" });
    fireEvent.click(screen.getByRole("button", { name: "Add view" }));
    await waitFor(() => expect(backend.writeWorkspaceText).toHaveBeenCalledOnce());
    const write = backend.writeWorkspaceText.mock.calls[0]![0] as {
      workspaceId: string;
      relativePath: string;
      text: string;
      expectedContentHash: string;
    };
    expect(write).toMatchObject({
      workspaceId: "workspace-a",
      relativePath: viewsPath,
      expectedContentHash: "c".repeat(64),
    });
    expect(
      (JSON.parse(write.text) as { views: CollectionTableView[] }).views.map((view) => view.name),
    ).toEqual(["Unpaid", "Everything"]);
  });

  it("gives someone who does not own the Collection no saved views, and reads no views file", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset: readable });
    backend.readWorkspaceText.mockResolvedValue(saved([unpaid]));
    renderPage(false);
    await screen.findByLabelText("Collection view state");
    expect(screen.queryByRole("region", { name: "View tabs" })).toBeNull();
    expect(backend.readWorkspaceText).not.toHaveBeenCalled();
  });
});

it("keeps the worker usable after a read is aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-read-abort-"));
  // Child IPC supplies Node typed arrays, including its prepared changeset.
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(Buffer.prototype).constructor);
  const cursor = { revision: 0, digest: createHash("sha256").update("initial").digest("hex") };
  const worker = await openPersistentAppBackend({
    directory: root,
    schemaSql: "CREATE TABLE items(id TEXT NOT NULL PRIMARY KEY, value INTEGER NOT NULL);",
    tables: ["items"],
    scope: {
      workspaceId: "workspace-a",
      datasetId: id(1),
      hostEpoch: "host",
      approvedRevisionHash: dataset.revisionSha256,
    },
    cursor,
  });
  const prepared = deferred<void>(),
    release = deferred<void>();
  let first = true;
  backend.dataset.mockImplementation(async (request) => {
    if (request.action === "describe") return { kind: "description", dataset };
    if (request.action === "cancelInvoke") {
      await worker.abort();
      return { kind: "invoke-cancel-requested", outcome: "unknown" };
    }
    const response = await worker.prepare({
      expected: cursor,
      source: "globalThis.operations={read(){return [{value:42}]}}",
      operation: "read",
      input: {},
      caller: { kind: "owner" },
      nowMs: 0,
      requestId: crypto.randomUUID(),
      readOnly: true,
    });
    if (first) {
      first = false;
      prepared.resolve();
      await release.promise;
    }
    return { kind: "invoked", result: response.result, revision: 0, replayed: false };
  });
  try {
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    await screen.findByLabelText("Collection view state");
    const request = {
      workspaceId: "workspace-a",
      datasetId: id(1),
      revision: 1,
      revisionSha256: dataset.revisionSha256,
      operationId: id(4),
      input: {},
      idempotencyKey: "read",
    };
    const controller = new AbortController();
    const reading = pageInvoke.current!(request, controller.signal).catch((error) => error);
    await prepared.promise;
    controller.abort();
    release.resolve();
    expect(await reading).toBe(controller.signal.reason);
    // A second real query must reuse the surviving worker, not need a cold start.
    expect(
      (
        await pageInvoke.current!(
          { ...request, idempotencyKey: "next-read" },
          new AbortController().signal,
        )
      ).result,
    ).toEqual([{ value: 42 }]);
    expect(
      backend.dataset.mock.calls
        .filter(([request]) => request.action === "invoke")
        .every(([request]) => request.invocationId === undefined),
    ).toBe(true);
  } finally {
    cleanup();
    await worker.close();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 8 });
  }
});

it("reports an unknown action result in the open dialog without a toast or Notice", async () => {
  const action = {
    ...dataset.operations[0]!,
    operationId: id(7),
    name: "draw",
    label: "Draw winner",
    kind: "action" as const,
  };
  backend.dataset.mockImplementation(async (request) => {
    if (request.action === "invoke") throw new Error("Connection closed.");
    return {
      kind: "description",
      dataset: { ...dataset, operations: [...dataset.operations, action] },
    };
  });
  const onError = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Draw winner" }));
  fireEvent.click(screen.getByRole("button", { name: "Run action" }));
  await screen.findByText("Action not confirmed");
  expect(screen.getByText(/see if anything changed/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(onError).not.toHaveBeenCalled();
});

it("forwards Cancel over IPC with the running invocation id and retains the retry key", async () => {
  const action = {
    ...dataset.operations[0]!,
    operationId: id(7),
    name: "draw",
    label: "Draw winner",
    kind: "action" as const,
  };
  const running = deferred<unknown>();
  backend.dataset.mockImplementation(async (request) => {
    if (request.action === "invoke") return running.promise;
    if (request.action === "cancelInvoke") {
      running.reject(new Error("cancelled"));
      return { kind: "invoke-cancel-requested", outcome: "unknown" };
    }
    return {
      kind: "description",
      dataset: { ...dataset, operations: [...dataset.operations, action] },
    };
  });
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Draw winner" }));
  const recordsVersion = Number(
    screen.getByLabelText("Collection view state").getAttribute("data-records-version"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Run action" }));
  const first = backend.dataset.mock.calls.find(([request]) => request.action === "invoke")![0];
  fireEvent.keyDown(document, { key: "Escape" });
  await screen.findByText("Action cancelled");
  expect(
    Number(screen.getByLabelText("Collection view state").getAttribute("data-records-version")),
  ).toBe(recordsVersion + 1);
  expect(backend.dataset).toHaveBeenCalledWith({
    action: "cancelInvoke",
    workspaceId: "workspace-a",
    invocationId: first.invocationId,
  });
  backend.dataset.mockResolvedValue({ kind: "invoked", result: null, revision: 1, replayed: true });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Action completed");
  const second = backend.dataset.mock.calls.filter(
    ([request]) => request.action === "invoke",
  )[1]![0];
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.invocationId).not.toBe(first.invocationId);
});

describe("a dataset table's buttons", () => {
  const withButton: DatasetDescription = {
    ...dataset,
    tables: [
      {
        ...dataset.tables[0]!,
        fields: [...dataset.tables[0]!.fields, { fieldId: id(6), name: "Confirm", type: "button" }],
      },
    ],
  };
  const settle = (event: AutomationRunSettledEvent) => {
    for (const listener of backend.settled) listener(event);
  };

  it("asks before a button runs an action that can't be undone, and presses naming the actions it agreed to", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.onAutomationRunSettled.mockImplementation(
      (listener: (event: AutomationRunSettledEvent) => void) => {
        backend.settled.push(listener);
        return () => undefined;
      },
    );
    backend.listAutomationButtons.mockResolvedValue({
      buttons: [
        {
          field: "Confirm",
          table: "Registrations",
          state: {
            kind: "ready",
            automationId: "collection:Fundraiser#confirm",
            irreversible: [{ name: "registrations.receipt", label: "Send receipt" }],
          },
        },
      ],
    });
    backend.pressAutomationButton.mockResolvedValue({
      busy: false,
      claimId: "claim-2",
      settled: null,
    });
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onNotice={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    const button = await screen.findByRole("button", { name: "Confirm for record 12" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(backend.pressAutomationButton).toHaveBeenCalledWith(
        expect.objectContaining({ field: "Confirm", confirmed: ["registrations.receipt"] }),
      ),
    );
  });

  it("presses with the dataset, the table's name, and the record's key as JSON, runs until settled, and says what ran", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.onAutomationRunSettled.mockImplementation(
      (listener: (event: AutomationRunSettledEvent) => void) => {
        backend.settled.push(listener);
        return () => undefined;
      },
    );
    backend.listAutomationButtons.mockResolvedValue({
      buttons: [
        {
          field: "Confirm",
          table: "Registrations",
          state: { kind: "ready", automationId: "collection:Fundraiser#confirm" },
        },
        {
          field: "Confirm",
          table: "Donors",
          state: {
            kind: "disabled",
            reason: "Only people who can edit Donors can use this button.",
          },
        },
      ],
    });
    backend.pressAutomationButton.mockResolvedValue({
      busy: false,
      claimId: "claim-1",
      settled: null,
    });
    const onNotice = vi.fn();
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onNotice={onNotice}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    const button = await screen.findByRole("button", { name: "Confirm for record 12" });
    // The state of this table's button, not another table's button of the same name.
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
    expect(backend.listAutomationButtons).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      datasetId: id(1),
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(backend.pressAutomationButton).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        datasetId: id(1),
        table: "Registrations",
        field: "Confirm",
        recordId: "12",
        pressId: expect.any(String),
        confirmed: [],
      }),
    );
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    act(() =>
      settle({ workspaceId: "workspace-a", claimId: "claim-1", outcome: "done", error: null }),
    );
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(onNotice).toHaveBeenCalledWith("Ran Confirm on record 12");
  });

  it("asks main nothing about buttons for a table that has none", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    await screen.findByLabelText("Collection view state");
    expect(backend.listAutomationButtons).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /for record/ })).toBeNull();
  });
});
it("opens wrapped history through the real dialog and reverses the saved edit", async () => {
  let undone = false;
  const current: DatasetDescription = {
    ...dataset,
    operations: [
      ...dataset.operations,
      {
        operationId: id(5),
        tableId: id(2),
        name: "edit",
        label: "Edit",
        kind: "edit",
        reversible: true,
        access: "owner",
        readOnly: false,
        fieldIds: [id(3)],
      },
    ],
  };
  backend.dataset.mockImplementation(async (input) => {
    if (input.action === "describe") return { kind: "description", dataset: current };
    if (input.action === "history")
      return {
        kind: "history",
        datasetId: id(1),
        headRevision: undone ? 3 : 2,
        nextBeforeRevision: null,
        entries: undone
          ? []
          : [
              {
                revision: 2,
                operation: "edit",
                callerReference: "b".repeat(64),
                recordedAtMs: 1000,
                approvedRevisionHash: current.revisionSha256,
                changesetBytes: 80,
                attachmentCount: 0,
                undo: {
                  operationId: id(5),
                  revision: 1,
                  revisionSha256: current.revisionSha256,
                  recordId: "record",
                  expectedVersion: 2,
                  fields: [{ fieldId: id(3), name: "Name", value: "Original name" }],
                },
              },
            ],
      };
    if (input.action === "invoke") {
      undone = true;
      return {
        kind: "invoked",
        result: { id: "record", version: 3 },
        revision: 3,
        replayed: false,
      };
    }
    throw Error("Unexpected request");
  });
  const onError = vi.fn(),
    onNotice = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onNotice={onNotice}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  const history = within(screen.getByRole("dialog", { name: "Collection history" }));
  fireEvent.click(await history.findByText("edit", { exact: true }));
  expect(history.getByText('"Original name"')).toBeTruthy();
  fireEvent.click(history.getByRole("button", { name: "Undo edit" }));
  await history.findByText("No saved actions on this page. Refresh to check for changes.");
  expect(backend.dataset).toHaveBeenCalledWith({
    action: "invoke",
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    expectedDatasetId: id(1),
    revision: 1,
    revisionSha256: current.revisionSha256,
    operationId: id(5),
    idempotencyKey: expect.any(String),
    input: { id: "record", expectedVersion: 2, values: { [id(3)]: "Original name" } },
  });
  expect(onNotice).toHaveBeenCalledWith("Reversed the edit");
  expect(onError).not.toHaveBeenCalled();
});
it("reads the Collection again when a change to its fields applies elsewhere, and not for another Collection or workspace", async () => {
  const rulesChanged: Array<(event: { workspaceId: string; datasetId: string }) => void> = [];
  backend.onCollectionRulesChanged.mockImplementation((listener) => {
    rulesChanged.push(listener);
    return () => undefined;
  });
  backend.dataset.mockResolvedValue({ kind: "description", dataset });
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  const input = await screen.findByLabelText("Collection view state");
  await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("1"));
  expect(input.getAttribute("data-fields")).toBe("Name");
  const describes = () =>
    backend.dataset.mock.calls
      .map(([request]) => request)
      .filter((request) => request.action === "describe");
  expect(describes()).toHaveLength(1);
  const changed = (workspaceId: string, datasetId: string) =>
    act(() => {
      for (const listener of rulesChanged) listener({ workspaceId, datasetId });
    });
  changed("workspace-b", id(1));
  changed("workspace-a", id(9));
  expect(describes()).toHaveLength(1);
  const withDueDate: DatasetDescription = {
    ...dataset,
    revision: 2,
    tables: [
      {
        ...dataset.tables[0]!,
        fields: [
          ...dataset.tables[0]!.fields,
          { fieldId: id(7), name: "Due date", type: "date", required: false, unique: false },
        ],
      },
    ],
  };
  backend.dataset.mockResolvedValue({ kind: "description", dataset: withDueDate });
  changed("workspace-a", id(1));
  await waitFor(() => expect(input.getAttribute("data-fields")).toBe("Name,Due date"));
  expect(describes()).toHaveLength(2);
  expect(describes()[1]).toMatchObject({
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    expectedDatasetId: id(1),
  });
  expect(input.getAttribute("data-records-version")).toBe("2");
});
it("closes the form after its public choices apply, though the page read the Collection again first", async () => {
  formDialog.outcomes.length = 0;
  const rulesChanged: Array<(event: { workspaceId: string; datasetId: string }) => void> = [];
  backend.onCollectionRulesChanged.mockImplementation((listener) => {
    rulesChanged.push(listener);
    return () => undefined;
  });
  const approved = Promise.withResolvers<{ kind: "migrated" }>();
  backend.dataset.mockImplementation(async (input: { action: string }) => {
    if (input.action === "describe") return { kind: "description", dataset };
    if (input.action === "approveMigration") return await approved.promise;
    throw new Error(`Unexpected ${input.action}`);
  });
  const onError = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Create form" }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve public choices" }));
  await waitFor(() =>
    expect(
      backend.dataset.mock.calls.some(([request]) => request.action === "approveMigration"),
    ).toBe(true),
  );
  act(() => {
    for (const listener of rulesChanged) listener({ workspaceId: "workspace-a", datasetId: id(1) });
  });
  await act(async () => approved.resolve({ kind: "migrated" }));
  await waitFor(() => expect(formDialog.outcomes).toEqual(["approved"]));
  expect(screen.queryByRole("button", { name: "Approve public choices" })).toBeNull();
  await waitFor(() =>
    expect(
      backend.dataset.mock.calls.filter(([request]) => request.action === "describe"),
    ).toHaveLength(3),
  );
  expect(onError).not.toHaveBeenCalled();
});

it("reads the records again in place when runs in its workspace end, however they started", async () => {
  const runsChanged: Array<(event: { workspaceId: string }) => void> = [];
  backend.onAutomationRunsChanged.mockImplementation((listener) => {
    runsChanged.push(listener);
    return () => undefined;
  });
  backend.dataset.mockResolvedValue({ kind: "description", dataset });
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  const input = await screen.findByLabelText("Collection view state");
  await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("1"));
  expect(input.getAttribute("data-records-changed")).toBe("0");
  const runsEnded = (workspaceId: string) =>
    act(() => {
      for (const listener of runsChanged) listener({ workspaceId });
    });
  runsEnded("workspace-b");
  expect(input.getAttribute("data-records-changed")).toBe("0");
  runsEnded("workspace-a");
  expect(input.getAttribute("data-records-changed")).toBe("1");
  // The quiet read, not the one that shows a loading line.
  expect(input.getAttribute("data-records-version")).toBe("1");
});
it("shows its kept copy brought up to date in place, and leaves read-only by itself once the server is reachable", async () => {
  const copyChanged: Array<(event: { workspaceId: string; datasetId?: string }) => void> = [];
  backend.onCollectionCopyChanged.mockImplementation((listener) => {
    copyChanged.push(listener);
    return () => undefined;
  });
  backend.dataset.mockResolvedValue({
    kind: "description",
    dataset,
    copy: { offline: true, host: "sync.example.test" },
  });
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  const input = await screen.findByLabelText("Collection view state");
  await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("1"));
  expect(screen.queryByRole("button", { name: "Create form" })).toBeNull();
  const changed = (workspaceId: string, datasetId: string) =>
    act(() => {
      for (const listener of copyChanged) listener({ workspaceId, datasetId });
    });
  const describes = () =>
    backend.dataset.mock.calls.filter(([request]) => request.action === "describe").length;
  changed("workspace-b", id(1));
  changed("workspace-a", id(9));
  expect(describes()).toBe(1);

  backend.dataset.mockResolvedValue({ kind: "description", dataset, copy: { offline: false } });
  changed("workspace-a", id(1));
  await screen.findByRole("button", { name: "Create form" });
  // The table reads its records again in place, without the loading line.
  expect(input.getAttribute("data-records-changed")).toBe("1");
  expect(input.getAttribute("data-records-version")).toBe("1");
});

it("drops a signed-out copy when an account signs in, reads nothing meanwhile, and shows nothing of it if the next read fails", async () => {
  const session: Array<
    (event: { sessionKey: string | null; phase: "changing" | "ready" }) => void
  > = [];
  backend.onCloudSessionChanged.mockImplementation(((listener: (typeof session)[number]) => {
    session.push(listener);
    return () => session.splice(session.indexOf(listener), 1);
  }) as never);
  const copyChanged: Array<(event: { workspaceId: string; datasetId?: string }) => void> = [];
  backend.onCollectionCopyChanged.mockImplementation((listener) => {
    copyChanged.push(listener);
    return () => undefined;
  });
  backend.dataset.mockResolvedValue({
    kind: "description",
    dataset,
    copy: { offline: true, signedOut: true, host: "sync.example.test" },
  });
  const onError = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  await screen.findByLabelText("Collection view state");
  act(() => {
    for (const listener of [...session]) listener({ sessionKey: "b", phase: "changing" });
  });
  expect(screen.queryByLabelText("Collection view state")).toBeNull();
  // While the session changes, the page reads nothing: not on a copy change, nor on Try again.
  const reads = backend.dataset.mock.calls.length;
  act(() => {
    for (const listener of copyChanged)
      listener({ workspaceId: "workspace-a", datasetId: dataset.datasetId });
  });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(backend.dataset.mock.calls.length).toBe(reads);
  expect(screen.queryByLabelText("Collection view state")).toBeNull();
  backend.dataset.mockRejectedValue(new Error("The other account can't read this."));
  act(() => {
    for (const listener of [...session]) listener({ sessionKey: "b", phase: "ready" });
  });
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(screen.queryByLabelText("Collection view state")).toBeNull();
});
it("shows no signed-out copy from a first read that answers after a session starts", async () => {
  const session: Array<
    (event: { sessionKey: string | null; phase: "changing" | "ready" }) => void
  > = [];
  backend.onCloudSessionChanged.mockImplementation(((listener: (typeof session)[number]) => {
    session.push(listener);
    return () => session.splice(session.indexOf(listener), 1);
  }) as never);
  let answer!: (value: unknown) => void;
  backend.dataset.mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve)) as never,
  );
  const onError = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  await waitFor(() => expect(backend.dataset).toHaveBeenCalledTimes(1));
  act(() => {
    for (const listener of [...session]) listener({ sessionKey: "b", phase: "changing" });
  });
  // The first read, which main answered from the account signed in last, arrives now.
  await act(async () => {
    answer({
      kind: "description",
      dataset,
      copy: { offline: true, signedOut: true, host: "sync.example.test" },
    });
    await Promise.resolve();
  });
  expect(screen.queryByLabelText("Collection view state")).toBeNull();
  backend.dataset.mockRejectedValue(new Error("The other account can't read this."));
  act(() => {
    for (const listener of [...session]) listener({ sessionKey: "b", phase: "ready" });
  });
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(backend.dataset).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText("Collection view state")).toBeNull();
});
it("shows a slow quiet read's answer when another change arrives during it", async () => {
  const copyChanged: Array<(event: { workspaceId: string; datasetId?: string }) => void> = [];
  backend.onCollectionCopyChanged.mockImplementation((listener) => {
    copyChanged.push(listener);
    return () => undefined;
  });
  backend.dataset.mockResolvedValue({
    kind: "description",
    dataset,
    copy: { offline: true, host: "sync.example.test" },
  });
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  const input = await screen.findByLabelText("Collection view state");
  await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("1"));
  const changed = () =>
    act(() => {
      for (const listener of copyChanged)
        listener({ workspaceId: "workspace-a", datasetId: id(1) });
    });
  const slow = deferred<unknown>();
  backend.dataset.mockReturnValueOnce(slow.promise as never);
  changed();
  // Another change arrives while that read is under way, and any read after it never answers.
  backend.dataset.mockReturnValue(new Promise(() => undefined) as never);
  changed();
  await act(async () => slow.resolve({ kind: "description", dataset, copy: { offline: false } }));
  await screen.findByRole("button", { name: "Create form" });
  expect(input.getAttribute("data-records-changed")).toBe("1");
});

describe("a quiet read beside one the page started", () => {
  const copyChanged: Array<(event: { workspaceId: string; datasetId?: string }) => void> = [];
  const changed = () =>
    act(() => {
      for (const listener of copyChanged)
        listener({ workspaceId: "workspace-a", datasetId: id(1) });
    });
  async function open(props: { onError?: () => void; onSettled?: (row: string) => void } = {}) {
    copyChanged.length = 0;
    backend.onCollectionCopyChanged.mockImplementation((listener) => {
      copyChanged.push(listener);
      return () => undefined;
    });
    backend.dataset.mockResolvedValue({
      kind: "description",
      dataset,
      copy: { offline: true, host: "sync.example.test" },
    });
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={props.onError ?? vi.fn()}
        onSettled={props.onSettled}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    const input = await screen.findByLabelText("Collection view state");
    await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("1"));
    return input;
  }

  it("keeps the quiet read's answer when the page's own read, started before it, answers last", async () => {
    const input = await open();
    const manual = deferred<unknown>();
    backend.dataset.mockReturnValueOnce(manual.promise as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    backend.dataset.mockResolvedValueOnce({
      kind: "description",
      dataset,
      copy: { offline: false },
    });
    changed();
    await screen.findByRole("button", { name: "Create form" });
    await act(async () =>
      manual.resolve({
        kind: "description",
        dataset,
        copy: { offline: true, host: "sync.example.test" },
      }),
    );
    await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("2"));
    expect(screen.getByRole("button", { name: "Create form" })).toBeTruthy();
  });

  it("reports nothing when the page's own read fails after a quiet read started later showed the Collection", async () => {
    const onError = vi.fn();
    const input = await open({ onError });
    const manual = deferred<unknown>();
    backend.dataset.mockReturnValueOnce(manual.promise as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    backend.dataset.mockResolvedValueOnce({
      kind: "description",
      dataset,
      copy: { offline: false },
    });
    changed();
    await screen.findByRole("button", { name: "Create form" });
    await act(async () => manual.reject(Error("Disk busy")));
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create form" })).toBeTruthy();
    expect(input.getAttribute("data-fields")).toBeTruthy();
  });

  it("still shows a refusal the page's own read met after a quiet read started later showed the Collection", async () => {
    await open();
    const manual = deferred<unknown>();
    backend.dataset.mockReturnValueOnce(manual.promise as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    backend.dataset.mockResolvedValueOnce({
      kind: "description",
      dataset,
      copy: { offline: false },
    });
    changed();
    await screen.findByRole("button", { name: "Create form" });
    await act(async () =>
      manual.reject(
        Error(
          "Error invoking remote method 'desktop:dataset': CollectionsRefusalError [collections-replaced]: Another copy replaced this computer's Collections.",
        ),
      ),
    );
    expect((await screen.findByTestId("collection-refusal")).textContent).toContain(
      "Another copy replaced",
    );
  });

  it("takes back the page's failed-read row when a quiet read then succeeds", async () => {
    const onError = vi.fn(),
      onSettled = vi.fn();
    await open({ onError, onSettled });
    backend.dataset.mockRejectedValueOnce(Error("Disk busy"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    const row = "collection-open:data/dataset.json";
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "dohc could not open this Collection.",
        expect.anything(),
        expect.any(Function),
        row,
      ),
    );
    onSettled.mockClear();
    changed();
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(row));
  });
});

it("asks for the Collection again while it is open, so a change made elsewhere reaches it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    backend.dataset.mockResolvedValue({ kind: "description", dataset, copy: { offline: false } });
    const { unmount } = render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    const input = await screen.findByLabelText("Collection view state");
    await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("1"));
    const describes = () =>
      backend.dataset.mock.calls.filter(([request]) => request.action === "describe").length;
    expect(describes()).toBe(1);
    act(() => vi.advanceTimersByTime(10_000));
    await waitFor(() => expect(describes()).toBe(2));
    // A quiet read: no loading line.
    expect(input.getAttribute("data-records-version")).toBe("1");
    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(describes()).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the page mounted through successful and failed metadata refreshes", async () => {
  backend.dataset.mockResolvedValue({ kind: "description", dataset });
  const onError = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  const input = await screen.findByLabelText("Collection view state");
  fireEvent.change(input, { target: { value: "pending edit and current search" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
  await waitFor(() => expect(input.getAttribute("data-records-version")).toBe("2"));
  expect(screen.getByLabelText("Collection view state")).toBe(input);
  backend.dataset.mockRejectedValueOnce(Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
  await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("Collection view state")).toBe(input);
  expect(input.getAttribute("data-records-version")).toBe("3");
  expect((input as HTMLInputElement).value).toBe("pending edit and current search");
});
async function setup() {
  backend.listCollections.mockResolvedValue({ collections: [] });
  backend.listWorkspaceFiles.mockResolvedValue({ files: [] });
  backend.dataset.mockImplementation(async (input) =>
    input.action === "describe"
      ? { kind: "description", dataset }
      : { kind: "invoked", result: { id: "created", version: 1 } },
  );
  const props = {
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    tableId: id(2),
    onError: vi.fn(),
    onFormCreated: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenScheduleSettings: vi.fn(),
  };
  const rendered = render(<ConnectedTransactionalCollection {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Import or export CSV" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "CSV or saved import report" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "CSV or saved import report" }));
  fireEvent.change(screen.getByLabelText("CSV text"), { target: { value: "Name\nAlice" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview CSV" }));
  return { ...rendered, props };
}
describe("connected CSV transfers", () => {
  it("saves a scoped durable report before invoking its approved create operation", async () => {
    const saved = deferred<{ path: string }>();
    backend.createWorkspaceFile.mockImplementation(() => saved.promise);
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Save retry report and import" }));
    await waitFor(() => expect(backend.createWorkspaceFile).toHaveBeenCalledOnce());
    expect(backend.dataset.mock.calls.filter(([input]) => input.action === "invoke")).toHaveLength(
      0,
    );
    const request = backend.createWorkspaceFile.mock.calls[0]![0];
    expect(request.workspaceId).toBe("workspace-a");
    expect(request.relativePath).toMatch(/^Registrations-import-[0-9a-f-]+\.json$/);
    const report = JSON.parse(request.initialText);
    await act(async () => saved.resolve({ path: request.relativePath }));
    await waitFor(() =>
      expect(
        backend.dataset.mock.calls.filter(([input]) => input.action === "invoke"),
      ).toHaveLength(1),
    );
    expect(
      backend.dataset.mock.calls.find(([input]) => input.action === "invoke")![0],
    ).toMatchObject({
      workspaceId: "workspace-a",
      operationId: id(4),
      idempotencyKey: report.rows[0].idempotencyKey,
    });
    await waitFor(() =>
      expect(backend.deleteWorkspacePath).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        relativePath: request.relativePath,
      }),
    );
    expect(screen.getByText(/1 accepted · 0 refused/)).toBeTruthy();
    expect(screen.queryByText(`Saved in this workspace: ${request.relativePath}`)).toBeNull();
  });
  it("keeps the retry report when a row is not confirmed", async () => {
    backend.createWorkspaceFile.mockImplementation(async (input: { relativePath: string }) => ({
      path: input.relativePath,
    }));
    await setup();
    backend.dataset.mockImplementation(async (input) =>
      input.action === "describe"
        ? { kind: "description", dataset }
        : Promise.reject(Error("Offline")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save retry report and import" }));
    await screen.findByText(/0 accepted · 0 refused · 1 uncertain/);
    const path = backend.createWorkspaceFile.mock.calls[0]![0].relativePath;
    expect(screen.getByText(`Saved in this workspace: ${path}`)).toBeTruthy();
    expect(backend.deleteWorkspacePath).not.toHaveBeenCalled();
  });
  it("does not begin import or repaint after the workspace changes during report save", async () => {
    const saved = deferred<{ path: string }>();
    backend.createWorkspaceFile.mockImplementation(() => saved.promise);
    const { rerender, props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Save retry report and import" }));
    await waitFor(() => expect(backend.createWorkspaceFile).toHaveBeenCalledOnce());
    rerender(<ConnectedTransactionalCollection {...props} workspaceId="workspace-b" />);
    await act(async () => saved.resolve({ path: "old-report.json" }));
    expect(backend.dataset.mock.calls.filter(([input]) => input.action === "invoke")).toHaveLength(
      0,
    );
    expect(screen.queryByText("Saved in this workspace: old-report.json")).toBeNull();
    expect(props.onError).not.toHaveBeenCalled();
  });
});

it("opens archived metadata without running records and offers owner restore", async () => {
  backend.dataset.mockImplementation(async (input) =>
    input.action === "describe"
      ? { kind: "description", dataset: { ...dataset, archived: true, operations: [] } }
      : { kind: "lifecycle-updated", archived: false, generation: 2 },
  );
  const onLifecycleChanged = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
      onLifecycleChanged={onLifecycleChanged}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Restore Collection" }));
  await waitFor(() => expect(onLifecycleChanged).toHaveBeenCalledOnce());
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "invoke")).toBe(false);
  expect(backend.dataset).toHaveBeenCalledWith({
    action: "describe",
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    includeArchived: true,
  });
});

it("loads owner pending responses and requires confirmation before clearing a saved retry", async () => {
  let cleared = false;
  backend.dataset.mockImplementation(async (input) => {
    if (input.action === "describe") return { kind: "description", dataset };
    if (input.action === "approval") return ownerApproval;
    if (input.action === "pendingAttempts")
      return {
        kind: "pending-attempts",
        datasetId: dataset.datasetId,
        entries: cleared
          ? []
          : [
              {
                reference: "b".repeat(64),
                operation: "Submit",
                recordedAtMs: 1000,
                revision: 2,
                outcome: "committed",
                attachmentCount: 0,
              },
            ],
        nextAfter: null,
      };
    cleared = true;
    return { kind: "attempt-reconciled", cleared: true };
  });
  const onNotice = vi.fn(),
    onError = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onNotice={onNotice}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Pending responses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Clear retry" }));
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "reconcileAttempt")).toBe(
    false,
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear retry" }),
  );
  await screen.findByText("No pending responses.");
  expect(backend.dataset).toHaveBeenCalledWith({
    action: "pendingAttempts",
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    expectedDatasetId: id(1),
    limit: 50,
  });
  expect(backend.dataset).toHaveBeenCalledWith({
    action: "reconcileAttempt",
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    expectedDatasetId: id(1),
    reference: "b".repeat(64),
    acknowledge: true,
  });
  expect(onNotice).toHaveBeenCalledWith("Cleared the saved response's retry");
  expect(onError).not.toHaveBeenCalled();
});

it.each([
  { owner: false, offline: false },
  { owner: true, offline: true },
])(
  "hides pending review and recovery export for $owner owner and $offline offline",
  async ({ owner, offline }) => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset, copy: { offline } });
    render(
      <ConnectedTransactionalCollection
        role={owner ? "owner" : "member"}
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    await screen.findByLabelText("Collection view state");
    expect(screen.queryByText("Opening Collection…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pending responses" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export recovery" })).toBeNull();
  },
);

it.each([
  { role: "owner", fields: true, recovery: true },
  { role: "admin", fields: true, recovery: false },
  { role: "member", fields: false, recovery: false },
] as const)(
  "offers the $role the rule controls they can use",
  async ({ role, fields, recovery }) => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    render(
      <ConnectedTransactionalCollection
        role={role}
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    await screen.findByLabelText("Collection view state");
    expect(!!screen.queryByRole("button", { name: "Fields and names" })).toBe(fields);
    expect(!!screen.queryByRole("button", { name: "Export recovery" })).toBe(recovery);
  },
);

it("reports the saved recovery file through the shell notice callback", async () => {
  backend.dataset.mockImplementation(async (input) =>
    input.action === "describe"
      ? { kind: "description", dataset }
      : { kind: "exported", savedPath: "C:/private/fundraiser.dohc-recovery" },
  );
  const onNotice = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onNotice={onNotice}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Export recovery" }));
  fireEvent.click(screen.getByRole("button", { name: "Save recovery file" }));
  await waitFor(() =>
    expect(onNotice).toHaveBeenCalledWith(
      "Saved recovery file: C:/private/fundraiser.dohc-recovery",
    ),
  );
});

it("keeps archived offline Collections read-only until refresh reaches the host", async () => {
  backend.dataset
    .mockResolvedValueOnce({
      kind: "description",
      dataset: { ...dataset, archived: true },
      copy: { offline: true, host: "sync.example.test" },
    })
    .mockResolvedValue({ kind: "description", dataset: { ...dataset, archived: true } });
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  const restore = await screen.findByRole("button", { name: "Restore Collection" });
  expect(restore.hasAttribute("disabled")).toBe(true);
  fireEvent.click(restore);
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "restore")).toBe(false);
  expect(screen.getByRole("status").textContent).toBe(
    "Offline copy · Restoring needs sync.example.test",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Restore Collection" }).hasAttribute("disabled"),
    ).toBe(false),
  );
});

it("cancels an unconfirmed response only after owner acknowledgement and reports confirmation", async () => {
  let cancelled = false;
  backend.dataset.mockImplementation(async (input) => {
    if (input.action === "describe") return { kind: "description", dataset };
    if (input.action === "approval") return ownerApproval;
    if (input.action === "pendingAttempts")
      return {
        kind: "pending-attempts",
        datasetId: dataset.datasetId,
        entries: cancelled
          ? []
          : [
              {
                reference: "c".repeat(64),
                operation: "Submit",
                recordedAtMs: null,
                revision: null,
                outcome: "unconfirmed",
                attachmentCount: 0,
              },
            ],
        nextAfter: null,
      };
    cancelled = true;
    return { kind: "attempt-cancelled", cancelled: true };
  });
  const onNotice = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onNotice={onNotice}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Pending responses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel response" }));
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "cancelAttempt")).toBe(
    false,
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel response" }),
  );
  await screen.findByText("No pending responses.");
  expect(backend.dataset).toHaveBeenCalledWith({
    action: "cancelAttempt",
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    expectedDatasetId: id(1),
    reference: "c".repeat(64),
    acknowledge: true,
  });
  expect(onNotice).toHaveBeenCalledWith("Cancelled the pending response");
});

const deletionPreview = () => ({
  kind: "delete-preview",
  cursor: {
    workspaceId: "workspace-a",
    datasetId: id(1),
    hostEpoch: "host",
    approvedRevisionHash: "a".repeat(64),
    revision: 3,
    digest: "b".repeat(64),
  },
  reviewToken: "c".repeat(64),
  name: "Fundraiser",
  archived: true,
  generation: 2,
  reason: "done",
  apps: [{ appId: "form", binding: { operationIds: [id(4)] } }],
  nextCursor: null,
  irreversible: true,
});
it("deletes an archived Collection with its reviewed cursor and updates the shell", async () => {
  backend.dataset.mockImplementation(async (input) => {
    if (input.action === "describe")
      return { kind: "description", dataset: { ...dataset, archived: true } };
    if (input.action === "deletePreview") return deletionPreview();
    return { kind: "deleted", deleted: true, datasetId: id(1) };
  });
  const onNotice = vi.fn(),
    onLifecycleChanged = vi.fn(),
    onError = vi.fn();
  render(
    <ConnectedTransactionalCollection
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={onError}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
      onNotice={onNotice}
      onLifecycleChanged={onLifecycleChanged}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" }));
  await screen.findByText("form");
  expect(backend.dataset.mock.calls.some(([input]) => input.action === "delete")).toBe(false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  await screen.findByText("Collection deleted");
  expect(backend.dataset).toHaveBeenCalledWith({
    action: "delete",
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    expectedDatasetId: id(1),
    expected: deletionPreview().cursor,
    reviewToken: "c".repeat(64),
    acknowledge: true,
  });
  expect(onLifecycleChanged).toHaveBeenCalledOnce();
  expect(onNotice).toHaveBeenCalledWith("Collection deleted");
  expect(onError).not.toHaveBeenCalled();
});
it.each([
  { owner: false, offline: false },
  { owner: true, offline: true },
])("hides permanent delete for $owner owner and $offline offline", async ({ owner, offline }) => {
  backend.dataset.mockResolvedValue({
    kind: "description",
    dataset: { ...dataset, archived: true },
    copy: { offline },
  });
  render(
    <ConnectedTransactionalCollection
      role={owner ? "owner" : "member"}
      workspaceId="workspace-a"
      datasetPath="data/dataset.json"
      tableId={id(2)}
      onError={vi.fn()}
      onFormCreated={vi.fn()}
      onOpenFile={vi.fn()}
      onOpenScheduleSettings={vi.fn()}
    />,
  );
  await screen.findByText("The Collection Fundraiser is archived");
  expect(screen.queryByRole("button", { name: "Delete permanently…" })).toBeNull();
});
it("does not report permanent deletion in a different workspace", async () => {
  const pending = deferred<{ kind: string; deleted: true; datasetId: string }>();
  backend.dataset.mockImplementation(async (input) => {
    if (input.action === "describe")
      return { kind: "description", dataset: { ...dataset, archived: true } };
    if (input.action === "deletePreview") return deletionPreview();
    return pending.promise;
  });
  const props = {
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    tableId: id(2),
    onError: vi.fn(),
    onFormCreated: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenScheduleSettings: vi.fn(),
    onNotice: vi.fn(),
    onLifecycleChanged: vi.fn(),
  };
  const view = render(<ConnectedTransactionalCollection {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently…" }));
  await screen.findByText("form");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  view.rerender(<ConnectedTransactionalCollection {...props} workspaceId="workspace-b" />);
  await act(async () => pending.resolve({ kind: "deleted", deleted: true, datasetId: id(1) }));
  expect(props.onNotice).not.toHaveBeenCalled();
  expect(props.onLifecycleChanged).not.toHaveBeenCalled();
  expect(props.onError).not.toHaveBeenCalled();
  expect(screen.queryByText("Collection deleted")).toBeNull();
});

function buttonApproval() {
  const CONFIRM = {
    operationId: id(7),
    tableId: id(2),
    name: "registrations.confirm",
    label: "Confirm",
    kind: "action" as const,
    access: "owner" as const,
    readOnly: false,
    fieldIds: [],
  };
  const before: DatasetDescription = { ...dataset, operations: [...dataset.operations, CONFIRM] };
  const after: DatasetDescription = {
    ...before,
    revision: 2,
    revisionSha256: "e".repeat(64),
    tables: [
      {
        ...before.tables[0]!,
        fields: [...before.tables[0]!.fields, { fieldId: id(8), name: "Confirm", type: "button" }],
      },
    ],
  };
  const definition = {
    formatVersion: 1 as const,
    datasetId: id(1),
    name: "Fundraiser",
    schemaPath: "Fundraiser/schema.sql",
    operationsPath: "Fundraiser/operations.js",
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
            type: "text" as const,
            required: true,
            unique: true,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(9),
        name: "read",
        label: "Read",
        tableId: id(2),
        kind: "read" as const,
        access: "owner" as const,
        readOnly: true,
        fieldIds: [id(3)],
      },
    ],
  };
  const previousRevision = {
    datasetId: id(1),
    revision: 1,
    revisionSha256: before.revisionSha256,
    definitionSha256: "b".repeat(64),
    schemaSha256: "c".repeat(64),
    operationsSha256: "d".repeat(64),
    definition,
  };
  const nextRevision = {
    ...structuredClone(previousRevision),
    revision: 2,
    revisionSha256: after.revisionSha256,
  };
  nextRevision.definition.tables[0]!.fields.push({
    fieldId: id(8),
    name: "Confirm",
    type: "button",
  } as never);
  const expected = {
    workspaceId: "workspace-a",
    datasetId: id(1),
    hostEpoch: "epoch",
    revision: 4,
    digest: "f".repeat(64),
    approvedRevisionHash: before.revisionSha256,
  };
  const preparation = {
    preparationId: id(10),
    previousRevision,
    revision: nextRevision,
    expected,
    sourceDigest: "a".repeat(64),
    approvalDigest: "b".repeat(64),
    schemaSql: "schema",
    operationSource: "source",
    migrationSql: "SELECT 1;",
    expiresAtMs: Date.now() + 600_000,
    candidate: {
      candidateId: id(11),
      expected,
      approvedRevisionHash: after.revisionSha256,
      checkpointSha256: "a".repeat(64),
      changeSha256: "d".repeat(64),
      expiresAtMs: Date.now() + 600_000,
      preview: {
        tables: [
          {
            table: "registrations",
            beforeRows: 0,
            afterRows: 0,
            changedRows: 0,
            deletedRows: 0,
            beforeValues: {},
            afterValues: {},
            clearedValues: {},
          },
        ],
        firstPage: { changes: [], nextCursor: null },
      },
    },
  };
  return { before, after, preparation, CONFIRM };
}

describe("a dataset table's ⚡ panel", () => {
  const onTable = (
    automationId: string,
    table: string,
  ): Extract<ListCollectionAutomationsResult, { status: "read" }>["automations"][number] => ({
    valid: true,
    automationId: `collection:Fundraiser#${automationId}`,
    definitionHash: "0123456789abcdef",
    cannotRun: null,
    reach: { kind: "checked", steps: [] },
    lastRun: null,
    automation: {
      id: automationId,
      name: automationId,
      enabled: true,
      when: { kind: "record-added", table },
      if: null,
      do: [
        {
          kind: "set",
          values: [{ field: "Name", value: { kind: "literal", value: "Welcome" } }],
          records: null,
          operation: null,
        },
      ],
    },
  });
  const renderPage = () =>
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );

  it("names the automations file from Customize… once dohc finds the dataset's folder", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({ status: "missing" });
    renderPage();
    const customize = await screen.findByRole("button", { name: "Customize…" });
    customize.focus();
    fireEvent.click(customize);
    const dialog = await screen.findByRole("dialog", { name: "Customize Registrations" });
    expect(within(dialog).getByText("Fundraiser/automations.yaml")).toBeTruthy();
    expect(within(dialog).getByText("Created with your first automation")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Open automations.yaml" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(customize);
  });

  it("finds the dataset's folder, counts this table's automations, and lists them in the panel", async () => {
    const donors = { tableId: id(9), name: "Donors", fields: dataset.tables[0]!.fields };
    backend.dataset.mockResolvedValue({
      kind: "description",
      dataset: { ...dataset, tables: [...dataset.tables, donors] },
    });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [onTable("welcome", "Registrations"), onTable("thank", "Donors")],
    });
    renderPage();
    const button = await screen.findByTestId("collection-automations-button");
    await waitFor(() => expect(button.textContent).toBe("Automations1"));
    expect(backend.findDatasetCollection).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      datasetId: id(1),
    });
    expect(backend.listCollectionAutomations).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      collectionPath: "Fundraiser",
    });
    fireEvent.click(button);
    await screen.findByTestId("automation-welcome");
    expect(screen.queryByTestId("automation-thank")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId("collection-automations-panel")).toBeNull());
  });

  it.each([
    [
      {
        status: "cannot-run",
        reason: "This Collection's rules are not approved yet, so its automations cannot run.",
      },
      "This Collection's rules are not approved yet, so its automations cannot run.",
    ],
    [{ status: "unavailable" }, "This Collection's automations run on its owner's computer."],
  ] as Array<[FindDatasetCollectionResult, string]>)(
    "says why the panel has no automations to show when main answers %o",
    async (found, sentence) => {
      backend.dataset.mockResolvedValue({ kind: "description", dataset });
      backend.findDatasetCollection.mockResolvedValue(found);
      renderPage();
      fireEvent.click(await screen.findByTestId("collection-automations-button"));
      expect((await screen.findByTestId("collection-automations-panel")).textContent).toContain(
        sentence,
      );
      expect(backend.listCollectionAutomations).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Close automations" }));
      expect(screen.queryByTestId("collection-automations-panel")).toBeNull();
    },
  );

  it("opens the builder on a button nothing uses from Fields and names, with the button as its trigger", async () => {
    const withButton: DatasetDescription = {
      ...dataset,
      tables: [
        {
          ...dataset.tables[0]!,
          fields: [
            ...dataset.tables[0]!.fields,
            { fieldId: id(6), name: "Confirm", type: "button" },
          ],
        },
      ],
    };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [],
    });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({
      buttons: [
        {
          field: "Confirm",
          table: "Registrations",
          state: { kind: "no-automation", reason: "No automation uses this button." },
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose action: Confirm" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(
      "Confirm",
    );
    expect(
      (within(panel).getByRole("combobox", { name: "Trigger" }) as HTMLSelectElement).value,
    ).toBe("button");
    expect(
      (within(panel).getByRole("combobox", { name: "Button" }) as HTMLSelectElement).value,
    ).toBe("Confirm");
  });

  it("closes for a record the page opens, and keeps its place and its draft when the person keeps editing", async () => {
    const withButton: DatasetDescription = {
      ...dataset,
      tables: [
        {
          ...dataset.tables[0]!,
          fields: [
            ...dataset.tables[0]!.fields,
            { fieldId: id(6), name: "Confirm", type: "button" },
          ],
        },
      ],
    };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [],
    });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({
      buttons: [
        {
          field: "Confirm",
          table: "Registrations",
          state: { kind: "no-automation", reason: "No automation uses this button." },
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open a record" }));
    expect(handoff.opened).toBe(1);
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose action: Confirm" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    fireEvent.change(within(panel).getByRole("textbox", { name: "Name" }), {
      target: { value: "Confirm twice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open a record" }));
    fireEvent.click(
      within(await screen.findByTestId("automation-unsaved")).getByRole("button", {
        name: "Keep editing",
      }),
    );
    expect(handoff.opened).toBe(1);
    expect(
      (
        within(screen.getByTestId("collection-automations-panel")).getByRole("textbox", {
          name: "Name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Confirm twice");
    fireEvent.click(screen.getByTestId("collection-automations-button"));
    fireEvent.click(
      within(await screen.findByTestId("automation-unsaved")).getByRole("button", {
        name: "Discard",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("collection-automations-panel")).toBeNull());
    expect(handoff.opened).toBe(1);
    fireEvent.click(screen.getByTestId("collection-automations-button"));
    await screen.findByTestId("collection-automations-panel");
    fireEvent.click(screen.getByRole("button", { name: "Open a record" }));
    await waitFor(() => expect(screen.queryByTestId("collection-automations-panel")).toBeNull());
    expect(handoff.opened).toBe(2);
  });

  it("adds an action as a button, closes Fields after approval, and opens the builder on it, saving nothing before Save", async () => {
    const { before, after, preparation } = buttonApproval();
    let current = before;
    backend.dataset.mockImplementation(async (input: { action: string }) => {
      if (input.action === "describe") return { kind: "description", dataset: current };
      if (input.action === "prepareSchemaChange")
        return { kind: "migration-prepared", ...preparation };
      if (input.action === "approveMigration") {
        current = after;
        return { kind: "migrated" };
      }
      throw new Error(`Unexpected ${input.action}`);
    });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [],
    });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [] });
    const onError = vi.fn();
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add as button: Confirm" }));
    // A button changes only names, so its review asks for no confirmation checkbox.
    fireEvent.click(await screen.findByRole("button", { name: "Approve change" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Fields and names" })).toBeNull(),
    );
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(
      "Confirm",
    );
    expect(
      (within(panel).getByRole("combobox", { name: "Step 1, action" }) as HTMLSelectElement).value,
    ).toBe("registrations.confirm");
    expect(
      (within(panel).getByRole("textbox", { name: "Step 1, input 1 name" }) as HTMLInputElement)
        .value,
    ).toBe("id");
    expect(
      (within(panel).getByRole("textbox", { name: "Step 1, id, formula" }) as HTMLInputElement)
        .value,
    ).toBe("record.id");
    expect(document.activeElement).toBe(within(panel).getByRole("textbox", { name: "Name" }));
    expect(screen.queryByRole("heading", { name: "Review Collection change" })).toBeNull();
    expect(backend.writeCollectionAutomations).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ["open", false],
    ["closed", true],
  ])(
    "reads the Collection again on Try again for a refused field change with Fields %s, then prepares it",
    async (_state, close) => {
      const { before, preparation } = buttonApproval();
      const moved: DatasetDescription = { ...before, revision: 2, revisionSha256: "9".repeat(64) };
      let current = before;
      backend.dataset.mockImplementation(
        async (input: { action: string; revisionSha256?: string }) => {
          if (input.action === "describe") return { kind: "description", dataset: current };
          if (input.action === "prepareSchemaChange") {
            if (input.revisionSha256 !== current.revisionSha256)
              throw new Error(
                "Collection rules changed. Refresh the Collection before changing fields.",
              );
            return {
              kind: "migration-prepared",
              ...preparation,
              previousRevision: {
                ...preparation.previousRevision,
                revision: 2,
                revisionSha256: current.revisionSha256,
              },
            };
          }
          throw new Error(`Unexpected ${input.action}`);
        },
      );
      backend.findDatasetCollection.mockResolvedValue({
        status: "found",
        collectionPath: "Fundraiser",
      });
      backend.listCollectionAutomations.mockResolvedValue({
        status: "read",
        contentHash: "b".repeat(64),
        addsStay: [],
        automations: [],
      });
      backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
      backend.listAutomationButtons.mockResolvedValue({ buttons: [] });
      const onError = vi.fn();
      render(
        <ConnectedTransactionalCollection
          workspaceId="workspace-a"
          datasetPath="data/dataset.json"
          tableId={id(2)}
          onError={onError}
          onFormCreated={vi.fn()}
          onOpenFile={vi.fn()}
          onOpenScheduleSettings={vi.fn()}
        />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
      // The rules change somewhere else, as from the CLI, which tells this page nothing.
      current = moved;
      fireEvent.click(await screen.findByRole("button", { name: "Add as button: Confirm" }));
      await waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          "dohc could not prepare this field change.",
          expect.any(Error),
          expect.any(Function),
        ),
      );
      if (close) {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog", { name: "Fields and names" })).toBeNull();
      }
      await act(async () => {
        (onError.mock.calls[0]![2] as () => void)();
      });
      expect(await screen.findByRole("button", { name: "Approve change" })).toBeTruthy();
      const calls = backend.dataset.mock.calls
        .map(([input]) => input as { action: string; revisionSha256?: string })
        .filter((call) => call.action !== "approval");
      expect(calls.map((call) => call.action)).toEqual([
        "describe",
        "prepareSchemaChange",
        "describe",
        "prepareSchemaChange",
      ]);
      expect(calls[3]!.revisionSha256).toBe(moved.revisionSha256);
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );

  it("prepares a refused field change on Try again though the rules changed again while the page read the Collection", async () => {
    const { before, preparation } = buttonApproval();
    const moved: DatasetDescription = { ...before, revision: 2, revisionSha256: "9".repeat(64) };
    const rulesChanged: Array<(event: { workspaceId: string; datasetId: string }) => void> = [];
    backend.onCollectionRulesChanged.mockImplementation((listener) => {
      rulesChanged.push(listener);
      return () => undefined;
    });
    let current = before;
    let holding = false;
    const reads: Array<PromiseWithResolvers<void>> = [];
    backend.dataset.mockImplementation(
      async (input: { action: string; revisionSha256?: string }) => {
        if (input.action === "describe") {
          if (holding) {
            const read = Promise.withResolvers<void>();
            reads.push(read);
            await read.promise;
          }
          return { kind: "description", dataset: current };
        }
        if (input.action === "prepareSchemaChange") {
          if (input.revisionSha256 !== current.revisionSha256)
            throw new Error(
              "Collection rules changed. Refresh the Collection before changing fields.",
            );
          return {
            kind: "migration-prepared",
            ...preparation,
            previousRevision: {
              ...preparation.previousRevision,
              revision: 2,
              revisionSha256: current.revisionSha256,
            },
          };
        }
        throw new Error(`Unexpected ${input.action}`);
      },
    );
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [],
    });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [] });
    const onError = vi.fn();
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    current = moved;
    fireEvent.click(await screen.findByRole("button", { name: "Add as button: Confirm" }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "dohc could not prepare this field change.",
        expect.any(Error),
        expect.any(Function),
      ),
    );
    holding = true;
    act(() => {
      (onError.mock.calls[0]![2] as () => void)();
    });
    act(() => {
      for (const listener of rulesChanged)
        listener({ workspaceId: "workspace-a", datasetId: id(1) });
    });
    await waitFor(() => expect(reads).toHaveLength(2));
    holding = false;
    await act(async () => reads[0]!.resolve());
    await act(async () => reads[1]!.resolve());
    expect(await screen.findByRole("button", { name: "Approve change" })).toBeTruthy();
    const calls = backend.dataset.mock.calls
      .map(([input]) => input as { action: string; revisionSha256?: string })
      .filter((call) => call.action !== "approval");
    expect(calls.at(-1)).toMatchObject({
      action: "prepareSchemaChange",
      revisionSha256: moved.revisionSha256,
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fills in the action named for a button nothing uses when Choose what it does opens the builder", async () => {
    const { before } = buttonApproval();
    const withButton: DatasetDescription = {
      ...before,
      tables: [
        {
          ...before.tables[0]!,
          fields: [
            ...before.tables[0]!.fields,
            { fieldId: id(8), name: "Confirm", type: "button" },
          ],
        },
      ],
    };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: withButton });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [],
    });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({
      buttons: [
        {
          field: "Confirm",
          table: "Registrations",
          state: { kind: "no-automation", reason: "No automation uses this button." },
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose action: Confirm" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    const name = within(panel).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(
      (within(panel).getByRole("combobox", { name: "Step 1, action" }) as HTMLSelectElement).value,
    ).toBe("registrations.confirm");
    expect(
      (within(panel).getByRole("textbox", { name: "Step 1, input 1 name" }) as HTMLInputElement)
        .value,
    ).toBe("id");
    expect(
      (within(panel).getByRole("textbox", { name: "Step 1, id, formula" }) as HTMLInputElement)
        .value,
    ).toBe("record.id");
  });

  it("fills in no step for a button whose name two actions share", async () => {
    const { before, CONFIRM } = buttonApproval();
    const twice: DatasetDescription = {
      ...before,
      operations: [
        ...before.operations,
        { ...CONFIRM, operationId: id(12), name: "registrations.confirmAgain" },
      ],
      tables: [
        {
          ...before.tables[0]!,
          fields: [
            ...before.tables[0]!.fields,
            { fieldId: id(8), name: "Confirm", type: "button" },
          ],
        },
      ],
    };
    backend.dataset.mockResolvedValue({ kind: "description", dataset: twice });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [],
    });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({
      buttons: [
        {
          field: "Confirm",
          table: "Registrations",
          state: { kind: "no-automation", reason: "No automation uses this button." },
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose action: Confirm" }));
    const panel = await screen.findByTestId("collection-automations-panel");
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(
      "Confirm",
    );
    expect(within(panel).queryByRole("combobox", { name: "Step 1, action" })).toBeNull();
  });

  it("neither refreshes nor opens the builder when the page closed before an approval finished", async () => {
    const { before, after, preparation } = buttonApproval();
    const approved = Promise.withResolvers<{ kind: "migrated" }>();
    let current = before;
    backend.dataset.mockImplementation(async (input: { action: string }) => {
      if (input.action === "describe") return { kind: "description", dataset: current };
      if (input.action === "prepareSchemaChange")
        return { kind: "migration-prepared", ...preparation };
      if (input.action === "approveMigration") {
        current = after;
        return await approved.promise;
      }
      throw new Error(`Unexpected ${input.action}`);
    });
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({
      status: "read",
      contentHash: "b".repeat(64),
      addsStay: [],
      automations: [],
    });
    backend.onAutomationRunSettled.mockImplementation(() => () => undefined);
    backend.listAutomationButtons.mockResolvedValue({ buttons: [] });
    const onError = vi.fn();
    const { unmount } = render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Fields and names" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add as button: Confirm" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve change" }));
    await waitFor(() =>
      expect(
        backend.dataset.mock.calls.some(([input]) => input.action === "approveMigration"),
      ).toBe(true),
    );
    const describes = backend.dataset.mock.calls.filter(
      ([input]) => input.action === "describe",
    ).length;
    unmount();
    await act(async () => approved.resolve({ kind: "migrated" }));
    expect(
      backend.dataset.mock.calls.filter(([input]) => input.action === "describe"),
    ).toHaveLength(describes);
    expect(onError).not.toHaveBeenCalled();
  });

  it("asks main for the dataset's folder only once the page has read its dataset, even when automations change first", async () => {
    const automationsChanged: Array<(event: { workspaceId: string }) => void> = [];
    backend.onCollectionAutomationsChanged.mockImplementation((listener) => {
      automationsChanged.push(listener);
      return () => undefined;
    });
    const described = deferred<{ kind: "description"; dataset: DatasetDescription }>();
    backend.dataset.mockReturnValue(described.promise);
    backend.findDatasetCollection.mockResolvedValue({
      status: "found",
      collectionPath: "Fundraiser",
    });
    backend.listCollectionAutomations.mockResolvedValue({ status: "missing" });
    const onError = vi.fn();
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    await waitFor(() => expect(automationsChanged.length).toBeGreaterThan(0));
    act(() => {
      for (const listener of automationsChanged) listener({ workspaceId: "workspace-a" });
    });
    expect(backend.findDatasetCollection).not.toHaveBeenCalled();
    await act(async () => described.resolve({ kind: "description", dataset }));
    await waitFor(() =>
      expect(backend.findDatasetCollection).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        datasetId: id(1),
      }),
    );
    expect(backend.findDatasetCollection).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("says when dohc could not find the automations, through the error hook and in the panel, and tries again", async () => {
    backend.dataset.mockResolvedValue({ kind: "description", dataset });
    backend.findDatasetCollection
      .mockRejectedValueOnce(new Error("engine stopped"))
      .mockResolvedValue({ status: "found", collectionPath: "Fundraiser" });
    backend.listCollectionAutomations.mockResolvedValue({ status: "missing" });
    const onError = vi.fn();
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByTestId("collection-automations-button"));
    const panel = await screen.findByTestId("collection-automations-panel");
    await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("false"));
    expect(panel.textContent).toContain("dohc could not read this Collection's automations.");
    expect(onError).toHaveBeenCalledWith(
      "dohc could not read this Collection's automations.",
      expect.any(Error),
      expect.any(Function),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No automations in this Collection yet.")).toBeTruthy();
  });
});

describe("a Collection this computer cannot use", () => {
  const refused = (code: string, words: string, computer?: string) =>
    new Error(
      `Error invoking remote method 'desktop:dataset': CollectionsRefusalError [${code}]${computer ? ` [computer=${computer}]` : ""}: ${words}`,
    );
  const props = {
    workspaceId: "workspace-a",
    datasetPath: "data/dataset.json",
    tableId: id(2),
    onFormCreated: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenScheduleSettings: vi.fn(),
  };

  it("says which computer keeps it in place, without a toast, and reads again on Try again", async () => {
    const words =
      "These Collections are on Laptop. Open this workspace there to use them, or to move them to a server.";
    backend.dataset.mockRejectedValueOnce(refused("collections-elsewhere", words, "Laptop"));
    const onError = vi.fn(),
      onKeepCollections = vi.fn();
    render(
      <ConnectedTransactionalCollection
        {...props}
        onError={onError}
        onKeepCollections={onKeepCollections}
      />,
    );
    expect((await screen.findByTestId("collection-refusal")).textContent).toContain(words);
    expect(screen.getByRole("button", { name: "Use this computer" })).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
    backend.dataset.mockResolvedValueOnce({ kind: "description", dataset });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByLabelText("Collection view state");
    expect(screen.queryByTestId("collection-refusal")).toBeNull();
  });

  it("keeps Collections no computer keeps on this one, then opens the Collection", async () => {
    backend.dataset.mockRejectedValueOnce(
      refused(
        "collections-unclaimed",
        "dohc doesn't know which computer keeps this workspace's Collections. To keep them on this computer, choose Use this computer in dohc.",
      ),
    );
    const onKeepCollections = vi.fn((then: () => void) => then());
    render(
      <ConnectedTransactionalCollection
        {...props}
        onError={vi.fn()}
        onKeepCollections={onKeepCollections}
      />,
    );
    backend.dataset.mockResolvedValueOnce({ kind: "description", dataset });
    fireEvent.click(await screen.findByRole("button", { name: "Use this computer" }));
    expect(onKeepCollections).toHaveBeenCalledOnce();
    await screen.findByLabelText("Collection view state");
  });

  it("offers no way to keep Collections here on a computer that joined, where that would make a second store", async () => {
    const words =
      "Another computer keeps this workspace's Collections. Open this workspace there to use them.";
    backend.dataset.mockRejectedValueOnce(refused("collections-joined", words));
    render(
      <ConnectedTransactionalCollection {...props} onError={vi.fn()} onKeepCollections={vi.fn()} />,
    );
    expect((await screen.findByTestId("collection-refusal")).textContent).toBe(words);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the server it needs in place, without a toast, when there is no saved copy, and reads again on Try again", async () => {
    const words = "This Collection needs sync.example.test, which dohc can't reach.";
    backend.dataset.mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'desktop:dataset': CollectionServerUnreachableError: ${words}`,
      ),
    );
    const onError = vi.fn();
    render(<ConnectedTransactionalCollection {...props} onError={onError} />);
    expect(await screen.findByText(words)).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
    backend.dataset.mockResolvedValueOnce({ kind: "description", dataset });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByLabelText("Collection view state");
    expect(screen.queryByText(words)).toBeNull();
  });

  it("stops showing records once a later read is refused", async () => {
    backend.dataset.mockResolvedValueOnce({ kind: "description", dataset });
    render(<ConnectedTransactionalCollection {...props} onError={vi.fn()} />);
    await screen.findByLabelText("Collection view state");
    backend.dataset.mockRejectedValueOnce(
      refused(
        "collections-replaced",
        "This computer keeps this workspace's Collections, but another copy replaced .dohc/local/datasets/state.sqlite.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    expect((await screen.findByTestId("collection-refusal")).textContent).toContain(
      "another copy replaced",
    );
    expect(screen.queryByLabelText("Collection view state")).toBeNull();
  });
});

describe("a read that waited for this Collection's move", () => {
  it("files one row naming the Collection, and takes it back when the Collection reads again", async () => {
    const waited = Error(
      "CollectionMoveUnfinishedError [waited]: This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.",
    );
    let describes = 0;
    backend.dataset.mockImplementation(async (input: { action: string }) => {
      if (input.action === "describe") {
        describes += 1;
        if (describes === 2) throw waited;
        return { kind: "description", dataset };
      }
      return { kind: "grant-updated" };
    });
    // Another request that waited for the move: the read again leaves it to its own Try again.
    backend.findDatasetCollection.mockRejectedValueOnce(waited);
    const onError = vi.fn(),
      onSettled = vi.fn();
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onSettled={onSettled}
        onNotice={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    const named =
      'CollectionMoveUnfinishedError [waited]: "Fundraiser" didn\'t finish moving to sync.example.test. Its records are kept on this computer.';
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.any(String), named, expect.any(Function)),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Refresh records" }));
    const row = "collection-open:data/dataset.json";
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "dohc could not open this Collection.",
        named,
        expect.any(Function),
        row,
      ),
    );
    onSettled.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    await waitFor(() => expect(describes).toBe(3));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(row));
    expect(backend.findDatasetCollection).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe("relation label resolution through connected resolver", () => {
  it("omits empty search and requests up to 100 related records to display labels in table cells", async () => {
    const membersTableId = id(20);
    const memberPkId = id(21);
    const memberNameId = id(22);
    const readMembersOpId = id(23);
    const expensesTableId = id(24);
    const expensePkId = id(25);
    const expenseTitleId = id(26);
    const paidByFieldId = id(27);
    const readExpensesOpId = id(28);
    const multiTableDataset: DatasetDescription = {
      datasetId: id(1),
      name: "Split",
      revision: 1,
      revisionSha256: "a".repeat(64),
      tables: [
        {
          tableId: membersTableId,
          name: "Members",
          fields: [
            { fieldId: memberPkId, name: "ID", type: "text", required: true, unique: true },
            { fieldId: memberNameId, name: "Name", type: "text", required: true, unique: false },
          ],
        },
        {
          tableId: expensesTableId,
          name: "Expenses",
          fields: [
            { fieldId: expensePkId, name: "ID", type: "text", required: true, unique: true },
            { fieldId: expenseTitleId, name: "Title", type: "text", required: true, unique: false },
            {
              fieldId: paidByFieldId,
              name: "Paid by",
              type: "relation",
              required: false,
              unique: false,
              relation: {
                datasetId: id(1),
                tableId: membersTableId,
                fieldId: memberPkId,
                many: false,
              },
            },
          ],
        },
      ],
      operations: [
        {
          operationId: readMembersOpId,
          name: "listMembers",
          label: "List members",
          tableId: membersTableId,
          kind: "read",
          access: "owner",
          readOnly: true,
          fieldIds: [memberPkId, memberNameId],
        },
        {
          operationId: readExpensesOpId,
          name: "listExpenses",
          label: "List expenses",
          tableId: expensesTableId,
          kind: "read",
          access: "owner",
          readOnly: true,
          fieldIds: [expensePkId, expenseTitleId, paidByFieldId],
        },
      ],
    };
    const memberReads: unknown[] = [];
    backend.dataset.mockImplementation(
      async (input: { action: string; operationId?: string; input?: unknown }) => {
        if (input.action === "describe") return { kind: "description", dataset: multiTableDataset };
        if (input.action === "invoke" && input.operationId === readExpensesOpId) {
          return {
            kind: "invoked",
            result: {
              rows: [
                {
                  id: "exp-1",
                  version: 1,
                  values: {
                    [expensePkId]: "exp-1",
                    [expenseTitleId]: "Lunch",
                    [paidByFieldId]: "mem-1",
                  },
                },
              ],
              nextCursor: null,
            },
            revision: 1,
            replayed: false,
          };
        }
        if (input.action === "invoke" && input.operationId === readMembersOpId) {
          memberReads.push(input.input);
          const count = (input.input as { limit?: number })?.limit === 100 ? 51 : 1;
          return {
            kind: "invoked",
            result: {
              rows: Array.from({ length: count }, (_, index) => ({
                id: `mem-${index + 1}`,
                version: 1,
                values: { [memberPkId]: `mem-${index + 1}`, [memberNameId]: `Member ${index + 1}` },
              })),
              nextCursor: null,
            },
            revision: 1,
            replayed: false,
          };
        }
        return { kind: "grant-updated" };
      },
    );
    render(
      <ConnectedTransactionalCollection
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={expensesTableId}
        onError={vi.fn()}
        onNotice={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
    await screen.findByLabelText("Collection view state");
    expect(pageResolveRelation.current).toBeTruthy();
    const resolved = await pageResolveRelation.current!(
      {
        workspaceId: "workspace-a",
        datasetId: id(1),
        revision: 1,
        revisionSha256: "a".repeat(64),
        fieldId: paidByFieldId,
        search: "",
        limit: 100,
      },
      new AbortController().signal,
    );
    expect(resolved.options).toHaveLength(51);
    expect(resolved.options[0]).toEqual({ value: "mem-1", label: "Member 1" });
    expect(resolved.options[50]).toEqual({ value: "mem-51", label: "Member 51" });
    expect(resolved.hasMore).toBe(false);
    expect(memberReads).toEqual([{ limit: 100 }]);
    await pageResolveRelation.current!(
      {
        workspaceId: "workspace-a",
        datasetId: id(1),
        revision: 1,
        revisionSha256: "a".repeat(64),
        fieldId: paidByFieldId,
        search: "Al",
        limit: 20,
      },
      new AbortController().signal,
    );
    expect(memberReads).toEqual([{ limit: 100 }, { limit: 20, search: "Al" }]);
  });
});

describe("who approved a Collection's rules", () => {
  const approval = (
    approvedBy: object | null,
    needsOwnerConfirmation = false,
    revisionSha256 = dataset.revisionSha256,
  ) => ({ kind: "approval", revisionSha256, approvedBy, needsOwnerConfirmation });
  const renderPage = (owner: boolean | "admin", onError = vi.fn(), onSettled = vi.fn()) =>
    render(
      <ConnectedTransactionalCollection
        role={owner === "admin" ? "admin" : owner ? "owner" : "member"}
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={onError}
        onSettled={onSettled}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />,
    );
  const answer = (
    approved: ReturnType<typeof approval> | (() => never),
    confirmed?: ReturnType<typeof approval> | (() => never),
    described: DatasetDescription = dataset,
  ) =>
    backend.dataset.mockImplementation(async (input: { action: string }) => {
      const result =
        input.action === "approval"
          ? approved
          : input.action === "confirmApproval"
            ? confirmed
            : { kind: "description", dataset: { ...described } };
      return typeof result === "function" ? result() : result;
    });
  const formerAda = { role: "admin", name: "Ada", former: true, approvedAtMs: 1 };

  it.each([
    [{ role: "admin", name: "Ada", former: false, approvedAtMs: 1 }, "Approved by Ada · Admin"],
    [formerAda, "Approved by Ada · former Admin"],
    [{ role: "admin", name: null, former: false, approvedAtMs: 1 }, "Approved by an Admin"],
    [{ role: "admin", name: null, former: true, approvedAtMs: 1 }, "Approved by a former Admin"],
  ])("names an Admin who approved them beside the Collection's status", async (by, line) => {
    answer(approval(by));
    renderPage(true);
    expect((await screen.findByTestId("collection-approved-by")).textContent).toBe(line);
    expect(screen.queryByTestId("collection-confirm-approval")).toBeNull();
  });

  it("says nothing when the Owner approved them, and reads nothing for a member", async () => {
    answer(approval({ role: "owner", name: "Owner", former: false, approvedAtMs: 1 }));
    renderPage(true);
    await waitFor(() =>
      expect(backend.dataset).toHaveBeenCalledWith(expect.objectContaining({ action: "approval" })),
    );
    expect(screen.queryByTestId("collection-approved-by")).toBeNull();
    cleanup();
    backend.dataset.mockClear();
    renderPage(false);
    await screen.findByLabelText("Collection view state");
    expect(backend.dataset).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "approval" }),
    );
  });

  it("follows a role change while the page is open", async () => {
    answer(approval(formerAda));
    const page = (role: "admin" | "member") => (
      <ConnectedTransactionalCollection
        role={role}
        workspaceId="workspace-a"
        datasetPath="data/dataset.json"
        tableId={id(2)}
        onError={vi.fn()}
        onFormCreated={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenScheduleSettings={vi.fn()}
      />
    );
    const view = render(page("member"));
    await screen.findByLabelText("Collection view state");
    expect(screen.queryByTestId("collection-approved-by")).toBeNull();
    view.rerender(page("admin"));
    expect((await screen.findByTestId("collection-approved-by")).textContent).toBe(
      "Approved by Ada · former Admin",
    );
    view.rerender(page("member"));
    await waitFor(() => expect(screen.queryByTestId("collection-approved-by")).toBeNull());
  });

  it("names the approver to an Admin, and leaves confirming to the Owner", async () => {
    answer(approval(formerAda, true));
    renderPage("admin");
    expect((await screen.findByTestId("collection-approved-by")).textContent).toBe(
      "Approved by Ada · former Admin",
    );
    expect(screen.queryByTestId("collection-confirm-approval")).toBeNull();
  });

  it("stops naming who approved them when reading that again fails", async () => {
    answer(approval({ role: "admin", name: "Ada", former: false, approvedAtMs: 1 }));
    renderPage(true);
    await screen.findByTestId("collection-approved-by");
    answer(() => {
      throw Error("offline");
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    await waitFor(() => expect(screen.queryByTestId("collection-approved-by")).toBeNull());
    const reread = Promise.withResolvers<ReturnType<typeof approval>>();
    answer(() => reread.promise as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    await waitFor(() =>
      expect(
        backend.dataset.mock.calls.filter(([input]) => input.action === "approval"),
      ).toHaveLength(3),
    );
    expect(screen.queryByTestId("collection-approved-by")).toBeNull();
    await act(async () =>
      reread.resolve(approval({ role: "admin", name: "Ada", former: false, approvedAtMs: 1 })),
    );
    expect(await screen.findByTestId("collection-approved-by")).toBeTruthy();
  });

  it("clears a failed confirmation once another computer confirmed, and reports nothing after the page closes", async () => {
    const former = approval(formerAda, true);
    answer(former, () => {
      throw Error("conflict");
    });
    const onError = vi.fn(),
      onSettled = vi.fn();
    const page = renderPage(true, onError, onSettled);
    fireEvent.click(
      within(await screen.findByTestId("collection-confirm-approval")).getByRole("button", {
        name: "Confirm approval",
      }),
    );
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    onSettled.mockClear();
    answer(approval({ role: "owner", name: "Owner", former: false, approvedAtMs: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    await waitFor(() =>
      expect(onSettled).toHaveBeenCalledWith("collection-approval:data/dataset.json"),
    );
    expect(screen.queryByTestId("collection-confirm-approval")).toBeNull();

    const refused = Promise.withResolvers<never>();
    answer(former, () => refused.promise as never);
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    fireEvent.click(
      within(await screen.findByTestId("collection-confirm-approval")).getByRole("button", {
        name: "Confirm approval",
      }),
    );
    await waitFor(() =>
      expect(backend.dataset).toHaveBeenCalledWith(
        expect.objectContaining({ action: "confirmApproval" }),
      ),
    );
    page.unmount();
    await act(async () => {
      refused.reject(Error("conflict"));
      await refused.promise.catch(() => undefined);
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("shows the rules the Owner confirms: a newer approval refreshes the Collection first", async () => {
    const renamed = structuredClone({ ...dataset, revision: 2, revisionSha256: "b".repeat(64) });
    renamed.tables[0]!.fields[0]!.name = "Guest";
    const newer = approval(formerAda, true, renamed.revisionSha256);
    let described = 0;
    backend.dataset.mockImplementation(async (input: { action: string }) => {
      if (input.action === "approval") return newer;
      described++;
      return { kind: "description", dataset: described === 1 ? dataset : renamed };
    });
    renderPage(true);
    await waitFor(() => expect(described).toBe(2));
    expect(await screen.findByTestId("collection-confirm-approval")).toBeTruthy();
    expect(
      screen.getByLabelText("Collection view state").getAttribute("data-fields")?.split(",")[0],
    ).toBe("Guest");
  });

  it("names no approver and offers no confirmation for rules the page isn't showing", async () => {
    answer(approval(formerAda, true, "b".repeat(64)));
    renderPage(true);
    await waitFor(() =>
      expect(
        backend.dataset.mock.calls.filter(([input]) => input.action === "describe"),
      ).toHaveLength(2),
    );
    expect(screen.queryByTestId("collection-confirm-approval")).toBeNull();
    expect(screen.queryByTestId("collection-approved-by")).toBeNull();
  });

  it("lets the Owner confirm rules a former Admin approved, and refreshes the Collection when that fails", async () => {
    const former = approval(formerAda, true);
    const confirmed = approval({ role: "owner", name: "Owner", former: false, approvedAtMs: 2 });
    answer(former, () => {
      throw Error("conflict");
    });
    const onError = vi.fn();
    renderPage(true, onError);
    const notice = await screen.findByTestId("collection-confirm-approval");
    expect(screen.getByTestId("collection-approved-by").textContent).toBe(
      "Approved by Ada · former Admin",
    );
    expect(notice.textContent).toBe(
      "Ada approved these rules and is no longer an Admin. They keep running. Confirm to approve them as yourself.Confirm approval",
    );
    fireEvent.click(within(notice).getByRole("button", { name: "Confirm approval" }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const [words, , retry, identity] = onError.mock.calls[0]! as [
      string,
      unknown,
      () => void,
      string,
    ];
    expect(words).toBe("dohc could not confirm this approval.");
    expect(identity).toBe("collection-approval:data/dataset.json");
    backend.dataset.mockClear();
    answer(former, confirmed);
    act(() => retry());
    await waitFor(() =>
      expect(backend.dataset).toHaveBeenCalledWith(expect.objectContaining({ action: "describe" })),
    );
    expect(backend.dataset).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "confirmApproval" }),
    );
    fireEvent.click(
      within(await screen.findByTestId("collection-confirm-approval")).getByRole("button", {
        name: "Confirm approval",
      }),
    );
    answer(confirmed, confirmed);
    await waitFor(() => expect(screen.queryByTestId("collection-confirm-approval")).toBeNull());
    expect(backend.dataset).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirmApproval",
        revisionSha256: dataset.revisionSha256,
      }),
    );
  });
});

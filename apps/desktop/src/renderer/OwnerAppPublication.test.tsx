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
import userEvent from "@testing-library/user-event";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import type {
  CloudStatusResult,
  ListRelayShareLinksResult,
  SyncStatusResult,
} from "../ipc/bridgeContract";
import type {
  OwnerAppPublicationRequest,
  OwnerAppPublicationResult,
} from "../ipc/ownerAppPublicationContract";
import { deferred } from "../testing/deferred";
import { OwnerAppPublication as Control, appLinkUrl } from "./OwnerAppPublication";
import { WorkspaceSessionProvider } from "./workspace/workspaceSession";

function Session({ children }: { children: ReactNode }) {
  return <WorkspaceSessionProvider workspaceId="ws-trip">{children}</WorkspaceSessionProvider>;
}

const render = (ui: ReactElement) => renderBare(ui, { wrapper: Session });

const prepared: Extract<OwnerAppPublicationResult, { kind: "prepared" }> = {
  kind: "prepared",
  approvalId: "af28e679-fb6e-4b69-b852-c6f643e5d7ac",
  candidateDigest: "a".repeat(64),
  appRoot: "trip",
  versionId: "main",
  sourceRevision: "b".repeat(64),
  sourcePaths: ["trip/main.tsx", "trip/style.css"],
  capabilities: [],
  externalNetwork: true,
};
const published: Extract<OwnerAppPublicationResult, { kind: "published" }> = {
  kind: "published",
  publicationId: "c".repeat(64),
  authorityRevision: 1,
};
const approvedCollection = {
  kind: "collection-create" as const,
  collectionPath: "trip/responses",
  schemaSha256: "a".repeat(64),
  allowedFields: ["destination"],
  requiredFields: ["destination"],
  readFields: ["destination"],
};
const datasetCapability = {
  kind: "dataset" as const,
  name: "Orders",
  datasetId: "00000000-0000-4000-8000-000000000001",
  revision: 1,
  revisionSha256: "a".repeat(64),
  operationIds: ["00000000-0000-4000-8000-000000000002"],
  operations: [
    {
      operationId: "00000000-0000-4000-8000-000000000002",
      name: "submit",
      access: "link" as const,
      readOnly: false,
    },
  ],
};
const datasetRow = {
  publicationId: published.publicationId,
  authorityRevision: 1,
  shareId: "share-trip",
  grantId: "grant-trip",
  active: true,
  linkCurrent: true,
  audience: "link" as const,
  datasetCapabilities: [datasetCapability],
  collectionCapability: null,
  manifestUnavailable: false as const,
  appRoot: "trip",
  sourceRevision: "b".repeat(64),
};
const row: ListRelayShareLinksResult["links"][number] = {
  shareId: "share-trip",
  grantId: "grant-trip",
  generation: 1,
  status: "active",
  createdAtMs: 1,
  revokedAtMs: null,
  lastUsedAtMs: null,
  url: null,
  urlIssuedAtMs: 1,
  dependents: [],
  selector: { paths: ["trip"], versionId: null },
  access: "view",
};
const page: ListRelayShareLinksResult = {
  supportedLinkAccess: ["view", "comment"],
  links: [row],
  independentGrants: [],
};
const syncedStatus: SyncStatusResult = {
  state: "synced",
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
  liveSessionsGeneration: 0,
  historyRecordingUnavailable: false,
  historyShareView: false,
};
async function answer(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult> {
  if (request.action === "list") return { kind: "listed", publications: [], nextCursor: null };
  if (request.action === "listLocal") return { kind: "localListed", publications: [] };
  if (request.action === "prepareLocal") return { ...prepared, local: true };
  if (request.action === "prepare" || request.action === "reviewReactivation") return prepared;
  if (request.action === "approve") return published;
  if (request.action === "withdraw")
    return { kind: "withdrawn", publicationId: published.publicationId, authorityRevision: 2 };
  return { kind: "cancelled" };
}
const datasetAnswer = async (_request?: { action?: string }): Promise<unknown> => ({
  kind: "list",
  datasets: [
    {
      datasetId: datasetCapability.datasetId,
      datasetPath: "data/dataset.json",
      datasetAddressStatus: "available",
    },
  ],
  nextCursor: null,
});
const api = {
  dataset: vi.fn(datasetAnswer),
  listRelayShareLinks: vi.fn(async (): Promise<ListRelayShareLinksResult> => page),
  publishOwnerApp: vi.fn(answer),
  openExternalUrl: vi.fn(async () => undefined),
  cloudStatus: vi.fn(async (): Promise<CloudStatusResult> => ({
    connected: true,
    workspaceSynced: true,
  })),
  getSyncStatus: vi.fn(async (): Promise<SyncStatusResult> => syncedStatus),
};
const actions = (action: OwnerAppPublicationRequest["action"]) =>
  api.publishOwnerApp.mock.calls.map(([input]) => input).filter((input) => input.action === action);
const audiences = (card: HTMLElement, action: string) => {
  const row = Array.from(card.querySelectorAll("tbody tr")).find(
    (tr) => tr.querySelector("th[scope=row]")?.textContent === action,
  );
  if (!row) throw Error(`No row for ${action} in ${card.textContent}`);
  return Array.from(row.querySelectorAll("td"), (cell) => cell.textContent);
};

// The page owns whether the dialog is open.
function OwnerAppPublication(
  props: Omit<ComponentProps<typeof Control>, "open" | "onOpenChange" | "testId">,
) {
  const context = `${props.workspaceId}\0${props.appRoot}`;
  const [openFor, setOpenFor] = useState<string | null>(null);
  return (
    <Control
      {...props}
      open={openFor === context}
      onOpenChange={(open) => setOpenFor(open ? context : null)}
      testId="app-view-review"
    />
  );
}

async function open() {
  await userEvent.setup().click(screen.getByRole("button", { name: "Review app" }));
  await waitFor(() => expect(screen.queryByText("Loading links…")).toBeNull());
}
async function review() {
  await open();
  await userEvent
    .setup()
    .selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
  await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
  await screen.findByRole("heading", { name: "Review app publication" });
}

describe("owner app publication", () => {
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", api);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    api.listRelayShareLinks.mockResolvedValue(page);
    api.publishOwnerApp.mockImplementation(answer);
    api.cloudStatus.mockResolvedValue({ connected: true, workspaceSynced: true });
    api.getSyncStatus.mockResolvedValue(syncedStatus);
    api.dataset.mockImplementation(datasetAnswer);
  });

  it("reviews exact source and network consequences before approval", async () => {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "prepare")).toEqual([
      [
        {
          action: "prepare",
          workspaceId: "ws-trip",
          appRoot: "trip",
          shareId: row.shareId,
          grantId: row.grantId,
        },
      ],
    ]);
    expect(screen.getByTestId("app-publication-source-paths").textContent).toContain(
      "trip/main.tsx",
    );
    expect(
      screen.getByText("The app can use external services and send them data it receives."),
    ).toBeTruthy();
    expect(screen.getByTestId("app-publication-digest").textContent).toBe(prepared.candidateDigest);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Review app publication" }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
    await screen.findByText("App published on the selected link.");
    expect(api.publishOwnerApp).toHaveBeenCalledWith({
      action: "approve",
      workspaceId: "ws-trip",
      approvalId: prepared.approvalId,
      candidateDigest: prepared.candidateDigest,
    });
  });

  it.each([approvedCollection, "unavailable" as const])(
    "confirms revocation of %s, sends the displayed revision, and keeps the app published",
    async (currentCapability) => {
      let revision = 7;
      api.publishOwnerApp.mockImplementation(async (request) => {
        if (request.action === "list")
          return {
            kind: "listed",
            publications: [
              {
                publicationId: published.publicationId,
                authorityRevision: revision,
                shareId: row.shareId,
                grantId: row.grantId,
                active: true,
                audience: "link" as const,
                datasetCapabilities: [],
                collectionCapability: revision === 7 ? currentCapability : null,
                linkCurrent: true,
                manifestUnavailable: false,
                appRoot: "trip",
                sourceRevision: prepared.sourceRevision,
              },
            ],
            nextCursor: null,
          };
        if (request.action === "revokeCollection") {
          revision++;
          return {
            kind: "collectionRevoked",
            publicationId: published.publicationId,
            authorityRevision: revision,
          };
        }
        return answer(request);
      });
      render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
      await open();
      if (currentCapability !== "unavailable") {
        expect(screen.getByText("destination (required)")).toBeTruthy();
        expect(
          screen.getByText(
            "People with this share can read every response file and all its fields.",
          ),
        ).toBeTruthy();
      }
      fireEvent.click(
        screen.getByRole("button", { name: `Revoke Collection access ${published.publicationId}` }),
      );
      expect(
        api.publishOwnerApp.mock.calls.some(([input]) => input.action === "revokeCollection"),
      ).toBe(false);
      expect(
        screen.getByText(
          /Saved responses stay in your workspace, and copies already received cannot be removed\./,
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
      await screen.findByText(
        "App Collection access revoked. Prepare the app again to review and restore access.",
      );
      expect(api.publishOwnerApp).toHaveBeenCalledWith({
        action: "revokeCollection",
        workspaceId: "ws-trip",
        publicationId: published.publicationId,
        expectedAuthorityRevision: 7,
      });
      expect(
        screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }),
      ).toBeTruthy();
      await screen.findByText("No Collection access");
      expect(
        screen.queryByRole("button", {
          name: `Revoke Collection access ${published.publicationId}`,
        }),
      ).toBeNull();
    },
  );

  it("does not show a late revocation result in another workspace", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    api.publishOwnerApp.mockImplementation(async (request) => {
      if (request.action === "list")
        return {
          kind: "listed",
          publications:
            request.workspaceId === "ws-trip"
              ? [
                  {
                    publicationId: published.publicationId,
                    authorityRevision: 7,
                    shareId: row.shareId,
                    grantId: row.grantId,
                    active: true,
                    audience: "link" as const,
                    datasetCapabilities: [],
                    collectionCapability: approvedCollection,
                    linkCurrent: true,
                    manifestUnavailable: false,
                    appRoot: "trip",
                    sourceRevision: prepared.sourceRevision,
                  },
                ]
              : [],
          nextCursor: null,
        };
      if (request.action === "revokeCollection") return pending.promise;
      return answer(request);
    });
    const view = render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    fireEvent.click(
      screen.getByRole("button", { name: `Revoke Collection access ${published.publicationId}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    view.rerender(<OwnerAppPublication workspaceId="ws-other" appRoot="other" />);
    await open();
    await act(async () =>
      pending.resolve({
        kind: "collectionRevoked",
        publicationId: published.publicationId,
        authorityRevision: 8,
      }),
    );
    expect(
      screen.queryByText(
        "App Collection access revoked. Prepare the app again to review and restore access.",
      ),
    ).toBeNull();
  });

  it("never paints workspace A's pending preparation in workspace B", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    api.publishOwnerApp.mockImplementation((request) =>
      request.action === "prepare" ? pending.promise : answer(request),
    );
    const view = render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    fireEvent.change(screen.getByLabelText("Publication share link"), {
      target: { value: row.grantId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare app" }));
    view.rerender(<OwnerAppPublication workspaceId="ws-other" appRoot="other" />);
    await act(async () => {
      pending.resolve(prepared);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({
      action: "cancel",
      workspaceId: "ws-trip",
      approvalId: prepared.approvalId,
    });
  });

  it("reviews a stored revision before explicitly republishing after withdrawal", async () => {
    let active = true;
    api.publishOwnerApp.mockImplementation(async (request) => {
      if (request.action === "list")
        return {
          kind: "listed",
          publications: [
            {
              ...published,
              shareId: row.shareId,
              grantId: row.grantId,
              appRoot: "trip",
              sourceRevision: prepared.sourceRevision,
              active,
              authorityRevision: active ? 7 : 8,
              audience: "link" as const,
              datasetCapabilities: [],
              collectionCapability: null,
              linkCurrent: true,
              manifestUnavailable: false,
            },
          ],
          nextCursor: null,
        };
      if (request.action === "withdraw") active = false;
      if (request.action === "approve") active = true;
      return answer(request);
    });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }));
    expect(api.publishOwnerApp.mock.calls.some(([input]) => input.action === "withdraw")).toBe(
      false,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Unpublish app" }));
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Review and republish" }));
    await screen.findByText(
      "Republish this stored revision. It does not include later source edits.",
    );
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({
      action: "reviewReactivation",
      workspaceId: "ws-trip",
      publicationId: published.publicationId,
    });
    expect(api.publishOwnerApp.mock.calls.some(([input]) => input.action === "approve")).toBe(
      false,
    );
    expect(screen.getByTestId("app-publication-digest").textContent).toBe(prepared.candidateDigest);
    await userEvent.setup().click(screen.getByRole("button", { name: "Republish this revision" }));
    await screen.findByText("App republished.");
    expect(api.publishOwnerApp).toHaveBeenCalledWith({
      action: "approve",
      workspaceId: "ws-trip",
      approvalId: prepared.approvalId,
      candidateDigest: prepared.candidateDigest,
    });
  });

  it("finds a Collection again from its newest Try again, and not from an older one", async () => {
    const reportError =
      vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
    const failed = deferred<unknown>();
    const found = deferred<unknown>();
    api.dataset.mockReturnValueOnce(failed.promise).mockReturnValueOnce(found.promise);
    api.publishOwnerApp.mockImplementation((request) =>
      request.action === "prepare"
        ? Promise.resolve({ ...prepared, capabilities: [datasetCapability] })
        : answer(request),
    );
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" reportError={reportError} />);
    await review();
    const scope = screen.getByTestId("app-publication-capability");
    expect(scope.textContent).toContain("Finding Collection…");
    await act(async () => failed.reject(new Error("engine stopped")));
    expect(scope.textContent).toContain("Collection path unavailable");
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]![0]).toBe("dohc could not find this Collection.");
    const tryAgain = reportError.mock.calls[0]![2]!;
    act(tryAgain);
    expect(scope.textContent).toContain("Finding Collection…");
    await waitFor(() => expect(api.dataset).toHaveBeenCalledTimes(2));
    act(tryAgain);
    await act(async () => found.resolve(await datasetAnswer()));
    expect(scope.textContent).toContain("data/dataset.json");
    expect(api.dataset).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("loads plain-English action descriptions for published dataset details only after expanding, without blocking Unpublish", async () => {
    const historyPending = deferred<unknown>();
    const definition = {
      formatVersion: 1 as const,
      datasetId: datasetCapability.datasetId,
      name: "Orders",
      schemaPath: "data/schema.sql",
      operationsPath: "data/operations.js",
      tables: [
        {
          tableId: "00000000-0000-4000-8000-000000000020",
          name: "Orders",
          sqlName: "orders",
          primaryKey: "id",
          fields: [
            {
              fieldId: "00000000-0000-4000-8000-000000000021",
              name: "ID",
              sqlColumn: "id",
              type: "text" as const,
              required: true,
              unique: true,
            },
            {
              fieldId: "00000000-0000-4000-8000-000000000022",
              name: "Item",
              sqlColumn: "item",
              type: "text" as const,
              required: true,
              unique: false,
            },
          ],
        },
      ],
      operations: [
        {
          operationId: datasetCapability.operations[0]!.operationId,
          name: "submit",
          label: "Submit order",
          tableId: "00000000-0000-4000-8000-000000000020",
          kind: "create" as const,
          access: "link" as const,
          readOnly: false,
          fieldIds: ["00000000-0000-4000-8000-000000000022"],
        },
      ],
    };
    api.dataset.mockImplementation(async (request) => {
      if (request?.action === "historyRevision") return historyPending.promise;
      return datasetAnswer();
    });
    api.publishOwnerApp.mockImplementation(async (request) =>
      request.action === "list"
        ? { kind: "listed", publications: [datasetRow], nextCursor: null }
        : answer(request),
    );
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(
      screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }),
    ).toBeTruthy();
    expect(api.dataset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Approved Collection access"));
    await waitFor(() =>
      expect(api.dataset).toHaveBeenCalledWith({
        action: "historyRevision",
        workspaceId: "ws-trip",
        datasetPath: "data/dataset.json",
        revisionSha256: datasetCapability.revisionSha256,
      }),
    );
    const card = screen.getByTestId("app-publication-capability");
    expect(audiences(card, "submit")).toEqual(["Yes", "Yes", "Yes"]);
    await act(async () =>
      historyPending.resolve({
        kind: "history-revision",
        revision: {
          datasetId: datasetCapability.datasetId,
          definition,
          revision: datasetCapability.revision,
          revisionSha256: datasetCapability.revisionSha256,
          definitionSha256: "b".repeat(64),
          schemaSha256: "c".repeat(64),
          operationsSha256: "d".repeat(64),
        },
        schemaSql: "",
        operationSource: generateDatasetOperations(definition),
        generatedSources: true,
      }),
    );
    expect(audiences(card, "Adds recordsItem · submit")).toEqual(["Yes", "Yes", "Yes"]);
  });

  it("does not make field-level claims on published cards when schema triggers make sources custom", async () => {
    const definition: DatasetDefinition = {
      formatVersion: 1,
      datasetId: datasetCapability.datasetId,
      name: "Items",
      schemaPath: "data/schema.sql",
      operationsPath: "data/operations.js",
      tables: [
        {
          tableId: "00000000-0000-4000-8000-000000000020",
          name: "Items",
          sqlName: "items",
          primaryKey: "id",
          fields: [
            {
              fieldId: "00000000-0000-4000-8000-000000000021",
              name: "ID",
              sqlColumn: "id",
              type: "text",
              required: true,
              unique: true,
            },
            {
              fieldId: "00000000-0000-4000-8000-000000000022",
              name: "Item",
              sqlColumn: "item",
              type: "text",
              required: true,
              unique: false,
            },
          ],
        },
      ],
      operations: [
        {
          operationId: "00000000-0000-4000-8000-000000000002",
          name: "submit",
          label: "Submit",
          tableId: "00000000-0000-4000-8000-000000000020",
          kind: "create",
          access: "link",
          readOnly: false,
          fieldIds: ["00000000-0000-4000-8000-000000000022"],
        },
      ],
    };
    api.dataset.mockImplementation(async (request) => {
      if (request?.action === "historyRevision") {
        return {
          kind: "history-revision",
          revision: {
            datasetId: datasetCapability.datasetId,
            definition,
            revision: datasetCapability.revision,
            revisionSha256: datasetCapability.revisionSha256,
            definitionSha256: "b".repeat(64),
            schemaSha256: "c".repeat(64),
            operationsSha256: "d".repeat(64),
          },
          schemaSql: "CREATE TRIGGER custom_edit AFTER INSERT ON items BEGIN SELECT 1; END;",
          operationSource: generateDatasetOperations(definition),
          generatedSources: false,
        };
      }
      return datasetAnswer();
    });
    api.publishOwnerApp.mockImplementation(async (request) =>
      request.action === "list"
        ? { kind: "listed", publications: [datasetRow], nextCursor: null }
        : answer(request),
    );
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    fireEvent.click(screen.getByText("Approved Collection access"));
    await waitFor(() =>
      expect(screen.getByTestId("app-publication-capability").textContent).toContain(
        'Runs "Submit"',
      ),
    );
    expect(screen.getByTestId("app-publication-capability").textContent).not.toContain(
      "Adds records with Item",
    );
  });

  it("shows plain-English dataset action summaries and surfaces address warnings in the share-link review card", async () => {
    const datasetWithDisplay = {
      ...datasetCapability,
      operationIds: [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
      ],
      operations: [
        {
          operationId: "00000000-0000-4000-8000-000000000002",
          name: "submit",
          access: "link" as const,
          readOnly: false,
          display: { kind: "create" as const, label: "Submit", fields: ["Item", "Quantity"] },
        },
        {
          operationId: "00000000-0000-4000-8000-000000000003",
          name: "list",
          access: "helper" as const,
          readOnly: true,
          display: { kind: "read" as const, label: "View orders", fields: ["Item", "Status"] },
        },
        {
          operationId: "00000000-0000-4000-8000-000000000004",
          name: "cancel",
          access: "owner" as const,
          readOnly: false,
          display: { kind: "action" as const, label: "Cancel order", fields: [] },
        },
      ],
    };
    api.dataset.mockResolvedValueOnce({
      kind: "list",
      datasets: [
        {
          datasetId: datasetCapability.datasetId,
          datasetPath: null,
          datasetAddressStatus: "ambiguous",
        },
      ],
      nextCursor: null,
    });
    api.publishOwnerApp.mockImplementation((request) =>
      request.action === "prepare"
        ? Promise.resolve({ ...prepared, capabilities: [datasetWithDisplay] })
        : answer(request),
    );
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    const card = screen.getByTestId("app-publication-capability");
    expect(card.textContent).toContain(
      "Multiple dataset.json files name this Collection. Remove the duplicate file.",
    );
    expect(audiences(card, "Adds recordsItem, Quantity · submit")).toEqual(["Yes", "Yes", "Yes"]);
    expect(audiences(card, "Reads recordsItem, Status · list")).toEqual(["No", "Yes", "Yes"]);
    expect(audiences(card, 'Runs "Cancel order"cancel')).toEqual(["No", "No", "Yes"]);
    expect(card.textContent).toContain(
      "This app uses only this Collection's approved actions. Its responses appear in the same Collection, and approving this app does not change the Collection's rules.",
    );
    expect(card.querySelector("details")?.open).toBe(false);
    expect(
      screen.getByText(
        "Unpublishing stops new access through this app. It cannot remove copies sent elsewhere.",
      ),
    ).toBeTruthy();
  });

  it("shows the fixed collection capability before approving the unchanged digest", async () => {
    const capability = {
      kind: "collection-create" as const,
      collectionPath: "trip/responses",
      schemaSha256: "d".repeat(64),
      allowedFields: ["name", "place"],
      requiredFields: ["place"],
      readFields: ["place"],
    };
    api.publishOwnerApp.mockImplementation((request) =>
      request.action === "prepare"
        ? Promise.resolve({ ...prepared, capabilities: [capability] })
        : answer(request),
    );
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    const scope = screen.getByTestId("app-publication-capability");
    expect(scope.textContent).toContain("Creates records only in trip/responses");
    expect(scope.textContent).toContain("Adds recordsname, place (required)");
    expect(scope.textContent).toContain("Reads only");
    expect(scope.textContent).toContain("Reads recordsplace");
    expect(scope.textContent).toContain(
      "People with this share can read every response file and all its fields.",
    );
    expect(scope.textContent).toContain(capability.schemaSha256);
    expect(scope.textContent).toContain("cannot change or delete existing records");
    expect(
      screen.getByText(
        "Unpublishing stops new access through this app. The share link still opens its response files. Copies sent elsewhere stay.",
      ),
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
    expect(api.publishOwnerApp).toHaveBeenCalledWith({
      action: "approve",
      workspaceId: "ws-trip",
      approvalId: prepared.approvalId,
      candidateDigest: prepared.candidateDigest,
    });
  });

  it.each([undefined, [{ kind: "collection-create", collectionPath: "trip/responses" }]])(
    "refuses malformed or missing capabilities: %j",
    async (capabilities) => {
      api.publishOwnerApp.mockImplementation((request) =>
        request.action === "prepare"
          ? Promise.resolve({ ...prepared, capabilities } as unknown as OwnerAppPublicationResult)
          : answer(request),
      );
      render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
      await open();
      await userEvent
        .setup()
        .selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
      await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
      await screen.findByText(
        "dohc could not verify this app's data access. Prepare the app again.",
      );
      expect(screen.queryByRole("button", { name: "Publish this revision" })).toBeNull();
      expect(api.publishOwnerApp.mock.calls.some(([input]) => input.action === "approve")).toBe(
        false,
      );
      expect(api.publishOwnerApp).toHaveBeenCalledWith({
        action: "cancel",
        workspaceId: "ws-trip",
        approvalId: prepared.approvalId,
      });
    },
  );

  it("keeps concurrent removal results visible until every panel finishes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const ownerAppResponses = vi.fn(async (request: { action: string; grantId: string }) =>
      request.action === "list"
        ? {
            action: "list",
            acceptances: [
              {
                kind: "accepted",
                acceptanceId: request.grantId,
                objectId: "object",
                momentId: "moment",
                publicPrincipalId: "person",
                versionId: "main",
                collectionPath: "trip/responses",
                path: `trip/responses/${request.grantId}.md`,
                acceptedAtMs: 1,
              },
            ],
            nextAcceptanceId: null,
          }
        : request.grantId === "grant-1"
          ? first.promise
          : second.promise,
    );
    vi.stubGlobal("dohcDesktop", { ...api, ownerAppResponses });
    api.publishOwnerApp.mockImplementation(async (request) =>
      request.action === "list"
        ? {
            kind: "listed",
            publications: [1, 2].map((index) => ({
              publicationId: String(index).repeat(64),
              authorityRevision: 1,
              shareId: row.shareId,
              grantId: `grant-${index}`,
              appRoot: "trip",
              sourceRevision: prepared.sourceRevision,
              active: true,
              audience: "link" as const,
              datasetCapabilities: [],
              collectionCapability: approvedCollection,
              linkCurrent: true,
              manifestUnavailable: false,
            })),
            nextCursor: null,
          }
        : answer(request),
    );
    render(
      <OwnerAppPublication workspaceId="ws-trip" appRoot="trip" onShareSource={() => undefined} />,
    );
    await open();
    for (const button of screen.getAllByRole("button", { name: "Load responses" })) {
      fireEvent.click(button);
    }
    await screen.findByText("trip/responses/grant-2.md");
    for (const button of screen.getAllByRole("button", {
      name: /Remove this holder.s responses/,
    })) {
      fireEvent.click(button);
      fireEvent.click(screen.getByRole("button", { name: "Remove responses" }));
    }
    const blocked = () => {
      for (const name of [
        "Close",
        "Reload publications",
        "Prepare app",
        "Share app folder",
        "Cancel",
      ])
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.getByRole("dialog")).toBeTruthy();
    };
    blocked();
    await act(async () =>
      first.resolve({
        action: "undo",
        items: [{ acceptanceId: "grant-1", status: "deleted", momentId: "delete" }],
        nextCursor: null,
      }),
    );
    blocked();
    await act(async () =>
      second.resolve({
        action: "undo",
        items: [{ acceptanceId: "grant-2", status: "conflict" }],
        nextCursor: null,
      }),
    );
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      screen.getByText("1 removed. 0 already absent. 0 conflicts kept. 0 failed."),
    ).toBeTruthy();
    expect(
      screen.getByText("0 removed. 0 already absent. 1 conflict kept. 0 failed."),
    ).toBeTruthy();
  });

  describe("review on this device", () => {
    type LocalRow = Extract<
      OwnerAppPublicationResult,
      { kind: "localListed" }
    >["publications"][number];
    type Capability = Extract<
      OwnerAppPublicationResult,
      { kind: "prepared" }
    >["capabilities"][number];
    const listOperation = {
      operationId: "00000000-0000-4000-8000-000000000003",
      name: "list",
      access: "helper" as const,
      readOnly: true,
      display: { kind: "read" as const, label: "View orders", fields: ["Item", "Status"] },
    };
    const cancelOperation = {
      operationId: "00000000-0000-4000-8000-000000000007",
      name: "cancel",
      access: "link" as const,
      readOnly: false,
      display: { kind: "action" as const, label: "Cancel order", fields: [] },
    };
    const submitOperation = {
      ...datasetCapability.operations[0]!,
      display: { kind: "create" as const, label: "Submit", fields: ["Item", "Quantity"] },
    };
    const approvedAccess = {
      ...datasetCapability,
      operationIds: [listOperation.operationId, submitOperation.operationId],
      operations: [listOperation, submitOperation],
    };
    const grownAccess = {
      ...approvedAccess,
      operationIds: [...approvedAccess.operationIds, cancelOperation.operationId],
      operations: [listOperation, submitOperation, cancelOperation],
    };
    const localRow = {
      publicationId: "d".repeat(64),
      authorityRevision: 1,
      appRoot: "trip",
      sourceRevision: "b".repeat(64),
      datasetCapability: approvedAccess,
      approved: true,
      active: true,
    };
    const collectionRow = {
      publicationId: "d".repeat(64),
      authorityRevision: 1,
      appRoot: "trip",
      sourceRevision: "b".repeat(64),
      approved: true,
      active: true,
      collectionCapability: approvedCollection,
      pendingCreates: 0,
    };
    const checked: Extract<OwnerAppPublicationResult, { kind: "localChecked" }> = {
      kind: "localChecked",
      appRoot: "trip",
      sourceRevision: "b".repeat(64),
      sourcePaths: ["trip/app.publish.json", "trip/main.tsx", "shared/theme.css"],
    };
    const secondApproval = "0f6d2c1e-4b8a-4c3e-9d2f-1a2b3c4d5e6f";
    function local(
      rows: LocalRow[] = [],
      options: { revision?: string; capabilities?: Capability[] } = {},
    ) {
      return async (request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult> => {
        if (request.action === "listLocal") return { kind: "localListed", publications: rows };
        if (request.action === "checkLocal")
          return { ...checked, sourceRevision: options.revision ?? checked.sourceRevision };
        if (request.action === "prepareLocal")
          return {
            ...prepared,
            local: true,
            capabilities: options.capabilities ?? [approvedAccess],
          };
        if (request.action === "approve")
          return { ...published, publicationId: localRow.publicationId, local: true };
        if (request.action === "withdraw")
          return {
            kind: "withdrawn",
            publicationId: request.publicationId,
            authorityRevision: request.expectedAuthorityRevision + 1,
          };
        if (request.action === "launchLocal")
          return {
            kind: "localLaunched",
            publicationId: request.publicationId,
            url: "http://127.0.0.1:43123/",
          };
        return answer(request);
      };
    }
    function renderLocal(props: Partial<ComponentProps<typeof OwnerAppPublication>> = {}) {
      return render(
        <OwnerAppPublication
          workspaceId="ws-trip"
          appRoot="trip"
          title="Trip planner"
          localApproval="tab"
          {...props}
        />,
      );
    }
    const openLocal = () =>
      userEvent.setup().click(screen.getByRole("button", { name: "Review app" }));
    const stateText = async () => (await screen.findByTestId("app-review-state")).textContent;
    const approveButton = () => screen.getByTestId("app-publication-approve") as HTMLButtonElement;
    const ready = () => waitFor(() => expect(approveButton().disabled).toBe(false));
    const lines = (term: "Reads only" | "Changes data") =>
      Array.from(
        within(screen.getByTestId("app-access")).getByText(term).parentElement?.children ?? [],
        (line) => line.textContent,
      ).slice(1);
    const dialog = () => screen.queryByTestId("app-publication-dialog");

    it("asks for a first approval, shows what the app reaches, and approves and opens it", async () => {
      const onLocalChange = vi.fn();
      api.publishOwnerApp.mockImplementation(local());
      renderLocal({ onLocalChange });
      await openLocal();
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2, name: "Trip planner" }),
      );
      expect(await stateText()).toBe(
        "Approve this app to run it on this device.Later source edits wait for your approval.",
      );
      await ready();
      expect(approveButton().textContent).toBe("Approve and open");
      expect(actions("prepareLocal")).toEqual([
        { action: "prepareLocal", workspaceId: "ws-trip", appRoot: "trip" },
      ]);
      expect(actions("checkLocal")).toEqual([
        { action: "checkLocal", workspaceId: "ws-trip", appRoot: "trip" },
      ]);
      const access = screen.getByTestId("app-access");
      expect(within(access).getByText("Orders")).toBeTruthy();
      expect(lines("Reads only")).toEqual(["Reads recordsItem, Status"]);
      expect(lines("Changes data")).toEqual(["Adds recordsItem, Quantity"]);
      expect(within(access).queryByText("New")).toBeNull();
      expect(screen.getByTestId("app-access-boundary").textContent).toBe(
        "Uses only this Collection's approved actions. It cannot read other workspace files.",
      );
      expect(access.textContent).toContain("It can send what it receives to other websites.");
      expect(screen.getByRole("heading", { name: "What it can reach" })).toBeTruthy();
      expect(await screen.findByRole("heading", { name: "Share links" })).toBeTruthy();
      expect(screen.getByText("Not on a link")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove approval" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(screen.queryByText("That share isn't available anymore.")).toBeNull();
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(dialog()).toBeNull());
      expect(actions("approve")).toEqual([
        {
          action: "approve",
          workspaceId: "ws-trip",
          approvalId: prepared.approvalId,
          candidateDigest: prepared.candidateDigest,
        },
      ]);
      expect(onLocalChange).toHaveBeenCalled();
      expect(actions("cancel")).toEqual([]);
      expect(actions("launchLocal")).toEqual([]);
      expect(api.openExternalUrl).not.toHaveBeenCalled();
    });

    it.each([
      [
        "no workspace data",
        [] as Capability[],
        "Cannot read or change workspace files or Collections.",
      ],
      [
        "collection-create",
        [approvedCollection] as Capability[],
        "Cannot change or delete existing records, or read other workspace files.",
      ],
    ])(
      "states the accurate boundary line for %s",
      async (_label, capabilities, expectedBoundary) => {
        api.publishOwnerApp.mockImplementation(local([], { capabilities }));
        renderLocal();
        await openLocal();
        await ready();
        expect(screen.getByTestId("app-access-boundary").textContent).toBe(expectedBoundary);
      },
    );

    it("marks newly added fields when changed source widens createFields on an existing operation", async () => {
      const restrictedSubmit = {
        ...submitOperation,
        display: { kind: "create" as const, label: "Submit", fields: ["Item"] },
      };
      const narrowApproval = {
        ...approvedAccess,
        operations: [listOperation, restrictedSubmit],
        createFields: [
          {
            operationId: submitOperation.operationId,
            fieldIds: ["00000000-0000-4000-8000-000000000010"],
          },
        ],
      };
      api.publishOwnerApp.mockImplementation(
        local([{ ...localRow, datasetCapability: narrowApproval }], {
          revision: "e".repeat(64),
          capabilities: [approvedAccess],
        }),
      );
      renderLocal();
      await openLocal();
      await ready();
      expect(lines("Changes data")).toEqual(["Adds recordsItem, QuantityNew"]);
      expect(within(screen.getByTestId("app-access")).getAllByText("New")).toHaveLength(1);
    });

    it("marks a widened createFields operation even when display metadata is unavailable", async () => {
      const bareSubmit = datasetCapability.operations[0]!;
      const narrowApproval = {
        ...datasetCapability,
        operations: [bareSubmit],
        createFields: [
          {
            operationId: bareSubmit.operationId,
            fieldIds: ["00000000-0000-4000-8000-000000000010"],
          },
        ],
      };
      api.publishOwnerApp.mockImplementation(
        local([{ ...localRow, datasetCapability: narrowApproval }], {
          revision: "e".repeat(64),
          capabilities: [datasetCapability],
        }),
      );
      renderLocal();
      await openLocal();
      await ready();
      expect(lines("Changes data")).toEqual(["RecordsNew"]);
      expect(within(screen.getByTestId("app-access")).getAllByText("New")).toHaveLength(1);
    });

    it("marks what changed source adds and approves the changes", async () => {
      api.publishOwnerApp.mockImplementation(
        local([localRow], { revision: "e".repeat(64), capabilities: [grownAccess] }),
      );
      renderLocal();
      await openLocal();
      expect(await stateText()).toBe(
        "The app's source changed since you approved it.The app runs the approved version until you approve the changes.",
      );
      await ready();
      expect(approveButton().textContent).toBe("Approve changes");
      expect(lines("Reads only")).toEqual(["Reads recordsItem, Status"]);
      expect(lines("Changes data")).toEqual([
        "Adds recordsItem, Quantity",
        'Runs "Cancel order"New',
      ]);
      expect(within(screen.getByTestId("app-access")).getAllByText("New")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Remove approval" })).toBeTruthy();
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(dialog()).toBeNull());
      expect(actions("approve")).toHaveLength(1);
    });

    it("keeps an unconfirmed removal distinct from success and retries at its ending revision", async () => {
      const reportError =
        vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
      let ended = false;
      const answers = local();
      api.publishOwnerApp.mockImplementation(async (request) => {
        if (request.action === "listLocal")
          return {
            kind: "localListed",
            publications: [
              ended
                ? {
                    ...collectionRow,
                    authorityRevision: 2,
                    approved: false,
                    active: false,
                    pendingCreates: 1,
                  }
                : collectionRow,
            ],
          };
        if (request.action === "withdraw") {
          ended = true;
          return request.expectedAuthorityRevision === 1
            ? {
                kind: "withdrawalUnconfirmed",
                publicationId: collectionRow.publicationId,
                authorityRevision: 2,
                unresolvedCreates: 2,
              }
            : {
                kind: "withdrawn",
                publicationId: collectionRow.publicationId,
                authorityRevision: 2,
              };
        }
        return answers(request);
      });
      renderLocal({ reportError });
      await openLocal();
      await stateText();
      await userEvent.setup().click(screen.getByRole("button", { name: "Remove approval" }));
      await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
      expect(reportError).toHaveBeenCalledWith(
        "dohc removed this app's approval but has not confirmed whether 2 responses were saved.",
        undefined,
        expect.any(Function),
      );
      await screen.findByText("1 response not yet confirmed");
      const rowRetry = () =>
        within(screen.getByText("1 response not yet confirmed").parentElement!).getByRole(
          "button",
          { name: "Try again" },
        ) as HTMLButtonElement;
      expect(screen.queryByText(/Its data is not active here/)).toBeNull();
      await act(async () => reportError.mock.calls[0]![2]!());
      await waitFor(() => expect(actions("withdraw")).toHaveLength(2));
      expect(actions("withdraw").at(-1)).toEqual({
        action: "withdraw",
        workspaceId: "ws-trip",
        publicationId: collectionRow.publicationId,
        expectedAuthorityRevision: 2,
      });
      await waitFor(() => expect(rowRetry().disabled).toBe(false));
      await userEvent.setup().click(rowRetry());
      await waitFor(() => expect(actions("withdraw")).toHaveLength(3));
      expect(actions("withdraw").at(-1)).toEqual({
        action: "withdraw",
        workspaceId: "ws-trip",
        publicationId: collectionRow.publicationId,
        expectedAuthorityRevision: 2,
      });
    });

    it("shows a failed approval in place and approves a fresh candidate on retry", async () => {
      const reportError = vi.fn();
      let preparations = 0,
        approvals = 0;
      const answers = local();
      api.publishOwnerApp.mockImplementation(async (request) => {
        if (request.action === "prepareLocal")
          return {
            ...prepared,
            local: true,
            capabilities: [approvedAccess],
            approvalId: ++preparations === 1 ? prepared.approvalId : secondApproval,
          };
        if (request.action === "approve" && ++approvals === 1)
          throw new Error("This app preparation expired. Prepare the app again.");
        return answers(request);
      });
      renderLocal({ reportError });
      await openLocal();
      await ready();
      await userEvent.setup().click(approveButton());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("dohc could not approve this app. Try again.");
      expect(alert.className).toContain("text-right");
      expect(alert.getAttribute("title")).toBe(
        "This app preparation expired. Prepare the app again.",
      );
      expect(alert.nextElementSibling?.tagName).toBe("FOOTER");
      expect(reportError).not.toHaveBeenCalled();
      expect(dialog()).toBeTruthy();
      expect(await stateText()).toContain("Approve this app to run it on this device.");
      await waitFor(() => expect(actions("prepareLocal")).toHaveLength(2));
      await ready();
      expect(actions("cancel")).toEqual([]);
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(dialog()).toBeNull());
      expect(
        actions("approve").map((input) => input.action === "approve" && input.approvalId),
      ).toEqual([prepared.approvalId, secondApproval]);
    });

    it("refuses and cancels a candidate that is not this app's local one", async () => {
      const reportError = vi.fn();
      const answers = local();
      api.publishOwnerApp.mockImplementation(async (request) =>
        request.action === "prepareLocal" ? { ...prepared, appRoot: "other" } : answers(request),
      );
      renderLocal({ reportError });
      await openLocal();
      await waitFor(() =>
        expect(reportError).toHaveBeenCalledWith(
          "dohc could not prepare this app.",
          expect.any(Error),
          expect.any(Function),
        ),
      );
      expect(actions("cancel")).toEqual([
        { action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId },
      ]);
      expect(approveButton().disabled).toBe(true);
    });

    it("moves through the dialog from the title, and Escape cancels the candidate and returns focus", async () => {
      api.publishOwnerApp.mockImplementation(local());
      renderLocal();
      await openLocal();
      await ready();
      await screen.findByRole("button", { name: "Publish on a link" });
      const user = userEvent.setup();
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2, name: "Trip planner" }),
      );
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "2 files" }));
      await user.tab();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Publish on a link" }),
      );
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
      await user.tab();
      expect(document.activeElement).toBe(approveButton());
      fireEvent.keyDown(document, { key: "Escape" });
      expect(dialog()).toBeNull();
      expect(api.publishOwnerApp).toHaveBeenLastCalledWith({
        action: "cancel",
        workspaceId: "ws-trip",
        approvalId: prepared.approvalId,
      });
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review app" })),
      );
    });

    const accessFor = (connected: boolean, connect: () => void = vi.fn()) => ({
      server: "https://sync.example.org",
      context: {
        facts: {
          cloud: { connected, workspaceSynced: true, workspaceSyncConnected: connected },
          shareView: false,
        },
        openSyncSettings: vi.fn(),
        connect,
      },
    });

    it("reads the links once the workspace's server connects", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      const view = renderLocal({ access: accessFor(false) });
      await openLocal();
      await screen.findByTestId("app-links-signed-out");
      expect(actions("list")).toEqual([]);
      view.rerender(
        <OwnerAppPublication
          workspaceId="ws-trip"
          appRoot="trip"
          title="Trip planner"
          localApproval="tab"
          access={accessFor(true)}
        />,
      );
      await waitFor(() =>
        expect(actions("list")).toEqual([
          { action: "list", workspaceId: "ws-trip", appRoot: "trip" },
        ]),
      );
      expect(await screen.findByRole("button", { name: "Publish on a link" })).toBeTruthy();
      expect(screen.queryByTestId("app-links-signed-out")).toBeNull();
    });

    it.each([
      ["workspace", { workspaceId: "ws-other" }],
      ["app", { appRoot: "trip-two" }],
    ])("ignores a links answer for the %s the dialog no longer shows", async (_, next) => {
      const stale = deferred<OwnerAppPublicationResult>();
      api.publishOwnerApp.mockImplementation(async (request) => {
        if (
          request.action === "list" &&
          request.workspaceId === "ws-trip" &&
          request.appRoot === "trip"
        )
          return stale.promise;
        const answer = await local([localRow])(request);
        if (answer.kind === "localListed" && request.action === "listLocal")
          return { ...answer, publications: [{ ...localRow, appRoot: request.appRoot }] };
        if (answer.kind === "localChecked" && request.action === "checkLocal")
          return { ...answer, appRoot: request.appRoot };
        return answer;
      });
      const props = {
        workspaceId: "ws-trip",
        appRoot: "trip",
        title: "Trip planner",
        localApproval: "tab" as const,
        open: true,
        onOpenChange: () => undefined,
        testId: "app-view-review",
      };
      const view = render(<Control {...props} />);
      await waitFor(() => expect(actions("list")).toHaveLength(1));
      view.rerender(<Control {...props} {...next} />);
      expect(await screen.findByRole("button", { name: "Publish on a link" })).toBeTruthy();
      await act(async () =>
        stale.reject(
          new Error(
            "Error invoking remote method 'desktop:publish-owner-app': Error: Sharing failed (503).",
          ),
        ),
      );
      expect(screen.queryByText("The server did not return this app's links.")).toBeNull();
      expect(screen.getByRole("button", { name: "Publish on a link" })).toBeTruthy();
      expect(api.getSyncStatus).not.toHaveBeenCalled();
    });

    it("shows a failed Open in browser in place, and sends it to Notices only once the dialog closes", async () => {
      const reportError =
        vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
      const answers = local([localRow]);
      api.publishOwnerApp.mockImplementation(async (request) =>
        request.action === "launchLocal"
          ? {
              kind: "localLaunched",
              publicationId: localRow.publicationId,
              url: "http://localhost:43123/",
            }
          : answers(request),
      );
      renderLocal({ reportError });
      await openLocal();
      await stateText();
      await userEvent.setup().click(screen.getByRole("button", { name: "Open in browser" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("dohc could not open this app in your browser. Try again.");
      expect(alert.className).toContain("text-right");
      expect(alert.nextElementSibling?.tagName).toBe("FOOTER");
      expect(api.openExternalUrl).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      await userEvent.setup().click(screen.getByRole("button", { name: "Done" }));
      expect(dialog()).toBeNull();
      expect(reportError).toHaveBeenCalledExactlyOnceWith(
        "dohc could not open this app in your browser.",
        expect.any(Error),
        expect.any(Function),
      );
      api.publishOwnerApp.mockImplementation(local([localRow]));
      await act(async () => reportError.mock.calls[0]![2]!());
      await waitFor(() =>
        expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({
          url: "http://127.0.0.1:43123/",
        }),
      );
    });

    describe("an app that opens in the browser", () => {
      it("opens once through the loopback address after approval", async () => {
        const launch = deferred<OwnerAppPublicationResult>();
        const answers = local();
        api.publishOwnerApp.mockImplementation((request) =>
          request.action === "launchLocal" ? launch.promise : answers(request),
        );
        renderLocal({ localApproval: "browser" });
        await openLocal();
        await ready();
        await userEvent.setup().click(approveButton());
        await waitFor(() =>
          expect(actions("launchLocal")).toEqual([
            {
              action: "launchLocal",
              workspaceId: "ws-trip",
              publicationId: localRow.publicationId,
            },
          ]),
        );
        expect(approveButton().disabled).toBe(true);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(dialog()).toBeTruthy();
        expect(api.openExternalUrl).not.toHaveBeenCalled();
        await act(async () =>
          launch.resolve({
            kind: "localLaunched",
            publicationId: localRow.publicationId,
            url: "http://127.0.0.1:43123/",
          }),
        );
        expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({
          url: "http://127.0.0.1:43123/",
        });
        await waitFor(() => expect(dialog()).toBeNull());
      });

      it("never opens an approval that resolves after the workspace changed", async () => {
        const approval = deferred<OwnerAppPublicationResult>();
        const onLocalChange = vi.fn();
        const answers = local();
        api.publishOwnerApp.mockImplementation((request) =>
          request.action === "approve" ? approval.promise : answers(request),
        );
        const view = renderLocal({ localApproval: "browser", onLocalChange });
        await openLocal();
        await ready();
        await userEvent.setup().click(approveButton());
        view.rerender(
          <OwnerAppPublication
            workspaceId="ws-other"
            appRoot="other"
            localApproval="browser"
            onLocalChange={onLocalChange}
          />,
        );
        await act(async () =>
          approval.resolve({ ...published, publicationId: localRow.publicationId, local: true }),
        );
        expect(actions("launchLocal")).toEqual([]);
        expect(api.openExternalUrl).not.toHaveBeenCalled();
        expect(onLocalChange).not.toHaveBeenCalled();
      });
    });
  });
});

it("reviews a chosen read and its fields, with approval off by default", async () => {
  vi.stubGlobal("dohcDesktop", api);
  const read = {
    operationId: "00000000-0000-4000-8000-000000000003",
    name: "records.list",
    access: "helper" as const,
    readOnly: true,
    fields: [
      { fieldId: "00000000-0000-4000-8000-000000000006", name: "Record ID" },
      { fieldId: "00000000-0000-4000-8000-000000000005", name: "Email" },
      { fieldId: "00000000-0000-4000-8000-000000000004", name: "Name" },
    ],
  };
  api.publishOwnerApp.mockImplementation(async (request) =>
    request.action === "prepare"
      ? {
          ...prepared,
          capabilities: [
            { ...datasetCapability, operationIds: [read.operationId], operations: [read] },
          ],
        }
      : answer(request),
  );
  render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
  await review();
  const choice = screen.getByRole("checkbox", {
    name: "Let anyone with the link use records.list",
  }) as HTMLInputElement;
  expect(choice.checked).toBe(false);
  const card = screen.getByTestId("app-publication-capability");
  expect(audiences(card, "records.listRecord ID, Email, Name")).toEqual(["", "Yes", "Yes"]);
  expect(
    screen.getByText(
      "Ticked reads show anyone with the link current records and later changes. Unpublish to withdraw access.",
    ),
  ).toBeTruthy();
  fireEvent.click(choice);
  expect(choice.checked).toBe(true);
  fireEvent.click(choice);
  expect(choice.checked).toBe(false);
  fireEvent.click(choice);
  await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
  expect(api.publishOwnerApp).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "approve",
      linkReads: [
        { operationId: read.operationId, fieldIds: read.fields.map((field) => field.fieldId) },
      ],
    }),
  );
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  api.publishOwnerApp.mockImplementation(answer);
  api.dataset.mockImplementation(datasetAnswer);
  api.listRelayShareLinks.mockResolvedValue(page);
});

it("refuses a link read on an action two Collections share, and says why", async () => {
  vi.stubGlobal("dohcDesktop", api);
  const read = {
    operationId: "00000000-0000-4000-8000-000000000003",
    name: "records.list",
    access: "helper" as const,
    readOnly: true,
    fields: [{ fieldId: "00000000-0000-4000-8000-000000000004", name: "Name" }],
  };
  const first = { ...datasetCapability, operationIds: [read.operationId], operations: [read] };
  const second = {
    ...first,
    datasetId: "00000000-0000-4000-8000-000000000020",
    name: "Volunteers",
  };
  api.publishOwnerApp.mockImplementation(async (request) =>
    request.action === "prepare" ? { ...prepared, capabilities: [first, second] } : answer(request),
  );
  try {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    const choices = screen.getAllByRole("checkbox", {
      name: "Let anyone with the link use records.list",
    }) as HTMLInputElement[];
    expect(choices).toHaveLength(2);
    expect(choices.every((choice) => choice.disabled)).toBe(true);
    expect(
      screen.getAllByText(
        "dohc can't open records.list to the link, because another of this app's Collections has an action with the same name.",
      ),
    ).toHaveLength(2);
    expect(screen.queryByText(/^Ticked reads/)).toBeNull();
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    api.publishOwnerApp.mockImplementation(answer);
  }
});

it.each([false, true])(
  "shows an operator takedown reason and removes republishing, with current link %s",
  async (linkCurrent) => {
    vi.stubGlobal("dohcDesktop", api);
    api.publishOwnerApp.mockImplementation(async (request) =>
      request.action === "list"
        ? {
            kind: "listed",
            publications: [
              {
                ...datasetRow,
                active: false,
                linkCurrent,
                operatorTakedown: {
                  actor: "operator",
                  disabledAtMs: 30,
                  reason: "Confirmed phishing",
                },
              },
            ],
            nextCursor: null,
          }
        : answer(request),
    );
    try {
      render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
      await open();
      await screen.findByText("Confirmed phishing");
      expect(screen.getByText(/Disabled by server operator/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Review and republish" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: `Unpublish ${published.publicationId}` }),
      ).toBeNull();
    } finally {
      cleanup();
      vi.unstubAllGlobals();
      api.publishOwnerApp.mockImplementation(answer);
    }
  },
);

it("shows every bound Collection and its alias in the local review dialog for a multi-Collection app", async () => {
  vi.stubGlobal("dohcDesktop", api);
  const expensesCap = {
    ...datasetCapability,
    alias: "expenses",
    name: "Expenses",
    datasetId: "00000000-0000-4000-8000-000000000010",
  };
  const workoutsCap = {
    ...datasetCapability,
    alias: "workouts",
    name: "Workouts",
    datasetId: "00000000-0000-4000-8000-000000000020",
  };
  api.publishOwnerApp.mockImplementation(async (request) => {
    if (request.action === "listLocal") {
      return {
        kind: "localListed",
        publications: [
          {
            publicationId: published.publicationId,
            authorityRevision: 1,
            appRoot: "control-tower",
            sourceRevision: prepared.sourceRevision,
            datasetCapabilities: [expensesCap, workoutsCap],
            approved: true,
            active: true,
          },
        ],
      };
    }
    if (request.action === "checkLocal") {
      return {
        kind: "localChecked",
        appRoot: "control-tower",
        sourceRevision: prepared.sourceRevision,
        sourcePaths: ["control-tower/main.tsx"],
      };
    }
    return answer(request);
  });
  try {
    render(
      <OwnerAppPublication workspaceId="ws-trip" appRoot="control-tower" localApproval="browser" />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Review app" }));
    const accessBox = await screen.findByTestId("app-access");
    expect(accessBox.textContent).toContain("Expenses");
    expect(accessBox.textContent).toContain("expenses");
    expect(accessBox.textContent).toContain("Workouts");
    expect(accessBox.textContent).toContain("workouts");
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    api.publishOwnerApp.mockImplementation(answer);
  }
});

it("renders a single plain-English staged review card for new/updated Collections and approves or discards it", async () => {
  vi.stubGlobal("dohcDesktop", api);
  const stageId = "00000000-0000-4000-8000-000000000099";
  const reviewDigest = "c".repeat(64);
  const expensesCap = {
    kind: "dataset" as const,
    name: "Expenses",
    alias: "expenses",
    datasetId: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    revisionSha256: "a".repeat(64),
    operationIds: ["00000000-0000-4000-8000-000000000002"],
    operations: [
      {
        operationId: "00000000-0000-4000-8000-000000000002",
        name: "listExpenses",
        access: "owner" as const,
        readOnly: true,
        display: { kind: "read" as const, label: "List", fields: ["Merchant", "Amount"] },
      },
    ],
  };
  const workoutsCap = {
    kind: "dataset" as const,
    name: "Workouts",
    alias: "workouts",
    datasetId: "00000000-0000-4000-8000-000000000011",
    revision: 2,
    revisionSha256: "b".repeat(64),
    operationIds: ["00000000-0000-4000-8000-000000000012"],
    operations: [
      {
        operationId: "00000000-0000-4000-8000-000000000012",
        name: "logWorkout",
        access: "owner" as const,
        readOnly: false,
        display: { kind: "create" as const, label: "Log", fields: ["Activity", "Minutes"] },
      },
    ],
  };
  let stagedVisible = true;
  const approvedCalls: OwnerAppPublicationRequest[] = [];
  const discardedCalls: OwnerAppPublicationRequest[] = [];
  api.publishOwnerApp.mockImplementation(async (request) => {
    if (request.action === "listLocal") return { kind: "localListed", publications: [] };
    if (request.action === "checkLocal")
      return {
        kind: "localChecked",
        appRoot: "control-tower",
        sourceRevision: prepared.sourceRevision,
        sourcePaths: ["control-tower/index.tsx"],
      };
    if (request.action === "listStaged") {
      return {
        kind: "stagedListed",
        stages: stagedVisible
          ? [
              {
                stageId,
                appRoot: "control-tower",
                reviewDigest,
                createdAtMs: 1_790_000_000_000,
                sourceRevision: prepared.sourceRevision,
                sourcePaths: ["control-tower/index.tsx"],
                collections: [
                  {
                    alias: "expenses",
                    datasetId: expensesCap.datasetId,
                    name: "Expenses",
                    datasetPath: "control-tower/expenses/dataset.json",
                    action: "create",
                    targetRevision: 1,
                    targetRevisionSha256: expensesCap.revisionSha256,
                    applied: false,
                    tables: [{ name: "Expenses", fields: ["Date", "Merchant", "Amount"] }],
                  },
                  {
                    alias: "workouts",
                    datasetId: workoutsCap.datasetId,
                    name: "Workouts",
                    datasetPath: "control-tower/workouts/dataset.json",
                    action: "migrate",
                    previousRevision: 1,
                    targetRevision: 2,
                    targetRevisionSha256: workoutsCap.revisionSha256,
                    migrationPath: null,
                    applied: false,
                    changes: [
                      { kind: "code-changed", summary: "Changes the code for the actions" },
                    ],
                  },
                ],
                capabilities: [expensesCap, workoutsCap],
                externalNetwork: true,
              },
            ]
          : [],
      };
    }
    if (request.action === "approveStaged") {
      approvedCalls.push(request);
      stagedVisible = false;
      return {
        kind: "stagedApproved",
        stageId,
        publicationId: "d".repeat(64),
        authorityRevision: 1,
        collectionsApplied: [
          {
            datasetId: expensesCap.datasetId,
            action: "create",
            revision: 1,
            revisionSha256: expensesCap.revisionSha256,
          },
        ],
      };
    }
    if (request.action === "discardStaged") {
      discardedCalls.push(request);
      stagedVisible = false;
      return { kind: "stagedDiscarded", stageId };
    }
    return answer(request);
  });
  try {
    const user = userEvent.setup();
    const collectionsChanged = vi.fn();
    render(
      <OwnerAppPublication
        workspaceId="ws-trip"
        appRoot="control-tower"
        localApproval="tab"
        onCollectionsChange={collectionsChanged}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Review app" }));
    const card = await screen.findByTestId("staged-app-review-card");
    expect(card.textContent).toContain("1 new Collection and 1 updated Collection");
    expect(card.textContent).toContain("Expenses");
    expect(card.textContent).toContain("Date, Merchant, Amount");
    expect(card.textContent).toContain("Workouts");
    expect(card.textContent).toContain("Changes the code for the actions");

    await user.click(screen.getByTestId("staged-app-approve"));
    await waitFor(() =>
      expect(approvedCalls).toEqual([
        { action: "approveStaged", workspaceId: "ws-trip", stageId, reviewDigest },
      ]),
    );
    expect(collectionsChanged).toHaveBeenCalledTimes(1);

    stagedVisible = true;
    await user.click(screen.getByRole("button", { name: "Review app" }));
    await screen.findByTestId("staged-app-review-card");
    await user.click(screen.getByTestId("staged-app-discard"));
    await waitFor(() =>
      expect(discardedCalls).toEqual([
        { action: "discardStaged", workspaceId: "ws-trip", stageId },
      ]),
    );
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    api.publishOwnerApp.mockImplementation(answer);
  }
});

it("shows the failed review state instead of falling back when loading staged proposals fails", async () => {
  const user = userEvent.setup();
  const prepareLocalCalls: OwnerAppPublicationRequest[] = [];
  api.publishOwnerApp.mockImplementation(async (request) => {
    if (request.action === "listLocal") return { kind: "localListed", publications: [] };
    if (request.action === "checkLocal")
      return {
        kind: "localChecked",
        appRoot: "control-tower",
        sourceRevision: prepared.sourceRevision,
        sourcePaths: ["control-tower/index.tsx"],
      };
    if (request.action === "listStaged") throw new Error("staged store unavailable");
    if (request.action === "prepareLocal") {
      prepareLocalCalls.push(request);
      return { ...prepared, local: true };
    }
    return answer(request);
  });
  vi.stubGlobal("dohcDesktop", api);
  try {
    render(
      <OwnerAppPublication workspaceId="ws-trip" appRoot="control-tower" localApproval="tab" />,
    );
    await user.click(screen.getByRole("button", { name: "Review app" }));
    expect((await screen.findByRole("alert")).textContent).toContain("staged store unavailable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(prepareLocalCalls).toEqual([]);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    api.publishOwnerApp.mockImplementation(answer);
  }
});

describe("appLinkUrl and Copy app link", () => {
  const pubId = "c".repeat(64);
  const otherPubId = "d".repeat(64);

  it("appends ?app=<publicationId> before fragments and preserves existing query parameters", () => {
    expect(appLinkUrl("https://share.example/s/secret#section", pubId)).toBe(
      `https://share.example/s/secret?app=${pubId}#section`,
    );
    expect(appLinkUrl("https://share.example/s/secret?foo=bar#frag", pubId)).toBe(
      `https://share.example/s/secret?foo=bar&app=${pubId}#frag`,
    );
    expect(appLinkUrl("javascript:alert(1)", pubId)).toBeNull();
    expect(appLinkUrl("https://share.example/s/secret", "not-a-hash")).toBeNull();
    expect(appLinkUrl(null, pubId)).toBeNull();
  });

  it("offers Copy app link only for verified active publications whose link URL is known", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    api.listRelayShareLinks.mockResolvedValue({
      supportedLinkAccess: ["view", "comment"],
      independentGrants: [],
      links: [
        {
          url: "https://share.example/s/secret#frag",
          shareId: "share-1",
          grantId: "grant-11111111",
          generation: 1,
          status: "active",
          createdAtMs: 1,
          revokedAtMs: null,
          lastUsedAtMs: null,
          urlIssuedAtMs: 1,
          dependents: [],
          selector: { paths: ["trip"], versionId: null },
          access: "view",
        },
        {
          url: null,
          shareId: "share-2",
          grantId: "grant-22222222",
          generation: 1,
          status: "active",
          createdAtMs: 1,
          revokedAtMs: null,
          lastUsedAtMs: null,
          urlIssuedAtMs: null,
          dependents: [],
          selector: { paths: ["trip"], versionId: null },
          access: "view",
        },
      ],
    });
    api.publishOwnerApp.mockImplementation(async (request) => {
      if (request.action === "list")
        return {
          kind: "listed",
          publications: [
            {
              publicationId: pubId,
              authorityRevision: 1,
              shareId: "share-1",
              grantId: "grant-11111111",
              active: true,
              linkCurrent: true,
              manifestUnavailable: false,
              appRoot: "trip",
              sourceRevision: "b".repeat(64),
              collectionCapability: null,
              audience: "link" as const,
              datasetCapabilities: [],
            },
            {
              publicationId: otherPubId,
              authorityRevision: 1,
              shareId: "share-1",
              grantId: "grant-11111111",
              active: true,
              linkCurrent: true,
              manifestUnavailable: true,
              collectionCapability: null,
              audience: "link" as const,
              datasetCapabilities: [],
            },
          ],
          nextCursor: null,
        };
      if (request.action === "listLocal") return { kind: "localListed", publications: [] };
      if (request.action === "listStaged") return { kind: "stagedListed", stages: [] };
      return answer(request);
    });
    vi.stubGlobal("dohcDesktop", api);
    try {
      render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
      await user.click(screen.getByRole("button", { name: "Review app" }));
      const copyButtons = await screen.findAllByRole("button", { name: "Copy app link" });
      expect(copyButtons).toHaveLength(1);
      await user.click(copyButtons[0]!);
      expect(writeText).toHaveBeenCalledWith(`https://share.example/s/secret?app=${pubId}#frag`);
    } finally {
      cleanup();
      vi.unstubAllGlobals();
      api.publishOwnerApp.mockImplementation(answer);
      api.listRelayShareLinks.mockReset();
    }
  });
});

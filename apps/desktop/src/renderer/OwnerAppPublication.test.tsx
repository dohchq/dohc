// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import type { CloudStatusResult, ListRelayShareLinksResult, SyncStatusResult } from "../ipc/bridgeContract";
import type { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "../ipc/ownerAppPublicationContract";
import { deferred } from "../testing/deferred";
import { OwnerAppPublication as Control } from "./OwnerAppPublication";

const prepared: Extract<OwnerAppPublicationResult, { kind: "prepared" }> = {
  kind: "prepared", approvalId: "af28e679-fb6e-4b69-b852-c6f643e5d7ac", candidateDigest: "a".repeat(64),
  appRoot: "trip", versionId: "main", sourceRevision: "b".repeat(64),
  sourcePaths: ["trip/main.tsx", "trip/style.css"], capabilities: [], externalNetwork: true,
};
const published: Extract<OwnerAppPublicationResult, { kind: "published" }> = { kind: "published", publicationId: "c".repeat(64), authorityRevision: 1 };
const approvedCollection = {kind:"collection-create" as const,collectionPath:"trip/responses",schemaSha256:"a".repeat(64),allowedFields:["destination"],requiredFields:["destination"],readFields:["destination"]};
const datasetCapability = { kind: "dataset" as const, name: "Orders", datasetId: "00000000-0000-4000-8000-000000000001", revision: 1, revisionSha256: "a".repeat(64), operationIds: ["00000000-0000-4000-8000-000000000002"], operations: [{ operationId: "00000000-0000-4000-8000-000000000002", name: "submit", access: "link" as const, readOnly: false }] };
const datasetRow = { publicationId: published.publicationId, authorityRevision: 1, shareId: "share-trip", grantId: "grant-trip", active: true, linkCurrent: true, datasetCapability, collectionCapability: null, manifestUnavailable: false as const, appRoot: "trip", sourceRevision: "b".repeat(64) };
const row: ListRelayShareLinksResult["links"][number] = {
  shareId: "share-trip", grantId: "grant-trip", generation: 1, status: "active", createdAtMs: 1,
  revokedAtMs: null, lastUsedAtMs: null, url: null, urlIssuedAtMs: 1, dependents: [], selector: { paths: ["trip"], versionId: null }, access: "view",
};
const page: ListRelayShareLinksResult = { supportedLinkAccess: ["view", "comment"], links: [row], independentGrants: [] };
const syncedStatus: SyncStatusResult = { state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null, liveSessionsGeneration: 0, historyRecordingUnavailable: false, historyShareView: false };
async function answer(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult> {
  if (request.action === "list") return { kind: "listed", publications: [], nextCursor: null };
  if (request.action === "listLocal") return { kind: "localListed", publications: [] };
  if (request.action === "prepareLocal") return { ...prepared, local: true };
  if (request.action === "prepare" || request.action === "reviewReactivation") return prepared;
  if (request.action === "approve") return published;
  if (request.action === "withdraw") return { kind: "withdrawn", publicationId: published.publicationId, authorityRevision: 2 };
  return { kind: "cancelled" };
}
// A Collection already on the server, so Publish moves nothing.
const datasetAnswer = async (input?: unknown): Promise<unknown> => (input as { action?: string } | undefined)?.action === "permissions"
  ? { kind: "permissions", permissions: [], nextCursor: null, place: { kind: "server", host: "sync.example.test" } } : { kind: "list", datasets: [{ datasetId: datasetCapability.datasetId, datasetPath: "data/dataset.json", datasetAddressStatus: "available" }], nextCursor: null };
const api = {
  dataset: vi.fn(datasetAnswer),
  listRelayShareLinks: vi.fn(async (): Promise<ListRelayShareLinksResult> => page),
  publishOwnerApp: vi.fn(answer),
  openExternalUrl: vi.fn(async () => undefined),
  cloudStatus: vi.fn(async (): Promise<CloudStatusResult> => ({ connected: true, workspaceSynced: true })),
  getSyncStatus: vi.fn(async (): Promise<SyncStatusResult> => syncedStatus),
};
const actions = (action: OwnerAppPublicationRequest["action"]) => api.publishOwnerApp.mock.calls.map(([input]) => input).filter(input => input.action === action);

// The page owns whether the dialog is open.
function OwnerAppPublication(props: Omit<ComponentProps<typeof Control>, "open" | "onOpenChange" | "testId">) {
  const context = `${props.workspaceId}\0${props.appRoot}`;
  const [openFor, setOpenFor] = useState<string | null>(null);
  return <Control {...props} open={openFor === context} onOpenChange={open => setOpenFor(open ? context : null)} testId="app-view-review" />;
}

async function open() {
  await userEvent.setup().click(screen.getByRole("button", { name: "Review app" }));
  await waitFor(() => expect(screen.queryByText("Loading links…")).toBeNull());
}
async function review() {
  await open();
  await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
  await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
  await screen.findByRole("heading", { name: "Review app publication" });
}

describe("owner app publication", () => {
  beforeEach(() => { vi.stubGlobal("dohcDesktop", api); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); api.listRelayShareLinks.mockResolvedValue(page);
    api.publishOwnerApp.mockImplementation(answer);
    api.cloudStatus.mockResolvedValue({ connected: true, workspaceSynced: true });
    api.getSyncStatus.mockResolvedValue(syncedStatus);
    api.dataset.mockImplementation(datasetAnswer);
  });

  it("keeps Publish off until dohc knows where the Collection is, including after a failed check", async () => {
    const place = deferred<unknown>();
    api.dataset.mockImplementation(async (input?: unknown) => (input as { action: string }).action === "permissions" ? place.promise : datasetAnswer(input));
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, capabilities: [datasetCapability] } : answer(request));
    const reportError = vi.fn();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" reportError={reportError} />);
    await review();
    const publish = screen.getByRole("button", { name: "Publish this revision" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    place.reject(Error("Engine connection lost"));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not check where this Collection is.", expect.any(Error), expect.any(Function)));
    expect(publish.disabled).toBe(true);
    api.dataset.mockImplementation(datasetAnswer);
    act(() => reportError.mock.calls[0]![2]());
    await waitFor(() => expect(publish.disabled).toBe(false));
  });

  it("reviews exact source and network consequences before approval", async () => {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "prepare")).toEqual([[{ action: "prepare", workspaceId: "ws-trip", appRoot: "trip", shareId: row.shareId, grantId: row.grantId }]]);
    expect(screen.getByTestId("app-publication-source-paths").textContent).toContain("trip/main.tsx");
    expect(screen.getByText("The app can use external services and send them data it receives.")).toBeTruthy();
    expect(screen.getByTestId("app-publication-digest").textContent).toBe(prepared.candidateDigest);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review app publication" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
    await screen.findByText("App published on the selected link.");
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "approve", workspaceId: "ws-trip", approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
  });

  it("never paints workspace A's pending preparation in workspace B", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    api.publishOwnerApp.mockImplementation(request => request.action === "prepare" ? pending.promise : answer(request));
    const view = render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    fireEvent.change(screen.getByLabelText("Publication share link"), { target: { value: row.grantId } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare app" }));
    view.rerender(<OwnerAppPublication workspaceId="ws-other" appRoot="other" />);
    await act(async () => { pending.resolve(prepared); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
  });

  it("reviews a stored revision before explicitly republishing after withdrawal", async () => {
    let active = true;
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action === "list") return { kind: "listed", publications: [{ ...published, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active, authorityRevision: active ? 7 : 8, datasetCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: false }], nextCursor: null };
      if (request.action === "withdraw") active = false;
      if (request.action === "approve") active = true;
      return answer(request);
    });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().click(screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }));
    expect(api.publishOwnerApp.mock.calls.some(([input]) => input.action === "withdraw")).toBe(false);
    await userEvent.setup().click(screen.getByRole("button", { name: "Unpublish app" }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Review and republish" }));
    await screen.findByText("Republish this stored revision. It does not include later source edits.");
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "reviewReactivation", workspaceId: "ws-trip", publicationId: published.publicationId });
    expect(api.publishOwnerApp.mock.calls.some(([input]) => input.action === "approve")).toBe(false);
    expect(screen.getByTestId("app-publication-digest").textContent).toBe(prepared.candidateDigest);
    await userEvent.setup().click(screen.getByRole("button", { name: "Republish this revision" }));
    await screen.findByText("App republished.");
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "approve", workspaceId: "ws-trip", approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
  });

  it("shows the fixed collection capability before approving the unchanged digest", async () => {
    const capability = { kind: "collection-create" as const, collectionPath: "trip/responses", schemaSha256: "d".repeat(64), allowedFields: ["name", "place"], requiredFields: ["place"], readFields: ["place"] };
    api.publishOwnerApp.mockImplementation(request => request.action === "prepare" ? Promise.resolve({ ...prepared, capabilities: [capability] }) : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    const scope = screen.getByTestId("app-publication-capability");
    expect(scope.textContent).toContain("Create records only in trip/responses");
    expect(scope.textContent).toContain("Fields it can create: name, place");
    expect(scope.textContent).toContain("Required fields: place");
    expect(scope.textContent).toContain("Fields shown in the app: place");
    expect(scope.textContent).toContain("People with this share can read every response file and all its fields.");
    expect(scope.textContent).toContain(capability.schemaSha256);
    expect(scope.textContent).toContain("cannot change or delete existing records");
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "approve", workspaceId: "ws-trip", approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
  });

  it("keeps concurrent removal results visible until every panel finishes", async () => {
    const first = deferred<unknown>(); const second = deferred<unknown>();
    const ownerAppResponses = vi.fn(async (request: { action: string; grantId: string }) => request.action === "list" ? {
      action: "list", acceptances: [{kind: "accepted", acceptanceId: request.grantId, objectId: "object", momentId: "moment", publicPrincipalId: "person", versionId: "main", collectionPath: "trip/responses", path: `trip/responses/${request.grantId}.md`, acceptedAtMs: 1}], nextAcceptanceId: null,
    } : request.grantId === "grant-1" ? first.promise : second.promise);
    vi.stubGlobal("dohcDesktop", { ...api, ownerAppResponses });
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [1,2].map(index => ({ publicationId: String(index).repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: `grant-${index}`, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, datasetCapability: null, collectionCapability: approvedCollection, linkCurrent: true, manifestUnavailable: false })), nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" onShareSource={() => undefined} />); await open();
    for (const button of screen.getAllByRole("button", {name: "Load responses"})) { fireEvent.click(button); }
    await screen.findByText("trip/responses/grant-2.md");
    for (const button of screen.getAllByRole("button", {name: /Remove this holder.s responses/})) {
      fireEvent.click(button); fireEvent.click(screen.getByRole("button", {name: "Remove responses"}));
    }
    const blocked = () => {
      for (const name of ["Close", "Reload publications", "Prepare app", "Share app folder", "Cancel"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.keyDown(document, {key:"Escape"}); expect(screen.getByRole("dialog")).toBeTruthy();
    };
    blocked();
    await act(async () => first.resolve({action:"undo",items:[{acceptanceId:"grant-1",status:"deleted",momentId:"delete"}],nextCursor:null}));
    blocked();
    await act(async () => second.resolve({action:"undo",items:[{acceptanceId:"grant-2",status:"conflict"}],nextCursor:null}));
    expect((screen.getByRole("button", {name:"Close"}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("1 removed. 0 already absent. 0 conflicts kept. 0 failed.")).toBeTruthy();
    expect(screen.getByText("0 removed. 0 already absent. 1 conflicts kept. 0 failed.")).toBeTruthy();
  });

  describe("review on this device", () => {
    type LocalRow = Extract<OwnerAppPublicationResult, { kind: "localListed" }>["publications"][number];
    type Capability = Extract<OwnerAppPublicationResult, { kind: "prepared" }>["capabilities"][number];
    const listOperation = { operationId: "00000000-0000-4000-8000-000000000003", name: "list", access: "helper" as const, readOnly: true,
      display: { kind: "read" as const, label: "View orders", fields: ["Item", "Status"] } };
    const cancelOperation = { operationId: "00000000-0000-4000-8000-000000000007", name: "cancel", access: "link" as const, readOnly: false,
      display: { kind: "action" as const, label: "Cancel order", fields: [] } };
    const submitOperation = { ...datasetCapability.operations[0]!, display: { kind: "create" as const, label: "Submit", fields: ["Item", "Quantity"] } };
    const approvedAccess = { ...datasetCapability, operationIds: [listOperation.operationId, submitOperation.operationId], operations: [listOperation, submitOperation] };
    const grownAccess = { ...approvedAccess, operationIds: [...approvedAccess.operationIds, cancelOperation.operationId], operations: [listOperation, submitOperation, cancelOperation] };
    const localRow = { publicationId: "d".repeat(64), authorityRevision: 1, appRoot: "trip", sourceRevision: "b".repeat(64), datasetCapability: approvedAccess, approved: true, active: true };
    const collectionRow = { publicationId: "d".repeat(64), authorityRevision: 1, appRoot: "trip", sourceRevision: "b".repeat(64), approved: true, active: true, collectionCapability: approvedCollection, pendingCreates: 0 };
    const checked: Extract<OwnerAppPublicationResult, { kind: "localChecked" }> = { kind: "localChecked", appRoot: "trip", sourceRevision: "b".repeat(64),
      sourcePaths: ["trip/app.publish.json", "trip/main.tsx", "shared/theme.css"] };
    const secondApproval = "0f6d2c1e-4b8a-4c3e-9d2f-1a2b3c4d5e6f";
    // This device's answers: its approvals, the source revision now, and the candidate prepareLocal returns.
    function local(rows: LocalRow[] = [], options: { revision?: string; capabilities?: Capability[] } = {}) {
      return async (request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult> => {
        if (request.action === "listLocal") return { kind: "localListed", publications: rows };
        if (request.action === "checkLocal") return { ...checked, sourceRevision: options.revision ?? checked.sourceRevision };
        if (request.action === "prepareLocal") return { ...prepared, local: true, capabilities: options.capabilities ?? [approvedAccess] };
        if (request.action === "approve") return { ...published, publicationId: localRow.publicationId, local: true };
        if (request.action === "withdraw") return { kind: "withdrawn", publicationId: request.publicationId, authorityRevision: request.expectedAuthorityRevision + 1 };
        if (request.action === "launchLocal") return { kind: "localLaunched", publicationId: request.publicationId, url: "http://127.0.0.1:43123/" };
        return answer(request);
      };
    }
    function renderLocal(props: Partial<ComponentProps<typeof OwnerAppPublication>> = {}) {
      return render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" title="Trip planner" localApproval="tab" {...props} />);
    }
    const openLocal = () => userEvent.setup().click(screen.getByRole("button", { name: "Review app" }));
    const stateText = async () => (await screen.findByTestId("app-review-state")).textContent;
    const approveButton = () => screen.getByTestId("app-publication-approve") as HTMLButtonElement;
    const ready = () => waitFor(() => expect(approveButton().disabled).toBe(false));
    // The text beside Reads or Changes in the access box.
    const reach = (term: "Reads" | "Changes") => within(screen.getByTestId("app-access")).getByText(term).nextElementSibling?.textContent;
    // Each line beside Reads or Changes.
    const lines = (term: "Reads" | "Changes") => Array.from(within(screen.getByTestId("app-access")).getByText(term).nextElementSibling?.children ?? [], line => line.textContent);
    const dialog = () => screen.queryByTestId("app-publication-dialog");

    it("asks for a first approval, shows what the app reaches, and approves and opens it", async () => {
      const onLocalChange = vi.fn();
      api.publishOwnerApp.mockImplementation(local());
      renderLocal({ onLocalChange });
      await openLocal();
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Trip planner" }));
      expect(await stateText()).toBe("Approve it to run this version on this device.Later edits to its source wait for your approval.");
      await ready();
      expect(approveButton().textContent).toBe("Approve and open");
      expect(actions("prepareLocal")).toEqual([{ action: "prepareLocal", workspaceId: "ws-trip", appRoot: "trip" }]);
      expect(actions("checkLocal")).toEqual([{ action: "checkLocal", workspaceId: "ws-trip", appRoot: "trip" }]);
      const access = screen.getByTestId("app-access");
      expect(within(access).getByText("Orders")).toBeTruthy();
      expect(reach("Reads")).toBe("Item, Status");
      expect(reach("Changes")).toBe("Adds records with Item, Quantity");
      expect(within(access).queryByText("New")).toBeNull();
      expect(access.textContent).toContain("It can send what it receives to other websites.");
      expect(screen.getByRole("heading", { name: "What it can reach" })).toBeTruthy();
      // Publishing on a link does not wait for approval here.
      expect(await screen.findByRole("heading", { name: "Share links" })).toBeTruthy();
      expect(screen.getByText("Not on a link")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove approval" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(screen.queryByText("That share isn't available anymore.")).toBeNull();
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(dialog()).toBeNull());
      expect(actions("approve")).toEqual([{ action: "approve", workspaceId: "ws-trip", approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest }]);
      expect(onLocalChange).toHaveBeenCalled();
      // The approval spent the candidate, and an app in a tab reopens there on its own.
      expect(actions("cancel")).toEqual([]);
      expect(actions("launchLocal")).toEqual([]);
      expect(api.openExternalUrl).not.toHaveBeenCalled();
    });

    it("marks what changed source adds and approves the changes", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow], { revision: "e".repeat(64), capabilities: [grownAccess] }));
      renderLocal();
      await openLocal();
      expect(await stateText()).toBe("Its source changed since you approved it.The app runs the approved version until you approve the changes.");
      await ready();
      expect(approveButton().textContent).toBe("Approve changes");
      expect(reach("Reads")).toBe("Item, Status");
      // One line for each operation, and the New pill stays on the line it marks.
      expect(lines("Changes")).toEqual(["Adds records with Item, Quantity", 'Runs "Cancel order"New']);
      expect(within(screen.getByTestId("app-access")).getAllByText("New")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Remove approval" })).toBeTruthy();
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(dialog()).toBeNull());
      expect(actions("approve")).toHaveLength(1);
    });

    it("keeps an unconfirmed removal distinct from success and retries at its ending revision", async () => {
      const reportError = vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
      let ended = false;
      const answers = local();
      api.publishOwnerApp.mockImplementation(async request => {
        if (request.action === "listLocal") return { kind: "localListed", publications: [ended ? { ...collectionRow, authorityRevision: 2, approved: false, active: false, pendingCreates: 1 } : collectionRow] };
        if (request.action === "withdraw") { ended = true; return request.expectedAuthorityRevision === 1
          ? { kind: "withdrawalUnconfirmed", publicationId: collectionRow.publicationId, authorityRevision: 2, unresolvedCreates: 2 }
          : { kind: "withdrawn", publicationId: collectionRow.publicationId, authorityRevision: 2 }; }
        return answers(request);
      });
      renderLocal({ reportError });
      await openLocal();
      await stateText();
      await userEvent.setup().click(screen.getByRole("button", { name: "Remove approval" }));
      await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
      expect(reportError).toHaveBeenCalledWith("dohc removed this app's approval but has not confirmed whether 2 responses were saved.", undefined, expect.any(Function));
      // One response settled meanwhile. A Collection row says nothing about Dataset moves.
      await screen.findByText("1 response not yet confirmed");
      const rowRetry = () => within(screen.getByText("1 response not yet confirmed").parentElement!).getByRole("button", { name: "Try again" }) as HTMLButtonElement;
      expect(screen.queryByText(/Its data is not active here/)).toBeNull();
      // Both the error's Try again and the row's retry at the revision the removal ended at.
      await act(async () => reportError.mock.calls[0]![2]!());
      await waitFor(() => expect(actions("withdraw")).toHaveLength(2));
      expect(actions("withdraw").at(-1)).toEqual({ action: "withdraw", workspaceId: "ws-trip", publicationId: collectionRow.publicationId, expectedAuthorityRevision: 2 });
      // The row's Try again waits until that retry settles.
      await waitFor(() => expect(rowRetry().disabled).toBe(false));
      await userEvent.setup().click(rowRetry());
      await waitFor(() => expect(actions("withdraw")).toHaveLength(3));
      expect(actions("withdraw").at(-1)).toEqual({ action: "withdraw", workspaceId: "ws-trip", publicationId: collectionRow.publicationId, expectedAuthorityRevision: 2 });
    });

    it("shows a failed approval in place and approves a fresh candidate on retry", async () => {
      const reportError = vi.fn();
      let preparations = 0, approvals = 0;
      const answers = local();
      api.publishOwnerApp.mockImplementation(async request => {
        if (request.action === "prepareLocal") return { ...prepared, local: true, capabilities: [approvedAccess], approvalId: ++preparations === 1 ? prepared.approvalId : secondApproval };
        if (request.action === "approve" && ++approvals === 1) throw new Error("This app preparation expired. Prepare the app again.");
        return answers(request);
      });
      renderLocal({ reportError });
      await openLocal();
      await ready();
      await userEvent.setup().click(approveButton());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("dohc could not approve this app. Try again.");
      expect(alert.className).toContain("text-right");
      expect(alert.getAttribute("title")).toBe("This app preparation expired. Prepare the app again.");
      // It sits right above the button that retries.
      expect(alert.nextElementSibling?.tagName).toBe("FOOTER");
      expect(reportError).not.toHaveBeenCalled();
      expect(dialog()).toBeTruthy();
      expect(await stateText()).toContain("Approve it to run this version on this device.");
      await waitFor(() => expect(actions("prepareLocal")).toHaveLength(2));
      await ready();
      // The spent candidate is never cancelled; the fresh one is approved.
      expect(actions("cancel")).toEqual([]);
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(dialog()).toBeNull());
      expect(actions("approve").map(input => input.action === "approve" && input.approvalId)).toEqual([prepared.approvalId, secondApproval]);
    });

    it("refuses and cancels a candidate that is not this app's local one", async () => {
      const reportError = vi.fn();
      const answers = local();
      api.publishOwnerApp.mockImplementation(async request => request.action === "prepareLocal" ? { ...prepared, appRoot: "other" } : answers(request));
      renderLocal({ reportError });
      await openLocal();
      await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not prepare this app.", expect.any(Error), expect.any(Function)));
      expect(actions("cancel")).toEqual([{ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId }]);
      expect(approveButton().disabled).toBe(true);
    });

    it("moves through the dialog from the title, and Escape cancels the candidate and returns focus", async () => {
      api.publishOwnerApp.mockImplementation(local());
      renderLocal();
      await openLocal();
      await ready();
      await screen.findByRole("button", { name: "Publish on a link" });
      const user = userEvent.setup();
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Trip planner" }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "2 files" }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Publish on a link" }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
      await user.tab();
      expect(document.activeElement).toBe(approveButton());
      fireEvent.keyDown(document, { key: "Escape" });
      expect(dialog()).toBeNull();
      expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review app" })));
    });

    // The shell's workspace server connection: signed out of sync.example.org, or connected to it.
    const accessFor = (connected: boolean, connect: () => void = vi.fn()) => ({ server: "https://sync.example.org",
      context: { facts: { cloud: { connected, workspaceSynced: true, workspaceSyncConnected: connected }, shareView: false }, openSyncSettings: vi.fn(), connect } });

    it("reads the links once the workspace's server connects", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      const view = renderLocal({ access: accessFor(false) });
      await openLocal();
      await screen.findByTestId("app-links-signed-out");
      expect(actions("list")).toEqual([]);
      view.rerender(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" title="Trip planner" localApproval="tab" access={accessFor(true)} />);
      await waitFor(() => expect(actions("list")).toEqual([{ action: "list", workspaceId: "ws-trip", appRoot: "trip" }]));
      expect(await screen.findByRole("button", { name: "Publish on a link" })).toBeTruthy();
      expect(screen.queryByTestId("app-links-signed-out")).toBeNull();
    });

    it.each([
      ["workspace", { workspaceId: "ws-other" }],
      ["app", { appRoot: "trip-two" }],
    ])("ignores a links answer for the %s the dialog no longer shows", async (_, next) => {
      const stale = deferred<OwnerAppPublicationResult>();
      api.publishOwnerApp.mockImplementation(async request => {
        if (request.action === "list" && request.workspaceId === "ws-trip" && request.appRoot === "trip") return stale.promise;
        const answer = await local([localRow])(request);
        // This device approved whichever app the dialog shows.
        if (answer.kind === "localListed" && request.action === "listLocal") return { ...answer, publications: [{ ...localRow, appRoot: request.appRoot }] };
        if (answer.kind === "localChecked" && request.action === "checkLocal") return { ...answer, appRoot: request.appRoot };
        return answer;
      });
      const props = { workspaceId: "ws-trip", appRoot: "trip", title: "Trip planner", localApproval: "tab" as const, open: true, onOpenChange: () => undefined, testId: "app-view-review" };
      const view = render(<Control {...props} />);
      await waitFor(() => expect(actions("list")).toHaveLength(1));
      view.rerender(<Control {...props} {...next} />);
      expect(await screen.findByRole("button", { name: "Publish on a link" })).toBeTruthy();
      await act(async () => stale.reject(listFailure("Error: Sharing failed (503).")));
      expect(screen.queryByText(linksLine)).toBeNull();
      expect(screen.getByRole("button", { name: "Publish on a link" })).toBeTruthy();
      expect(api.getSyncStatus).not.toHaveBeenCalled();
    });

    it("shows a failed Open in browser in place, and sends it to Notices only once the dialog closes", async () => {
      const reportError = vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
      const answers = local([localRow]);
      api.publishOwnerApp.mockImplementation(async request => request.action === "launchLocal"
        ? { kind: "localLaunched", publicationId: localRow.publicationId, url: "http://localhost:43123/" } : answers(request));
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
      expect(reportError).toHaveBeenCalledExactlyOnceWith("dohc could not open this app in your browser.", expect.any(Error), expect.any(Function));
      // Try again in Notices opens the app itself, now through a good address.
      api.publishOwnerApp.mockImplementation(local([localRow]));
      await act(async () => reportError.mock.calls[0]![2]!());
      await waitFor(() => expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "http://127.0.0.1:43123/" }));
    });

    describe("an app that opens in the browser", () => {
      it("opens once through the loopback address after approval", async () => {
        const launch = deferred<OwnerAppPublicationResult>();
        const answers = local();
        api.publishOwnerApp.mockImplementation(request => request.action === "launchLocal" ? launch.promise : answers(request));
        renderLocal({ localApproval: "browser" });
        await openLocal();
        await ready();
        await userEvent.setup().click(approveButton());
        await waitFor(() => expect(actions("launchLocal")).toEqual([{ action: "launchLocal", workspaceId: "ws-trip", publicationId: localRow.publicationId }]));
        // Still busy, so a second press does nothing and the dialog cannot close mid-approval.
        expect(approveButton().disabled).toBe(true);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(dialog()).toBeTruthy();
        expect(api.openExternalUrl).not.toHaveBeenCalled();
        await act(async () => launch.resolve({ kind: "localLaunched", publicationId: localRow.publicationId, url: "http://127.0.0.1:43123/" }));
        expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "http://127.0.0.1:43123/" });
        await waitFor(() => expect(dialog()).toBeNull());
      });

      it("never opens an approval that resolves after the workspace changed", async () => {
        const approval = deferred<OwnerAppPublicationResult>();
        const onLocalChange = vi.fn();
        const answers = local();
        api.publishOwnerApp.mockImplementation(request => request.action === "approve" ? approval.promise : answers(request));
        const view = renderLocal({ localApproval: "browser", onLocalChange });
        await openLocal();
        await ready();
        await userEvent.setup().click(approveButton());
        view.rerender(<OwnerAppPublication workspaceId="ws-other" appRoot="other" localApproval="browser" onLocalChange={onLocalChange} />);
        await act(async () => approval.resolve({ ...published, publicationId: localRow.publicationId, local: true }));
        expect(actions("launchLocal")).toEqual([]);
        expect(api.openExternalUrl).not.toHaveBeenCalled();
        expect(onLocalChange).not.toHaveBeenCalled();
      });
    });
  });
});

it("reviews a chosen read and its fields, with approval off by default", async () => {
  vi.stubGlobal("dohcDesktop", api);
  const read = { operationId: "00000000-0000-4000-8000-000000000003", name: "records.list", access: "helper" as const, readOnly: true,
    fields: [{ fieldId: "00000000-0000-4000-8000-000000000006", name: "Record ID" }, { fieldId: "00000000-0000-4000-8000-000000000005", name: "Email" }, { fieldId: "00000000-0000-4000-8000-000000000004", name: "Name" }] };
  api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, capabilities: [{ ...datasetCapability, operationIds: [read.operationId], operations: [read] }] } : answer(request));
  render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
  await review();
  const choice = screen.getByRole("checkbox", { name: /records.list/ }) as HTMLInputElement;
  expect(choice.checked).toBe(false);
  expect(screen.getByText("Fields: Record ID, Email, Name")).toBeTruthy();
  fireEvent.click(choice); expect(choice.checked).toBe(true);
  fireEvent.click(choice); expect(choice.checked).toBe(false);
  fireEvent.click(choice);
  await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
  expect(api.publishOwnerApp).toHaveBeenCalledWith(expect.objectContaining({ action: "approve", linkReads: [{ operationId: read.operationId, fieldIds: read.fields.map(field => field.fieldId) }] }));
  cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); api.publishOwnerApp.mockImplementation(answer);
    api.dataset.mockImplementation(datasetAnswer); api.listRelayShareLinks.mockResolvedValue(page);
});

it.each([false, true])("shows an operator takedown reason and removes republishing, with current link %s", async linkCurrent => {
  vi.stubGlobal("dohcDesktop", api);
  api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {
    kind: "listed", publications: [{...datasetRow, active: false, linkCurrent,
      operatorTakedown: {actor: "operator", disabledAtMs: 30, reason: "Confirmed phishing"}}], nextCursor: null,
  } : answer(request));
  try {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await screen.findByText("Confirmed phishing");
    expect(screen.getByText(/Disabled by server operator/)).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Review and republish"})).toBeNull();
    expect(screen.queryByRole("button", {name: `Unpublish ${published.publicationId}`})).toBeNull();
  } finally { cleanup(); vi.unstubAllGlobals(); api.publishOwnerApp.mockImplementation(answer); }
});

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
  revokedAtMs: null, lastUsedAtMs: null, urlIssuedAtMs: 1, dependents: [], selector: { paths: ["trip"], versionId: null }, access: "view",
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

  it.each(["missing", "ambiguous"] as const)("distinguishes %s Collection source and keeps the approved name", async status => {
    api.dataset.mockResolvedValue({ kind: "list", datasets: [{ datasetId: datasetCapability.datasetId, datasetPath: null, datasetAddressStatus: status }], nextCursor: null });
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, capabilities: [datasetCapability] } : answer(request));
    const reportError = vi.fn();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" reportError={reportError} />);
    await review();
    await screen.findByText(status === "ambiguous" ? "Multiple dataset.json files name this Collection. Remove the duplicate file." : "Collection source missing. Restore its dataset.json file.");
    expect(screen.getByTestId("app-publication-capability").textContent).toContain("Orders");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports lookup failure to the shell and retries without claiming source is missing", async () => {
    const failure = new Error("Engine connection lost");
    api.dataset.mockRejectedValueOnce(failure);
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, capabilities: [datasetCapability] } : answer(request));
    const reportError = vi.fn();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" reportError={reportError} />);
    await review();
    await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not find this Collection.", failure, expect.any(Function)));
    expect(screen.queryByText("Collection source missing. Restore its dataset.json file.")).toBeNull();
    act(() => reportError.mock.calls[0]![2]());
    await screen.findByText("data/dataset.json");
    expect(screen.getByTestId("app-publication-capability").textContent).toContain("Orders");
  });

  it("scopes the sync prerequisite to link publishing", async () => {
    const unsynced = new Error("Sync this workspace before sharing.");
    api.cloudStatus.mockResolvedValue({ connected: false, workspaceSynced: false });
    api.listRelayShareLinks.mockRejectedValue(unsynced);
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? Promise.reject(unsynced) : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await screen.findByText("Sync this workspace to publish on a share link. Opening on this device does not need sync.");
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(screen.queryByText("Sync this workspace before sharing.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Publications" })).toBeNull();
    expect(screen.queryByLabelText("Publication share link")).toBeNull();
    expect(screen.queryByRole("button", { name: "Prepare app" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("reviews a bound Collection app without presenting another response database", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, capabilities: [datasetCapability] } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    expect(screen.getByTestId("app-publication-capability").textContent).toContain("responses appear in the same Collection");
    expect(screen.getByText("Approving this app grants these actions. It does not change the Collection's rules.")).toBeTruthy();
    expect(screen.getByTestId("app-publication-capability").textContent).not.toContain("private store");
    await waitFor(() => expect((screen.getByTestId("app-publication-approve") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("collection-move-note")).toBeNull();
  });

  it("says publishing on a link moves a Collection on this computer to the server before Publish", async () => {
    api.dataset.mockImplementation(async (input: unknown) => (input as { action: string }).action === "permissions"
      ? { kind: "permissions", permissions: [], nextCursor: null, place: { kind: "here", server: { host: "sync.example.test", runs: "no-schedules", automations: 1, scheduledAutomations: 1 } } }
      : { kind: "list", datasets: [{ datasetId: datasetCapability.datasetId, datasetPath: "data/dataset.json", datasetAddressStatus: "available" }], nextCursor: null });
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, capabilities: [datasetCapability] } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    expect((await screen.findByTestId("collection-move-note")).textContent).toBe("Publishing moves this Collection to sync.example.test. Even on this computer, it then works only while "
      + "sync.example.test is reachable. dohc can't move it back. Its schedules and Group messages stop until you choose sync.example.test under Schedules run on in Settings.");
    expect(api.dataset).toHaveBeenCalledWith({ action: "permissions", workspaceId: "ws-trip", datasetPath: "data/dataset.json", expectedDatasetId: datasetCapability.datasetId, limit: 1 });
    // The first of what publishing does, right above Publish.
    expect(screen.getByTestId("collection-move-note").nextElementSibling?.textContent).toBe("The app can use external services and send them data it receives.");
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

  it("shows changed links honestly and offers fresh preparation while preserving withdrawal", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {kind: "listed", publications: [{
      publicationId: published.publicationId, authorityRevision: 1, shareId: row.shareId, grantId: row.grantId,
      active: true, linkCurrent: false, datasetCapability: null, collectionCapability: null, manifestUnavailable: false, appRoot: "trip", sourceRevision: prepared.sourceRevision,
    }], nextCursor: null} : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(await screen.findByText(/Link changed/)).toBeTruthy();
    expect(screen.getByRole("button", {name: `Unpublish ${published.publicationId}`})).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Review and republish"})).toBeNull();
    await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
    await userEvent.setup().click(screen.getByRole("button", {name: "Prepare app"}));
    await screen.findByRole("heading", {name: "Review app publication"});
    expect(api.publishOwnerApp).toHaveBeenCalledWith({action: "prepare", workspaceId: "ws-trip", appRoot: "trip", shareId: row.shareId, grantId: row.grantId});
  });

  it("cancels a prepared candidate on Escape without publishing", async () => {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review app" })));
  });
  it.each([approvedCollection, "unavailable" as const])("confirms revocation of %s, sends the displayed revision, and keeps the app published", async currentCapability => {
    let revision = 7;
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action === "list") return {kind:"listed",publications:[{publicationId:published.publicationId,authorityRevision:revision,shareId:row.shareId,grantId:row.grantId,active:true,datasetCapability: null, collectionCapability: revision === 7 ? currentCapability : null, linkCurrent: true, manifestUnavailable: false,appRoot:"trip",sourceRevision:prepared.sourceRevision}],nextCursor:null};
      if (request.action === "revokeCollection") { revision++; return {kind:"collectionRevoked",publicationId:published.publicationId,authorityRevision:revision}; }
      return answer(request);
    });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    if (currentCapability !== "unavailable") {
      expect(screen.getByText("Shown in the app: destination")).toBeTruthy();
      expect(screen.getByText("People with this share can read every response file and all its fields.")).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button",{name:`Revoke collection access ${published.publicationId}`}));
    expect(api.publishOwnerApp.mock.calls.some(([input])=>input.action==="revokeCollection")).toBe(false);
    expect(screen.getByText("Saved responses stay in your workspace. Copies already received cannot be removed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Revoke access"}));
    await screen.findByText("App collection access revoked. Prepare the app again to review and restore access.");
    expect(api.publishOwnerApp).toHaveBeenCalledWith({action:"revokeCollection",workspaceId:"ws-trip",publicationId:published.publicationId,expectedAuthorityRevision:7});
    expect(screen.getByRole("button",{name:`Unpublish ${published.publicationId}`})).toBeTruthy();
    await screen.findByText("No collection access");
    expect(screen.queryByRole("button",{name:`Revoke collection access ${published.publicationId}`})).toBeNull();
  });
  it("does not show a late revocation result in another workspace", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    api.publishOwnerApp.mockImplementation(async request => {
      if(request.action==="list") return {kind:"listed",publications:request.workspaceId==="ws-trip"?[{publicationId:published.publicationId,authorityRevision:7,shareId:row.shareId,grantId:row.grantId,active:true,datasetCapability: null, collectionCapability: approvedCollection, linkCurrent: true, manifestUnavailable: false,appRoot:"trip",sourceRevision:prepared.sourceRevision}]:[],nextCursor:null};
      if(request.action==="revokeCollection") return pending.promise;
      return answer(request);
    });
    const view=render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);await open();
    fireEvent.click(screen.getByRole("button",{name:`Revoke collection access ${published.publicationId}`}));
    fireEvent.click(screen.getByRole("button",{name:"Revoke access"}));
    expect((screen.getByRole("button",{name:"Close publication"}) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<OwnerAppPublication workspaceId="ws-other" appRoot="other" />);await open();
    await act(async()=>pending.resolve({kind:"collectionRevoked",publicationId:published.publicationId,authorityRevision:8}));
    expect(screen.queryByText("App collection access revoked. Prepare the app again to review and restore access.")).toBeNull();
  });

  it("discards and cancels preparation arriving after the dialog closes", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    api.publishOwnerApp.mockImplementation(request => request.action === "prepare" ? pending.promise : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    fireEvent.change(screen.getByLabelText("Publication share link"), { target: { value: row.grantId } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare app" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => { pending.resolve(prepared); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
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

  it("keeps the approval result visible and refuses duplicate approval", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    api.publishOwnerApp.mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Publish this revision" }));
    fireEvent.click(screen.getByRole("button", { name: "Publishing…" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "approve")).toHaveLength(1);
    await act(async () => { pending.resolve(published); });
    expect(screen.getByText("App published on the selected link.")).toBeTruthy();
  });

  it("loads later link pages and excludes revoked or damaged links", async () => {
    api.listRelayShareLinks.mockResolvedValueOnce({ ...page, links: [{ ...row, status: "revoked" }], nextCursor: "next" })
      .mockResolvedValueOnce({ ...page, links: [{ ...row, grantId: "bad", selector: null, damaged: true }, row] });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(api.listRelayShareLinks).toHaveBeenLastCalledWith({ workspaceId: "ws-trip", cursor: "next" });
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("offers retry after link retrieval fails", async () => {
    api.listRelayShareLinks.mockRejectedValueOnce(new Error("Relay unavailable"));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(screen.getByRole("alert").textContent).toBe("Relay unavailable");
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload links" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
  });

  it("requires a fresh preparation after an approval failure", async () => {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    api.publishOwnerApp.mockRejectedValueOnce(new Error("This app preparation expired. Prepare the app again."));
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Publish this revision" })).toBeNull();
    expect(screen.getByRole("button", { name: "Prepare app" })).toBeTruthy();
  });

  it("retrieves publications after reopening and withdraws the current authority revision", async () => {
    let active = true;
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action === "list") return { kind: "listed", publications: active ? [{ ...published, datasetCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: false, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, authorityRevision: 7 }] : [], nextCursor: null };
      if (request.action === "withdraw") active = false;
      return answer(request);
    });
    const view = render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await screen.findByRole("button", { name: `Unpublish ${published.publicationId}` });
    view.unmount();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().click(await screen.findByRole("button", { name: `Unpublish ${published.publicationId}` }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Unpublish app" }));
    await screen.findByText("App unpublished. The share link still works for its other shared content.");
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "withdraw", workspaceId: "ws-trip", publicationId: published.publicationId, expectedAuthorityRevision: 7 });
    expect(screen.queryByRole("button", { name: `Unpublish ${published.publicationId}` })).toBeNull();
  });

  it("follows an empty publication page and keeps ended publications out of the reverse action", async () => {
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action !== "list") return answer(request);
      if (!request.cursor) return { kind: "listed", publications: [], nextCursor: "d".repeat(64) };
      return { kind: "listed", publications: [{ ...published, datasetCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: false, appRoot: "trip", sourceRevision: prepared.sourceRevision, shareId: row.shareId, grantId: row.grantId, active: false }], nextCursor: null };
    });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await screen.findByRole("button", { name: "Review and republish" });
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "list", workspaceId: "ws-trip", appRoot: "trip", cursor: "d".repeat(64) });
    expect(screen.queryByRole("button", { name: /^Unpublish/ })).toBeNull();
  });

  it("offers source-folder sharing when existing links cover only built files", async () => {
    api.listRelayShareLinks.mockResolvedValue({ ...page, links: [{ ...row, selector: { paths: ["trip/dist/index.html"], versionId: null } }] });
    const onShareSource = vi.fn();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" onShareSource={onShareSource} />);
    await open();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("No active links include this app's source folder.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Share app folder" }));
    expect(onShareSource).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.publishOwnerApp.mock.calls.every(([input]) => input.action === "list" || input.action === "listLocal")).toBe(true);
  });

  it("can unpublish a damaged manifest without inventing its source or app", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {
      kind: "listed", publications: [{ publicationId: published.publicationId, authorityRevision: 9, shareId: row.shareId, grantId: row.grantId, active: true, datasetCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: true }], nextCursor: null,
    } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(await screen.findByText("Source details unavailable. This publication may belong to another app.")).toBeTruthy();
    expect(screen.queryByText(/^Source b/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }));
    expect(screen.getByText("Source details are unavailable. This publication may belong to another app and cannot currently be republished.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Unpublish app" }));
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "withdraw", workspaceId: "ws-trip", publicationId: published.publicationId, expectedAuthorityRevision: 9 });
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

  it("republishes a Collection app without checking where its Collection is, even with its source file gone", async () => {
    api.dataset.mockImplementation(async () => ({ kind: "list", datasets: [{ datasetId: datasetCapability.datasetId, datasetPath: null, datasetAddressStatus: "missing" }], nextCursor: null }));
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action === "list") return { kind: "listed", publications: [{ ...published, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: false, authorityRevision: 8, datasetCapability, collectionCapability: null, linkCurrent: true, manifestUnavailable: false }], nextCursor: null };
      if (request.action === "reviewReactivation") return { ...prepared, capabilities: [datasetCapability] };
      return answer(request);
    });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Review and republish" }));
    await screen.findByText("Republish this stored revision. It does not include later source edits.");
    await waitFor(() => expect(api.dataset).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: "Republish this revision" }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.dataset.mock.calls.every(([input]) => (input as { action: string }).action === "list")).toBe(true);
    expect(screen.queryByTestId("collection-move-note")).toBeNull();
  });

  it("cancels withdrawal confirmation without mutation", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ ...published, datasetCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: false, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().click(screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }));
    await userEvent.setup().click(screen.getByTestId("app-publication-withdraw-cancel"));
    expect(screen.queryByTestId("app-publication-withdraw-confirm")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "trip" }));
    expect(api.publishOwnerApp.mock.calls.every(([input]) => input.action === "list" || input.action === "listLocal")).toBe(true);
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

  it.each([undefined, [{ kind: "collection-create", collectionPath: "trip/responses" }]])("refuses malformed or missing capabilities: %j", async capabilities => {
    api.publishOwnerApp.mockImplementation(request => request.action === "prepare" ? Promise.resolve({ ...prepared, capabilities } as unknown as OwnerAppPublicationResult) : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
    await screen.findByText("dohc could not verify this app's data access. Prepare the app again.");
    expect(screen.queryByRole("button", { name: "Publish this revision" })).toBeNull();
    expect(api.publishOwnerApp.mock.calls.some(([input]) => input.action === "approve")).toBe(false);
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
  });

  it("mounts one lazy response panel per grant across multiple publications", async () => {
    const ownerAppResponses = vi.fn();
    vi.stubGlobal("dohcDesktop", { ...api, ownerAppResponses });
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {
      kind: "listed", publications: ["c", "d"].map((value, index) => ({ publicationId: value.repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: index === 0, datasetCapability: null, collectionCapability: approvedCollection, linkCurrent: true, manifestUnavailable: false })), nextCursor: null,
    } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await screen.findByRole("region", { name: "App responses" });
    expect(screen.getAllByRole("region", { name: "App responses" })).toHaveLength(1);
    expect(ownerAppResponses).not.toHaveBeenCalled();
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
      for (const name of ["Close publication", "Reload publications", "Prepare app", "Share app folder", "Cancel"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.keyDown(document, {key:"Escape"}); expect(screen.getByRole("dialog")).toBeTruthy();
    };
    blocked();
    await act(async () => first.resolve({action:"undo",items:[{acceptanceId:"grant-1",status:"deleted",momentId:"delete"}],nextCursor:null}));
    blocked();
    await act(async () => second.resolve({action:"undo",items:[{acceptanceId:"grant-2",status:"conflict"}],nextCursor:null}));
    expect((screen.getByRole("button", {name:"Close publication"}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("1 removed. 0 already absent. 0 conflicts kept. 0 failed.")).toBeTruthy();
    expect(screen.getByText("0 removed. 0 already absent. 1 conflicts kept. 0 failed.")).toBeTruthy();
  });

  it("allows closing while responses are loading", async () => {
    const pending = deferred<unknown>();
    vi.stubGlobal("dohcDesktop", { ...api, ownerAppResponses: vi.fn(() => pending.promise) });
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ publicationId: "c".repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, datasetCapability: null, collectionCapability: approvedCollection, linkCurrent: true, manifestUnavailable: false }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    fireEvent.click(screen.getByRole("button", { name: "Load responses" }));
    expect((screen.getByRole("button", { name: "Close publication" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => pending.resolve({ action: "list", acceptances: [], nextAcceptanceId: null }));
  });

  it("shows the shared Collection binding and directs the owner to its records", async () => {
    const datasetCapability = { kind: "dataset" as const, name: "Orders", datasetId: "00000000-0000-4000-8000-000000000001", revision: 1, revisionSha256: "a".repeat(64),
      operationIds: ["00000000-0000-4000-8000-000000000002"], operations: [{ operationId: "00000000-0000-4000-8000-000000000002", name: "submit", access: "link" as const, readOnly: false }] };
    api.publishOwnerApp.mockImplementation(async request => request.action === "list"
      ? { kind: "listed", publications: [{ ...datasetRow, datasetCapability }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(await screen.findByText("Approved Collection access")).toBeTruthy();
    expect(screen.getByText("Open the Collection to view and manage its records.")).toBeTruthy();
    expect(screen.queryByText("No collection access")).toBeNull();
    expect(screen.queryByRole("region", { name: "App data" })).toBeNull();
    expect(screen.queryByRole("region", { name: "App responses" })).toBeNull();
  });

  it("refuses a local answer to a link preparation and cancels it", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, local: true } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
    await screen.findByText("dohc could not prepare this app. Try again.");
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
    expect(screen.queryByRole("button", { name: "Publish this revision" })).toBeNull();
  });

  it("states shared response visibility only for link approvals of a document Collection", async () => {
    const sentence = "People with this share can read every response file and all its fields.";
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, capabilities: [approvedCollection] }
      : request.action === "list" ? { kind: "listed", publications: [{ publicationId: "c".repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, datasetCapability: null, collectionCapability: approvedCollection, linkCurrent: true, manifestUnavailable: false }], nextCursor: null }
      : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(await screen.findByText(sentence)).toBeTruthy();
    await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
    await screen.findByRole("heading", { name: "Review app publication" });
    expect(screen.getByTestId("app-publication-capability").textContent).toContain(sentence);
  });

  it("reports a failed preparation in plain words through the error hook and retries it", async () => {
    const reason = "trip/index.html loads https://cdn.example.test/app.js from outside the app. Save a copy in the app folder and link to that instead.";
    api.publishOwnerApp.mockImplementation(request => request.action === "prepare"
      ? Promise.reject(new Error(`Error invoking remote method 'desktop:publish-owner-app': Error: ${reason}`)) : answer(request));
    const reportError = vi.fn();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" reportError={reportError} />);
    await open();
    await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not prepare this app.", new Error(reason), expect.any(Function)));
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { (reportError.mock.calls[0]![2] as () => void)(); });
    await waitFor(() => expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "prepare")).toHaveLength(2));
    // Once the dialog is closed, Try again opens it again instead of doing nothing.
    await userEvent.setup().click(screen.getByRole("button", { name: "Close publication" }));
    expect(screen.queryByTestId("app-publication-dialog")).toBeNull();
    await act(async () => { (reportError.mock.calls[1]![2] as () => void)(); });
    expect(await screen.findByTestId("app-publication-dialog")).toBeTruthy();
  });

  it("does not mount a response panel for an unknown damaged app", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {kind:"listed",publications:[{publicationId:"c".repeat(64),authorityRevision:1,shareId:row.shareId,grantId:row.grantId,active:true,datasetCapability: null, collectionCapability: null, linkCurrent: true, manifestUnavailable: true}],nextCursor:null} : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    await screen.findByText("Source details unavailable. This publication may belong to another app.");
    expect(screen.queryByRole("region",{name:"App responses"})).toBeNull();
  });

  describe("review on this device", () => {
    type LocalRow = Extract<OwnerAppPublicationResult, { kind: "localListed" }>["publications"][number];
    type Capability = Extract<OwnerAppPublicationResult, { kind: "prepared" }>["capabilities"][number];
    const listOperation = { operationId: "00000000-0000-4000-8000-000000000003", name: "list", access: "helper" as const, readOnly: true };
    const cancelOperation = { operationId: "00000000-0000-4000-8000-000000000007", name: "cancel", access: "link" as const, readOnly: false };
    const submitOperation = datasetCapability.operations[0]!;
    const approvedAccess = { ...datasetCapability, operationIds: [listOperation.operationId, submitOperation.operationId], operations: [listOperation, submitOperation] };
    const grownAccess = { ...approvedAccess, operationIds: [...approvedAccess.operationIds, cancelOperation.operationId], operations: [listOperation, submitOperation, cancelOperation] };
    const localRow = { publicationId: "d".repeat(64), authorityRevision: 1, appRoot: "trip", sourceRevision: "b".repeat(64), datasetCapability: approvedAccess, approved: true, active: true };
    const collectionRow = { publicationId: "d".repeat(64), authorityRevision: 1, appRoot: "trip", sourceRevision: "b".repeat(64), approved: true, active: true, collectionCapability: approvedCollection, pendingCreates: 0 };
    const checked: Extract<OwnerAppPublicationResult, { kind: "localChecked" }> = { kind: "localChecked", appRoot: "trip", sourceRevision: "b".repeat(64),
      sourcePaths: ["trip/app.publish.json", "trip/main.tsx", "shared/theme.css"] };
    const secondApproval = "0f6d2c1e-4b8a-4c3e-9d2f-1a2b3c4d5e6f";
    const checkFailed = "dohc could not check whether this app is approved on this device.";

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
      expect(actions("checkLocal")).toEqual([]);
      const access = screen.getByTestId("app-access");
      expect(within(access).getByText("Orders")).toBeTruthy();
      expect(reach("Reads")).toBe("list");
      expect(reach("Changes")).toBe("submit");
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

    it("lists the files closed until the toggle opens them, relative to the app", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      renderLocal();
      await openLocal();
      await stateText();
      const toggle = screen.getByRole("button", { name: "3 files" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByTestId("app-publication-source-paths")).toBeNull();
      await userEvent.setup().click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const files = screen.getByTestId("app-publication-source-paths");
      expect(toggle.getAttribute("aria-controls")).toBe(files.id);
      expect([...files.querySelectorAll("li")].map(item => item.textContent)).toEqual(["app.publish.json", "main.tsx", "shared/theme.css"]);
      expect(files.textContent).not.toContain("Changed");
      await userEvent.setup().click(toggle);
      expect(screen.queryByTestId("app-publication-source-paths")).toBeNull();
    });

    it("lists the candidate's files while changes are under review, the ones Approve changes binds", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow], { revision: "e".repeat(64) }));
      renderLocal();
      await openLocal();
      await ready();
      await userEvent.setup().click(screen.getByRole("button", { name: "2 files" }));
      expect([...screen.getByTestId("app-publication-source-paths").querySelectorAll("li")].map(item => item.textContent)).toEqual(["main.tsx", "style.css"]);
    });

    it("shows an unchanged approval without preparing anything, and Done closes", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      renderLocal();
      await openLocal();
      expect(await stateText()).toBe("Approved on this device");
      expect(actions("checkLocal")).toEqual([{ action: "checkLocal", workspaceId: "ws-trip", appRoot: "trip" }]);
      expect(actions("prepareLocal")).toEqual([]);
      expect(reach("Reads")).toBe("list");
      expect(reach("Changes")).toBe("submit");
      expect(screen.queryByTestId("app-publication-approve")).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(screen.getByRole("button", { name: "Remove approval" })).toBeTruthy();
      // The source revision appears nowhere: the approval line says all a person needs.
      expect(screen.getByTestId("app-publication-dialog").textContent).not.toContain("b".repeat(12));
      expect(screen.queryByText("This device only")).toBeNull();
      await userEvent.setup().click(screen.getByRole("button", { name: "Done" }));
      expect(dialog()).toBeNull();
      expect(actions("cancel")).toEqual([]);
    });

    it("marks what changed source adds and approves the changes", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow], { revision: "e".repeat(64), capabilities: [grownAccess] }));
      renderLocal();
      await openLocal();
      expect(await stateText()).toBe("Its source changed since you approved it.The app runs the approved version until you approve the changes.");
      await ready();
      expect(approveButton().textContent).toBe("Approve changes");
      expect(reach("Reads")).toBe("list");
      expect(reach("Changes")).toBe("submit, cancelNew");
      expect(within(screen.getByTestId("app-access")).getAllByText("New")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Remove approval" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(dialog()).toBeNull());
      expect(actions("approve")).toHaveLength(1);
    });

    it("marks new fields when a Collection app's changed source asks for more", async () => {
      const grown = { ...approvedCollection, allowedFields: ["destination", "notes"], readFields: ["destination", "notes"] };
      api.publishOwnerApp.mockImplementation(local([collectionRow], { revision: "e".repeat(64), capabilities: [grown] }));
      renderLocal();
      await openLocal();
      await ready();
      const access = screen.getByTestId("app-access");
      expect(within(access).getByText("responses").getAttribute("title")).toBe("trip/responses");
      expect(reach("Reads")).toBe("destination, notesNew");
      expect(reach("Changes")).toBe("Adds records with destination, notesNew");
      expect(access.textContent).not.toContain("People with this share can read every response file");
    });

    it("removes an approval in place and returns to a first review", async () => {
      let approved = true;
      const onLocalChange = vi.fn();
      const answers = local([localRow]);
      api.publishOwnerApp.mockImplementation(async request => {
        if (request.action === "listLocal") return { kind: "localListed", publications: approved ? [localRow] : [] };
        if (request.action === "withdraw") approved = false;
        return answers(request);
      });
      renderLocal({ onLocalChange });
      await openLocal();
      await stateText();
      await userEvent.setup().click(screen.getByRole("button", { name: "Remove approval" }));
      await waitFor(() => expect(screen.getByTestId("app-review-state").textContent).toBe("Approve it to run this version on this device.Later edits to its source wait for your approval."));
      expect(actions("withdraw")).toEqual([{ action: "withdraw", workspaceId: "ws-trip", publicationId: localRow.publicationId, expectedAuthorityRevision: 1 }]);
      expect(onLocalChange).toHaveBeenCalled();
      await ready();
      // The review shows the result, so no notice repeats it.
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove approval" })).toBeNull();
    });

    it("notes an inactive approval and keeps Remove approval", async () => {
      api.publishOwnerApp.mockImplementation(local([{ ...localRow, active: false }]));
      renderLocal();
      await openLocal();
      expect(await stateText()).toBe("Approved on this deviceInactive on this device");
      // The Dataset still exists here, so the text about a move to a share link would be false.
      expect(screen.queryByText(/Its data is not active here/)).toBeNull();
      expect(screen.getByRole("button", { name: "Remove approval" })).toBeTruthy();
    });

    it("says an ended Collection approval's data is not active here", async () => {
      api.publishOwnerApp.mockImplementation(local([{ ...localRow, approved: false, active: false }]));
      renderLocal();
      await openLocal();
      expect(await screen.findByText("Its data is not active here. If you moved it to a share link, open that publication.")).toBeTruthy();
      expect(await stateText()).toContain("Approve it to run this version on this device.");
      expect(screen.queryByRole("button", { name: "Remove approval" })).toBeNull();
    });

    it("words one unconfirmed response in the singular", async () => {
      const reportError = vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
      const answers = local([collectionRow]);
      api.publishOwnerApp.mockImplementation(async request => request.action === "withdraw"
        ? { kind: "withdrawalUnconfirmed", publicationId: collectionRow.publicationId, authorityRevision: 2, unresolvedCreates: 1 } : answers(request));
      renderLocal({ reportError });
      await openLocal();
      await stateText();
      await userEvent.setup().click(screen.getByRole("button", { name: "Remove approval" }));
      await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc removed this app's approval but has not confirmed whether 1 response was saved.", undefined, expect.any(Function)));
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

    it("shows the header at once and the access lines after the wait, with the primary button busy", async () => {
      const list = deferred<OwnerAppPublicationResult>();
      const candidate = deferred<OwnerAppPublicationResult>();
      const answers = local();
      api.publishOwnerApp.mockImplementation(request => request.action === "listLocal" ? list.promise : request.action === "prepareLocal" ? candidate.promise : answers(request));
      renderLocal();
      await openLocal();
      expect(screen.getByRole("heading", { level: 2, name: "Trip planner" })).toBeTruthy();
      expect(screen.queryByTestId("app-review-state")).toBeNull();
      // The skeleton waits 150 ms before it shows, so a fast load never flashes.
      expect(screen.getByText("Loading what this app can reach…").closest("[role=status]")?.className).toContain("dohc-reveal-if-slow");
      expect(approveButton().textContent).toBe("Approve and open");
      expect(approveButton().disabled).toBe(true);
      expect(approveButton().getAttribute("aria-busy")).toBe("true");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      await act(async () => list.resolve({ kind: "localListed", publications: [] }));
      await stateText();
      expect(approveButton().getAttribute("aria-busy")).toBe("true");
      await act(async () => candidate.resolve({ ...prepared, local: true, capabilities: [approvedAccess] }));
      await ready();
      expect(approveButton().getAttribute("aria-busy")).toBe("false");
      expect(screen.queryByText("Loading what this app can reach…")).toBeNull();
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

    it("keeps a known approval when only its source check fails, and reports the check with Try again", async () => {
      const reportError = vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
      // For example, a malformed app.publish.json makes main's source check throw.
      const failure = new Error("Error invoking remote method 'desktop:publish-owner-app': Error: app.publish.json is not valid JSON.");
      let checks = 0;
      const answers = local([localRow]);
      api.publishOwnerApp.mockImplementation(async request => request.action === "checkLocal" && ++checks === 1 ? Promise.reject(failure) : answers(request));
      renderLocal({ reportError });
      await openLocal();
      await waitFor(() => expect(reportError).toHaveBeenCalledExactlyOnceWith(
        "dohc could not check whether this app's source changed since you approved it.", failure, expect.any(Function)));
      // The source counts as unchanged, so the state line stays true.
      expect(await stateText()).toBe("Approved on this device");
      expect(screen.getByRole("button", { name: "Remove approval" })).toBeTruthy();
      expect(await screen.findByRole("heading", { name: "Share links" })).toBeTruthy();
      expect(screen.queryByTestId("app-access-retry")).toBeNull();
      expect(actions("prepareLocal")).toEqual([]);
      // Try again on the Notices row runs the check again.
      await act(async () => reportError.mock.calls[0]![2]!());
      await waitFor(() => expect(actions("checkLocal")).toHaveLength(2));
      expect(await stateText()).toBe("Approved on this device");
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("retries a failed approvals list through the Notices row", async () => {
      const reportError = vi.fn<(fallback: string, error: unknown, retry: (() => void) | null) => void>();
      let lists = 0;
      const answers = local();
      api.publishOwnerApp.mockImplementation(async request => request.action === "listLocal" && ++lists === 1 ? Promise.reject(new Error("Engine connection lost")) : answers(request));
      renderLocal({ reportError });
      await openLocal();
      await waitFor(() => expect(reportError).toHaveBeenCalledWith(checkFailed, expect.any(Error), expect.any(Function)));
      expect(actions("prepareLocal")).toEqual([]);
      await act(async () => reportError.mock.calls[0]![2]!());
      await ready();
    });

    it("reports a failed preparation to Notices and retries it from the access box", async () => {
      const reportError = vi.fn();
      const reason = "trip/index.html loads https://cdn.example.test/app.js from outside the app. Save a copy in the app folder and link to that instead.";
      let preparations = 0;
      const answers = local();
      api.publishOwnerApp.mockImplementation(async request => request.action === "prepareLocal" && ++preparations === 1
        ? Promise.reject(new Error(`Error invoking remote method 'desktop:publish-owner-app': Error: ${reason}`)) : answers(request));
      renderLocal({ reportError });
      await openLocal();
      await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not prepare this app.", new Error(reason), expect.any(Function)));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(approveButton().disabled).toBe(true);
      await userEvent.setup().click(within(screen.getByTestId("app-access-retry")).getByRole("button", { name: "Try again" }));
      await ready();
      expect(actions("prepareLocal")).toHaveLength(2);
    });

    it("lets an approval finish when the failed preparation's Notices row is retried during it", async () => {
      const reportError = vi.fn();
      let preparations = 0;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const answers = local();
      api.publishOwnerApp.mockImplementation(async request => {
        if (request.action === "prepareLocal" && ++preparations === 1) throw new Error("Engine connection lost");
        if (request.action === "approve") await held;
        return answers(request);
      });
      renderLocal({ reportError });
      await openLocal();
      await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not prepare this app.", expect.any(Error), expect.any(Function)));
      await userEvent.setup().click(within(screen.getByTestId("app-access-retry")).getByRole("button", { name: "Try again" }));
      await ready();
      await userEvent.setup().click(approveButton());
      await waitFor(() => expect(actions("approve")).toHaveLength(1));
      // The Notices row from the first failure is still there. Its retry must not take over the approval.
      await act(async () => reportError.mock.calls[0]![2]!());
      expect(actions("prepareLocal")).toHaveLength(2);
      await act(async () => { release(); });
      await waitFor(() => expect(dialog()).toBeNull());
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
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close publication" }));
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

    it("reaches the Share links rows before the footer", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      renderLocal();
      await openLocal();
      const publish = await screen.findByRole("button", { name: "Publish on a link" });
      const user = userEvent.setup();
      await user.tab(); await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "3 files" }));
      await user.tab();
      expect(document.activeElement).toBe(publish);
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove approval" }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open in browser" }));
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
    });

    it("offers a share link when synced, and Back returns to the review", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      renderLocal();
      await openLocal();
      expect(await screen.findByRole("heading", { name: "Share links" })).toBeTruthy();
      expect(screen.getByText("Not on a link")).toBeTruthy();
      await userEvent.setup().click(screen.getByRole("button", { name: "Publish on a link" }));
      expect(await screen.findByRole("heading", { name: "Publish on a share link" })).toBeTruthy();
      expect(screen.queryByTestId("app-review-state")).toBeNull();
      await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
      await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
      await screen.findByRole("heading", { name: "Review app publication" });
      expect(actions("prepare")).toEqual([{ action: "prepare", workspaceId: "ws-trip", appRoot: "trip", shareId: row.shareId, grantId: row.grantId }]);
      await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
      await userEvent.setup().click(await screen.findByRole("button", { name: "Back" }));
      expect(await stateText()).toBe("Approved on this device");
    });

    it("lists a link publication with Unpublish behind its confirmation", async () => {
      const answers = local([localRow]);
      let active = true;
      api.publishOwnerApp.mockImplementation(async request => {
        if (request.action === "list") return { kind: "listed", publications: active ? [datasetRow] : [], nextCursor: null };
        if (request.action === "withdraw" && request.publicationId === datasetRow.publicationId) active = false;
        return answers(request);
      });
      renderLocal();
      await openLocal();
      expect(await screen.findByText("Published on a share link")).toBeTruthy();
      expect(screen.getByText("Link grant-tr")).toBeTruthy();
      expect(screen.queryByText("Not on a link")).toBeNull();
      await userEvent.setup().click(screen.getByRole("button", { name: `Unpublish ${datasetRow.publicationId}` }));
      expect(actions("withdraw")).toEqual([]);
      await userEvent.setup().click(screen.getByRole("button", { name: "Unpublish app" }));
      await screen.findByText("App unpublished. The share link still works for its other shared content.");
      expect(actions("withdraw")).toEqual([{ action: "withdraw", workspaceId: "ws-trip", publicationId: datasetRow.publicationId, expectedAuthorityRevision: 1 }]);
      expect(await screen.findByText("Not on a link")).toBeTruthy();
    });

    it("shows an operator takedown without Unpublish", async () => {
      const answers = local([localRow]);
      api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ ...datasetRow, active: false,
        operatorTakedown: { actor: "operator", disabledAtMs: 30, reason: "Confirmed phishing" } }], nextCursor: null } : answers(request));
      renderLocal();
      await openLocal();
      expect(await screen.findByText("Disabled by server operator")).toBeTruthy();
      expect(screen.queryByRole("button", { name: `Unpublish ${datasetRow.publicationId}` })).toBeNull();
    });

    it("shows a first review's existing link publication", async () => {
      const answers = local();
      api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [datasetRow], nextCursor: null } : answers(request));
      renderLocal();
      await openLocal();
      expect(await screen.findByText("Published on a share link")).toBeTruthy();
    });

    // How main's list failures reach the renderer: the relay's copy behind Electron's prefix.
    const listFailure = (cause: string) => new Error(`Error invoking remote method 'desktop:publish-owner-app': ${cause}`);
    const failingList = (cause: string) => async (request: OwnerAppPublicationRequest) =>
      request.action === "list" ? Promise.reject(listFailure(cause)) : local([localRow])(request);
    const linksLine = "The server didn't return this app's links.";

    it.each([
      ["the workspace is not synced", () => api.cloudStatus.mockResolvedValue({ connected: false, workspaceSynced: false })],
      // main answers listUnavailable for the relay's not_found 404.
      ["the server does not publish apps here", () => api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listUnavailable" } : local([localRow])(request))],
      ["the sync status says the server is disconnected", () => {
        api.publishOwnerApp.mockImplementation(failingList("TypeError: fetch failed"));
        api.getSyncStatus.mockResolvedValue({ ...syncedStatus, state: "cloud-disconnected" });
      }],
      ["the sync status says the server is unreachable", () => {
        api.publishOwnerApp.mockImplementation(failingList("TypeError: fetch failed"));
        api.getSyncStatus.mockResolvedValue({ ...syncedStatus, state: "sync-failed", syncFailure: { cause: "server-unreachable", detail: "offline", sinceMs: 1, attempts: 2 } });
      }],
    ])("hides Share links when %s", async (_, arrange) => {
      const reportError = vi.fn();
      api.publishOwnerApp.mockImplementation(local([localRow]));
      arrange();
      renderLocal({ reportError });
      await openLocal();
      expect(await stateText()).toBe("Approved on this device");
      await waitFor(() => expect(api.cloudStatus).toHaveBeenCalled());
      await waitFor(() => expect(actions("list").length).toBeGreaterThan(0));
      await act(async () => undefined);
      await act(async () => undefined);
      expect(screen.queryByRole("heading", { name: "Share links" })).toBeNull();
      expect(screen.queryByText(linksLine)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(reportError).not.toHaveBeenCalled();
    });

    it.each([
      ["a 5xx", "Error: Sharing failed (503)."],
      ["a timeout", "TimeoutError: The operation was aborted due to timeout"],
    ])("keeps Share links with one line and Try again after %s, and Try again reloads the list", async (_, cause) => {
      const reportError = vi.fn();
      const retry = deferred<OwnerAppPublicationResult>();
      let lists = 0;
      api.publishOwnerApp.mockImplementation(async request => request.action !== "list" ? local([localRow])(request)
        : ++lists === 1 ? Promise.reject(listFailure(cause)) : retry.promise);
      renderLocal({ reportError });
      await openLocal();
      const line = await screen.findByText(linksLine);
      const section = screen.getByRole("region", { name: "Share links" });
      expect(section.contains(line)).toBe(true);
      expect(within(section).queryByRole("button", { name: "Publish on a link" })).toBeNull();
      expect(api.getSyncStatus).toHaveBeenCalledWith({ workspaceId: "ws-trip" });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(reportError).not.toHaveBeenCalled();

      await userEvent.setup().click(within(section).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(actions("list")).toHaveLength(2));
      expect(actions("list")[1]).toEqual({ action: "list", workspaceId: "ws-trip", appRoot: "trip" });
      // The line stays while the list reloads, so the dialog does not jump.
      expect(screen.getByText(linksLine)).toBeTruthy();
      expect(within(section).getByRole("button", { name: "Try again" }).getAttribute("aria-busy")).toBe("true");

      await act(async () => retry.resolve({ kind: "listed", publications: [datasetRow], nextCursor: null }));
      expect(screen.queryByText(linksLine)).toBeNull();
      expect(await screen.findByText("Published on a share link")).toBeTruthy();
      expect(within(screen.getByRole("region", { name: "Share links" })).getByRole("button", { name: "Publish on a link" })).toBeTruthy();
      expect(reportError).not.toHaveBeenCalled();
    });

    // The shell's workspace server connection: signed out of sync.example.org, or connected to it.
    const accessFor = (connected: boolean, connect: () => void = vi.fn()) => ({ server: "https://sync.example.org",
      context: { facts: { cloud: { connected, workspaceSynced: true, workspaceSyncConnected: connected }, shareView: false }, openSyncSettings: vi.fn(), connect } });

    it("offers Connect server in Share links while signed out, without reading the links", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      renderLocal({ access: accessFor(false) });
      await openLocal();
      expect(await stateText()).toBe("Approved on this device");
      const section = await screen.findByRole("region", { name: "Share links" });
      const row = within(section).getByTestId("app-links-signed-out");
      expect(row.textContent).toBe("Not connected to sync.example.orgConnect server");
      expect(within(row).getByText("sync.example.org").className).toContain("font-medium");
      expect(within(row).getByRole("button", { name: "Connect server" }).className).not.toContain("bg-accent");
      expect(screen.queryByText("Others may have access.")).toBeNull();
      expect(screen.queryByText(linksLine)).toBeNull();
      expect(within(section).queryByRole("button", { name: "Publish on a link" })).toBeNull();
      expect(actions("list")).toEqual([]);
      expect(api.getSyncStatus).not.toHaveBeenCalled();
    });

    it("closes the dialog before Connect server opens its place", async () => {
      const order: string[] = [];
      api.publishOwnerApp.mockImplementation(local([localRow]));
      const view = render(<Control workspaceId="ws-trip" appRoot="trip" title="Trip planner" localApproval="tab" open testId="app-view-review"
        onOpenChange={open => order.push(open ? "open" : "close")} access={accessFor(false, () => order.push("connect"))} />);
      await userEvent.setup().click(await screen.findByRole("button", { name: "Connect server" }));
      expect(order).toEqual(["close", "connect"]);
      view.unmount();

      const connect = vi.fn();
      renderLocal({ access: accessFor(false, connect) });
      await openLocal();
      await userEvent.setup().click(await screen.findByRole("button", { name: "Connect server" }));
      expect(connect).toHaveBeenCalledOnce();
      expect(dialog()).toBeNull();
    });

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

    it("ignores an approvals answer that arrives after the workspace changed", async () => {
      const list = deferred<OwnerAppPublicationResult>();
      const answers = local();
      api.publishOwnerApp.mockImplementation(request => request.action === "listLocal" && request.workspaceId === "ws-trip" ? list.promise : answers(request));
      const view = renderLocal();
      await openLocal();
      view.rerender(<OwnerAppPublication workspaceId="ws-other" appRoot="trip" title="Trip planner" localApproval="tab" />);
      await act(async () => list.resolve({ kind: "localListed", publications: [localRow] }));
      expect(dialog()).toBeNull();
      expect(actions("checkLocal")).toEqual([]);
      expect(actions("prepareLocal")).toEqual([]);
    });

    it("cancels a candidate that arrives after the dialog closed", async () => {
      const candidate = deferred<OwnerAppPublicationResult>();
      const answers = local();
      api.publishOwnerApp.mockImplementation(request => request.action === "prepareLocal" ? candidate.promise : answers(request));
      renderLocal();
      await openLocal();
      await waitFor(() => expect(actions("prepareLocal")).toHaveLength(1));
      fireEvent.keyDown(document, { key: "Escape" });
      await act(async () => candidate.resolve({ ...prepared, local: true, capabilities: [approvedAccess] }));
      expect(dialog()).toBeNull();
      expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
    });

    it("lays out a first review with Share links after the access box and one primary button, at the dialog spacing", async () => {
      api.publishOwnerApp.mockImplementation(local());
      renderLocal();
      await openLocal();
      await ready();
      const links = (await screen.findByRole("heading", { name: "Share links" })).closest("section")!;
      const access = screen.getByRole("heading", { name: "What it can reach" }).closest("section")!;
      const footer = screen.getByTestId("app-publication-dialog").querySelector("footer")!;
      // What it can reach, then Share links, then the buttons, which end the dialog.
      expect(access.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(links.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(footer.closest("[data-testid=app-publication-dialog] > *")?.nextElementSibling).toBeNull();
      const primaries = [...screen.getByTestId("app-publication-dialog").querySelectorAll("button")].filter(button => button.className.includes("bg-accent"));
      expect(primaries.map(button => button.textContent)).toEqual(["Approve and open"]);
      expect(within(links).getByRole("button", { name: "Publish on a link" }).className).not.toContain("bg-accent");
      // The skill's dialog: p-6, gap-6 between parts, labels 8 px over their boxes, buttons gap-2 apart, 520 px wide.
      const panel = screen.getByTestId("app-publication-dialog");
      expect(panel.className.split(" ")).toEqual(expect.arrayContaining(["p-6", "gap-6", "w-[min(520px,calc(100vw-32px))]"]));
      for (const label of [within(links).getByRole("heading"), within(access).getByRole("heading")]) expect(label.className.split(" ")).toContain("mb-2");
      expect(footer.className.split(" ")).toContain("gap-2");
    });

    it("offers Open in browser left of Done only while the approval matches the source", async () => {
      api.publishOwnerApp.mockImplementation(local([localRow]));
      renderLocal();
      await openLocal();
      expect(await stateText()).toBe("Approved on this device");
      const open = screen.getByRole("button", { name: "Open in browser" });
      const done = screen.getByRole("button", { name: "Done" });
      expect(open.nextElementSibling).toBe(done);
      expect(open.className).not.toContain("bg-accent");
      expect(screen.getByTestId("app-publication-dialog").querySelector("footer")!.firstElementChild?.textContent).toBe("Remove approval");
      await userEvent.setup().click(open);
      await waitFor(() => expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "http://127.0.0.1:43123/" }));
      expect(actions("launchLocal")).toEqual([{ action: "launchLocal", workspaceId: "ws-trip", publicationId: localRow.publicationId }]);
      expect(dialog()).toBeTruthy();
      cleanup();
      api.publishOwnerApp.mockImplementation(local([localRow], { revision: "e".repeat(64) }));
      renderLocal();
      await openLocal();
      await ready();
      expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull();
      cleanup();
      api.publishOwnerApp.mockImplementation(local());
      renderLocal();
      await openLocal();
      await ready();
      expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull();
    });

    it.each([
      ["an active", true],
      ["an inactive", false],
    ])("offers Open in browser in state 2 only for %s approval", async (_, active) => {
      api.publishOwnerApp.mockImplementation(local([{ ...localRow, active }]));
      renderLocal();
      await openLocal();
      expect(await stateText()).toBe(active ? "Approved on this device" : "Approved on this deviceInactive on this device");
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Remove approval" })).toBeTruthy();
      expect(!!screen.queryByRole("button", { name: "Open in browser" })).toBe(active);
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

    it("sends nothing to Notices after a successful retry in place", async () => {
      const reportError = vi.fn();
      let launches = 0;
      const answers = local([localRow]);
      api.publishOwnerApp.mockImplementation(async request => request.action === "launchLocal" && ++launches === 1 ? { kind: "cancelled" } : answers(request));
      renderLocal({ reportError });
      await openLocal();
      await stateText();
      await userEvent.setup().click(screen.getByRole("button", { name: "Open in browser" }));
      await screen.findByRole("alert");
      await userEvent.setup().click(screen.getByRole("button", { name: "Open in browser" }));
      await waitFor(() => expect(api.openExternalUrl).toHaveBeenCalledOnce());
      expect(screen.queryByRole("alert")).toBeNull();
      await userEvent.setup().click(screen.getByRole("button", { name: "Done" }));
      expect(reportError).not.toHaveBeenCalled();
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

      it.each([
        { name: "another app's id", result: { kind: "localLaunched" as const, publicationId: "e".repeat(64), url: "http://127.0.0.1:43123/" } },
        { name: "an https address", result: { kind: "localLaunched" as const, publicationId: "d".repeat(64), url: "https://127.0.0.1:43123/" } },
        { name: "a hostname", result: { kind: "localLaunched" as const, publicationId: "d".repeat(64), url: "http://localhost:43123/" } },
        { name: "credentials", result: { kind: "localLaunched" as const, publicationId: "d".repeat(64), url: "http://owner:secret@127.0.0.1:43123/" } },
        { name: "no port", result: { kind: "localLaunched" as const, publicationId: "d".repeat(64), url: "http://127.0.0.1/" } },
        { name: "the wrong result kind", result: { kind: "cancelled" as const } },
      ])("refuses to open $name and retries the launch from Notices", async ({ result }) => {
        const answers = local();
        api.publishOwnerApp.mockImplementation(request => request.action === "launchLocal" ? Promise.resolve(result) : answers(request));
        const reportError = vi.fn();
        renderLocal({ localApproval: "browser", reportError });
        await openLocal();
        await ready();
        await userEvent.setup().click(approveButton());
        await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not open this app in your browser.", expect.any(Error), expect.any(Function)));
        // The approval itself succeeded, so the dialog closes.
        await waitFor(() => expect(dialog()).toBeNull());
        expect(api.openExternalUrl).not.toHaveBeenCalled();
        await act(async () => { (reportError.mock.calls[0]![2] as () => void)(); });
        await waitFor(() => expect(actions("launchLocal")).toHaveLength(2));
        expect(api.openExternalUrl).not.toHaveBeenCalled();
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

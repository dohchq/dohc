// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListRelayShareLinksResult } from "../ipc/bridgeContract";
import type { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "../ipc/ownerAppPublicationContract";
import { deferred } from "../testing/deferred";
import { OwnerAppPublication } from "./OwnerAppPublication";

const prepared: Extract<OwnerAppPublicationResult, { kind: "prepared" }> = {
  kind: "prepared", approvalId: "af28e679-fb6e-4b69-b852-c6f643e5d7ac", candidateDigest: "a".repeat(64),
  appRoot: "trip", versionId: "main", sourceRevision: "b".repeat(64),
  sourcePaths: ["trip/main.tsx", "trip/style.css"], capabilities: [], externalNetwork: true,
};
const published: Extract<OwnerAppPublicationResult, { kind: "published" }> = { kind: "published", publicationId: "c".repeat(64), authorityRevision: 1 };
const approvedCollection = {kind:"collection-create" as const,collectionPath:"trip/responses",schemaSha256:"a".repeat(64),allowedFields:["destination"],requiredFields:["destination"],readFields:["destination"]};
const backend = {
  kind: "app-backend" as const, dataPath: "trip/data/app.sqlite", backendPath: "backend.js" as const, schemaPath: "schema.sql" as const,
  backendSha256: "e".repeat(64), schemaSha256: "f".repeat(64), schemaVersion: 2,
  operations: [
    { name: "donate", access: "link" as const, readOnly: false },
    { name: "listDonations", access: "link" as const, readOnly: true },
    { name: "updateDonation", access: "owner" as const, readOnly: false },
    { name: "verifyDonation", access: "helper" as const, readOnly: false },
  ],
  tables: [
    { name: "donations", primaryKey: "id", readOperation: "listDonations", writeOperation: "updateDonation" },
    { name: "pledges", primaryKey: "id", readOperation: "listDonations", writeOperation: null },
  ],
};
const backendRow = { publicationId: published.publicationId, authorityRevision: 1, shareId: "share-trip", grantId: "grant-trip", active: true, linkCurrent: true,
  datasetCapability: null, collectionCapability: null, backendCapability: backend, manifestUnavailable: false as const, appRoot: "trip", sourceRevision: "b".repeat(64) };
const row: ListRelayShareLinksResult["links"][number] = {
  shareId: "share-trip", grantId: "grant-trip", generation: 1, status: "active", createdAtMs: 1,
  revokedAtMs: null, lastUsedAtMs: null, urlIssuedAtMs: 1, dependents: [], selector: { paths: ["trip"], versionId: null }, access: "view",
};
const page: ListRelayShareLinksResult = { supportedLinkAccess: ["view", "comment"], links: [row], independentGrants: [] };
const localRow = { publicationId: "d".repeat(64), authorityRevision: 1, appRoot: "trip", sourceRevision: "b".repeat(64), backendCapability: backend, active: true };
async function answer(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult> {
  if (request.action === "list") return { kind: "listed", publications: [], nextCursor: null };
  if (request.action === "listLocal") return { kind: "localListed", publications: [] };
  if (request.action === "prepareLocal") return { ...prepared, local: true };
  if (request.action === "prepare" || request.action === "reviewReactivation") return prepared;
  if (request.action === "approve") return published;
  if (request.action === "withdraw") return { kind: "withdrawn", publicationId: published.publicationId, authorityRevision: 2 };
  return { kind: "cancelled" };
}
const api = {
  listRelayShareLinks: vi.fn(async (): Promise<ListRelayShareLinksResult> => page),
  publishOwnerApp: vi.fn(answer),
  openExternalUrl: vi.fn(async () => undefined),
};
const localList = (request: OwnerAppPublicationRequest) => request.action === "listLocal" ? Promise.resolve<OwnerAppPublicationResult>({ kind: "localListed", publications: [localRow] }) : answer(request);
const openButton = () => screen.findByRole("button", { name: `Open in browser ${localRow.publicationId}` });

async function open() {
  await userEvent.setup().click(screen.getByRole("button", { name: "Publish app" }));
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
  });

  it("reviews a bound Collection app without presenting another response database", async () => {
    const datasetCapability = { kind: "dataset" as const, datasetId: "00000000-0000-4000-8000-000000000001", revision: 1, revisionSha256: "a".repeat(64),
      operationIds: ["00000000-0000-4000-8000-000000000002"], operations: [{ operationId: "00000000-0000-4000-8000-000000000002", name: "submit", access: "link" as const, readOnly: false }] };
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepareLocal" ? { ...prepared, local: true, capabilities: [datasetCapability] } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare for this device" }));
    await screen.findByRole("heading", { name: "Review app for this device" });
    expect(screen.getByTestId("app-publication-capability").textContent).toContain("responses appear in the same Collection");
    expect(screen.getByText("Approving this app grants these actions. It does not change the Collection's rules.")).toBeTruthy();
    expect(screen.getByTestId("app-publication-capability").textContent).not.toContain("private store");
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
      active: true, linkCurrent: false, datasetCapability: null, collectionCapability: null, backendCapability: null, manifestUnavailable: false, appRoot: "trip", sourceRevision: prepared.sourceRevision,
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
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Publish app" }));
  });
  it.each([approvedCollection, "unavailable" as const])("confirms revocation of %s, sends the displayed revision, and keeps the app published", async currentCapability => {
    let revision = 7;
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action === "list") return {kind:"listed",publications:[{publicationId:published.publicationId,authorityRevision:revision,shareId:row.shareId,grantId:row.grantId,active:true,datasetCapability: null, collectionCapability: revision === 7 ? currentCapability : null, backendCapability: null, linkCurrent: true, manifestUnavailable: false,appRoot:"trip",sourceRevision:prepared.sourceRevision}],nextCursor:null};
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
      if(request.action==="list") return {kind:"listed",publications:request.workspaceId==="ws-trip"?[{publicationId:published.publicationId,authorityRevision:7,shareId:row.shareId,grantId:row.grantId,active:true,datasetCapability: null, collectionCapability: approvedCollection, backendCapability: null, linkCurrent: true, manifestUnavailable: false,appRoot:"trip",sourceRevision:prepared.sourceRevision}]:[],nextCursor:null};
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
      if (request.action === "list") return { kind: "listed", publications: active ? [{ ...published, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: false, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, authorityRevision: 7 }] : [], nextCursor: null };
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
      return { kind: "listed", publications: [{ ...published, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: false, appRoot: "trip", sourceRevision: prepared.sourceRevision, shareId: row.shareId, grantId: row.grantId, active: false }], nextCursor: null };
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
      kind: "listed", publications: [{ publicationId: published.publicationId, authorityRevision: 9, shareId: row.shareId, grantId: row.grantId, active: true, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: true }], nextCursor: null,
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
      if (request.action === "list") return { kind: "listed", publications: [{ ...published, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active, authorityRevision: active ? 7 : 8, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: false }], nextCursor: null };
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

  it("cancels withdrawal confirmation without mutation", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ ...published, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: false, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().click(screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }));
    await userEvent.setup().click(screen.getByTestId("app-publication-withdraw-cancel"));
    expect(screen.queryByTestId("app-publication-withdraw-confirm")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Publish app" }));
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
      kind: "listed", publications: ["c", "d"].map((value, index) => ({ publicationId: value.repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: index === 0, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: false })), nextCursor: null,
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
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [1,2].map(index => ({ publicationId: String(index).repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: `grant-${index}`, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: false })), nextCursor: null } : answer(request));
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
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ publicationId: "c".repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: false }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    fireEvent.click(screen.getByRole("button", { name: "Load responses" }));
    expect((screen.getByRole("button", { name: "Close publication" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => pending.resolve({ action: "list", acceptances: [], nextAcceptanceId: null }));
  });

  it("explains backend access in plain words before approving the unchanged digest", async () => {
    api.publishOwnerApp.mockImplementation(request => request.action === "prepare" ? Promise.resolve({ ...prepared, capabilities: [backend] }) : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    const scope = screen.getByTestId("app-publication-capability");
    expect(scope.textContent).toContain("App data trip/data/app.sqlite lives in a private store on your dohc host. It is not a workspace file. This gives the app no access to workspace files.");
    expect(scope.textContent).toContain("Anyone with the link can run: donate (changes data), listDonations (reads only)");
    expect(scope.textContent).toContain("Helpers you allow can also run: verifyDonation (changes data)");
    expect(scope.textContent).toContain("Only you can run: updateDonation (changes data)");
    expect(scope.textContent).toContain("Tables you can browse: donations, pledges (read-only)");
    expect(scope.textContent).toContain(backend.backendSha256);
    expect(scope.textContent).toContain(backend.schemaSha256);
    expect(screen.queryByText(/Create records only/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Publish this revision" }));
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "approve", workspaceId: "ws-trip", approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
  });

  it("mounts the app data panel for an approved backend and shows its errors in the dialog", async () => {
    const appBackend = vi.fn((request: { action: string }) => request.action === "describe" ? Promise.resolve({ capability: backend, revision: 1, online: true }) : Promise.reject(new Error("Backend exited.")));
    vi.stubGlobal("dohcDesktop", { ...api, appBackend });
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [backendRow], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    const region = await screen.findByRole("region", { name: "App data" });
    expect(screen.getByText("Approved backend access")).toBeTruthy();
    expect(screen.queryByText("No collection access")).toBeNull();
    expect(screen.queryByRole("region", { name: "App responses" })).toBeTruthy();
    expect(appBackend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load table" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("Backend exited.");
    expect(region.querySelector("table")).toBeNull();
    expect(appBackend).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-trip", publicationId: published.publicationId, action: "invoke", operation: "listDonations" }));
  });

  it("routes app data errors through the shell hook when one is passed", async () => {
    const failure = new Error("Backend exited.");
    vi.stubGlobal("dohcDesktop", { ...api, appBackend: vi.fn(() => Promise.reject(failure)) });
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [backendRow], nextCursor: null } : answer(request));
    const reportError = vi.fn();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" reportError={reportError} />);
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Load table" }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not load donations.", failure, expect.any(Function)));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when backend details are unavailable and mounts no data panel", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ ...backendRow, backendCapability: "unavailable" as const }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(await screen.findByText("Backend data details unavailable.")).toBeTruthy();
    expect(screen.getByText("No collection access")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "App data" })).toBeNull();
  });
  it("shows the shared Collection binding and directs the owner to its records", async () => {
    const datasetCapability = { kind: "dataset" as const, datasetId: "00000000-0000-4000-8000-000000000001", revision: 1, revisionSha256: "a".repeat(64),
      operationIds: ["00000000-0000-4000-8000-000000000002"], operations: [{ operationId: "00000000-0000-4000-8000-000000000002", name: "submit", access: "link" as const, readOnly: false }] };
    api.publishOwnerApp.mockImplementation(async request => request.action === "list"
      ? { kind: "listed", publications: [{ ...backendRow, backendCapability: null, datasetCapability }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(await screen.findByText("Approved Collection access")).toBeTruthy();
    expect(screen.getByText("Open the Collection to view and manage its records.")).toBeTruthy();
    expect(screen.queryByText("No collection access")).toBeNull();
    expect(screen.queryByRole("region", { name: "App data" })).toBeNull();
  });

  it("prepares, reviews, and approves an app for this device when links and shared publications are unavailable", async () => {
    let approved = false;
    api.listRelayShareLinks.mockRejectedValue(new Error("Sign in to load links."));
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action === "list") throw new Error("Sign in to load publications.");
      if (request.action === "listLocal") return { kind: "localListed", publications: approved ? [localRow] : [] };
      if (request.action === "prepareLocal") return { ...prepared, capabilities: [backend], local: true };
      if (request.action === "approve") { approved = true; return { ...published, local: true }; }
      return answer(request);
    });
    const appBackend = vi.fn(async (request: { action: string }) => request.action === "describe" ? { capability: backend, revision: 1, online: true } : { result: { rows: [{ id: 1, status: "verified" }], total: 1 }, revision: 1, replayed: false });
    vi.stubGlobal("dohcDesktop", { ...api, appBackend });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(screen.getByText("No app approved on this device yet. Prepare it to review its source and data access.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Prepare app" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare for this device" }));
    await screen.findByRole("heading", { name: "Review app for this device" });
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "prepareLocal", workspaceId: "ws-trip", appRoot: "trip" });
    expect(screen.getByText("This device only")).toBeTruthy();
    expect(screen.getByText(/Approve this captured app for this device\. It is not published on any link\./)).toBeTruthy();
    const scope = screen.getByTestId("app-publication-capability");
    expect(scope.textContent).toContain("App data trip/data/app.sqlite stays in a private store on this device. It is not a workspace file.");
    expect(scope.textContent).toContain("No link exists for this approval. Only you can use the data until you publish the app on a link.");
    expect(scope.textContent).toContain("Once published on a link, anyone with the link can run: donate (changes data)");
    expect(screen.queryByText(/Unpublishing stops new access/)).toBeNull();
    expect(screen.getByTestId("app-publication-digest").textContent).toBe(prepared.candidateDigest);
    await userEvent.setup().click(screen.getByRole("button", { name: "Approve for this device" }));
    await screen.findByText("App approved on this device. It is not published on any link.");
    expect(api.publishOwnerApp).toHaveBeenCalledWith({ action: "approve", workspaceId: "ws-trip", approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
    expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "listLocal")).toHaveLength(2);
    await screen.findByText(/Approved on this device/);
    const region = screen.getByRole("region", { name: "App data" });
    expect(region.textContent).toContain("App data trip/data/app.sqlite stays in a private store on this device. Not published on any link.");
    fireEvent.click(screen.getByRole("button", { name: "Load table" }));
    await screen.findByRole("table");
    expect(appBackend).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-trip", publicationId: localRow.publicationId, action: "invoke", operation: "listDonations" }));
    expect(screen.getAllByRole("alert").map(alert => alert.textContent)).toEqual(["Sign in to load publications.", "Sign in to load links."]);
    expect(api.publishOwnerApp.mock.calls.some(([input]) => input.action === "prepare")).toBe(false);
  });

  it("cancels a local candidate on Escape and refuses a local answer to a link preparation", async () => {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare for this device" }));
    await screen.findByRole("heading", { name: "Review app for this device" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
    api.publishOwnerApp.mockImplementation(async request => request.action === "prepare" ? { ...prepared, local: true } : answer(request));
    await open();
    await userEvent.setup().selectOptions(screen.getByLabelText("Publication share link"), "grant-trip");
    await userEvent.setup().click(screen.getByRole("button", { name: "Prepare app" }));
    await screen.findByText("dohc could not prepare this app. Try again.");
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
    expect(screen.queryByRole("button", { name: "Publish this revision" })).toBeNull();
  });

  it("labels inactive local approvals, mounts no panel for them, and retries a failed local list alone", async () => {
    let attempts = 0;
    api.publishOwnerApp.mockImplementation(async request => {
      if (request.action !== "listLocal") return answer(request);
      if (++attempts === 1) throw new Error("Local apps are unavailable. Restart dohc and try again.");
      return { kind: "localListed", publications: [{ ...localRow, active: false }] };
    });
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect((await screen.findByRole("alert")).textContent).toBe("Local apps are unavailable. Restart dohc and try again.");
    expect(screen.getByText("No publications.")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload local apps" }));
    await screen.findByText(/Inactive on this device/);
    expect(screen.getByText("Its data is not active here. If you moved it to a share link, open that publication.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "App data" })).toBeNull();
    expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "list")).toHaveLength(1);
  });

  it("opens an active local approval in the browser once per click through the loopback address", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    api.publishOwnerApp.mockImplementation(request => request.action === "launchLocal" ? pending.promise : localList(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    expect(screen.queryByRole("button", { name: /^Open in browser/ })).toBeTruthy();
    fireEvent.click(await openButton());
    expect(screen.getByRole("button", { name: `Open in browser ${localRow.publicationId}` }).textContent).toBe("Opening…");
    fireEvent.click(screen.getByRole("button", { name: `Open in browser ${localRow.publicationId}` }));
    expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "launchLocal")).toEqual([[{ action: "launchLocal", workspaceId: "ws-trip", publicationId: localRow.publicationId }]]);
    expect((screen.getByRole("button", { name: "Prepare for this device" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close publication" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.openExternalUrl).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ kind: "localLaunched", publicationId: localRow.publicationId, url: "http://127.0.0.1:43123/" }); });
    expect(api.openExternalUrl).toHaveBeenCalledExactlyOnceWith({ url: "http://127.0.0.1:43123/" });
    expect(screen.getByText("App opened in your browser.")).toBeTruthy();
    expect((await openButton()).textContent).toBe("Open in browser");
  });

  it.each([
    { name: "another app's id", result: { kind: "localLaunched" as const, publicationId: "e".repeat(64), url: "http://127.0.0.1:43123/" } },
    { name: "an https address", result: { kind: "localLaunched" as const, publicationId: localRow.publicationId, url: "https://127.0.0.1:43123/" } },
    { name: "a hostname", result: { kind: "localLaunched" as const, publicationId: localRow.publicationId, url: "http://localhost:43123/" } },
    { name: "credentials", result: { kind: "localLaunched" as const, publicationId: localRow.publicationId, url: "http://owner:secret@127.0.0.1:43123/" } },
    { name: "no port", result: { kind: "localLaunched" as const, publicationId: localRow.publicationId, url: "http://127.0.0.1/" } },
    { name: "the wrong result kind", result: { kind: "cancelled" as const } },
  ])("refuses to open $name and offers a retry through the error hook", async ({ result }) => {
    api.publishOwnerApp.mockImplementation(request => request.action === "launchLocal" ? Promise.resolve(result) : localList(request));
    const reportError = vi.fn();
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" reportError={reportError} />);
    await open();
    fireEvent.click(await openButton());
    await waitFor(() => expect(reportError).toHaveBeenCalledWith("dohc could not open this app in your browser.", expect.any(Error), expect.any(Function)));
    expect(api.openExternalUrl).not.toHaveBeenCalled();
    expect(screen.queryByText("App opened in your browser.")).toBeNull();
    await act(async () => { (reportError.mock.calls[0]![2] as () => void)(); });
    await waitFor(() => expect(api.publishOwnerApp.mock.calls.filter(([input]) => input.action === "launchLocal")).toHaveLength(2));
    expect(api.openExternalUrl).not.toHaveBeenCalled();
  });

  it("never opens a launch that resolves after the workspace changed", async () => {
    const pending = deferred<OwnerAppPublicationResult>();
    api.publishOwnerApp.mockImplementation(request => request.action === "launchLocal" ? pending.promise : localList(request));
    const view = render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    fireEvent.click(await openButton());
    view.rerender(<OwnerAppPublication workspaceId="ws-other" appRoot="other" />);
    await act(async () => { pending.resolve({ kind: "localLaunched", publicationId: localRow.publicationId, url: "http://127.0.0.1:43123/" }); });
    expect(api.openExternalUrl).not.toHaveBeenCalled();
    expect(screen.queryByText("App opened in your browser.")).toBeNull();
  });

  it("does not mount a response panel for an unknown damaged app", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {kind:"listed",publications:[{publicationId:"c".repeat(64),authorityRevision:1,shareId:row.shareId,grantId:row.grantId,active:true,datasetCapability: null, collectionCapability: null, backendCapability: null, linkCurrent: true, manifestUnavailable: true}],nextCursor:null} : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    await screen.findByText("Source details unavailable. This publication may belong to another app.");
    expect(screen.queryByRole("region",{name:"App responses"})).toBeNull();
  });
});

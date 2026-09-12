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
const row: ListRelayShareLinksResult["links"][number] = {
  shareId: "share-trip", grantId: "grant-trip", generation: 1, status: "active", createdAtMs: 1,
  revokedAtMs: null, lastUsedAtMs: null, urlIssuedAtMs: 1, dependents: [], selector: { paths: ["trip"], versionId: null }, access: "view",
};
const page: ListRelayShareLinksResult = { supportedLinkAccess: ["view", "comment"], links: [row], independentGrants: [] };
async function answer(request: OwnerAppPublicationRequest): Promise<OwnerAppPublicationResult> {
  if (request.action === "list") return { kind: "listed", publications: [], nextCursor: null };
  if (request.action === "prepare" || request.action === "reviewReactivation") return prepared;
  if (request.action === "approve") return published;
  if (request.action === "withdraw") return { kind: "withdrawn", publicationId: published.publicationId, authorityRevision: 2 };
  return { kind: "cancelled" };
}
const api = {
  listRelayShareLinks: vi.fn(async (): Promise<ListRelayShareLinksResult> => page),
  publishOwnerApp: vi.fn(answer),
};

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

  it("cancels a prepared candidate on Escape without publishing", async () => {
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await review();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.publishOwnerApp).toHaveBeenLastCalledWith({ action: "cancel", workspaceId: "ws-trip", approvalId: prepared.approvalId });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Publish app" }));
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
      if (request.action === "list") return { kind: "listed", publications: active ? [{ ...published, manifestUnavailable: false, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, authorityRevision: 7 }] : [], nextCursor: null };
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
      return { kind: "listed", publications: [{ ...published, manifestUnavailable: false, appRoot: "trip", sourceRevision: prepared.sourceRevision, shareId: row.shareId, grantId: row.grantId, active: false }], nextCursor: null };
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
    expect(api.publishOwnerApp.mock.calls.every(([input]) => input.action === "list")).toBe(true);
  });

  it("can unpublish a damaged manifest without inventing its source or app", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {
      kind: "listed", publications: [{ publicationId: published.publicationId, authorityRevision: 9, shareId: row.shareId, grantId: row.grantId, active: true, manifestUnavailable: true }], nextCursor: null,
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
      if (request.action === "list") return { kind: "listed", publications: [{ ...published, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active, authorityRevision: active ? 7 : 8, manifestUnavailable: false }], nextCursor: null };
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
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ ...published, manifestUnavailable: false, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />);
    await open();
    await userEvent.setup().click(screen.getByRole("button", { name: `Unpublish ${published.publicationId}` }));
    await userEvent.setup().click(screen.getByTestId("app-publication-withdraw-cancel"));
    expect(screen.queryByTestId("app-publication-withdraw-confirm")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Publish app" }));
    expect(api.publishOwnerApp.mock.calls.every(([input]) => input.action === "list")).toBe(true);
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
    expect(scope.textContent).toContain("Fields it can read: place");
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
      kind: "listed", publications: ["c", "d"].map((value, index) => ({ publicationId: value.repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: index === 0, manifestUnavailable: false })), nextCursor: null,
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
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [1,2].map(index => ({ publicationId: String(index).repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: `grant-${index}`, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, manifestUnavailable: false })), nextCursor: null } : answer(request));
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
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? { kind: "listed", publications: [{ publicationId: "c".repeat(64), authorityRevision: 1, shareId: row.shareId, grantId: row.grantId, appRoot: "trip", sourceRevision: prepared.sourceRevision, active: true, manifestUnavailable: false }], nextCursor: null } : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    fireEvent.click(screen.getByRole("button", { name: "Load responses" }));
    expect((screen.getByRole("button", { name: "Close publication" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => pending.resolve({ action: "list", acceptances: [], nextAcceptanceId: null }));
  });

  it("does not mount a response panel for an unknown damaged app", async () => {
    api.publishOwnerApp.mockImplementation(async request => request.action === "list" ? {kind:"listed",publications:[{publicationId:"c".repeat(64),authorityRevision:1,shareId:row.shareId,grantId:row.grantId,active:true,manifestUnavailable:true}],nextCursor:null} : answer(request));
    render(<OwnerAppPublication workspaceId="ws-trip" appRoot="trip" />); await open();
    await screen.findByText("Source details unavailable. This publication may belong to another app.");
    expect(screen.queryByRole("region",{name:"App responses"})).toBeNull();
  });
});

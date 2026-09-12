// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { OwnerAppResponses } from "./OwnerAppResponses";

const accepted = { kind: "accepted", acceptanceId: "accepted-1", objectId: "object-1", momentId: "moment-1",
  publicPrincipalId: "public-person-1", versionId: "main", collectionPath: "trip/responses", path: "trip/responses/vote.md", acceptedAtMs: 1 };
const page = { action: "list", acceptances: [accepted], nextAcceptanceId: null };
const api = { ownerAppResponses: vi.fn() };
beforeEach(() => { vi.stubGlobal("dohcDesktop", api); api.ownerAppResponses.mockResolvedValue(page); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

async function load() {
  fireEvent.click(screen.getByRole("button", { name: "Load responses" }));
  await screen.findByText(accepted.path);
}

it("shows response provenance and requires confirmation before removing a holder's responses", async () => {
  render(<OwnerAppResponses workspaceId="workspace" grantId="grant" />);
  await load();
  expect(api.ownerAppResponses).toHaveBeenCalledWith({ action: "list", workspaceId: "workspace", grantId: "grant", limit: 100 });
  const trigger = screen.getByRole("button", { name: "Remove this holder’s responses" });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole("dialog").textContent).toContain("including responses outside this page");
  expect(api.ownerAppResponses).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retries an uncertain removal with the same identity and resumes the returned page", async () => {
  render(<OwnerAppResponses workspaceId="workspace" grantId="grant" />);
  await load();
  api.ownerAppResponses.mockRejectedValueOnce(new Error("Connection ended."));
  fireEvent.click(screen.getByRole("button", { name: "Remove this holder’s responses" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove responses" }));
  await screen.findByRole("alert");
  const first = api.ownerAppResponses.mock.calls[1][0];
  expect(first).toMatchObject({ action: "undo", workspaceId: "workspace", grantId: "grant", publicPrincipalId: accepted.publicPrincipalId, limit: 100 });
  api.ownerAppResponses.mockResolvedValueOnce({ action: "undo", items: [{ acceptanceId: accepted.acceptanceId, status: "deleted", momentId: "delete-1" }], nextCursor: "accepted-100" });
  fireEvent.click(screen.getByRole("button", { name: "Retry removal" }));
  await screen.findByText("Restore removed files from workspace history.");
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "App responses" }));
  expect(api.ownerAppResponses.mock.calls[2][0]).toEqual(first);
  api.ownerAppResponses.mockResolvedValueOnce({ action: "undo", items: [{ acceptanceId: "accepted-101", status: "conflict" }], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "Continue removing responses" }));
  await screen.findByText("0 removed. 0 already absent. 1 conflicts kept. 0 failed.");
  expect(api.ownerAppResponses.mock.calls[3][0]).toEqual({ ...first, afterAcceptanceId: "accepted-100" });
  expect(screen.queryByRole("button", { name: "Continue removing responses" })).toBeNull();
});

it("discards a response page after switching workspaces", async () => {
  const pending = deferred<unknown>();
  api.ownerAppResponses.mockReturnValueOnce(pending.promise);
  const view = render(<OwnerAppResponses workspaceId="workspace-a" grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "Load responses" }));
  view.rerender(<OwnerAppResponses workspaceId="workspace-b" grantId="grant" />);
  await act(async () => { pending.resolve(page); });
  expect(screen.queryByText(accepted.path)).toBeNull();
  expect(screen.getByRole("button", { name: "Load responses" })).toBeTruthy();
});

it("reports a malformed result and offers a working reload", async () => {
  api.ownerAppResponses.mockResolvedValueOnce({ action: "list", acceptances: [{ ...accepted, publicPrincipalId: undefined }], nextAcceptanceId: null });
  render(<OwnerAppResponses workspaceId="workspace" grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "Load responses" }));
  await screen.findByRole("alert");
  await load();
  expect(screen.queryByRole("alert")).toBeNull();
});

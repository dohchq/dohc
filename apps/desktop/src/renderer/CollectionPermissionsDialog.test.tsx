// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { CollectionPermissionsDialog } from "./CollectionPermissionsDialog";
import { ShellErrorReporter } from "./shell/useShellError";
import { deferred } from "../testing/deferred";
const api = vi.hoisted(() => ({ dataset: vi.fn(), listRelayShares: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => api }));
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const dataset: DatasetDescription = { datasetId: id(1), name: "Orders", revision: 2, revisionSha256: "a".repeat(64), tables: [], operations: [
  { operationId: id(2), name: "read", label: "Read orders", kind: "read", access: "helper", readOnly: true, tableId: id(4), fieldIds: [] },
  { operationId: id(3), name: "admin", label: "Owner action", kind: "action", access: "owner", readOnly: false, tableId: id(4), fieldIds: [] },
] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("grants only selected shareable actions from the displayed revision to a workspace recipient", async () => {
  api.dataset.mockImplementation(async input => input.action === "permissions" ? { kind: "permissions", permissions: [], nextCursor: null } : { kind: "grant-updated" });
  api.listRelayShares.mockResolvedValue({ granted: [
    { workspaceId: "w", grantId: "grant", recipientUserId: "person", recipientEmail: "friend@example.test", revokedAtMs: null },
    { workspaceId: "elsewhere", grantId: "other", recipientUserId: "other", recipientEmail: "other@example.test", revokedAtMs: null },
  ] });
  render(<CollectionPermissionsDialog datasetPath="data/dataset.json" workspaceId="w" dataset={dataset} onClose={vi.fn()} onError={vi.fn()} />);
  await screen.findByRole("option", { name: /friend@example.test/ });
  expect(screen.queryByText("Owner action")).toBeNull(); expect(screen.queryByRole("option", { name: /other@example.test/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("Collection access person"), { target: { value: "grant" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Read orders/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(api.dataset).toHaveBeenCalledWith({ workspaceId: "w", datasetPath: "data/dataset.json", expectedDatasetId: id(1), action: "setGrant", grantId: "grant",
    grant: { revision: 2, revisionSha256: "a".repeat(64), operationIds: [id(2)], discover: true } }));
});
it("says what moving to the server means before saving access to a Collection on this computer, then where it is", async () => {
  let place: object = { kind: "here", server: { host: "sync.example.test", runs: "off", automations: 2, scheduledAutomations: 0 } };
  api.dataset.mockImplementation(async input => input.action === "permissions" ? { kind: "permissions", permissions: [], nextCursor: null, place }
    : (place = { kind: "server", host: "sync.example.test" }, { kind: "grant-updated" }));
  api.listRelayShares.mockResolvedValue({ granted: [{ workspaceId: "w", grantId: "grant", recipientUserId: "person", recipientEmail: "friend@example.test", revokedAtMs: null }] });
  const onMoved = vi.fn();
  render(<CollectionPermissionsDialog datasetPath="data/dataset.json" workspaceId="w" dataset={dataset} onClose={vi.fn()} onError={vi.fn()} onMoved={onMoved} />);
  expect((await screen.findByTestId("collection-move-note")).textContent).toBe("Saving moves this Collection to sync.example.test. Even on this computer, "
    + "it then works only while sync.example.test is reachable. dohc can't move it back. Its automations stop, because sync.example.test doesn't run automations.");
  expect(screen.queryByText(/Saving replaces this person's allowed actions/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Collection access person"), { target: { value: "grant" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Read orders/ }));
  fireEvent.click(screen.getByRole("button", { name: "Move and save access" }));
  await waitFor(() => expect(api.dataset).toHaveBeenCalledWith(expect.objectContaining({ action: "setGrant", moveToServer: true })));
  await screen.findByText("This Collection is on sync.example.test.");
  expect(onMoved).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("collection-move-note")).toBeNull();
  expect(screen.getByRole("button", { name: "Save access" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Collection access person"), { target: { value: "grant" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Read orders/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(api.dataset.mock.calls.filter(([input]) => input.action === "setGrant")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save access" }).getAttribute("aria-disabled")).toBeNull());
  expect(onMoved).toHaveBeenCalledTimes(1);
});
const stopped = Error("CollectionMoveUnfinishedError: This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.");
const friend = { workspaceId: "w", grantId: "grant", recipientUserId: "person", recipientEmail: "friend@example.test", revokedAtMs: null };
const friendRow = `collection-access:${id(1)}:grant`;
const choose = async () => {
  await screen.findByRole("option", { name: /friend@example.test/ });
  fireEvent.change(screen.getByLabelText("Collection access person"), { target: { value: "grant" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Read orders/ }));
};
it("says in place that the access wasn't saved, keeps the choices and focus, files nothing while open, and saves again from its button", async () => {
  let fail = true;
  api.dataset.mockImplementation(async input => {
    if (input.action === "permissions") return { kind: "permissions", permissions: [], nextCursor: null };
    if (fail) throw stopped;
    return { kind: "grant-updated" };
  });
  api.listRelayShares.mockResolvedValue({ granted: [friend] });
  const onError = vi.fn(), onSettled = vi.fn(), report = vi.fn();
  render(<ShellErrorReporter.Provider value={report}><CollectionPermissionsDialog datasetPath="data/dataset.json" workspaceId="w" dataset={dataset} onClose={vi.fn()} onError={onError} onSettled={onSettled} /></ShellErrorReporter.Provider>);
  await choose();
  const save = screen.getByRole("button", { name: "Save access" });
  save.focus();
  fireEvent.click(save);
  const line = await screen.findByText("Access wasn't saved. This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.");
  expect(line.getAttribute("role")).toBe("status");
  expect(document.activeElement).toBe(save);
  expect((screen.getByLabelText("Collection access person") as HTMLSelectElement).value).toBe("grant");
  expect((screen.getByRole("checkbox", { name: /Read orders/ }) as HTMLInputElement).checked).toBe(true);
  expect(onError).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  fail = false;
  fireEvent.click(save);
  await waitFor(() => expect(onSettled).toHaveBeenCalledWith(friendRow));
  expect(screen.queryByText(/Access wasn't saved/)).toBeNull();
  await waitFor(() => expect((screen.getByLabelText("Collection access person") as HTMLSelectElement).value).toBe(""));
  expect(onError).not.toHaveBeenCalled();
});
it("keeps a failure in place when new rules arrive while it saves", async () => {
  const answer = deferred<never>();
  api.dataset.mockImplementation(async input => input.action === "permissions" ? { kind: "permissions", permissions: [], nextCursor: null } : answer.promise);
  api.listRelayShares.mockResolvedValue({ granted: [friend] });
  const report = vi.fn(), onError = vi.fn();
  const dialog = (shown: DatasetDescription) => <ShellErrorReporter.Provider value={report}>
    <CollectionPermissionsDialog datasetPath="data/dataset.json" workspaceId="w" dataset={shown} onClose={vi.fn()} onError={onError} /></ShellErrorReporter.Provider>;
  const { rerender } = render(dialog(dataset));
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(api.dataset).toHaveBeenCalledWith(expect.objectContaining({ action: "setGrant" })));
  rerender(dialog({ ...dataset, revision: 3, revisionSha256: "b".repeat(64) }));
  await act(async () => { answer.reject(stopped); await answer.promise.catch(() => undefined); });
  await screen.findByText("Access wasn't saved. This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.");
  expect(report).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
it("says in place that access wasn't removed, with the reason it failed", async () => {
  api.dataset.mockImplementation(async input => {
    if (input.action === "permissions") return { kind: "permissions", nextCursor: null,
      permissions: [{ kind: "data", principal: "person-key", current: true, metadata: { operationIds: [id(2)] } }] };
    throw Error("Sharing failed (502).");
  });
  api.listRelayShares.mockResolvedValue({ granted: [] });
  const onError = vi.fn();
  render(<CollectionPermissionsDialog datasetPath="data/dataset.json" workspaceId="w" dataset={dataset} onClose={vi.fn()} onError={onError} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove access" }));
  await screen.findByText("Access wasn't removed. Sharing failed (502).");
  expect(onError).not.toHaveBeenCalled();
});
it("reports a save that answers after the dialog closed with a toast naming the person and the Collection, whose Try again saves again", async () => {
  const answer = deferred<never>();
  let fail = true;
  api.dataset.mockImplementation(async input => {
    if (input.action === "permissions") return { kind: "permissions", permissions: [], nextCursor: null };
    if (fail) return answer.promise;
    return { kind: "grant-updated" };
  });
  api.listRelayShares.mockResolvedValue({ granted: [friend] });
  const report = vi.fn();
  const { unmount } = render(<ShellErrorReporter.Provider value={report}><CollectionPermissionsDialog datasetPath="data/dataset.json" workspaceId="w" dataset={dataset} onClose={vi.fn()} onError={vi.fn()} /></ShellErrorReporter.Provider>);
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(api.dataset).toHaveBeenCalledWith(expect.objectContaining({ action: "setGrant" })));
  unmount();
  await act(async () => { answer.reject(stopped); await answer.promise.catch(() => undefined); });
  await waitFor(() => expect(report).toHaveBeenCalledWith({ title: "Access wasn't saved for friend@example.test",
    message: "\"Orders\" didn't finish moving to sync.example.test. Its records are kept on this computer.", cause: stopped, identity: friendRow, retry: expect.any(Function) }));
  fail = false;
  act(() => { (report.mock.calls[0]![0] as { retry: () => void }).retry(); });
  await waitFor(() => expect(api.dataset.mock.calls.filter(([input]) => input.action === "setGrant")).toHaveLength(2));
  await act(async () => { await Promise.resolve(); });
  expect(report).toHaveBeenCalledTimes(1);
});
it("takes back a closed dialog's row when the next save for that person succeeds", async () => {
  const answer = deferred<never>();
  let fail = true;
  api.dataset.mockImplementation(async input => {
    if (input.action === "permissions") return { kind: "permissions", permissions: [], nextCursor: null };
    if (fail) return answer.promise;
    return { kind: "grant-updated" };
  });
  api.listRelayShares.mockResolvedValue({ granted: [friend] });
  const report = vi.fn(), onSettled = vi.fn();
  const dialog = <ShellErrorReporter.Provider value={report}><CollectionPermissionsDialog datasetPath="data/dataset.json" workspaceId="w" dataset={dataset} onClose={vi.fn()} onError={vi.fn()} onSettled={onSettled} /></ShellErrorReporter.Provider>;
  const first = render(dialog);
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(api.dataset).toHaveBeenCalledWith(expect.objectContaining({ action: "setGrant" })));
  first.unmount();
  await act(async () => { answer.reject(stopped); await answer.promise.catch(() => undefined); });
  await waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ identity: friendRow })));
  fail = false;
  render(dialog);
  await choose();
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(onSettled).toHaveBeenCalledWith(friendRow));
});

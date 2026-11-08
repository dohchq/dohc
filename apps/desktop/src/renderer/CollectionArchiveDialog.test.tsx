// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CollectionArchiveDialog } from "./CollectionArchiveDialog";
import { deferred } from "../testing/deferred";
const backend = vi.hoisted(() => ({ dataset: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => backend }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const props = () => ({ datasetId: "dataset", workspaceId: "workspace", datasetPath: "data/dataset.json", name: "Fundraiser", onClose: vi.fn(), onChanged: vi.fn(), onError: vi.fn() });
it("shows affected apps before archiving and confirms the reverse path", async () => {
  backend.dataset.mockImplementation(async value => value.action === "lifecycle" ? { kind: "lifecycle", archived: false, generation: 0, reason: "", apps: [{ appId: "public-form", binding: { operationIds: ["submit"] } }], nextCursor: null } : { kind: "lifecycle-updated", archived: true, generation: 1 });
  const p = props(); render(<CollectionArchiveDialog {...p} />);
  expect(await screen.findByText("public-form")).toBeTruthy(); expect(screen.getByText(/Restore it from archived Collections/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(p.onChanged).toHaveBeenCalledOnce());
  expect(backend.dataset).toHaveBeenLastCalledWith({ workspaceId: "workspace", datasetPath: "data/dataset.json", expectedDatasetId: "dataset", action: "archive" }); expect(p.onClose).toHaveBeenCalledOnce();
});
it("does not repaint or close a new workspace when an earlier archive acknowledgement arrives", async () => {
  const pending = deferred<unknown>(); backend.dataset.mockImplementation(async input => input.action === "archive" ? pending.promise : { kind: "lifecycle", archived: false, generation: 0, reason: "", apps: [], nextCursor: null });
  const p = props(), view = render(<CollectionArchiveDialog {...p} />);
  await screen.findByText("No apps use this Collection."); fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  view.rerender(<CollectionArchiveDialog {...p} datasetPath="data/dataset.json" workspaceId="other" />);
  await act(async () => pending.resolve({ kind: "lifecycle-updated", archived: true, generation: 1 }));
  expect(p.onChanged).not.toHaveBeenCalled(); expect(p.onClose).not.toHaveBeenCalled();
});
it("says no app uses the Collection without a heading or a refresh button", async () => {
  backend.dataset.mockResolvedValue({ kind: "lifecycle", archived: false, generation: 0, reason: "", apps: [], nextCursor: null });
  render(<CollectionArchiveDialog {...props()} />);
  await screen.findByText("No apps use this Collection.");
  expect(screen.queryByRole("heading", { name: "Affected apps" })).toBeNull(); expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
});
it("shows Try again in the list's place when a page fails, and reads that page again", async () => {
  const lifecycle = (apps: string[], nextCursor: string | null) => ({ kind: "lifecycle", archived: false, generation: 0, reason: "", apps: apps.map(appId => ({ appId, binding: { operationIds: ["submit"] } })), nextCursor });
  backend.dataset.mockResolvedValueOnce(lifecycle(["form"], "next")).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(lifecycle(["admin"], null));
  const p = props(); render(<CollectionArchiveDialog {...p} />);
  await screen.findByText("form"); fireEvent.click(screen.getByRole("button", { name: "More apps" }));
  expect(await screen.findByTestId("collection-archive-apps-retry")).toBeTruthy();
  expect(p.onError).toHaveBeenCalledWith("Could not read the affected apps.", expect.any(Error), expect.any(Function));
  expect((screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("admin")).toBeTruthy();
  expect(backend.dataset).toHaveBeenLastCalledWith(expect.objectContaining({ action: "lifecycle", after: "next" }));
  expect(screen.queryByTestId("collection-archive-apps-retry")).toBeNull();
});
it("reads Archiving… while the archive runs", async () => {
  const pending = deferred<unknown>(); backend.dataset.mockImplementation(async input => input.action === "archive" ? pending.promise : { kind: "lifecycle", archived: false, generation: 0, reason: "", apps: [], nextCursor: null });
  render(<CollectionArchiveDialog {...props()} />);
  await screen.findByText("No apps use this Collection."); fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  expect((await screen.findByRole("button", { name: "Archiving…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve({ kind: "lifecycle-updated", archived: true, generation: 1 }));
});

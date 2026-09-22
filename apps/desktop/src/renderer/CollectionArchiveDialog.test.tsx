// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CollectionArchiveDialog } from "./CollectionArchiveDialog";
import { deferred } from "../testing/deferred";
const backend = vi.hoisted(() => ({ dataset: vi.fn() }));
vi.mock("./bridge", () => ({ bridge: () => backend }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const props = () => ({ workspaceId: "workspace", datasetId: "dataset", name: "Fundraiser", onClose: vi.fn(), onChanged: vi.fn(), onError: vi.fn() });
it("shows affected apps before archiving and confirms the reverse path", async () => {
  backend.dataset.mockImplementation(async value => value.action === "lifecycle" ? { kind: "lifecycle", archived: false, generation: 0, reason: "", apps: [{ appId: "public-form", binding: { operationIds: ["submit"] } }], nextCursor: null } : { kind: "lifecycle-updated", archived: true, generation: 1 });
  const p = props(); render(<CollectionArchiveDialog {...p} />);
  expect(await screen.findByText("public-form")).toBeTruthy(); expect(screen.getByText(/Restore it from Archived collections/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archive Collection" }));
  await waitFor(() => expect(p.onChanged).toHaveBeenCalledOnce());
  expect(backend.dataset).toHaveBeenLastCalledWith({ workspaceId: "workspace", datasetId: "dataset", action: "archive" }); expect(p.onClose).toHaveBeenCalledOnce();
});
it("does not repaint or close a new workspace when an earlier archive acknowledgement arrives", async () => {
  const pending = deferred<unknown>(); backend.dataset.mockImplementation(async input => input.action === "archive" ? pending.promise : { kind: "lifecycle", archived: false, generation: 0, reason: "", apps: [], nextCursor: null });
  const p = props(), view = render(<CollectionArchiveDialog {...p} />);
  await screen.findByText("No apps on this page use this Collection."); fireEvent.click(screen.getByRole("button", { name: "Archive Collection" }));
  view.rerender(<CollectionArchiveDialog {...p} workspaceId="other" />);
  await act(async () => pending.resolve({ kind: "lifecycle-updated", archived: true, generation: 1 }));
  expect(p.onChanged).not.toHaveBeenCalled(); expect(p.onClose).not.toHaveBeenCalled();
});

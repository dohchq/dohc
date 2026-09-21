// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBackendCapability } from "@dohc/security-contract/app-backend";
import { deferred } from "../testing/deferred";
import { OwnerAppBackend } from "./OwnerAppBackend";

const capability: AppBackendCapability = {
  kind: "app-backend", dataPath: "trip/data/app.sqlite", backendPath: "backend.js", schemaPath: "schema.sql",
  backendSha256: "a".repeat(64), schemaSha256: "b".repeat(64), schemaVersion: 1,
  operations: [
    { name: "donate", access: "link", readOnly: false },
    { name: "listDonations", access: "owner", readOnly: true },
    { name: "listPledges", access: "owner", readOnly: true },
    { name: "updateDonation", access: "owner", readOnly: false },
  ],
  tables: [
    { name: "donations", primaryKey: "id", readOperation: "listDonations", writeOperation: "updateDonation" },
    { name: "pledges", primaryKey: "id", readOperation: "listPledges", writeOperation: null },
  ],
};
const rows = [
  { id: 1, donor: "Ana", amount: 25, status: "pending_verification", verified: false, note: null, version: 4, meta: { source: "web" } },
  { id: 2, donor: "Bo", amount: 40, status: "verified", verified: true, note: "cash", meta: { source: "venue" } },
];
type Request = { workspaceId: string; publicationId: string; action: string; operation?: string; idempotencyKey?: string; input?: unknown };
function answer(request: Request): Promise<unknown> {
  if (request.action === "describe") return Promise.resolve({ capability, revision: 3, online: true });
  if (request.action === "invoke") return Promise.resolve({ result: request.operation === "updateDonation" ? { ok: true } : { rows, total: 2 }, revision: 3, replayed: false });
  if (request.action === "export") return Promise.resolve({ savedPath: "C:/exports/app.sqlite" });
  return Promise.reject(new Error("unexpected action"));
}
const api = { appBackend: vi.fn(answer) };
const onError = vi.fn();
const publicationId = "c".repeat(64);
const invokes = (operation: string) => api.appBackend.mock.calls.filter(([input]) => input.action === "invoke" && input.operation === operation);
const panel = (workspaceId = "ws-trip", id = publicationId) => <OwnerAppBackend workspaceId={workspaceId} publicationId={id} capability={capability} onError={onError} />;
async function loadTable() {
  fireEvent.click(screen.getByRole("button", { name: "Load table" }));
  await screen.findByRole("table");
}

describe("owner app backend", () => {
  beforeEach(() => { vi.stubGlobal("dohcDesktop", api); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); api.appBackend.mockImplementation(answer); });

  it("loads a table through the declared read operation and shows scalar fields only", async () => {
    render(panel());
    expect(api.appBackend).not.toHaveBeenCalled();
    await loadTable();
    expect(api.appBackend).toHaveBeenCalledWith({ workspaceId: "ws-trip", publicationId, action: "describe" });
    expect(invokes("listDonations")[0]![0]).toMatchObject({ workspaceId: "ws-trip", publicationId, input: { offset: 0, limit: 50, search: "" } });
    expect(screen.getAllByRole("columnheader").map(header => header.textContent)).toEqual(["id", "donor", "amount", "status", "verified", "note", "version", "Actions"]);
    expect(screen.getByText("pending_verification")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
    expect(screen.getByText("Data active")).toBeTruthy();
    expect(screen.getByText("Rows 1–2 of 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().type(screen.getByLabelText("Search app data"), "Ana{Enter}");
    await waitFor(() => expect(invokes("listDonations")).toHaveLength(2));
    expect(invokes("listDonations")[1]![0].input).toEqual({ offset: 0, limit: 50, search: "Ana" });
  });

  it("pages forward by the page size", async () => {
    api.appBackend.mockImplementation(request => request.action === "invoke"
      ? Promise.resolve({ result: { rows: Array.from({ length: 50 }, (_, index) => ({ id: index + 1, donor: "x" })), total: 120 }, revision: 3, replayed: false }) : answer(request));
    render(panel());
    await loadTable();
    expect(screen.getByText("Rows 1–50 of 120")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Rows 51–100 of 120");
    expect(invokes("listDonations")[1]![0].input).toEqual({ offset: 50, limit: 50, search: "" });
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("Rows 1–50 of 120");
  });

  it("sends the loaded row version with an edit and omits it when the row has none", async () => {
    render(panel());
    await loadTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    const form = screen.getByRole("form", { name: "Edit row" });
    expect(form.textContent).toContain("Runs updateDonation");
    await userEvent.setup().selectOptions(screen.getByLabelText("Edit field"), "status");
    expect((screen.getByLabelText("Edit value") as HTMLInputElement).value).toBe("pending_verification");
    fireEvent.change(screen.getByLabelText("Edit value"), { target: { value: "verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved status for row 1.");
    expect(invokes("updateDonation")).toHaveLength(1);
    expect(invokes("updateDonation")[0]![0]).toMatchObject({ workspaceId: "ws-trip", publicationId, input: { rowId: 1, field: "status", value: "verified", expectedVersion: 4 } });
    expect(typeof invokes("updateDonation")[0]![0].idempotencyKey).toBe("string");
    expect(invokes("listDonations")).toHaveLength(2);
    expect(screen.queryByRole("form", { name: "Edit row" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "App data" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit row 2" }));
    await userEvent.setup().selectOptions(screen.getByLabelText("Edit field"), "amount");
    expect((screen.getByLabelText("Edit value") as HTMLInputElement).type).toBe("number");
    fireEvent.change(screen.getByLabelText("Edit value"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved amount for row 2.");
    expect(invokes("updateDonation")[1]![0].input).toEqual({ rowId: 2, field: "amount", value: 30 });

    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    await userEvent.setup().selectOptions(screen.getByLabelText("Edit field"), "verified");
    await userEvent.setup().selectOptions(screen.getByLabelText("Edit value"), "true");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved verified for row 1.");
    expect(invokes("updateDonation")[2]![0].input).toEqual({ rowId: 1, field: "verified", value: true, expectedVersion: 4 });
  });

  it("reports a refused edit and retries the captured value, version, and idempotency key", async () => {
    const refusal = new Error("Cannot verify a rejected donation.");
    let version = 4;
    api.appBackend.mockImplementation(request => request.action !== "invoke" ? answer(request) : request.operation === "updateDonation" ? Promise.reject(refusal)
      : Promise.resolve({ result: { rows: [{ ...rows[0]!, version }, rows[1]!], total: 2 }, revision: 3, replayed: false }));
    render(panel());
    await loadTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    await userEvent.setup().selectOptions(screen.getByLabelText("Edit field"), "status");
    fireEvent.change(screen.getByLabelText("Edit value"), { target: { value: "verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not save status for row 1.", refusal, expect.any(Function)));
    expect(screen.getByRole("form", { name: "Edit row" })).toBeTruthy();
    expect(screen.queryByText(/^Saved/)).toBeNull();
    expect(invokes("listDonations")).toHaveLength(1);
    const first = invokes("updateDonation")[0]![0];
    expect(first.input).toEqual({ rowId: 1, field: "status", value: "verified", expectedVersion: 4 });
    version = 5;
    fireEvent.click(screen.getByRole("button", { name: "Reload table" }));
    await screen.findByText("5");
    const retry = onError.mock.calls[0]![2] as () => void;
    await act(async () => { retry(); });
    await waitFor(() => expect(invokes("updateDonation")).toHaveLength(2));
    expect(invokes("updateDonation")[1]![0].idempotencyKey).toBe(first.idempotencyKey);
    expect(invokes("updateDonation")[1]![0].input).toEqual(first.input);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    await userEvent.setup().selectOptions(screen.getByLabelText("Edit field"), "status");
    fireEvent.change(screen.getByLabelText("Edit value"), { target: { value: "rejected" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokes("updateDonation")).toHaveLength(3));
    expect(invokes("updateDonation")[2]![0].idempotencyKey).not.toBe(first.idempotencyKey);
    expect(invokes("updateDonation")[2]![0].input).toEqual({ rowId: 1, field: "status", value: "rejected", expectedVersion: 5 });
  });

  it.each([
    { name: "a result without rows", respond: () => Promise.resolve({ result: { count: 2 }, revision: 3, replayed: false }), detail: "The app's read operation did not return rows." },
    { name: "a rejected read", respond: () => Promise.reject(new Error("Backend exited.")), detail: "Backend exited." },
  ])("reports $name and offers a retry", async ({ respond, detail }) => {
    api.appBackend.mockImplementation(request => request.action === "invoke" ? respond() : answer(request));
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Load table" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dohc could not load donations.", expect.objectContaining({ message: detail }), expect.any(Function)));
    expect(screen.queryByRole("table")).toBeNull();
    api.appBackend.mockImplementation(answer);
    await act(async () => { (onError.mock.calls[0]![2] as () => void)(); });
    await screen.findByRole("table");
  });

  it("never paints workspace A's pending page in workspace B", async () => {
    const pending = deferred<unknown>();
    api.appBackend.mockImplementation(request => request.action === "invoke" ? pending.promise : answer(request));
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Load table" }));
    await screen.findByRole("status");
    view.rerender(panel("ws-other", "d".repeat(64)));
    await act(async () => { pending.resolve({ result: { rows, total: 2 }, revision: 3, replayed: false }); });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Load table" })).toBeTruthy();
    expect(api.appBackend.mock.calls.every(([input]) => input.workspaceId === "ws-trip")).toBe(true);
  });

  it("drops a rejection that arrives after unmount", async () => {
    const pending = deferred<unknown>();
    api.appBackend.mockImplementation(request => request.action === "invoke" ? pending.promise : answer(request));
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Load table" }));
    await screen.findByRole("status");
    view.unmount();
    await act(async () => { pending.reject(new Error("late")); });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([{ local: true, hint: "If you moved its data to a share link, open that publication." }, { local: false, hint: "Initialize or restore its data first." }])("labels inactive data honestly instead of reading it (local: $local)", async ({ local, hint }) => {
    api.appBackend.mockImplementation(request => request.action === "describe" ? Promise.resolve({ capability, revision: 0, online: false }) : answer(request));
    render(<OwnerAppBackend workspaceId="ws-trip" publicationId={publicationId} capability={capability} local={local} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "Load table" }));
    await screen.findByText("No active data");
    expect(screen.getByRole("status").textContent).toBe(`This app has no active data here. dohc cannot load rows or save edits. ${hint}`);
    expect(screen.queryByRole("table")).toBeNull();
    expect(api.appBackend.mock.calls.every(([input]) => input.action === "describe")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Export data" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(local ? /Stored on this device in/ : /^Stored in/)).toBeTruthy();
  });

  it("offers no edit for a table without a write operation", async () => {
    render(panel());
    await userEvent.setup().selectOptions(screen.getByLabelText("App data table"), "pledges");
    expect(screen.getByText("The app allows no edits to pledges.")).toBeTruthy();
    await loadTable();
    expect(invokes("listPledges")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Edit row/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
  });

  it("exports data and shows where it was saved, and stays quiet when the save is cancelled", async () => {
    render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Export data" }));
    await screen.findByText("Exported data to C:/exports/app.sqlite.");
    expect(api.appBackend).toHaveBeenCalledWith({ workspaceId: "ws-trip", publicationId, action: "export" });
    api.appBackend.mockImplementation(request => request.action === "export" ? Promise.resolve({ savedPath: null }) : answer(request));
    fireEvent.click(screen.getByRole("button", { name: "Export data" }));
    await waitFor(() => expect(api.appBackend.mock.calls.filter(([input]) => input.action === "export")).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "Export data" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/^Exported/)).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

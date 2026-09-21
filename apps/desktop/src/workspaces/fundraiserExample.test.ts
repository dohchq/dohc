// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import { beforeEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  BackendError, createFundraiserClient, createRegistrationAttempt, submitRegistration, type BackendPort, type FundraiserClient,
} from "../../../../examples/fundraiser/client";
import { EXAMPLE_NOTICE, fullName, mountFundraiser, normalizeMobile } from "../../../../examples/fundraiser/frontend";
import type { PublicSession, RegisterResult, RegistrationRow } from "../../../../examples/fundraiser/ui-types";

// jsdom Blobs may lack arrayBuffer(); the app reads receipts through it.
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", { configurable: true, value(this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  } });
}

const sessions: PublicSession[] = [
  { id: "s1", name: "Session 1 (1–4 PM)", startsAt: "2026-09-27T13:00:00+08:00", capacity: 36, reserved: 4, available: 32, playerPrice: 1000, spectatorPrice: 150 },
  { id: "s2", name: "Session 2 (4–7 PM)", startsAt: "2026-09-27T16:00:00+08:00", capacity: 36, reserved: 36, available: 0, playerPrice: 1000, spectatorPrice: 150 },
];
const token = "A".repeat(43);
const saved: RegisterResult = { id: "req_1", status: "pending_verification", total: 1150, version: 1, createdAtMs: 1_790_000_000_000, sessions: [{ sessionId: "s1", players: 1, spectators: 1 }], statusToken: token };
const uploaded = { file: { fileId: "file_0123456789abcdef", name: "receipt.png", contentType: "image/png", byteLength: 4, sha256: "a".repeat(64) }, replayed: false };
const row: RegistrationRow = {
  id: "req_1", status: "pending_verification", total: 1150, version: 3, createdAtMs: 1_790_000_000_000, sessions: [{ sessionId: "s1", players: 1, spectators: 1 }],
  fullName: "Ana Cruz", mobile: "+639171234567", source: "website", paymentMethod: "gcash", hasReceipt: true, updatedAtMs: 1_790_000_000_000,
};
function fakeClient(overrides: Partial<FundraiserClient> = {}): FundraiserClient {
  return {
    listPublicSessions: vi.fn<FundraiserClient["listPublicSessions"]>(async () => sessions),
    uploadReceipt: vi.fn<FundraiserClient["uploadReceipt"]>(async () => uploaded),
    register: vi.fn<FundraiserClient["register"]>(async () => ({ result: saved, revision: 1, replayed: false })),
    lookupStatus: vi.fn<FundraiserClient["lookupStatus"]>(async () => ({ ...saved, attendees: [{ id: "a1", sessionId: "s1", role: "player", name: "Ana Cruz" }] })),
    listRegistrations: vi.fn<FundraiserClient["listRegistrations"]>(async () => ({ records: [], nextOffset: null })),
    setStatus: vi.fn<FundraiserClient["setStatus"]>(async () => ({ ...row, status: "verified", version: 4 })),
    manualEntry: vi.fn<FundraiserClient["manualEntry"]>(async () => ({ result: row, revision: 1, replayed: false })),
    attendees: vi.fn<FundraiserClient["attendees"]>(async () => ({ records: [], nextOffset: null })),
    totals: vi.fn<FundraiserClient["totals"]>(async () => []),
    receipt: vi.fn<FundraiserClient["receipt"]>(async () => ({ file: uploaded.file, bytesBase64: "iVBORw0KGgo=" })),
    close: vi.fn(),
    ...overrides,
  };
}
const fieldsetDisabled = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).closest("fieldset")?.disabled;
function mount(client: FundraiserClient): void {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mountFundraiser(root, client);
}
async function fillRegistration(): Promise<void> {
  await screen.findByLabelText("Session 1 (1–4 PM)");
  fireEvent.input(screen.getByLabelText("Your first and last name"), { target: { value: " Ice  de Vera " } });
  fireEvent.input(screen.getByLabelText("Mobile number"), { target: { value: "0917 123 4567" } });
  fireEvent.click(screen.getByLabelText("Session 1 (1–4 PM)"));
  fireEvent.input(screen.getByLabelText("Player 1 name"), { target: { value: "Ana Cruz" } });
  fireEvent.click(screen.getByRole("button", { name: "Add spectator" }));
  fireEvent.input(screen.getByLabelText("Spectator 1 name"), { target: { value: "Ben Reyes" } });
  fireEvent.click(screen.getByLabelText("GCash"));
  const fileInput = screen.getByLabelText("Receipt") as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["abcd"], "receipt.png", { type: "image/png" })] });
  fireEvent.change(fileInput);
}
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send registration" }));

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(URL, "createObjectURL", {value: vi.fn(() => "blob:synthetic-test"), configurable: true});
  Object.defineProperty(URL, "revokeObjectURL", {value: vi.fn(), configurable: true});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
Object.defineProperty(globalThis.crypto, "subtle", {value: webcrypto.subtle, configurable: true});

it("validates contact details the way the backend does", () => {
  expect(normalizeMobile("0917 123 4567")).toBe("+639171234567");
  expect(normalizeMobile("+63 (917) 123-4567")).toBe("+639171234567");
  expect(normalizeMobile("12345")).toBeNull();
  expect(fullName("  Ana   Cruz ")).toBe("Ana Cruz");
  expect(fullName("Ana")).toBeNull();
});

it("retries a registration with the same keys and skips a confirmed upload", async () => {
  const invoke = vi.fn(async (_operation: string, _input: unknown, _key: string) => ({ result: saved as unknown, revision: 2, replayed: false }))
    .mockRejectedValueOnce(new BackendError(503));
  const upload = vi.fn<BackendPort["upload"]>().mockResolvedValue(uploaded);
  const port: BackendPort = { invoke: invoke as unknown as BackendPort["invoke"], upload, file: vi.fn(), close: vi.fn() };
  const client = createFundraiserClient(port);
  const attempt = await createRegistrationAttempt({ fullName: "Ice de Vera", mobile: "+639171234567", sessions: [], paymentMethod: "gcash" }, { name: "receipt.png", contentType: "image/png", bytesBase64: "YWJjZA==" });
  await expect(submitRegistration(client, attempt)).rejects.toMatchObject({ status: 503, uncertain: true });
  await submitRegistration(client, attempt);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
  expect(invoke.mock.calls[0]![2]).toMatch(/^register:/);
  const corrected = await createRegistrationAttempt({ ...attempt.input, fullName: "Ice Vera" }, attempt.receipt);
  expect(corrected.registerKey).not.toBe(attempt.registerKey);
  expect(corrected.fileId).toBeNull();
  expect(corrected.uploadKey).not.toBe(attempt.uploadKey);
});

it("registers a group, shows the private token, and carries it to the status view", async () => {
  const client = fakeClient();
  mount(client);
  expect(screen.getByRole("note").textContent).toBe(EXAMPLE_NOTICE);
  await fillRegistration();
  expect(screen.getByText("Total").parentElement?.textContent).toContain("1,150");
  send();
  await screen.findByText("Registration received");
  expect(client.register).toHaveBeenCalledWith(expect.objectContaining({
    fullName: "Ice de Vera", mobile: "+639171234567", sessions: [{ sessionId: "s1", players: ["Ana Cruz"], spectators: ["Ben Reyes"] }],
    paymentMethod: "gcash", receiptFileId: uploaded.file.fileId,
  }), expect.stringMatching(/^register:/));
  expect(client.uploadReceipt).toHaveBeenCalledWith({ name: "receipt.png", contentType: "image/png", bytesBase64: "YWJjZA==" }, expect.stringMatching(/^upload:/));
  expect(screen.getByText(token)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  expect((screen.getByLabelText("Private status token") as HTMLInputElement).value).toBe(token);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await screen.findByText("Players:", { exact: false });
  expect(client.lookupStatus).toHaveBeenCalledWith(token);
});

it("freezes the draft after an uncertain outcome and retries the identical registration", async () => {
  const client = fakeClient({ register: vi.fn<FundraiserClient["register"]>().mockRejectedValueOnce(new BackendError(503)).mockResolvedValue({ result: saved, revision: 1, replayed: true }) });
  mount(client);
  await fillRegistration();
  send();
  const retry = await screen.findByRole("button", { name: "Retry same registration" });
  expect(fieldsetDisabled("Mobile number")).toBe(true);
  fireEvent.click(retry);
  await screen.findByText("Registration received");
  await screen.findByText("This registration was already saved. Nothing was sent twice.");
  expect(client.uploadReceipt).toHaveBeenCalledTimes(1);
  expect(vi.mocked(client.register).mock.calls[1]).toEqual(vi.mocked(client.register).mock.calls[0]);
});

it("unfreezes after a definite refusal and sends the corrected draft under a new key", async () => {
  const client = fakeClient({ register: vi.fn<FundraiserClient["register"]>().mockRejectedValueOnce(new BackendError(409)).mockResolvedValue({ result: saved, revision: 1, replayed: false }) });
  mount(client);
  await fillRegistration();
  send();
  await screen.findByRole("alert");
  expect(fieldsetDisabled("Mobile number")).toBe(false);
  expect(screen.queryByRole("button", { name: "Retry same registration" })).toBeNull();
  send();
  await screen.findByText("Registration received");
  const calls = vi.mocked(client.register).mock.calls;
  expect(calls[1]![1]).not.toBe(calls[0]![1]);
  expect(client.uploadReceipt).toHaveBeenCalledTimes(2);
});

it("shows the backend's safe capacity refusal beside the registration", async () => {
  const client = fakeClient({register: vi.fn<FundraiserClient["register"]>().mockRejectedValue(new BackendError(409,
    {code: "capacity_unavailable", message: "A session no longer has enough player slots."}))});
  mount(client); await fillRegistration(); send();
  await screen.findByText("A session no longer has enough player slots.");
  expect(fieldsetDisabled("Mobile number")).toBe(false);
});

it("resumes a retained attempt from the app context and reports when it settles", async () => {
  const client = fakeClient();
  const pendingAttempt = await createRegistrationAttempt({ fullName: "Ice de Vera", mobile: "+639171234567", sessions: [{ sessionId: "s2", players: ["Ana Cruz"], spectators: [] }], paymentMethod: "bdo" },
    { name: "receipt.png", contentType: "image/png", bytesBase64: "YWJjZA==" });
  pendingAttempt.fileId = uploaded.file.fileId;
  const pendingAttemptChanged = vi.fn();
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mountFundraiser(root, client, { pendingAttempt, pendingAttemptChanged });
  expect(fieldsetDisabled("Mobile number")).toBe(true);
  expect((screen.getByLabelText("Player 1 name") as HTMLInputElement).value).toBe("Ana Cruz");
  expect((screen.getByLabelText("BDO") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry same registration" }));
  await screen.findByText("Registration received");
  expect(client.uploadReceipt).not.toHaveBeenCalled();
  expect(client.register).toHaveBeenCalledWith({ ...pendingAttempt.input, receiptFileId: uploaded.file.fileId }, pendingAttempt.registerKey);
  expect(pendingAttemptChanged).toHaveBeenCalledWith(null);
});

it("reports unavailable organizer access without simulating authority", async () => {
  const client = fakeClient({ totals: vi.fn<FundraiserClient["totals"]>().mockRejectedValueOnce(new BackendError(404)).mockResolvedValue([]) });
  mount(client);
  fireEvent.click(screen.getByRole("button", { name: "Organizer" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Organizer access is unavailable");
  expect(client.listRegistrations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Payment totals");
  await waitFor(() => expect(client.listRegistrations).toHaveBeenCalledWith({ status: "pending_verification", search: "", offset: 0, limit: 50 }));
});

it("keeps readable recovery data when a download cannot start and sends nothing yet", async () => {
  const client = fakeClient(); mount(client); await fillRegistration();
  vi.mocked(URL.createObjectURL).mockImplementation(() => { throw new Error("download refused"); });
  send();
  await screen.findByRole("button", {name: "Retry same registration"});
  const details = screen.getByText("Copy recovery data if the download is missing").closest("details")!;
  details.open = true; fireEvent(details, new Event("toggle"));
  const value = (screen.getByLabelText("Private recovery data") as HTMLTextAreaElement).value;
  const recovery = JSON.parse(value);
  expect(recovery.attempt.input).toMatchObject({fullName: "Ice de Vera", retrySecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
  expect(client.register).not.toHaveBeenCalled();
  expect(client.uploadReceipt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Retry same registration"}));
  await screen.findByText("Registration received");
  expect(client.register).toHaveBeenCalledWith({...recovery.attempt.input, receiptFileId: uploaded.file.fileId}, recovery.attempt.registerKey);
});

it("changes a registration status with its expected version and updates the list", async () => {
  const client = fakeClient({ listRegistrations: vi.fn<FundraiserClient["listRegistrations"]>()
    .mockResolvedValueOnce({ records: [row], nextOffset: null })
    .mockResolvedValue({ records: [], nextOffset: null }) });
  mount(client);
  fireEvent.click(screen.getByRole("button", { name: "Organizer" }));
  fireEvent.click(await screen.findByRole("button", { name: "Ana Cruz" }));
  const dialog = document.querySelector("dialog")!;
  fireEvent.click(within(dialog).getByText("Verify payment"));
  await within(dialog).findByText("Payment verified.");
  expect(client.setStatus).toHaveBeenCalledWith({ id: "req_1", status: "verified", expectedVersion: 3 }, expect.stringMatching(/^status:/));
  expect(within(dialog).getByText("No longer in the pending verification list.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Ana Cruz" })).toBeNull();
  expect(client.totals).toHaveBeenCalledTimes(2);
  expect(client.listRegistrations).toHaveBeenCalledTimes(2);
});

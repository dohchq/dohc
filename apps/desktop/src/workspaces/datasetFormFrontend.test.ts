// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDatasetFormFrontend, type DatasetFormField } from "./datasetFormFrontend";

interface Request { id: string; op: string; operation?: string; idempotencyKey: string; input?: { values: Record<string, unknown> }; bytesBase64?: string }
const field = (fieldId: string, type: DatasetFormField["type"] = "text", options: Partial<DatasetFormField> = {}): DatasetFormField =>
  ({ fieldId, name: fieldId, type, required: false, omitWhenEmpty: false, ...options });
function mount(fields: DatasetFormField[]) {
  const parent = {} as Window, frame = Object.assign(new EventTarget(), { parent });
  const requests: Request[] = [];
  const port = { onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: vi.fn((request: Request) => requests.push(structuredClone(request))), start() {} };
  const source = generateDatasetFormFrontend({ title: "Register", operation: "register", fields })["frontend.js"].replace("import './frontend.css';\n", "");
  new Function("window", "document", "crypto", "setTimeout", "clearTimeout", source)(frame, document, crypto, setTimeout, clearTimeout);
  const connect = (source: Window = parent) => frame.dispatchEvent(new MessageEvent("message", { source, data: { kind: "dohc-app-channel", version: 1 }, ports: [port as unknown as MessagePort] }));
  const submit = () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const reply = async (data: object, index = requests.length - 1) => { port.onmessage?.({ data: { id: requests[index]!.id, ...data } }); await Promise.resolve(); };
  const success = () => reply({ ok: true, value: { result: { id: 42 }, revision: 1, replayed: false } });
  return { requests, connect, submit, reply, success };
}
const status = () => document.querySelector('[role="status"]')!.textContent;
beforeEach(() => { document.body.replaceChildren(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dataset form frontend", () => {
  it("submits typed stable field IDs and preserves required false booleans", async () => {
    const app = mount([field("name", "text", { name: "<img src=x>", required: true }), field("agree", "checkbox", { required: true }), field("count", "number"), field("tags", "multi-select", { options: ["A", "B"] })]);
    app.connect(); app.submit(); expect(app.requests).toHaveLength(0);
    document.querySelector<HTMLInputElement>('[type="text"]')!.value = "Alex";
    document.querySelector<HTMLInputElement>('[type="number"]')!.value = "2.5";
    document.querySelector<HTMLOptionElement>('option[value="B"]')!.selected = true;
    app.submit();
    expect(app.requests[0]).toMatchObject({ op: "backend.invoke", operation: "register", input: { values: { name: "Alex", agree: false, count: 2.5, tags: ["B"] } } });
    expect(document.querySelector("img")).toBeNull();
    await app.success(); expect(status()).toBe("Response received.");
  });

  it("keeps exact input and idempotency identity after ambiguous response and later refusal", async () => {
    const app = mount([field("name")]); app.connect();
    document.querySelector<HTMLInputElement>("input")!.value = "Alex"; app.submit();
    await vi.advanceTimersByTimeAsync(30000);
    document.querySelector<HTMLInputElement>("input")!.value = "Changed"; app.submit();
    expect(app.requests[1]!.input).toEqual(app.requests[0]!.input);
    expect(app.requests[1]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    await app.reply({ ok: false, status: 404 }); app.submit();
    expect(app.requests[2]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    await app.success();
  });

  it("lets the participant correct a first definite refusal with a new request identity", async () => {
    const app = mount([field("name")]); app.connect();
    document.querySelector<HTMLInputElement>("input")!.value = "First"; app.submit();
    await app.reply({ ok: false, status: 409, error: { code: "invalid_input", message: "Use a shorter name." } });
    expect(status()).toBe("Response not saved. Use a shorter name.");
    document.querySelector<HTMLInputElement>("input")!.value = "New"; app.submit();
    expect(app.requests[1]!.idempotencyKey).not.toBe(app.requests[0]!.idempotencyKey);
    expect(app.requests[1]!.input).toEqual({ values: { name: "New" } }); await app.success();
  });

  it("validates URLs and numeric limits before any upload or mutation", () => {
    const app = mount([field("url", "url"), field("number", "number")]); app.connect();
    document.querySelector<HTMLInputElement>('[type="url"]')!.value = "javascript:alert(1)";
    document.querySelector<HTMLInputElement>('[type="number"]')!.value = "1e100";
    app.submit(); expect(app.requests).toHaveLength(0);
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
  });

  it("uses one parent channel and omits empty defaulted fields", async () => {
    const app = mount([field("defaulted", "text", { omitWhenEmpty: true })]);
    app.connect({} as Window); app.submit(); expect(app.requests).toHaveLength(0);
    app.connect(); expect(app.requests[0]!.input).toEqual({ values: {} }); await app.success();
  });

  it("renders approved defaults and resets them for another response", async () => {
    const app = mount([field("checked", "checkbox", { default: true }), field("tags", "multi-select", { options: ["A", "B"], default: ["B"] }), field("name", "text", { default: "Guest" })]);
    app.connect(); app.submit();
    expect(app.requests[0]!.input).toEqual({ values: { checked: true, tags: ["B"], name: "Guest" } });
    await app.success();
    [...document.querySelectorAll("button")].find(button => button.textContent === "Submit another response")!.click();
    app.submit(); expect(app.requests[1]!.input).toEqual(app.requests[0]!.input); await app.success();
  });

  it("uploads once, retries the same upload after uncertainty, then submits its file ID", async () => {
    vi.stubGlobal("FileReader", class { result = "data:application/pdf;base64,JVBERg=="; onload?: () => void; readAsDataURL() { this.onload?.(); } });
    const app = mount([field("receipt", "attachment", { required: true })]); app.connect();
    Object.defineProperty(document.querySelector("input")!, "files", { value: [new File(["%PDF"], "receipt.pdf", { type: "application/pdf" })] });
    app.submit(); await Promise.resolve();
    expect(app.requests[0]).toMatchObject({ op: "backend.upload", bytesBase64: "JVBERg==" });
    await vi.advanceTimersByTimeAsync(30000); app.submit();
    expect(app.requests[1]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    const fileId = "abcdefghijklmnop";
    await app.reply({ ok: true, value: { file: { fileId } } });
    expect(app.requests[2]).toMatchObject({ op: "backend.invoke", input: { values: { receipt: fileId } } });
    await app.reply({ ok: false, status: 503 }); app.submit();
    expect(app.requests[3]!.op).toBe("backend.invoke");
    expect(app.requests[3]!.input).toEqual(app.requests[2]!.input);
    await app.success();
  });

  it("allows replacing a refused upload before any create attempt", async () => {
    vi.stubGlobal("FileReader", class { result = "data:application/pdf;base64,JVBERg=="; onload?: () => void; readAsDataURL() { this.onload?.(); } });
    const app = mount([field("receipt", "attachment")]); app.connect();
    Object.defineProperty(document.querySelector("input")!, "files", { value: [new File(["%PDF"], "receipt.pdf", { type: "application/pdf" })] });
    app.submit(); await Promise.resolve(); await app.reply({ ok: false, status: 413 });
    expect(document.querySelector("fieldset")!.disabled).toBe(false);
    expect(app.requests.every(request => request.op === "backend.upload")).toBe(true);
  });

  it("rejects oversized files before sending and malformed success stays uncertain", async () => {
    const app = mount([field("receipt", "attachment")]); app.connect();
    const input = document.querySelector("input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 5 * 1024 * 1024 + 1 }] });
    app.submit(); expect(app.requests).toHaveLength(0);
    Object.defineProperty(input, "files", { value: [] }); app.submit();
    await app.reply({ ok: true, value: { result: {}, revision: 1, replayed: false } });
    expect(status()).toContain("may have been saved");
  });
});

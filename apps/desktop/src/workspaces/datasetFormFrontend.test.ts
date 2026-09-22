// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDatasetFormFrontend, type DatasetFormField } from "./datasetFormFrontend";

interface Request { id: string; op: string; operation?: string; idempotencyKey: string; input?: { values: Record<string, unknown> }; bytesBase64?: string; request?: { action: string; token?: string; idempotencyKey?: string; input?: { values: Record<string, unknown> } } }
const field = (fieldId: string, type: DatasetFormField["type"] = "text", options: Partial<DatasetFormField> = {}): DatasetFormField =>
  ({ fieldId, name: fieldId, type, required: false, omitWhenEmpty: false, ...options });
function mount(fields: DatasetFormField[], store = { attempt: null as null | { token: string; idempotencyKey: string; input: { values: Record<string, unknown> } } }, manualAttempts = false) {
  const parent = {} as Window, frame = Object.assign(new EventTarget(), { parent });
  const requests: Request[] = [], attempts: Request[] = [];
  const port = { onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: vi.fn((request: Request) => {
      if (request.op !== "backend.attempt") { requests.push(structuredClone(request)); return; }
      attempts.push(structuredClone(request));
      if (manualAttempts) return;
      if (request.request?.action === "save" && !store.attempt) store.attempt = {token: "t".repeat(43), idempotencyKey: request.request.idempotencyKey!, input: structuredClone(request.request.input!)};
      if (request.request?.action === "clear" && store.attempt?.token === request.request.token) store.attempt = null;
      port.onmessage?.({data: {id: request.id, ok: true, value: {attempt: structuredClone(store.attempt)}}});
    }), start() {} };
  const source = generateDatasetFormFrontend({ title: "Register", operation: "register", fields })["frontend.js"].replace("import './frontend.css';\n", "");
  new Function("window", "document", "crypto", "setTimeout", "clearTimeout", source)(frame, document, crypto, setTimeout, clearTimeout);
  const connect = async (source: Window = parent) => { frame.dispatchEvent(new MessageEvent("message", { source, data: { kind: "dohc-app-channel", version: 1 }, ports: [port as unknown as MessagePort] })); await Promise.resolve(); };
  const submit = async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); };
  const reply = async (data: object, index = requests.length - 1) => { port.onmessage?.({ data: { id: requests[index]!.id, ...data } }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const success = () => reply({ ok: true, value: { result: { id: 42 }, revision: 1, replayed: false } });
  return { requests, attempts, store, connect, submit, reply, success, replyAttempt: async (value: unknown) => { port.onmessage?.({data: {id: attempts.at(-1)!.id, ok: true, value}}); await Promise.resolve(); await Promise.resolve(); } };
}
const status = () => document.querySelector('[role="status"]')!.textContent;
beforeEach(() => { document.body.replaceChildren(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dataset form frontend", () => {
  it("uploads every field with separate retry identities and restores the complete saved response", async () => {
    vi.stubGlobal("FileReader", class { result = "data:application/pdf;base64,JVBERg=="; onload?: () => void; readAsDataURL() { this.onload?.(); } });
    const fields = [field("receipt", "attachment", { required: true }), field("waiver", "attachment", { required: true })];
    const app = mount(fields); await app.connect();
    for (const input of document.querySelectorAll("input")) Object.defineProperty(input, "files", { value: [new File(["%PDF"], `${input.name}.pdf`)] });
    await app.submit(); await Promise.resolve();
    await app.reply({ ok: true, value: { file: { fileId: "receipt_abcdefghijklmnop" } } }); await Promise.resolve();
    expect(app.requests[1]!.op).toBe("backend.upload");
    expect(app.requests[1]!.idempotencyKey).not.toBe(app.requests[0]!.idempotencyKey);
    await vi.advanceTimersByTimeAsync(30000); await app.submit();
    expect(app.requests[2]!.idempotencyKey).toBe(app.requests[1]!.idempotencyKey);
    await app.reply({ ok: true, value: { file: { fileId: "waiver_abcdefghijklmnop" } } });
    expect(app.requests[3]).toMatchObject({ op: "backend.invoke", input: { values: { receipt: "receipt_abcdefghijklmnop", waiver: "waiver_abcdefghijklmnop" } } });
    await vi.advanceTimersByTimeAsync(30000);
    document.body.replaceChildren(); const reopened = mount(fields, app.store); await reopened.connect(); await reopened.submit();
    expect(reopened.requests).toHaveLength(1);
    expect(reopened.requests[0]).toMatchObject({ op: "backend.invoke", idempotencyKey: app.requests[3]!.idempotencyKey, input: app.requests[3]!.input });
    await reopened.success();
  });

  it("pages and searches only explicit relation actions and submits typed keys", async () => {
    const app = mount([field("product", "relation", { required: true, relation: { operation: "publicChoices", keyFieldId: "code", labelFieldId: "label", keyType: "number", many: false } })]);
    await app.connect();
    expect(app.requests[0]).toMatchObject({ op: "backend.invoke", operation: "publicChoices", input: { limit: 50 } });
    await app.reply({ ok: true, value: { result: { rows: [{ id: 2, values: { code: 2, label: "<img src=x>" } }], nextCursor: { id: 2, value: 2 } } } });
    expect(document.querySelector("img")).toBeNull();
    document.querySelector("select")!.value = "2";
    [...document.querySelectorAll("button")].find(button => button.textContent === "More choices")!.click();
    expect(app.requests[1]!.input).toEqual({ limit: 50, after: { id: 2, value: 2 } });
    await app.reply({ ok: true, value: { result: { rows: [{ id: 3, values: { code: 3, label: "Three" } }], nextCursor: null } } });
    expect(document.querySelector("select")!.value).toBe("2");
    document.querySelector<HTMLInputElement>('[type="search"]')!.value = "Three";
    [...document.querySelectorAll("button")].find(button => button.textContent === "Search")!.click();
    expect(app.requests[2]!.input).toEqual({ limit: 50, search: "Three" });
    await app.reply({ ok: true, value: { result: { rows: [{ id: 3, values: { code: 3, label: "Three" } }], nextCursor: null } } });
    document.querySelector("select")!.value = "3"; await app.submit();
    expect(app.requests[3]).toMatchObject({ operation: "register", input: { values: { product: 3 } } }); await app.success();
  });

  it("rejects malformed choice output and does not display undeclared private fields or counts", async () => {
    const app = mount([field("product", "relation", { relation: { operation: "publicChoices", keyFieldId: "code", labelFieldId: "label", keyType: "text", many: true } })]);
    await app.connect();
    await app.reply({ ok: true, value: { result: { rows: [{ id: "one", values: { code: "one", label: "Visible", secret: "PRIVATE" } }], nextCursor: null, count: 999 } } });
    expect(document.body.textContent).not.toMatch(/PRIVATE|999|Visible/);
    expect(document.body.textContent).toContain("Choices could not load");
    [...document.querySelectorAll("button")].find(button => button.textContent === "Search")!.click();
    await app.reply({ ok: false, status: 404 });
    expect(document.querySelectorAll("select option")).toHaveLength(0);
  });

  it("accepts more than 24 fields within the byte envelope and refuses oversized answers before writing", async () => {
    const app = mount(Array.from({ length: 128 }, (_, index) => field(`field${index}`))); await app.connect();
    for (const input of document.querySelectorAll("input")) input.value = "answer";
    await app.submit(); expect(Object.keys(app.requests[0]!.input!.values)).toHaveLength(128); await app.success();
    document.body.replaceChildren(); const large = mount(Array.from({ length: 128 }, (_, index) => field(`field${index}`))); await large.connect();
    for (const input of document.querySelectorAll("input")) input.value = "x".repeat(2000);
    await large.submit(); expect(large.requests).toHaveLength(0); expect(status()).toContain("too long");
  });

  it("submits typed stable field IDs and preserves required false booleans", async () => {
    const app = mount([field("name", "text", { name: "<img src=x>", required: true }), field("agree", "checkbox", { required: true }), field("count", "number"), field("tags", "multi-select", { options: ["A", "B"] })]);
    await app.connect(); await app.submit(); expect(app.requests).toHaveLength(0);
    document.querySelector<HTMLInputElement>('[type="text"]')!.value = "Alex";
    document.querySelector<HTMLInputElement>('[type="number"]')!.value = "2.5";
    document.querySelector<HTMLOptionElement>('option[value="B"]')!.selected = true;
    await app.submit();
    expect(app.requests[0]).toMatchObject({ op: "backend.invoke", operation: "register", input: { values: { name: "Alex", agree: false, count: 2.5, tags: ["B"] } } });
    expect(document.querySelector("img")).toBeNull();
    await app.success(); expect(status()).toBe("Response received.");
  });

  it("keeps exact input and idempotency identity after ambiguous response and later refusal", async () => {
    const app = mount([field("name")]); await app.connect();
    document.querySelector<HTMLInputElement>("input")!.value = "Alex"; await app.submit();
    await vi.advanceTimersByTimeAsync(30000);
    document.querySelector<HTMLInputElement>("input")!.value = "Changed"; await app.submit();
    expect(app.requests[1]!.input).toEqual(app.requests[0]!.input);
    expect(app.requests[1]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    await app.reply({ ok: false, status: 404 }); await app.submit();
    expect(app.requests[2]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    await app.success();
  });

  it("lets the participant correct a first definite refusal with a new request identity", async () => {
    const app = mount([field("name")]); await app.connect();
    document.querySelector<HTMLInputElement>("input")!.value = "First"; await app.submit();
    await app.reply({ ok: false, status: 409, error: { code: "invalid_input", message: "Use a shorter name." } });
    expect(status()).toBe("Response not saved. Use a shorter name.");
    document.querySelector<HTMLInputElement>("input")!.value = "New"; await app.submit();
    expect(app.requests[1]!.idempotencyKey).not.toBe(app.requests[0]!.idempotencyKey);
    expect(app.requests[1]!.input).toEqual({ values: { name: "New" } }); await app.success();
  });

  it("validates URLs and numeric limits before any upload or mutation", async () => {
    const app = mount([field("url", "url"), field("number", "number")]); await app.connect();
    document.querySelector<HTMLInputElement>('[type="url"]')!.value = "javascript:alert(1)";
    document.querySelector<HTMLInputElement>('[type="number"]')!.value = "1e100";
    await app.submit(); expect(app.requests).toHaveLength(0);
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
  });

  it("uses one parent channel and omits empty defaulted fields", async () => {
    const app = mount([field("defaulted", "text", { omitWhenEmpty: true })]);
    await app.connect({} as Window); await app.submit(); expect(app.requests).toHaveLength(0);
    await app.connect(); await app.submit(); expect(app.requests[0]!.input).toEqual({ values: {} }); await app.success();
  });

  it("renders approved defaults and resets them for another response", async () => {
    const app = mount([field("checked", "checkbox", { default: true }), field("tags", "multi-select", { options: ["A", "B"], default: ["B"] }), field("name", "text", { default: "Guest" })]);
    await app.connect(); await app.submit();
    expect(app.requests[0]!.input).toEqual({ values: { checked: true, tags: ["B"], name: "Guest" } });
    await app.success();
    [...document.querySelectorAll("button")].find(button => button.textContent === "Submit another response")!.click(); await Promise.resolve(); await Promise.resolve();
    await app.submit(); expect(app.requests[1]!.input).toEqual(app.requests[0]!.input); await app.success();
  });

  it("uploads once, retries the same upload after uncertainty, then submits its file ID", async () => {
    vi.stubGlobal("FileReader", class { result = "data:application/pdf;base64,JVBERg=="; onload?: () => void; readAsDataURL() { this.onload?.(); } });
    const app = mount([field("receipt", "attachment", { required: true })]); await app.connect();
    Object.defineProperty(document.querySelector("input")!, "files", { value: [new File(["%PDF"], "receipt.pdf", { type: "application/pdf" })] });
    await app.submit(); await Promise.resolve();
    expect(app.requests[0]).toMatchObject({ op: "backend.upload", bytesBase64: "JVBERg==" });
    await vi.advanceTimersByTimeAsync(30000); await app.submit();
    expect(app.requests[1]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    const fileId = "abcdefghijklmnop";
    await app.reply({ ok: true, value: { file: { fileId } } });
    expect(app.requests[2]).toMatchObject({ op: "backend.invoke", input: { values: { receipt: fileId } } });
    await app.reply({ ok: false, status: 503 }); await app.submit();
    expect(app.requests[3]!.op).toBe("backend.invoke");
    expect(app.requests[3]!.input).toEqual(app.requests[2]!.input);
    await app.success();
  });

  it("allows replacing a refused upload before any create attempt", async () => {
    vi.stubGlobal("FileReader", class { result = "data:application/pdf;base64,JVBERg=="; onload?: () => void; readAsDataURL() { this.onload?.(); } });
    const app = mount([field("receipt", "attachment")]); await app.connect();
    Object.defineProperty(document.querySelector("input")!, "files", { value: [new File(["%PDF"], "receipt.pdf", { type: "application/pdf" })] });
    await app.submit(); await Promise.resolve(); await app.reply({ ok: false, status: 413 });
    expect(document.querySelector("fieldset")!.disabled).toBe(false);
    expect(app.requests.every(request => request.op === "backend.upload")).toBe(true);
  });

  it("rejects oversized files before sending and malformed success stays uncertain", async () => {
    const app = mount([field("receipt", "attachment")]); await app.connect();
    const input = document.querySelector("input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 5 * 1024 * 1024 + 1 }] });
    await app.submit(); expect(app.requests).toHaveLength(0);
    Object.defineProperty(input, "files", { value: [] }); await app.submit();
    await app.reply({ ok: true, value: { result: {}, revision: 1, replayed: false } });
    expect(status()).toContain("may have been saved");
  });
});


it("restores the exact saved response after reload without reuploading its receipt", async () => {
  const saved = {token: "r".repeat(43), idempotencyKey: "original", input: {values: {name: "Alex", receipt: "file_abcdefghijklmnop"}}};
  const store = {attempt: saved};
  const app = mount([field("name"), field("receipt", "attachment", {required: true})], store);
  await app.connect();
  expect(document.querySelector<HTMLInputElement>('[type="text"]')!.value).toBe("Alex");
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  await app.submit();
  expect(app.requests).toHaveLength(1);
  expect(app.requests[0]).toMatchObject({op: "backend.invoke", idempotencyKey: saved.idempotencyKey, input: saved.input});
  await app.success(); expect(store.attempt).toEqual(saved);
  document.body.replaceChildren();
  const reopened = mount([field("name"), field("receipt", "attachment", {required: true})], store);
  await reopened.connect(); await reopened.submit();
  expect(reopened.requests[0]).toMatchObject({op: "backend.invoke", idempotencyKey: saved.idempotencyKey, input: saved.input});
  await reopened.success();
});

it("waits for durable acknowledgement before invoking and adopts a competing tab's exact attempt", async () => {
  const app = mount([field("name")], {attempt: null}, true); await app.connect();
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  await app.replyAttempt({attempt: null});
  document.querySelector<HTMLInputElement>("input")!.value = "Second tab";
  await app.submit(); expect(app.requests).toHaveLength(0);
  expect(app.attempts.at(-1)!.request).toMatchObject({action: "save", input: {values: {name: "Second tab"}}});
  const first = {token: "f".repeat(43), idempotencyKey: "first-tab", input: {values: {name: "First tab"}}};
  await app.replyAttempt({attempt: first});
  expect(app.requests[0]).toMatchObject({idempotencyKey: "first-tab", input: first.input});
  await app.reply({ok: false, status: 404});
  expect(app.attempts.filter(request => request.request?.action === "clear")).toHaveLength(0);
  await app.submit(); expect(app.requests[1]).toMatchObject({idempotencyKey: "first-tab", input: first.input});
});

it("retries an unacknowledged durable save without sending a create first", async () => {
  const app = mount([field("name")], {attempt: null}, true); await app.connect(); await app.replyAttempt({attempt: null});
  document.querySelector<HTMLInputElement>("input")!.value = "Original"; await app.submit();
  const original = app.attempts.at(-1)!.request;
  await vi.advanceTimersByTimeAsync(30000); expect(app.requests).toHaveLength(0);
  expect(document.querySelector("fieldset")!.disabled).toBe(true);
  await app.submit(); expect(app.attempts.at(-1)!.request).toEqual(original);
  await app.replyAttempt({attempt: {token: "s".repeat(43), idempotencyKey: original!.idempotencyKey, input: original!.input}});
  expect(app.requests[0]).toMatchObject({idempotencyKey: original!.idempotencyKey, input: original!.input});
});

it("keeps the response locked when durable lookup fails", async () => {
  const app = mount([field("name")], {attempt: null}, true); await app.connect();
  await vi.advanceTimersByTimeAsync(30000); await app.submit();
  expect(app.requests).toHaveLength(0); expect(document.querySelector("fieldset")!.disabled).toBe(true);
  expect(status()).toContain("Reload to try again");
});

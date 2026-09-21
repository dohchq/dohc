// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAppFormFrontend, type AppFormFrontendInput } from "./appFormFrontend.js";

interface Request { id: string; op: string; operation: string; idempotencyKey: string; input: Record<string, unknown> }

function mount(input: AppFormFrontendInput) {
  const parent = {} as Window;
  const frame = Object.assign(new EventTarget(), { parent });
  const requests: Request[] = [];
  const port = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: vi.fn((request: Request) => requests.push(structuredClone(request))),
    start: vi.fn(),
  };
  const source = generateAppFormFrontend(input)["frontend.js"].replace("import './frontend.css';\n", "");
  new Function("window", "document", "crypto", "setTimeout", "clearTimeout", source)(frame, document, crypto, setTimeout, clearTimeout);
  const connect = (source: Window = parent, connectedPort = port) => frame.dispatchEvent(new MessageEvent("message", {
    source, data: { kind: "dohc-app-channel", version: 1 }, ports: [connectedPort as unknown as MessagePort],
  }));
  const submit = () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const reply = async (data: object, index = requests.length - 1) => {
    port.onmessage?.({ data: { id: requests[index]!.id, ...data } });
    await Promise.resolve();
  };
  const success = (index?: number) => reply({ ok: true, value: { result: { id: "saved-record" }, revision: 1, replayed: false } }, index);
  return { frame, parent, port, requests, connect, submit, reply, success };
}

const input: AppFormFrontendInput = { title: "Register", fields: [{ name: "Name", type: "text" }] };
const nameInput = () => document.querySelector<HTMLInputElement>("input")!;
const status = () => document.querySelector('[role="status"]')!.textContent;

beforeEach(() => { document.body.replaceChildren(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("generated public form", () => {
  it("renders hostile labels/options as text and safely submits prototype-like field names", async () => {
    const hostile = '</script><img src=x onerror="alert(1)">';
    const app = mount({ title: hostile, fields: [
      { name: "__proto__", type: "text" },
      { name: hostile, type: "select", options: [hostile, "Regular"] },
    ] });
    expect(document.querySelector("h1")!.textContent).toBe(hostile);
    expect(document.querySelector("img, script")).toBeNull();
    expect(document.querySelector("label")!.htmlFor).toBe(nameInput().id);
    nameInput().value = "Safe value";
    document.querySelector("select")!.value = hostile;
    app.connect(); app.submit();
    expect(app.requests[0]!.input).toEqual(Object.fromEntries([["__proto__", "Safe value"], [hostile, hostile]]));
    expect(Object.hasOwn(app.requests[0]!.input, "__proto__")).toBe(true);
    await app.success();
  });

  it("sends typed public fields and nulls without read or administration requests", async () => {
    const app = mount({ title: "Details", fields: [
      { name: "Count", type: "number" }, { name: "Agree", type: "checkbox" },
      { name: "Day", type: "date" }, { name: "Website", type: "url" },
      { name: "Name", type: "text" }, { name: "Choice", type: "select", options: ["A"] },
    ] });
    document.querySelector<HTMLInputElement>('[type="number"]')!.value = "3.5";
    document.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked = true;
    document.querySelector<HTMLInputElement>('[type="date"]')!.value = "2026-09-22";
    app.connect(); app.submit();
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0]).toMatchObject({ op: "backend.invoke", operation: "submit", input: {
      Count: 3.5, Agree: true, Day: "2026-09-22", Website: null, Name: null, Choice: null,
    } });
    await app.success();
  });

  it("accepts only one parent channel and bounds requests while submitting", async () => {
    const app = mount(input);
    app.connect({} as Window);
    app.submit(); app.submit();
    expect(app.requests).toHaveLength(0);
    expect(status()).toContain("Keep this page open");
    app.connect();
    expect(app.requests).toHaveLength(1);
    const otherPort = { ...app.port, postMessage: vi.fn(), start: vi.fn() };
    app.connect(app.parent, otherPort);
    expect(otherPort.start).not.toHaveBeenCalled();
    expect(document.querySelector("fieldset")!.disabled).toBe(true);
    await app.success();
  });

  it("retains the exact key and payload across timeout, late replies, and repeated retries", async () => {
    const app = mount(input);
    app.connect(); nameInput().value = "Alice"; app.submit();
    await vi.advanceTimersByTimeAsync(30000);
    expect(status()).toContain("reloading loses this retry");
    expect(document.querySelector("fieldset")!.disabled).toBe(true);
    nameInput().value = "Changed behind disabled control";
    app.submit();
    expect(app.requests[1]!.id).not.toBe(app.requests[0]!.id);
    expect(app.requests[1]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    expect(app.requests[1]!.input).toEqual({ Name: "Alice" });
    await app.success(0);
    expect(status()).toContain("Sending");
    await app.reply({ ok: false, status: 503 });
    app.submit();
    expect(app.requests[2]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    await app.success();
    expect(status()).toBe("Response received.");
  });

  it("does not allow a new response after a refusal following an uncertain attempt", async () => {
    const app = mount(input);
    app.connect(); app.submit();
    await app.reply({ ok: false, status: 429 });
    app.submit();
    await app.reply({ ok: false, status: 404 });
    expect(document.querySelector("fieldset")!.disabled).toBe(true);
    app.submit();
    expect(app.requests[2]!.idempotencyKey).toBe(app.requests[0]!.idempotencyKey);
    await app.success();
  });

  it("allows corrections and a new key after a definite first refusal", async () => {
    const app = mount(input);
    app.connect(); nameInput().value = "First"; app.submit();
    await app.reply({ ok: false, status: 409, error: { code: "invalid_input", message: "Use a shorter name." } });
    expect(status()).toBe("Response not saved. Use a shorter name.");
    expect(document.querySelector("fieldset")!.disabled).toBe(false);
    nameInput().value = "New"; app.submit();
    expect(app.requests[1]!.idempotencyKey).not.toBe(app.requests[0]!.idempotencyKey);
    expect(app.requests[1]!.input).toEqual({ Name: "New" });
    await app.success();
  });

  it("treats malformed success as uncertain and requires an explicit action after confirmed success", async () => {
    const app = mount(input);
    app.connect(); app.submit();
    await app.reply({ ok: true, value: { result: {}, revision: 1, replayed: false } });
    expect(status()).toContain("may have been saved");
    app.submit(); await app.success();
    app.submit();
    expect(app.requests).toHaveLength(2);
    expect(document.querySelector("form")!.hidden).toBe(true);
    const another = [...document.querySelectorAll("button")].find(button => button.textContent === "Submit another response")!;
    another.click();
    expect(document.querySelector("form")!.hidden).toBe(false);
    expect(nameInput().value).toBe("");
    expect(document.activeElement).toBe(nameInput());
    app.submit();
    expect(app.requests[2]!.idempotencyKey).not.toBe(app.requests[0]!.idempotencyKey);
    await app.success();
  });

  it.each(["javascript:alert(1)", "ftp://example.com", "https://example.com/has space"])("rejects unsafe URL %s before invoking", url => {
    const app = mount({ title: "Website", fields: [{ name: "Link", type: "url" }] });
    app.connect(); nameInput().value = url; app.submit();
    expect(app.requests).toHaveLength(0);
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector(".field-error")!.textContent).toContain("web address");
  });

  it("rejects out-of-range numbers and oversized text before invoking", () => {
    const app = mount({ title: "Details", fields: [{ name: "Count", type: "number" }, { name: "Notes", type: "text" }] });
    app.connect(); nameInput().value = "1e100"; app.submit();
    expect(app.requests).toHaveLength(0);
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    nameInput().value = "2"; nameInput().dispatchEvent(new Event("input"));
    document.querySelector<HTMLInputElement>('[type="text"]')!.value = "x".repeat(2001);
    app.submit(); expect(app.requests).toHaveLength(0);
  });
});

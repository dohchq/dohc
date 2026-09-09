// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {markdownToYDoc, getDohcYDocBodyFragment} from "@dohc/ydoc-projection";
import type {NamedLiveBrowserState} from "./namedLiveBrowserTransport";
import NamedRecipientApp from "./NamedRecipientApp";
import {jsonResponse, settle, setControlValue} from "./testing";

const sessions: {state: NamedLiveBrowserState; close: ReturnType<typeof vi.fn>; notify(): void; path: string}[] = [];
vi.mock("./namedLiveBrowserTransport", async importOriginal => {
  const actual = await importOriginal<typeof import("./namedLiveBrowserTransport")>();
  return {...actual, createNamedLiveBrowserTransport: vi.fn(() => {
    let close = () => {};
    return {close: () => close(), select(selection: {objectId: string}) {
      close(); const doc = markdownToYDoc(`Draft ${selection.objectId}`), listeners = new Set<(state: NamedLiveBrowserState) => void>();
      const row = {path: selection.objectId, state: {status: "syncing", reason: null, binding: null, hostEpoch: null,
        pendingUpdates: 0, pendingBytes: 0, lastApplied: null} as NamedLiveBrowserState,
        close: vi.fn(), notify() {for (const listener of listeners) listener(row.state);}};
      sessions.push(row); close = row.close;
      return {doc, body: getDohcYDocBodyFragment(doc), state: () => row.state, close: row.close,
        edit(change: () => void) {if (row.state.status !== "live") return false; change(); return true;},
        subscribe(listener: (state: NamedLiveBrowserState) => void) {listeners.add(listener); return () => listeners.delete(listener);},
        reconnect: vi.fn(async () => {}), disconnect: vi.fn()};
    }};
  })};
});
const limits = {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
  maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
  maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10};
const files = (grantId = "grant", userId = "alice") => ({userId, workspaceId: "workspace", shareId: "share", grantId, limits,
  files: [{objectId: "a", path: "docs/a.md"}, {objectId: "b", path: "docs/b.md"}]});
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  sessions.length = 0; container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {configurable: true, value: function (this: HTMLDialogElement) {this.open = true;}},
    close: {configurable: true, value: function (this: HTMLDialogElement) {this.open = false;}},
  });
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");});
const ready = () => !container.textContent?.includes("Checking your account") && !container.textContent?.includes("Opening shared files");
async function render(grantId = "grant") {await act(async () => root.render(<NamedRecipientApp grantId={grantId}/>)); await settle(ready);}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(node => node.textContent === text);
  expect(button).toBeDefined(); await act(async () => button!.click()); await settle(ready);
}
it("signs in through the account endpoint, opens current files, and waits for live state before enabling edits", async () => {
  let signedIn = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/account/session") return jsonResponse({user: signedIn ? {id: "alice", name: "Alice"} : null});
    if (path === "/api/account/sign-in") {expect(JSON.parse(String(init?.body))).toEqual({email: "alice@example.test", password: "secret"}); signedIn = true; return jsonResponse({ok: true, user: {id: "alice", name: "Alice"}});}
    if (path === "/api/live/named-documents") {expect(JSON.parse(String(init?.body))).toEqual({grantId: "grant"}); return jsonResponse(files());}
    throw Error(path);
  });
  vi.stubGlobal("fetch", fetch); await render();
  await act(async () => {setControlValue(container.querySelector('input[name="email"]')!, "alice@example.test"); setControlValue(container.querySelector('input[name="password"]')!, "secret");});
  await click("Sign in"); expect(container.textContent).toContain("Alice"); await click("docs/a.md");
  expect(container.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe("false");
  await act(async () => {sessions[0]!.state = {...sessions[0]!.state, status: "live"}; sessions[0]!.notify();});
  expect(container.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe("true");
  expect(fetch.mock.calls.every(([, init]) => init?.credentials === "same-origin")).toBe(true);
});
it("keeps a quarantined draft until explicit discard, then opens a fresh session without merging its old state", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/account/session" ? jsonResponse({user: {id: "alice", name: "Alice"}}) : jsonResponse(files())));
  await render(); await click("docs/a.md");
  await act(async () => {sessions[0]!.state = {...sessions[0]!.state, status: "quarantined", pendingUpdates: 1}; sessions[0]!.notify();});
  expect(container.textContent).toContain("exist only in this tab"); await click("docs/b.md");
  expect(container.querySelector("dialog")?.open).toBe(true); expect(sessions).toHaveLength(1);
  await click("Keep reviewing"); expect(sessions[0]!.close).not.toHaveBeenCalled();
  await click("docs/b.md"); await click("Discard draft and continue");
  expect(sessions[0]!.close).toHaveBeenCalledTimes(1); expect(sessions).toHaveLength(2);
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain("Draft b");
});
it.each([200, 401])("distinguishes sign-in status %s from an unavailable invitation", async status => {
  let signedIn = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/account/session") return jsonResponse({user: signedIn ? {id: "alice", name: "Alice"} : null});
    if (String(input) === "/api/account/sign-in") {signedIn = status === 200; return jsonResponse({ok: signedIn}, status);}
    if (String(input) === "/api/live/named-documents") return jsonResponse({}, 404);
    throw Error(String(input));
  }));
  await render();
  await act(async () => {
    setControlValue(container.querySelector('input[name="email"]')!, "alice@example.test");
    setControlValue(container.querySelector('input[name="password"]')!, "secret");
  });
  await click("Sign in");
  const error = container.querySelector('[role="alert"]')?.textContent;
  if (status === 200) {
    expect(container.textContent).toContain("Alice");
    expect(error).toContain("could not open this invitation");
    expect(error).not.toContain("Check your email and password");
  } else {
    expect(container.textContent).not.toContain("Alice");
    expect(error).toContain("Check your email and password");
  }
});
it("ignores a late invitation response after navigation changes the grant", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/account/session") return jsonResponse({user: {id: "alice", name: "Alice"}});
    const grant = JSON.parse(String(init?.body)).grantId;
    return grant === "old" ? new Promise<Response>(done => {resolve = done;}) : jsonResponse({...files(grant), files: [{objectId: "new", path: "docs/current.md"}]});
  }));
  await act(async () => root.render(<NamedRecipientApp grantId="old"/>)); await settle(() => Boolean(resolve)); await render("new");
  await act(async () => resolve(jsonResponse(files("old")))); await settle(ready);
  expect(container.textContent).toContain("docs/current.md"); expect(container.textContent).not.toContain("docs/a.md");
});
it("refuses an account mismatch in the selected-grant response", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/account/session" ? jsonResponse({user: {id: "alice", name: "Alice"}}) : jsonResponse(files("grant", "bob"))));
  await render(); expect(container.textContent).toContain("could not open this invitation"); expect(container.textContent).not.toContain("docs/a.md");
});

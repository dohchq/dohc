// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {markdownToYDoc, getDohcYDocBodyFragment} from "@dohc/ydoc-projection";
import type {NamedLiveBrowserState} from "@dohc/ydoc-projection/named-live-browser-transport";
import {LinkDocumentEditor} from "./LinkDocumentEditor";
import {openLinkDocument} from "./linkLive";
import {settle} from "./testing";

vi.mock("./linkLive", () => ({openLinkDocument: vi.fn()}));
let container: HTMLDivElement, root: Root;
function fixture() {
  const doc = markdownToYDoc("Draft to keep"), listeners = new Set<(value: NamedLiveBrowserState) => void>();
  let state: NamedLiveBrowserState = {status: "live", reason: null, binding: null, hostEpoch: null, pendingUpdates: 0, pendingBytes: 0, lastApplied: null, membership: null};
  const notify = () => {for (const listener of listeners) listener(state);};
  const session = {doc, body: getDohcYDocBodyFragment(doc), state: () => state,
    subscribe(listener: (value: NamedLiveBrowserState) => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    close: vi.fn(() => {state = {...state, status: "closed"}; notify();}), reconnect: vi.fn(async () => {}), disconnect: vi.fn(),
    edit(change: () => void) {if (state.status !== "live") return false; change(); return true;}};
  return {session, update(value: Partial<NamedLiveBrowserState>) {state = {...state, ...value}; notify();}};
}
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {configurable: true, value: function (this: HTMLDialogElement) {this.open = true;}},
    close: {configurable: true, value: function (this: HTMLDialogElement) {this.open = false;}},
  });
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.resetAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");});
async function render(available: boolean, onClose = vi.fn()) {
  await act(async () => root.render(<LinkDocumentEditor discriminator="abcdefghijkl" path="docs/a.md" available={available} onClose={onClose}/>));
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(value => value.textContent === text); expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("retains a quarantined draft after access loss, including updates rejected before they entered the queue", async () => {
  const f = fixture(), onClose = vi.fn(); vi.mocked(openLinkDocument).mockResolvedValue(f.session);
  await render(true, onClose); await settle(() => container.querySelector('[role="textbox"]') !== null);
  await act(async () => f.update({status: "quarantined", pendingUpdates: 0, reason: "pending-update-limit"}));
  await render(false, onClose);
  expect(f.session.close).toHaveBeenCalled();
  expect(container.textContent).toContain("Draft to keep");
  expect(container.textContent).toContain("exist only in this tab");
  expect(container.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe("false");
  expect(container.textContent).not.toContain("Open current file");
  const unload = new Event("beforeunload", {cancelable: true}); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  await click("Back to shared files"); expect(onClose).not.toHaveBeenCalled(); expect(container.querySelector("dialog")?.open).toBe(true);
  await click("Keep reviewing"); expect(onClose).not.toHaveBeenCalled();
  await click("Back to shared files"); await click("Discard draft and continue"); expect(onClose).toHaveBeenCalledOnce();
});
it("retires a late open response when access changes during authorization", async () => {
  const f = fixture(); let release!: (value: typeof f.session) => void;
  vi.mocked(openLinkDocument).mockImplementation(() => new Promise(done => {release = done;}));
  await render(true); await render(false);
  await act(async () => release(f.session));
  expect(f.session.close).toHaveBeenCalledOnce(); expect(f.session.reconnect).not.toHaveBeenCalled();
  expect(container.querySelector('[role="textbox"]')).toBeNull();
});
it("requires explicit discard before opening a fresh session and never replays the held draft", async () => {
  const first = fixture(), next = fixture(); vi.mocked(openLinkDocument).mockResolvedValueOnce(first.session).mockResolvedValueOnce(next.session);
  await render(true); await settle(() => container.querySelector('[role="textbox"]') !== null);
  await act(async () => first.update({status: "quarantined", pendingUpdates: 1}));
  await click("Open current file"); expect(openLinkDocument).toHaveBeenCalledTimes(1);
  await click("Discard draft and continue"); await settle(() => next.session.reconnect.mock.calls.length === 1);
  expect(first.session.close).toHaveBeenCalled(); expect(next.session.doc).not.toBe(first.session.doc);
  expect(openLinkDocument).toHaveBeenLastCalledWith("abcdefghijkl", "docs/a.md", expect.any(AbortSignal));
});

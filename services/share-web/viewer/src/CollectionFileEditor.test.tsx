// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {CollectionFileEditor, isCollectionOwnFile} from "./CollectionFileEditor";
import {jsonResponse, requestPath, setControlValue, settle} from "./testing";

const PATH = "trip/packing/collection.yaml";
const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
const BASE = "a".repeat(64), CURRENT = "b".repeat(64);
let container: HTMLDivElement, root: Root;

beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {configurable: true, value: function (this: HTMLDialogElement) {this.open = true;}},
    close: {configurable: true, value: function (this: HTMLDialogElement) {this.open = false;}},
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

type Sent = {headers: Headers; body: {submitId: string; changes: Array<Record<string, unknown>>}};
function relay(answers: Array<() => Response>, blobs: Record<string, string> = {[BASE]: SCHEMA}) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const path = requestPath(input);
    if (path.startsWith("/api/view/blob/")) return new Response(blobs[path.slice("/api/view/blob/".length)] ?? null, {status: 200});
    if (path === "/api/view/collection-writes") {
      sent.push({headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Sent["body"]});
      return answers.shift()!();
    }
    throw new Error(`Unexpected request ${path}`);
  }));
  return sent;
}
async function render(available = true, onClose = vi.fn()) {
  await act(async () => root.render(<CollectionFileEditor session="abcdefghijkl" path={PATH} blobSha256={BASE} available={available} onClose={onClose}/>));
  await settle(() => container.querySelector("textarea") !== null);
  return container.querySelector("textarea")!;
}
const button = (text: string) => [...container.querySelectorAll("button")].find(value => value.textContent === text);
async function click(text: string) {
  expect(button(text)).toBeDefined();
  await act(async () => button(text)!.click());
}
const decoded = (change: Record<string, unknown>) => new TextDecoder().decode(Uint8Array.from(atob(String(change.afterContentBase64)), c => c.charCodeAt(0)));

it("offers only a Collection's schema and automations files", () => {
  expect(isCollectionOwnFile(PATH)).toBe(true);
  expect(isCollectionOwnFile("trip/packing/automations.yaml")).toBe(true);
  expect(isCollectionOwnFile("collection.yaml")).toBe(false);
  expect(isCollectionOwnFile("trip/packing/notes.yaml")).toBe(false);
});

it("saves the file on the content it opened, and says the relay has it before the owner's computer does", async () => {
  const sent = relay([() => jsonResponse({ok: true, outcome: "accepted", submitId: "x"})]);
  const text = await render();
  expect(text.value).toBe(SCHEMA);
  expect(button("Save")?.disabled).toBe(true);
  setControlValue(text, `${SCHEMA}  Count:\n    type: number\n`);
  await click("Save");
  await settle(() => container.textContent!.includes("Saved to the owner's workspace"));
  expect(container.textContent).toContain("Their computer applies it the next time it syncs.");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers.get("x-dohc-link-session")).toBe("abcdefghijkl");
  expect(Object.keys(sent[0]!.body).sort()).toEqual(["changes", "submitId"]);
  expect(sent[0]!.body.changes).toEqual([expect.objectContaining({
    basedOnPath: PATH, basedOnBlobSha256: BASE, operation: "write", afterPath: PATH, afterContentKind: "text"})]);
  expect(decoded(sent[0]!.body.changes[0]!)).toBe(`${SCHEMA}  Count:\n    type: number\n`);
  // Nothing is unsaved now, so leaving asks nothing.
  expect(button("Save")?.disabled).toBe(true);
});

it("keeps the text when the file changed first, and opens the current file only after the person lets the draft go", async () => {
  relay([() => jsonResponse({ok: false, outcome: "stale", path: PATH, currentBlobSha256: CURRENT}, 409)], {[BASE]: SCHEMA, [CURRENT]: "name: Theirs\n"});
  const text = await render();
  setControlValue(text, "name: Mine\n");
  await click("Save");
  await settle(() => container.querySelector('[role="alert"]') !== null);
  expect(container.textContent).toContain("This file changed after you opened it");
  expect(container.querySelector("textarea")!.value).toBe("name: Mine\n");
  await click("Open current file");
  expect(container.querySelector("dialog")?.open).toBe(true);
  await click("Keep reviewing");
  expect(container.querySelector("textarea")!.value).toBe("name: Mine\n");
  await click("Open current file");
  await click("Discard draft and continue");
  await settle(() => container.querySelector("textarea")?.value === "name: Theirs\n");
});

it("sends a save whose answer was lost again under the same submit id, and changed text under a new one", async () => {
  const unknown = () => jsonResponse({ok: false, error: "not found"}, 503);
  const sent = relay([unknown, unknown, () => jsonResponse({ok: true, outcome: "accepted", submitId: "x"})]);
  const text = await render();
  setControlValue(text, "name: Mine\n");
  await click("Save");
  await settle(() => container.textContent!.includes("dohc could not confirm the save"));
  await click("Save");
  await settle(() => sent.length === 2 && container.textContent!.includes("dohc could not confirm the save"));
  setControlValue(container.querySelector("textarea")!, "name: Mine again\n");
  await click("Save");
  await settle(() => container.textContent!.includes("Saved to the owner's workspace"));
  const [first, second, third] = sent.map(value => value.body.submitId);
  expect(second).toBe(first);
  expect(third).not.toBe(first);
  // Leaving with nothing unsaved asks nothing; with a draft, the page warns.
  const unload = new Event("beforeunload", {cancelable: true}); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
  setControlValue(container.querySelector("textarea")!, "name: Unsaved\n");
  const warned = new Event("beforeunload", {cancelable: true}); window.dispatchEvent(warned); expect(warned.defaultPrevented).toBe(true);
});

it("says why a write was refused, and stops editing when the link can no longer write", async () => {
  relay([
    () => jsonResponse({ok: false, outcome: "refused", reason: `${PATH} is not a valid collection.yaml`}, 403),
    () => jsonResponse({ok: false, error: "not found"}, 404),
  ]);
  const text = await render();
  setControlValue(text, "fields: [");
  await click("Save");
  await settle(() => container.textContent!.includes(`dohc did not save this change: ${PATH} is not a valid collection.yaml.`));
  await click("Save");
  await settle(() => container.textContent!.includes("This link can no longer change this file."));
  expect(container.querySelector("textarea")!.value).toBe("fields: [");

  const onClose = vi.fn();
  await act(async () => root.render(<CollectionFileEditor session="abcdefghijkl" path={PATH} blobSha256={BASE} available={false} onClose={onClose}/>));
  expect(container.querySelector("textarea")!.readOnly).toBe(true);
  expect(button("Save")).toBeUndefined();
  expect(container.textContent).toContain("Editing is no longer available.");
  await click("Back to shared files");
  expect(onClose).not.toHaveBeenCalled();
  await click("Discard draft and continue");
  expect(onClose).toHaveBeenCalledOnce();
});

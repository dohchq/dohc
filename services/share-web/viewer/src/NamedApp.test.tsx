// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import NamedApp from "./NamedApp";
import {heldJsonResponse, jsonResponse, settle, setControlValue} from "./testing";

const publicationId = "a".repeat(64), target = {workspaceId: "ws_1", publicationId};
const launch = () => ({action: `https://${"b".repeat(48)}.apps.example/bootstrap`, handoff: "c".repeat(43)});
let container: HTMLDivElement, root: Root, submitted: {action: string; fields: string[]}[];
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); submitted = [];
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push({action: this.action, fields: [...this.elements].map(element => `${(element as HTMLInputElement).name}=${(element as HTMLInputElement).value}`)});
  });
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
const ready = () => !/Checking your account|Signing out/.test(container.textContent ?? "");
async function render(current: typeof target | null = target) {await act(async () => root.render(<NamedApp target={current}/>)); await settle(ready);}
const button = (text: string) => [...container.querySelectorAll("button")].find(node => node.textContent === text);
async function click(text: string) {const control = button(text); expect(control).toBeDefined(); await act(async () => control!.click()); await settle(ready);}
async function fillSignIn() {
  await act(async () => {setControlValue(container.querySelector('input[name="email"]')!, "alice@example.test"); setControlValue(container.querySelector('input[name="password"]')!, "secret");});
}
function account(signedIn: () => boolean, rest: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/apps/summary") return jsonResponse({subjectName: "Trip planner", sharerName: "Ana (ana@example.test)", access: "comment"});
    if (path === "/api/account/session") return jsonResponse({user: signedIn() ? {id: "alice", name: "Alice"} : null});
    return rest(path, init);
  });
}

it("signs in, launches with only the workspace and publication ids, and submits the handoff to the approved origin", async () => {
  let signedIn = false;
  const fetch = account(() => signedIn, (path, init) => {
    if (path === "/api/account/sign-in") {expect(JSON.parse(String(init?.body))).toEqual({email: "alice@example.test", password: "secret"}); signedIn = true; return jsonResponse({ok: true});}
    if (path === "/api/apps/launch") {expect(JSON.parse(String(init?.body))).toEqual(target); return jsonResponse(launch());}
    throw Error(path);
  });
  vi.stubGlobal("fetch", fetch); await render();
  expect(container.textContent).toContain("Sign in to open this app"); expect(button("Open app")).toBeUndefined();
  await fillSignIn(); await click("Sign in");
  expect(container.textContent).toContain("Alice"); expect(container.textContent).toContain("external services");
  expect(container.textContent).toContain("Trip planner"); expect(container.textContent).toContain("Shared by Ana (ana@example.test)"); expect(container.textContent).toContain("Comment access");
  await click("Open app"); await settle(() => submitted.length === 1);
  expect(submitted[0]).toEqual({action: `https://${"b".repeat(48)}.apps.example/bootstrap`, fields: [`handoff=${"c".repeat(43)}`]});
  expect(button("Opening app")?.disabled).toBe(true);
  expect(fetch.mock.calls.every(([, init]) => init?.credentials === "same-origin")).toBe(true);
  const bodies = fetch.mock.calls.filter(([input]) => String(input) === "/api/apps/launch").map(([, init]) => Object.keys(JSON.parse(String(init?.body)) as object).sort());
  expect(bodies).toEqual([["publicationId", "workspaceId"]]);
});
it("explains an unavailable link without calling the account endpoints", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); await render(null);
  expect(container.textContent).toContain("This app link is unavailable"); expect(container.querySelector("form")).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it("reports a failed sign-in and keeps the form", async () => {
  vi.stubGlobal("fetch", account(() => false, path => path === "/api/account/sign-in" ? jsonResponse({ok: false}, 401) : jsonResponse({}, 404)));
  await render(); await fillSignIn(); await click("Sign in");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Check your email and password");
  expect(container.querySelector("form")).not.toBeNull(); expect(container.textContent).not.toContain("Alice");
});
it("offers a retry when the account check fails", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async () => attempts++ === 0 ? jsonResponse({}, 503) : jsonResponse({user: {id: "alice", name: "Alice"}})));
  await render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not check your account");
  await click("Try again"); expect(container.textContent).toContain("Alice"); expect(container.querySelector('[role="alert"]')).toBeNull();
});
it.each([
  [404, "Ask the owner to share it with you"],
  [503, "Check your connection"],
])("distinguishes launch status %s, then retries from the same control", async (status, message) => {
  let launches = 0;
  vi.stubGlobal("fetch", account(() => true, path => path === "/api/apps/launch" ? (launches++ === 0 ? jsonResponse({}, status) : jsonResponse(launch())) : jsonResponse({}, 404)));
  await render(); await click("Open app"); await settle(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(message); expect(submitted).toHaveLength(0);
  expect(button("Open app")?.disabled).toBe(false);
  await click("Open app"); await settle(() => submitted.length === 1); expect(container.querySelector('[role="alert"]')).toBeNull();
});
it("refuses a launch response whose destination is not an approved https bootstrap", async () => {
  vi.stubGlobal("fetch", account(() => true, () => jsonResponse({...launch(), action: `http://${"b".repeat(48)}.apps.example/bootstrap`})));
  await render(); await click("Open app"); await settle(() => Boolean(container.querySelector('[role="alert"]')));
  expect(submitted).toHaveLength(0); expect(button("Open app")?.disabled).toBe(false);
});
it("signs out back to the form and aborts a launch still in flight", async () => {
  let signedIn = true; const held = heldJsonResponse(200);
  vi.stubGlobal("fetch", account(() => signedIn, path => {
    if (path === "/api/apps/launch") return held.response;
    if (path === "/api/account/sign-out") {signedIn = false; return jsonResponse({ok: true});}
    throw Error(path);
  }));
  await render(); await click("Open app"); await settle(held.bodyStarted);
  await click("Sign out"); expect(container.textContent).toContain("Sign in to open this app"); expect(container.textContent).not.toContain("Alice");
  await act(async () => held.release(launch())); await settle(() => true);
  expect(submitted).toHaveLength(0);
});
it("drops a launch issued for a previous route after the target changes", async () => {
  const held = heldJsonResponse(200); let launches = 0;
  vi.stubGlobal("fetch", account(() => true, () => launches++ === 0 ? held.response : jsonResponse(launch())));
  await render(); await click("Open app"); await settle(held.bodyStarted);
  await render({workspaceId: "ws_2", publicationId});
  await act(async () => held.release(launch())); await settle(ready);
  expect(submitted).toHaveLength(0); expect(button("Open app")?.disabled).toBe(false);
});

it("keeps the complete account email when the sender label exceeds the subject limit", async () => {
  const sharerName = "Ana (" + "a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + ".test)";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/apps/summary"
    ? jsonResponse({subjectName: "Trip", sharerName, access: "view"})
    : jsonResponse({user: {id: "alice", name: "Alice"}})));
  await render();
  await settle(() => container.textContent?.includes(sharerName) ?? false);
  expect(container.textContent).toContain("Shared by " + sharerName);
});

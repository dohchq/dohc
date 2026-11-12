// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import JoinApp, {takeJoinToken} from "./JoinApp";
import {jsonResponse, settle, setControlValue} from "./testing";

const TOKEN = "invite_token_0123456789";
const PREVIEW = {workspaceName: "Community", ownerName: "Ana", alreadyMember: false};
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

type Handler = (body: unknown) => Response | Promise<Response>;
function server(routes: Record<string, Handler>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = routes[String(input)];
    if (!handler) throw Error(`unexpected ${String(input)}`);
    return handler(init?.body ? JSON.parse(String(init.body)) : undefined);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const signedIn = () => jsonResponse({user: {id: "user-sam", name: "Sam"}});
const signedOut = () => jsonResponse({user: null});
const text = () => container.textContent ?? "";
const ready = () => !container.querySelector("[aria-busy]");
async function render(token: string | null = TOKEN) { await act(async () => root.render(<JoinApp token={token} />)); await settle(ready); }
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(node => node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
  await settle(() => !button!.disabled || !button!.isConnected);
}

it("takes the token from the link, clears it from the address bar, and keeps it in the tab through sign-up", () => {
  history.replaceState(null, "", `/join#${TOKEN}`);
  expect(takeJoinToken()).toBe(TOKEN);
  expect(location.hash).toBe("");
  expect(location.pathname).toBe("/join");
  // Back from sign-up, the address has no token; the tab still does.
  expect(takeJoinToken()).toBe(TOKEN);
  history.replaceState(null, "", "/join#not a token");
  sessionStorage.clear();
  expect(takeJoinToken()).toBeNull();
  expect(location.hash).toBe("");
});

it("previews the workspace and its owner, joins in one click, and says where to find it", async () => {
  sessionStorage.setItem("dohc.join.token", TOKEN);
  const fetch = server({
    "/api/account/session": signedIn,
    "/api/members/join-preview": body => { expect(body).toEqual({token: TOKEN}); return jsonResponse(PREVIEW); },
    "/api/members/join": body => { expect(body).toEqual({token: TOKEN}); return jsonResponse({workspaceId: "ws-1", shareId: "share-1", workspaceName: "Community"}); },
  });
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("Join Community");
  expect(text()).toContain("Ana owns this workspace.");
  expect(text()).toContain("People in it will see your name. The owner and admins will also see your email.");
  expect(text()).toContain("Signed in as Sam.");
  await click("Join workspace");
  expect(container.querySelector("h1")?.textContent).toBe("You joined Community");
  expect(text()).toContain("In the dohc app, it is listed in Sharing, under Shared with me. This version of dohc cannot open it yet.");
  expect(sessionStorage.getItem("dohc.join.token")).toBeNull();
  expect(fetch.mock.calls.map(([path]) => String(path))).toEqual(["/api/account/session", "/api/members/join-preview", "/api/members/join"]);
});

it("tells a person already in the workspace so, with no Join", async () => {
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse({...PREVIEW, alreadyMember: true})});
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("You're already in Community");
  expect([...container.querySelectorAll("button")].map(node => node.textContent)).toEqual(["Sign out"]);
});

it("signs in, then previews; and offers an account to someone new, keeping the link's place", async () => {
  let session = false;
  server({
    "/api/account/session": () => session ? signedIn() : signedOut(),
    "/api/account/sign-in": body => { expect(body).toEqual({email: "sam@example.com", password: "pw"}); session = true; return jsonResponse({ok: true, user: {id: "user-sam", name: "Sam"}}); },
    "/api/members/join-preview": () => jsonResponse(PREVIEW),
  });
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("Join a workspace on dohc");
  expect(container.querySelector<HTMLAnchorElement>('a[href^="/account/sign-up"]')?.getAttribute("href")).toBe("/account/sign-up?next=%2Fjoin");
  await act(async () => {
    setControlValue(container.querySelector<HTMLInputElement>('input[name="email"]')!, "sam@example.com");
    setControlValue(container.querySelector<HTMLInputElement>('input[name="password"]')!, "pw");
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  await settle(() => container.querySelector("h1")?.textContent === "Join Community");
});

it("keeps the sign-in form with the reason when sign-in fails", async () => {
  server({"/api/account/session": signedOut, "/api/account/sign-in": () => jsonResponse({ok: false}, 401)});
  await render();
  await act(async () => {
    setControlValue(container.querySelector<HTMLInputElement>('input[name="email"]')!, "sam@example.com");
    setControlValue(container.querySelector<HTMLInputElement>('input[name="password"]')!, "wrong");
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  await settle(() => container.querySelector('[role="alert"]') !== null);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("dohc could not sign you in. Check your email and password, then retry.");
  expect(container.querySelector("form")).not.toBeNull();
});

it.each([
  ["link_off", 404, "This invite link no longer works", "turned it off or reset it"],
  ["removed", 403, "You were removed from this workspace", "ask them to let you back in"],
  ["full", 409, "This workspace is full", "1,000 people"],
] as const)("says why a %s link cannot join, and forgets the link", async (code, status, title, words) => {
  sessionStorage.setItem("dohc.join.token", TOKEN);
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse({ok: false, code}, status)});
  await render();
  expect(container.querySelector("h1")?.textContent).toBe(title);
  expect(text()).toContain(words);
  expect(sessionStorage.getItem("dohc.join.token")).toBeNull();
});

it("asks to sign in again when the session ends before joining", async () => {
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse(PREVIEW),
    "/api/members/join": () => jsonResponse({ok: false, code: "signed_out"}, 401)});
  await render();
  await click("Join workspace");
  expect(container.querySelector("h1")?.textContent).toBe("Join a workspace on dohc");
  expect(text()).toContain("Your sign-in ended. Sign in again to join.");
});

it("keeps the preview when the server is down at join, and joins from Try again", async () => {
  let up = false;
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse(PREVIEW),
    "/api/members/join": () => up ? jsonResponse({workspaceId: "ws-1", shareId: "s", workspaceName: "Community"}) : jsonResponse({ok: false, code: "unavailable"}, 503)});
  await render();
  await click("Join workspace");
  expect(container.querySelector("h1")?.textContent).toBe("Join Community");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("dohc could not reach the server. Check your connection. Try again");
  up = true;
  await click("Try again");
  expect(container.querySelector("h1")?.textContent).toBe("You joined Community");
});

it("reads the link again from Try again when the server could not be reached at first", async () => {
  let up = false;
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => {
    if (!up) throw new TypeError("Failed to fetch");
    return jsonResponse(PREVIEW);
  }});
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("dohc could not check this invite link");
  up = true;
  await click("Try again");
  expect(container.querySelector("h1")?.textContent).toBe("Join Community");
});

it("signs out from the preview", async () => {
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse(PREVIEW),
    "/api/account/sign-out": () => jsonResponse({ok: true})});
  await render();
  await click("Sign out");
  expect(container.querySelector("h1")?.textContent).toBe("Join a workspace on dohc");
});

it("says a link with no token is incomplete and asks the server nothing", async () => {
  const fetch = server({});
  await render(null);
  expect(container.querySelector("h1")?.textContent).toBe("This invite link is incomplete");
  expect(fetch).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import JoinApp, {takeJoinToken} from "./JoinApp";
import {jsonResponse, settle, setControlValue} from "./testing";

const TOKEN = "invite_token_0123456789";
const PREVIEW = {workspaceName: "Community", ownerName: "Ana", alreadyMember: false};
const JOINED = {workspaceId: "ws-1", shareId: "share-1", workspaceName: "Community"};
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
/** A response the test sends when it chooses. */
function held() {
  let send: (response: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => { send = resolve; });
  return {response, send: (value: Response) => send(value)};
}
const signedIn = () => jsonResponse({user: {id: "user-sam", name: "Sam"}});
const signedOut = () => jsonResponse({user: null});
const text = () => container.textContent ?? "";
const heading = () => container.querySelector("h1");
const announced = () => container.querySelector('[role="status"]')?.textContent;
const paths = (fetch: ReturnType<typeof server>) => fetch.mock.calls.map(([path]) => String(path));
const ready = () => !container.querySelector("[aria-busy]");
async function render(token: string | null = TOKEN) { await act(async () => root.render(<JoinApp token={token} />)); await settle(ready); }
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(node => node.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) {
  const pressed = button(label);
  await act(async () => pressed.click());
  await settle(() => !pressed.disabled || !pressed.isConnected);
}
async function signInAs(email: string, password: string) {
  await act(async () => {
    setControlValue(container.querySelector<HTMLInputElement>('input[name="email"]')!, email);
    setControlValue(container.querySelector<HTMLInputElement>('input[name="password"]')!, password);
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
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

it("previews the workspace and its owner, says before Join that dohc can't open it yet, joins, and says where to find it", async () => {
  sessionStorage.setItem("dohc.join.token", TOKEN);
  const fetch = server({
    "/api/account/session": signedIn,
    "/api/members/join-preview": body => { expect(body).toEqual({token: TOKEN}); return jsonResponse(PREVIEW); },
    "/api/members/join": body => { expect(body).toEqual({token: TOKEN}); return jsonResponse(JOINED); },
  });
  await render();
  expect(heading()?.textContent).toBe("Join Community");
  expect(text()).toContain("Ana owns this workspace.");
  expect(text()).toContain("People in it will see your name. The owner and admins will also see your email.");
  const limit = container.querySelector('[data-testid="join-limit"]')!;
  expect(limit.textContent).toBe("This version of dohc can't open a joined workspace yet. Once you join, it's listed in the dohc app, in Sharing under Shared with me.");
  // The limit comes before the button that acts on it.
  expect(limit.compareDocumentPosition(button("Join workspace")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(text()).toContain("Signed in as Sam · Sign out");
  await click("Join workspace");
  expect(heading()?.textContent).toBe("You joined Community");
  expect(container.querySelector('[data-testid="join-limit"]')?.textContent)
    .toBe("Find it in the dohc app, in Sharing under Shared with me. It opens there once dohc can open joined workspaces.");
  expect(text()).toContain("Signed in as Sam · Sign out");
  expect(sessionStorage.getItem("dohc.join.token")).toBeNull();
  expect(paths(fetch)).toEqual(["/api/account/session", "/api/members/join-preview", "/api/members/join"]);
});

it("tells a person already in the workspace so, with no Join", async () => {
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse({...PREVIEW, alreadyMember: true})});
  await render();
  expect(heading()?.textContent).toBe("You're already in Community");
  expect(text()).toContain("Find it in the dohc app");
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
  expect(heading()?.textContent).toBe("Join a workspace on dohc");
  expect(container.querySelector<HTMLAnchorElement>('a[href^="/account/sign-up"]')?.getAttribute("href")).toBe("/account/sign-up?next=%2Fjoin");
  await signInAs("sam@example.com", "pw");
  await settle(() => heading()?.textContent === "Join Community");
});

it("keeps the sign-in form with the reason when sign-in fails", async () => {
  server({"/api/account/session": signedOut, "/api/account/sign-in": () => jsonResponse({ok: false}, 401)});
  await render();
  await signInAs("sam@example.com", "wrong");
  await settle(() => container.querySelector('[role="alert"]') !== null);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("dohc could not sign you in. Check your email and password, then try again.");
  expect(container.querySelector("form")).not.toBeNull();
});

it.each([
  ["link_off", 404, "This invite link no longer works", "Ask them to turn it on, then choose Try again."],
  ["removed", 403, "You were removed from this workspace", "Ask them to let you back in, then choose Try again."],
  ["full", 409, "This workspace is full", "It already has 1,000 people."],
] as const)("says why a %s link cannot join, keeps the link and the account, and previews again from Try again", async (code, status, title, words) => {
  sessionStorage.setItem("dohc.join.token", TOKEN);
  let fixed = false;
  const fetch = server({"/api/account/session": signedIn,
    "/api/members/join-preview": () => fixed ? jsonResponse(PREVIEW) : jsonResponse({ok: false, code}, status)});
  await render();
  expect(heading()?.textContent).toBe(title);
  expect(text()).toContain(words);
  expect(text()).toContain("Signed in as Sam · Sign out");
  expect(sessionStorage.getItem("dohc.join.token")).toBe(TOKEN);
  fixed = true;
  await click("Try again");
  expect(heading()?.textContent).toBe("Join Community");
  expect(paths(fetch).filter(path => path === "/api/members/join-preview")).toHaveLength(2);
});

it("previews again after a refresh once an admin fixed access", async () => {
  history.replaceState(null, "", `/join#${TOKEN}`);
  let removed = true;
  server({"/api/account/session": signedIn,
    "/api/members/join-preview": () => removed ? jsonResponse({ok: false, code: "removed"}, 403) : jsonResponse(PREVIEW)});
  await render(takeJoinToken());
  expect(heading()?.textContent).toBe("You were removed from this workspace");
  await act(async () => root.unmount());
  root = createRoot(container);
  removed = false;
  // The address bar has no token after the first read; the tab kept it.
  expect(location.hash).toBe("");
  await render(takeJoinToken());
  expect(heading()?.textContent).toBe("Join Community");
});

it("asks to sign in again when the session ends before joining", async () => {
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse(PREVIEW),
    "/api/members/join": () => jsonResponse({ok: false, code: "signed_out"}, 401)});
  await render();
  await click("Join workspace");
  expect(heading()?.textContent).toBe("Join a workspace on dohc");
  expect(text()).toContain("Your sign-in ended. Sign in again to join.");
});

it("keeps the preview when the server is down at join, and joins from Try again", async () => {
  let up = false;
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse(PREVIEW),
    "/api/members/join": () => up ? jsonResponse(JOINED) : jsonResponse({ok: false, code: "unavailable"}, 503)});
  await render();
  await click("Join workspace");
  expect(heading()?.textContent).toBe("Join Community");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("dohc could not reach the server. Check your connection. Try again");
  up = true;
  await click("Try again");
  expect(heading()?.textContent).toBe("You joined Community");
});

it("retries a failed sign-out as a sign-out, never a join", async () => {
  let up = false;
  const fetch = server({"/api/account/session": signedIn, "/api/members/join-preview": () => jsonResponse(PREVIEW),
    "/api/members/join": () => jsonResponse(JOINED),
    "/api/account/sign-out": () => up ? jsonResponse({ok: true}) : jsonResponse({ok: false}, 500)});
  await render();
  await click("Sign out");
  expect(heading()?.textContent).toBe("Join Community");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("dohc could not sign you out. Try again");
  up = true;
  await click("Try again");
  expect(paths(fetch)).not.toContain("/api/members/join");
  expect(paths(fetch).filter(path => path === "/api/account/sign-out")).toHaveLength(2);
  expect(heading()?.textContent).toBe("Join a workspace on dohc");
});

it("reads the link again from Try again when the server could not be reached at first", async () => {
  let up = false;
  server({"/api/account/session": signedIn, "/api/members/join-preview": () => {
    if (!up) throw new TypeError("Failed to fetch");
    return jsonResponse(PREVIEW);
  }});
  await render();
  expect(heading()?.textContent).toBe("dohc could not check this invite link");
  expect(text()).toContain("Signed in as Sam · Sign out");
  up = true;
  await click("Try again");
  expect(heading()?.textContent).toBe("Join Community");
});

it("moves focus to each new stage's heading, or to the sign-in form's first field, and announces each stage", async () => {
  let session = false;
  const joining = held();
  server({
    "/api/account/session": () => session ? signedIn() : signedOut(),
    "/api/account/sign-in": () => { session = true; return jsonResponse({ok: true, user: {id: "user-sam", name: "Sam"}}); },
    "/api/members/join-preview": () => jsonResponse(PREVIEW),
    "/api/members/join": () => joining.response,
  });
  await render();
  expect(document.activeElement).toBe(container.querySelector('input[name="email"]'));
  expect(announced()).toBe("Sign in to see which workspace this link is for.");
  await signInAs("sam@example.com", "pw");
  await settle(() => heading()?.textContent === "Join Community");
  expect(document.activeElement).toBe(heading());
  expect(heading()?.tabIndex).toBe(-1);
  expect(announced()).toBe("Join Community");
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");

  await act(async () => button("Join workspace").click());
  expect(button("Joining…").getAttribute("aria-busy")).toBe("true");
  await act(async () => joining.send(jsonResponse(JOINED)));
  await settle(() => heading()?.textContent === "You joined Community");
  expect(document.activeElement).toBe(heading());
  expect(announced()).toBe("You joined Community");
});

it("marks Sign in busy while it signs in", async () => {
  const signing = held();
  server({"/api/account/session": signedOut, "/api/account/sign-in": () => signing.response});
  await render();
  await signInAs("sam@example.com", "pw");
  expect(button("Signing in…").getAttribute("aria-busy")).toBe("true");
  await act(async () => signing.send(jsonResponse({ok: false}, 401)));
  await settle(() => container.querySelector('[role="alert"]') !== null);
  expect(button("Sign in").getAttribute("aria-busy")).toBeNull();
});

it("says a link with no token is incomplete and asks the server nothing", async () => {
  const fetch = server({});
  await render(null);
  expect(heading()?.textContent).toBe("This invite link is incomplete");
  expect(fetch).not.toHaveBeenCalled();
});

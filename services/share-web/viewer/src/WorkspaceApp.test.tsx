// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {getDohcYDocBodyFragment, markdownToYDoc} from "@dohc/ydoc-projection";
import type {NamedLiveBrowserState} from "@dohc/ydoc-projection/named-live-browser-transport";
import WorkspaceApp from "./WorkspaceApp";
import {memberDocument, memberPageReady, openMemberPage} from "./memberLive";
import "./MemberLivePage";
import {jsonResponse, setControlValue, settle} from "./testing";

// A workspace member's page in a browser: the workspace's files, a page, and
// its Groups, at the member's level, and what it says when that ends.

vi.mock("./memberLive", () => ({openMemberPage: vi.fn(), memberPageReady: vi.fn(), memberDocument: vi.fn()}));

type Level = "view" | "comment" | "edit";
const GRANT = "grant-1", SESSION = `member.${GRANT}`;
const FILES = [
  {path: "trip/plan.md", objectId: "object-plan", blobSha256: "a".repeat(64), contentKind: "text"},
  {path: "trip/to-pack.md", objectId: "object-pack", blobSha256: "b".repeat(64), contentKind: "text"},
  {path: "welcome/readme.md", objectId: "object-readme", blobSha256: "c".repeat(64), contentKind: "text"},
];
const TEXT: Record<string, string> = {["a".repeat(64)]: "Leave at nine.", ["b".repeat(64)]: "Fuel and food.", ["c".repeat(64)]: "Welcome."};
const chat = (relaySeq: number, body: string, author = "ana") => ({relaySeq, messageId: `m${relaySeq}`, threadId: `t${relaySeq}`, authorUserId: author,
  authorDisplayName: author === "ana" ? "Ana" : "Sam", authorKind: "human", linkAgent: false, authorOwnerDisplayName: null, createdAtMs: relaySeq * 1000, body, bodyTooLarge: false});
type Held = {path: string; url: URL; signal: AbortSignal; answer(value: unknown, status?: number): void};

let container: HTMLDivElement, root: Root, held: Held[], posts: Record<string, unknown>[], narrow: boolean;
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  held = []; posts = []; narrow = false;
  Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "visible"});
  vi.stubGlobal("matchMedia", (query: string) => ({matches: query.includes("max-width") ? narrow : false, media: query,
    addEventListener() {}, removeEventListener() {}}));
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {configurable: true, value: function (this: HTMLDialogElement) {this.open = true;}},
    close: {configurable: true, value: function (this: HTMLDialogElement) {this.open = false;}},
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function server(options: {level?: Level; signedIn?: boolean; groups?: Array<{wire: string; name: string}>; files?: typeof FILES; member?: boolean;
  groupsFail?: number} = {}) {
  let signedIn = options.signedIn ?? true, groupsFail = options.groupsFail ?? 0;
  const level = options.level ?? "comment", files = options.files ?? FILES;
  const access = level === "view" ? "read-only" : "read-write";
  const groups = options.groups ?? [{wire: "wire-plans", name: "plans"}, {wire: "wire-food", name: "food"}];
  const meta = {ok: true, effectiveSelector: {paths: [], versionId: null, access: level, wholeWorkspace: true}, access: level, subjectName: "Trip",
    lastSettledAtMs: Date.now(), lastSettledKnown: true};
  const hold = (path: string, url: URL, signal: AbortSignal) => new Promise<Response>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
    const item: Held = {path, url, signal, answer: (value, status = 200) => {held.splice(held.indexOf(item), 1); resolve(jsonResponse(value, status));}};
    held.push(item);
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://share.test"), signal = init?.signal ?? new AbortController().signal;
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/account/session") return jsonResponse({user: signedIn ? {id: "sam", name: "Sam Rivera"} : null});
    if (url.pathname === "/api/account/sign-in") {signedIn = true; return jsonResponse({ok: true});}
    if (url.pathname === "/api/account/sign-out") {signedIn = false; return jsonResponse({ok: true});}
    // share-web gives an account that holds no membership the answer it gives an unknown grant.
    if (options.member === false && (url.pathname.startsWith("/api/view/") || url.pathname.startsWith("/api/named-chat/"))) return jsonResponse({ok: false, error: "not found"}, 404);
    if (url.pathname.startsWith("/api/view/")) {
      expect(headers.get("x-dohc-link-session") ?? url.searchParams.get("session")).toBe(SESSION);
      if (url.pathname === "/api/view/current") return jsonResponse({...meta, files, nextCursor: 7, epochLogFloor: 0});
      if (url.pathname === "/api/view/meta") return jsonResponse(meta);
      if (url.pathname === "/api/view/log") return url.searchParams.has("hold") ? hold("log", url, signal)
        : jsonResponse({ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0});
      const sha = url.pathname.slice("/api/view/blob/".length);
      return new Response(TEXT[sha] ?? "", {headers: {"content-type": "text/plain"}});
    }
    if (url.pathname === "/api/named-chat/channels" && groupsFail > 0) {groupsFail -= 1; return jsonResponse({ok: false, error: "unavailable"}, 503);}
    if (url.pathname === "/api/named-chat/channels") return jsonResponse({shareId: "share", userId: "sam", maxPostBytes: 9000, maxBodyBytes: 8000,
      channels: groups.map(group => ({channelWireId: group.wire, name: group.name, kind: "channel", access}))});
    if (url.pathname === "/api/named-chat/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
      const place = typeof body.path === "string" ? {path: body.path} : {channelWireId: body.channelWireId};
      return jsonResponse({shareId: "share", ...place, message: chat(40, String(body.body), "sam")});
    }
    // A file's Comments, by the file's path.
    const path = url.searchParams.get("path");
    if (url.pathname === "/api/named-chat/messages" && path !== null) {
      if (url.searchParams.has("since")) return hold("comments", url, signal);
      return jsonResponse({shareId: "share", path, nextCursor: 30, olderCursor: null,
        messages: path === "trip/plan.md" ? [chat(9, "Nine is early")] : []});
    }
    if (url.pathname === "/api/named-chat/messages" && url.searchParams.has("since")) return hold("chat", url, signal);
    if (url.pathname === "/api/named-chat/messages") {
      const wire = url.searchParams.get("channelWireId");
      return jsonResponse({shareId: "share", channelWireId: wire, nextCursor: 20, olderCursor: null,
        messages: wire === "wire-plans" ? [chat(3, "Plans start here")] : [chat(5, "Bring snacks")]});
    }
    throw Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const text = () => container.textContent ?? "";
const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) => buttons().find(node => node.textContent === label || node.getAttribute("aria-label") === label);
async function click(label: string) {const control = button(label); expect(control, label).toBeDefined(); await act(async () => control!.click());}
async function render(grantId: string | null = GRANT) {await act(async () => root.render(<WorkspaceApp grantId={grantId}/>));}
const following = (path: "log" | "chat" | "comments") => held.filter(item => item.path === path && !item.signal.aborted);
async function opened() {await settle(() => text().includes("Leave at nine.") && text().includes("Plans start here") && following("chat").length === 1);}
const groupPanel = () => container.querySelector<HTMLElement>("#workspace-chats")!;
const commentsPanel = () => container.querySelector<HTMLElement>("#workspace-comments")!;

it("asks a signed-out browser to sign in with the invited account, then opens the workspace", async () => {
  server({signedIn: false}); await render();
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(text()).toContain("Sign in to open this workspace");
  await act(async () => {setControlValue(container.querySelector('input[name="email"]')!, "sam@dohc.test");
    setControlValue(container.querySelector('input[name="password"]')!, "secret");});
  await click("Sign in"); await opened();
  expect(container.querySelector(".workspace-name")?.textContent).toBe("Trip");
  expect(text()).toContain("Sam Rivera");
});

it("shows the workspace's tree and a page's settled text at View, and its Groups without a composer", async () => {
  server({level: "view"}); await render(); await opened();
  const tree = container.querySelector('nav[aria-label="Workspace files"]')!;
  expect([...tree.querySelectorAll(".folder span, .file span")].map(node => node.textContent)).toEqual(["trip", "plan.md", "to-pack.md", "welcome", "readme.md"]);
  expect(container.querySelector(".page-title")?.textContent).toBe("plan");
  expect(container.querySelector(".workspace-page .badge")?.textContent).toBe("View only");
  expect(groupPanel().textContent).toContain("Only people who can comment post here.");
  expect(groupPanel().querySelector('textarea[name="body"]')).toBeNull();
  await act(async () => [...tree.querySelectorAll<HTMLButtonElement>(".file")].find(node => node.textContent === "to-pack.md")!.click());
  await settle(() => text().includes("Fuel and food."));
  expect(container.querySelector(".file.selected")?.textContent).toBe("to-pack.md");
  expect(vi.mocked(openMemberPage)).not.toHaveBeenCalled();
});

it("moves through the file tree with the arrow keys, folds a folder, and opens a file with Enter", async () => {
  server({level: "view"}); await render(); await opened();
  const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
  expect(tree.getAttribute("aria-label")).toBe("Workspace files");
  const items = () => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const named = (name: string) => items().find(node => node.textContent === name)!;
  // One item takes Tab: the open file.
  expect(items().filter(node => node.tabIndex === 0)).toEqual([named("plan.md")]);
  expect(named("plan.md").getAttribute("aria-selected")).toBe("true");
  expect(named("trip").getAttribute("aria-level")).toBe("1");
  expect(named("plan.md").getAttribute("aria-level")).toBe("2");
  const press = async (key: string) => act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true}));
  });
  named("plan.md").focus();
  await press("ArrowDown"); expect(document.activeElement).toBe(named("to-pack.md"));
  await press("ArrowDown"); expect(document.activeElement).toBe(named("welcome"));
  await press("ArrowLeft"); expect(named("welcome").getAttribute("aria-expanded")).toBe("false");
  expect(items().map(node => node.textContent)).toEqual(["trip", "plan.md", "to-pack.md", "welcome"]);
  await press("ArrowRight"); expect(named("welcome").getAttribute("aria-expanded")).toBe("true");
  await press("ArrowRight"); expect(document.activeElement).toBe(named("readme.md"));
  await press("ArrowLeft"); expect(document.activeElement).toBe(named("welcome"));
  await press("Home"); expect(document.activeElement).toBe(named("trip"));
  await press("End"); expect(document.activeElement).toBe(named("readme.md"));
  await press("ArrowUp"); expect(document.activeElement).toBe(named("welcome"));
  await press("ArrowDown"); await press("Enter");
  await settle(() => text().includes("Welcome."));
  expect(named("readme.md").getAttribute("aria-selected")).toBe("true");
  expect(items().filter(node => node.tabIndex === 0)).toEqual([named("readme.md")]);
});

it("raises a toast with Try again and copy when the Groups don't load, and keeps one line in their place", async () => {
  server({groupsFail: 1}); await render();
  await settle(() => text().includes("Leave at nine.") && groupPanel().textContent!.includes("Groups didn't load."));
  const toast = () => container.querySelector<HTMLElement>(".toast-slot [role=alert]");
  expect(toast()?.querySelector(".edit-notice-title")?.textContent).toBe("dohc could not load Groups and comments");
  expect(toast()?.textContent).toContain("Check your connection.");
  const copy = vi.fn(async () => {});
  vi.stubGlobal("navigator", {...navigator, clipboard: {writeText: copy}});
  await act(async () => toast()!.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click());
  expect(copy).toHaveBeenCalledWith("dohc could not load Groups and comments\nCheck your connection.");
  await act(async () => [...toast()!.querySelectorAll("button")].find(node => node.textContent === "Try again")!.click());
  await settle(() => text().includes("Plans start here"));
  expect(toast()).toBeNull();
});

it("posts in a Group at Comment, counts another Group's new messages, and opens it from the list", async () => {
  server({level: "comment"}); await render(); await opened();
  expect(following("chat")[0]!.url.searchParams.get("channelWireId")).toBeNull();
  const box = groupPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
  setControlValue(box, "Count me in"); await click("Send");
  await settle(() => posts.length === 1);
  expect(posts[0]).toMatchObject({shareId: "share", channelWireId: "wire-plans", body: "Count me in", authorKind: "human"});
  await act(async () => following("chat")[0]!.answer({shareId: "share", nextCursor: 22, hasMore: false,
    messages: [{...chat(21, "Bring snacks too"), channelWireId: "wire-food"}]}));
  await settle(() => button("All Groups")?.textContent?.includes("1") === true);
  await click("All Groups");
  const food = buttons().find(node => node.textContent?.startsWith("food"))!;
  expect(food.textContent).toBe("food1 unread");
  await act(async () => food.click());
  await settle(() => groupPanel().textContent?.includes("Bring snacks too") === true);
  expect(groupPanel().querySelector("h2")?.textContent).toBe("food");
  // One follow serves every Group, whichever is open.
  await settle(() => following("chat").length === 1);
});

function liveSession() {
  const doc = markdownToYDoc("Leave at nine."), listeners = new Set<(value: NamedLiveBrowserState) => void>();
  let state: NamedLiveBrowserState = {status: "authorizing", reason: null, binding: null, hostEpoch: null, pendingUpdates: 0, pendingBytes: 0, lastApplied: null, membership: null};
  const notify = () => {for (const listener of listeners) listener(state);};
  const session = {doc, body: getDohcYDocBodyFragment(doc), state: () => state,
    subscribe(listener: (value: NamedLiveBrowserState) => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    close: vi.fn(), reconnect: vi.fn(async () => {state = {...state, status: "live"}; notify();}), disconnect: vi.fn(),
    edit(change: () => void) {if (state.status !== "live") return false; change(); return true;}};
  return session;
}
const ADMITTED = {kind: "open", discriminator: "abcdefghijkl", objectId: "object-plan", userId: "sam", token: "ab".repeat(32), limits: {}} as const;

it("opens a page in the live editor at Edit, as the signed-in account", async () => {
  server({level: "edit"});
  const session = liveSession();
  vi.mocked(openMemberPage).mockResolvedValue(ADMITTED);
  vi.mocked(memberDocument).mockReturnValue({session: session as never, close: vi.fn()});
  await render();
  await settle(() => container.querySelector('[role="textbox"]') !== null && !container.querySelector(".named-body-editor")?.hasAttribute("hidden"));
  expect(vi.mocked(openMemberPage)).toHaveBeenCalledWith(GRANT, "trip/plan.md", expect.any(AbortSignal));
  expect(vi.mocked(memberDocument)).toHaveBeenCalledWith(expect.objectContaining({grantId: GRANT, path: "trip/plan.md", accountId: "sam", admission: ADMITTED}));
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain("Leave at nine.");
  expect(container.querySelector("header .named-document-status")?.textContent).toBe("Ready to edit");
  expect(container.querySelector(".workspace-page .badge")).toBeNull();
});

it("waits for the owner's dohc with the page readable, raises a toast after 15 seconds, and opens by itself once ready", async () => {
  server({level: "edit"});
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
  const session = liveSession();
  let ready!: (value: boolean) => void;
  vi.mocked(openMemberPage).mockResolvedValueOnce({kind: "refused", code: "live-document-without-lineage"}).mockResolvedValue(ADMITTED);
  vi.mocked(memberPageReady).mockImplementation(() => new Promise(resolve => {ready = resolve;}));
  vi.mocked(memberDocument).mockReturnValue({session: session as never, close: vi.fn()});
  await render();
  await settle(() => text().includes("You can read this page.") && text().includes("Leave at nine.") && ready !== undefined);
  expect(container.querySelector("header .live-ring")).not.toBeNull();
  expect(container.querySelector(".workspace-toast")).toBeNull();
  await act(async () => vi.advanceTimersByTime(15_000));
  const toast = container.querySelector(".workspace-toast")!;
  expect(toast.querySelector(".edit-notice-title")?.textContent).toBe('dohc could not open "plan.md" for editing');
  expect(toast.textContent).toContain("Editing starts once the owner's dohc is online. You can still read it.");
  await act(async () => ready(true));
  await settle(() => container.querySelector('[role="textbox"]') !== null && container.querySelector(".workspace-toast") === null);
  expect(vi.mocked(openMemberPage)).toHaveBeenCalledTimes(2);
});

it.each([
  ["live_paused_by_owner", "The owner paused live editing for this page. You can still read it."],
  ["live_host_full", "The server is editing too many pages right now. You can still read it."],
])("keeps a page readable when the host refuses it (%s), with Try again", async (code, sentence) => {
  server({level: "edit"});
  vi.mocked(openMemberPage).mockResolvedValue({kind: "refused", code});
  await render();
  await settle(() => container.querySelector(".workspace-toast") !== null && text().includes("Leave at nine."));
  expect(container.querySelector(".workspace-toast")?.textContent).toContain(sentence);
  expect(text()).toContain("You can read this page.");
  await click("Try again");
  await settle(() => vi.mocked(openMemberPage).mock.calls.length === 2);
});

it("says the membership ended and shows none of the workspace once the member is removed", async () => {
  server({level: "comment"}); await render(); await opened();
  await act(async () => following("log")[0]!.answer({ok: false, error: "not found"}, 404));
  await settle(() => text().includes("Your membership ended."));
  // A browser keeps no copy, so the page says only that.
  expect(container.querySelector(".state-message")?.textContent?.trim()).toBe("Your membership ended.");
  expect(container.querySelector('nav[aria-label="Workspace files"]')).toBeNull();
  expect(text()).not.toContain("Leave at nine.");
  expect(text()).not.toContain("Plans start here");
});

it("refuses an account that is not a member, and offers to sign out", async () => {
  server({member: false}); await render();
  await settle(() => text().includes("dohc could not open this workspace with this account."));
  expect(button("Sign out")).toBeDefined();
});

it("lays the files, the page and Chats or Comments side by side on a wide screen, and as four tabs on a phone", async () => {
  server({level: "comment"}); await render(); await opened();
  const side = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(side.map(tab => tab.textContent)).toEqual(["Comments", "Chats"]);
  expect(side.map(tab => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  for (const id of ["workspace-files", "workspace-main", "workspace-chats"]) {
    expect(container.querySelector(`#${id}`)?.closest("[hidden], [inert]"), id).toBeNull();
  }
  expect(commentsPanel().hasAttribute("inert")).toBe(true);
  await act(async () => root.unmount()); root = createRoot(container); held = [];
  narrow = true; await render(); await opened();
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map(tab => tab.textContent)).toEqual(["Files", "Page", "Comments", "Chats"]);
  expect(tabs.map(tab => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
  expect(container.querySelector("#workspace-files")?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector("#workspace-chats")?.hasAttribute("inert")).toBe(true);
  await act(async () => tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true})));
  expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[2]);
  expect(commentsPanel().hasAttribute("inert")).toBe(false);
  await settle(() => commentsPanel().textContent?.includes("Nine is early") === true);
  await act(async () => tabs[2]!.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true})));
  expect(container.querySelector("#workspace-chats")?.hasAttribute("inert")).toBe(false);
  await act(async () => tabs[0]!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("#workspace-files .file")].find(node => node.textContent === "readme.md")!.click());
  await settle(() => text().includes("Welcome."));
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
});

async function showComments() {
  await click("Comments");
  await settle(() => commentsPanel().textContent?.includes("Nine is early") === true && following("comments").length === 1);
}

it("shows the open file's Comments at Comment and posts one on the file", async () => {
  server({level: "comment"}); await render(); await opened();
  await showComments();
  expect(following("comments")[0]!.url.searchParams.get("path")).toBe("trip/plan.md");
  expect(commentsPanel().querySelector("h2")?.textContent).toBe("Comments");
  expect(commentsPanel().textContent).toContain("plan.md");
  const box = commentsPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
  expect(box.getAttribute("aria-label")).toBe("Comment");
  setControlValue(box, "Ten, then"); await act(async () => commentsPanel().querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await settle(() => posts.length === 1);
  expect(posts[0]).toMatchObject({shareId: "share", path: "trip/plan.md", body: "Ten, then", authorKind: "human"});
  expect(posts[0]).not.toHaveProperty("channelWireId");
  await settle(() => commentsPanel().textContent?.includes("Ten, then") === true);

  // Another file shows its own Comments.
  const tree = container.querySelector('nav[aria-label="Workspace files"]')!;
  await act(async () => [...tree.querySelectorAll<HTMLButtonElement>(".file")].find(node => node.textContent === "to-pack.md")!.click());
  await settle(() => commentsPanel().textContent?.includes("No comments yet.") === true);
  await settle(() => following("comments").length === 1 && following("comments")[0]!.url.searchParams.get("path") === "trip/to-pack.md");
});

it("shows a file's Comments at View with no comment controls", async () => {
  server({level: "view"}); await render(); await opened();
  await showComments();
  expect(commentsPanel().querySelector("textarea, form")).toBeNull();
  expect([...commentsPanel().querySelectorAll("button")].map(node => node.textContent)).not.toContain("Send");
  expect(commentsPanel().textContent).toContain("Only people who can comment post here.");
});

it("copies a toast's text with the Copy button beside it", async () => {
  server({level: "edit"});
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});
  vi.mocked(openMemberPage).mockResolvedValue({kind: "refused", code: "live_paused_by_owner"});
  await render();
  await settle(() => container.querySelector(".workspace-toast") !== null);
  const toast = container.querySelector<HTMLElement>(".workspace-toast")!;
  const copy = toast.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!;
  expect(copy).not.toBeNull();
  // Beside the text, before the actions.
  expect(copy.closest(".toast-text")).not.toBeNull();
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith('dohc could not open "plan.md" for editing\nThe owner paused live editing for this page. You can still read it.');
});

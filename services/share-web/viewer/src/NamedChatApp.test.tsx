// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import NamedChatApp from "./NamedChatApp";
import {jsonResponse, settle, setControlValue} from "./testing";

const shareId = "share", channelWireId = "wire";
const message = (relaySeq: number, body: string, author = "Ana") => ({relaySeq, messageId: `m${relaySeq}`, threadId: `t${relaySeq}`,
  authorUserId: author.toLowerCase(), authorDisplayName: author, authorKind: "human", authorOwnerDisplayName: null, createdAtMs: relaySeq * 1000, body});
type Follow = {grant: string; since: string; signal: AbortSignal; answer(value: unknown, status?: number): void};

let container: HTMLDivElement, root: Root, visibility: DocumentVisibilityState, follows: Follow[], posts: Record<string, unknown>[];
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true}); visibility = "visible"; follows = []; posts = [];
  Object.defineProperty(document, "visibilityState", {configurable: true, get: () => visibility});
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

function server(options: {access?: "read-only" | "read-write"; signedIn?: boolean; channelName?: string;
  history?: (before: string | null) => unknown; post?: (body: Record<string, unknown>) => Response} = {}) {
  let signedIn = options.signedIn ?? true;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://viewer.test"), signal = init?.signal ?? new AbortController().signal;
    if (url.pathname === "/api/account/session") return jsonResponse({user: signedIn ? {id: "alice", name: "Alice"} : null});
    if (url.pathname === "/api/account/sign-in") {signedIn = true; return jsonResponse({ok: true});}
    if (url.pathname === "/api/named-chat/channels") return jsonResponse({shareId, userId: "alice",
      channels: [{channelWireId, name: options.channelName ?? url.searchParams.get("grantId"), kind: "channel", access: options.access ?? "read-write"}]});
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
      return options.post?.(body) ?? jsonResponse({shareId, channelWireId, message: {...message(90, String(body.body), "Alice"), messageId: `posted-${String(body.id)}`}});
    }
    if (url.searchParams.has("since")) return new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
      follows.push({grant: String(container.querySelector("h1")?.textContent), since: url.searchParams.get("since")!, signal,
        answer: (value, status = 200) => resolve(jsonResponse(value, status))});
    });
    return jsonResponse(options.history?.(url.searchParams.get("before")) ??
      {shareId, channelWireId, messages: [message(2, "Second"), message(1, "First")], nextCursor: 10, olderCursor: null});
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label);
const composer = () => container.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
const status = () => container.querySelector("#chat-composer-status")?.textContent ?? "";
async function render(grantId: string | null = "grant") {await act(async () => root.render(<NamedChatApp grantId={grantId}/>));}
async function click(label: string) {const control = button(label); expect(control).toBeDefined(); await act(async () => control!.click());}
async function type(value: string) {setControlValue(composer()!, value);}
async function opened() {await settle(() => text().includes("Second") && follows.some(follow => !follow.signal.aborted));}

it("signs in with the shared form, reads the channel oldest first, and posts as the signed-in account", async () => {
  server({signedIn: false, channelName: "Trip to Lisbon"}); await render();
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(text()).toContain("Sign in to chat");
  await act(async () => {setControlValue(container.querySelector('input[name="email"]')!, "alice@example.test"); setControlValue(container.querySelector('input[name="password"]')!, "secret");});
  await click("Sign in"); await opened();
  expect(container.querySelector("h1")?.textContent).toBe("Trip to Lisbon");
  expect([...container.querySelectorAll(".chat-body")].map(node => node.textContent?.trim())).toEqual(["First", "Second"]);
  await type("Booked the **hotel**"); await click("Send"); await settle(() => composer()?.value === "");
  expect(posts).toEqual([{shareId, channelWireId, id: expect.any(String), body: "Booked the **hotel**", authorKind: "human", authorDisplayName: "Alice"}]);
  expect(container.querySelector(".chat-list li:last-child strong")?.textContent).toBe("hotel");
});

it("shows a pending post, keeps the draft after an unknown outcome, and retries with the same client ID", async () => {
  const answers = [() => new Response(null, {status: 503}), () => {throw new TypeError("network");}];
  server({post: body => {
    const next = answers.shift();
    if (next) return next();
    return jsonResponse({shareId, channelWireId, message: {...message(30, String(body.body), "Alice"), messageId: "accepted"}});
  }});
  await render(); await opened();
  await type("See you there"); await click("Send"); await settle(() => posts.length === 1 && !text().includes("Sending…"));
  expect(composer()?.value).toBe("See you there");
  expect(status()).toContain("could not confirm that your message was sent");
  await click("Try again"); await settle(() => posts.length === 2 && status().includes("could not confirm"));
  expect(composer()?.value).toBe("See you there");
  await click("Try again"); await settle(() => composer()?.value === "");
  expect(new Set(posts.map(post => post.id)).size).toBe(1);
  expect(text()).toContain("See you there"); expect(status()).toBe("");
});

it("replaces the composer with the reason when access is read only", async () => {
  server({access: "read-only"}); await render(); await opened();
  expect(composer()).toBeNull();
  expect(text()).toContain("You can read this channel but not post. The owner gave you read-only access.");
});

it("switches to read only and keeps the draft when the relay refuses a post", async () => {
  server({post: () => jsonResponse({ok: false, error: "this share does not accept appends", code: "share_read_only"}, 403)});
  await render(); await opened(); await type("Keep me"); await click("Send");
  await settle(() => text().includes("read-only access"));
  expect(composer()).toBeNull();
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your unsent message"]')?.value).toBe("Keep me");
});

it("follows new messages with the stored cursor, pauses while hidden, and resumes from the same cursor", async () => {
  server(); await render(); await opened();
  expect(follows.at(-1)!.since).toBe("10");
  await act(async () => follows.at(-1)!.answer({shareId, channelWireId, messages: [message(11, "Third")], nextCursor: 11, hasMore: false}));
  await settle(() => text().includes("Third") && follows.length === 2);
  expect(follows.at(-1)!.since).toBe("11");
  visibility = "hidden"; await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(follows.every(follow => follow.signal.aborted)).toBe(true);
  const count = follows.length;
  visibility = "visible"; await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await settle(() => follows.length === count + 1);
  expect(follows.at(-1)!.since).toBe("11");
});

it("loads older messages without moving the following cursor", async () => {
  server({history: before => before === null
    ? {shareId, channelWireId, messages: [message(5, "Newest")], nextCursor: 20, olderCursor: 5}
    : {shareId, channelWireId, messages: [message(3, "Oldest")], nextCursor: 4, olderCursor: null}});
  await render(); await settle(() => text().includes("Newest") && follows.length > 0);
  await click("Load earlier messages"); await settle(() => text().includes("Oldest"));
  expect([...container.querySelectorAll(".chat-body")].map(node => node.textContent?.trim())).toEqual(["Oldest", "Newest"]);
  expect(button("Load earlier messages")).toBeUndefined();
  await act(async () => follows.at(-1)!.answer({shareId, channelWireId, messages: [], nextCursor: 21, hasMore: false}));
  await settle(() => follows.length === 2);
  expect(follows.map(follow => follow.since)).toEqual(["20", "21"]);
});

it("drops a follow response that arrives after the invitation changed", async () => {
  server(); await render("grant-a"); await opened();
  const stale = follows.at(-1)!;
  await render("grant-b"); await settle(() => container.querySelector("h1")?.textContent === "grant-b" && follows.some(follow => follow.grant === "grant-b"));
  expect(stale.signal.aborted).toBe(true);
  stale.answer({shareId, channelWireId, messages: [message(12, "From the old channel")], nextCursor: 12, hasMore: false});
  await settle(() => true);
  expect(text()).not.toContain("From the old channel");
});

it("renders message bodies as sanitized Markdown, never raw HTML", async () => {
  server({history: () => ({shareId, channelWireId, nextCursor: 3, olderCursor: null,
    messages: [message(2, "<img src=x onerror=alert(1)>Second"), message(1, "[site](javascript:alert(1)) First")]})});
  await render(); await opened();
  expect(container.querySelector(".chat-list img, .chat-list [onerror]")).toBeNull();
  expect(container.querySelector(".chat-list a[href^='javascript']")).toBeNull();
  expect(text()).toContain("<img src=x onerror=alert(1)>Second");
});

it("returns to sign-in when the session ends while following", async () => {
  server(); await render(); await opened();
  await act(async () => follows.at(-1)!.answer({ok: false, error: "unauthorized", code: "unauthorized"}, 401));
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Your session ended. Sign in again to keep reading.");
});

// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import NamedChatApp from "./NamedChatApp";
import {CHAT_EMPTY_PAGE_LIMIT} from "./namedChat";
import {jsonResponse, settle, setControlValue} from "./testing";

const shareId = "share", channelWireId = "wire";
const message = (relaySeq: number, body: string, author = "Ana") => ({relaySeq, messageId: `m${relaySeq}`, threadId: `t${relaySeq}`,
  authorUserId: author.toLowerCase(), authorDisplayName: author, authorKind: "human", authorOwnerDisplayName: null, createdAtMs: relaySeq * 1000,
  body, bodyTooLarge: false});
const tooLarge = (relaySeq: number) => ({...message(relaySeq, ""), authorUserId: null, body: null, bodyTooLarge: true});
type Follow = {grant: string; since: string; signal: AbortSignal; answer(value: unknown, status?: number): void};

let container: HTMLDivElement, root: Root, visibility: DocumentVisibilityState, follows: Follow[], posts: Record<string, unknown>[];
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true}); visibility = "visible"; follows = []; posts = [];
  Object.defineProperty(document, "visibilityState", {configurable: true, get: () => visibility});
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

function server(options: {access?: "read-only" | "read-write"; signedIn?: boolean; channelName?: string; maxPostBytes?: number;
  history?: (before: string | null) => unknown; post?: (body: Record<string, unknown>) => Response} = {}) {
  let signedIn = options.signedIn ?? true;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://viewer.test"), signal = init?.signal ?? new AbortController().signal;
    if (url.pathname === "/api/account/session") return jsonResponse({user: signedIn ? {id: "alice", name: "Alice"} : null});
    if (url.pathname === "/api/account/sign-in") {signedIn = true; return jsonResponse({ok: true});}
    if (url.pathname === "/api/named-chat/channels") return jsonResponse({shareId, userId: "alice", maxPostBytes: options.maxPostBytes ?? 100_000, maxBodyBytes: 65536,
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
    return jsonResponse(await options.history?.(url.searchParams.get("before")) ??
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
const historyReads = (fetch: ReturnType<typeof server>) => fetch.mock.calls.map(([input]) => new URL(String(input), "https://viewer.test"))
  .filter(url => url.pathname === "/api/named-chat/messages" && !url.searchParams.has("since")).map(url => url.searchParams.get("before"));

it.each([401, 403])("explains sign-in refusal %s with the shared form", async status => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/account/session"
    ? jsonResponse({user: null}) : jsonResponse({ok: false, ...(status === 403 ? {code: "EMAIL_NOT_VERIFIED"} : {})}, status)));
  await render(); await settle(() => Boolean(container.querySelector('input[name="email"]')));
  await act(async () => {setControlValue(container.querySelector('input[name="email"]')!, "alice@example.test"); setControlValue(container.querySelector('input[name="password"]')!, "secret");});
  await click("Sign in"); await settle(() => Boolean(container.querySelector('[role="alert"]')));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(status === 403
    ? "Choose a password from an emailed link before you sign in. Use Forgot your password? to get a link."
    : "dohc could not sign you in. Check your email and password, then retry.");
  expect(Boolean(container.querySelector('a[href="/account/forgot-password"]'))).toBe(status === 403);
});

it("signs in with the shared form, reads the channel oldest first, and posts as the signed-in account", async () => {
  server({signedIn: false, channelName: "Trip to Lisbon"}); await render();
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(text()).toContain("Sign in to chat");
  await act(async () => {setControlValue(container.querySelector('input[name="email"]')!, "alice@example.test"); setControlValue(container.querySelector('input[name="password"]')!, "secret");});
  await click("Sign in"); await opened();
  expect(container.querySelector("h1")?.textContent).toBe("Trip to Lisbon");
  expect([...container.querySelectorAll(".chat-body")].map(node => node.textContent?.trim())).toEqual(["First", "Second"]);
  await type("Booked the **hotel**"); await click("Send"); await settle(() => composer()?.value === "");
  expect(posts).toEqual([{shareId, channelWireId, id: expect.any(String), body: "Booked the **hotel**", authorKind: "human"}]);
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

it("keeps the reader on the same message when older history and a new message commit together", async () => {
  let releaseOlder!: () => void;
  const olderPage = new Promise(resolve => {
    releaseOlder = () => resolve({shareId, channelWireId, messages: [9, 8, 7].map(seq => message(seq, `Old ${seq}`)), nextCursor: 10, olderCursor: null});
  });
  server({history: before => before === null
    ? {shareId, channelWireId, messages: [14, 13, 12, 11, 10].map(seq => message(seq, `Message ${seq}`)), nextCursor: 20, olderCursor: 10}
    : olderPage});
  await render(); await settle(() => text().includes("Message 14") && follows.length > 0);
  // jsdom has no layout: each message is 100px tall below a 40px row for "Load earlier messages", in a 300px scroller.
  const node = container.querySelector<HTMLElement>(".chat-scroller")!;
  const head = () => node.querySelector(".chat-older") ? 40 : 0, content = () => head() + node.querySelectorAll(".chat-message").length * 100;
  let scrollTop = 0;
  Object.defineProperties(node, {scrollHeight: {configurable: true, get: content}, clientHeight: {configurable: true, get: () => 300},
    scrollTop: {configurable: true, get: () => scrollTop, set: (value: number) => {scrollTop = Math.max(0, Math.min(value, content() - 300));}}});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = [...node.querySelectorAll(".chat-message")].indexOf(this);
    if (index < 0) return {top: 0, bottom: 300} as DOMRect;
    const top = head() + index * 100 - scrollTop;
    return {top, bottom: top + 100} as DOMRect;
  });
  const offset = (seq: number) => container.querySelector(`[data-seq="${seq}"]`)!.getBoundingClientRect().top;
  await act(async () => node.dispatchEvent(new Event("scroll")));
  expect(offset(10)).toBe(40);
  await click("Load earlier messages");
  await act(async () => {
    releaseOlder();
    follows.at(-1)!.answer({shareId, channelWireId, messages: [message(21, "New")], nextCursor: 21, hasMore: false});
    // Updates inside one act commit together when it ends.
    for (let turn = 0; turn < 100 && follows.length < 2; turn += 1) await Promise.resolve();
  });
  expect(text()).toContain("Old 7"); expect(text()).toContain("New");
  expect(offset(10)).toBe(40);
  expect(button("1 new message")).toBeDefined();
});

it("reads past empty history pages and shows an empty channel once nothing older remains", async () => {
  const fetch = server({history: before => ({shareId, channelWireId, messages: [], nextCursor: before === null ? 30 : 0,
    olderCursor: before === null ? 4000 : before === "4000" ? 2000 : null})});
  await render(); await settle(() => text().includes("No messages in this channel yet.") && follows.length > 0);
  expect(button("Load earlier messages")).toBeUndefined();
  expect(historyReads(fetch)).toEqual([null, "4000", "2000"]);
  expect(follows.at(-1)!.since).toBe("30");
});

it("loads earlier messages past empty pages in one click", async () => {
  const fetch = server({history: before => before === null
    ? {shareId, channelWireId, messages: [message(5000, "Newest")], nextCursor: 5001, olderCursor: 5000}
    : before === "5000" ? {shareId, channelWireId, messages: [], nextCursor: 0, olderCursor: 3000}
    : {shareId, channelWireId, messages: [message(3, "Oldest")], nextCursor: 0, olderCursor: null}});
  await render(); await settle(() => text().includes("Newest") && follows.length > 0);
  await click("Load earlier messages"); await settle(() => text().includes("Oldest"));
  expect(button("Load earlier messages")).toBeUndefined();
  expect(historyReads(fetch)).toEqual([null, "5000", "3000"]);
});

it("stops after a bounded run of empty pages and offers to keep reading", async () => {
  const fetch = server({history: () => ({shareId, channelWireId, messages: [], nextCursor: 30, olderCursor: 1})});
  await render(); await settle(() => Boolean(button("Load earlier messages")) && follows.length > 0);
  expect(historyReads(fetch)).toHaveLength(CHAT_EMPTY_PAGE_LIMIT);
  expect(text()).not.toContain("No messages in this channel yet.");
});

it("shows a message whose time is outside the date range without a time, and keeps following", async () => {
  server({history: () => ({shareId, channelWireId, nextCursor: 10, olderCursor: null,
    messages: [{...message(2, "Second"), createdAtMs: Number.MAX_SAFE_INTEGER}, message(1, "First")]})});
  await render(); await opened();
  expect([...container.querySelectorAll(".chat-body")].map(node => node.textContent?.trim())).toEqual(["First", "Second"]);
  expect(container.querySelectorAll(".chat-message time")).toHaveLength(1);
  expect(follows.at(-1)!.since).toBe("10");
});

it("shows a message too long for the browser, and keeps paging and following past it", async () => {
  server({history: before => before === null
    ? {shareId, channelWireId, messages: [message(5, "Newest"), tooLarge(4)], nextCursor: 20, olderCursor: 4}
    : {shareId, channelWireId, messages: [message(3, "Oldest")], nextCursor: 3, olderCursor: null}});
  await render(); await settle(() => text().includes("Newest") && follows.length > 0);
  const bodies = () => [...container.querySelectorAll(".chat-body")].map(node => node.textContent?.trim());
  expect(bodies()).toEqual(["This message is too long to show in the browser.", "Newest"]);
  await click("Load earlier messages"); await settle(() => text().includes("Oldest"));
  await act(async () => follows.at(-1)!.answer({shareId, channelWireId, messages: [tooLarge(21), message(22, "After")], nextCursor: 22, hasMore: false}));
  await settle(() => text().includes("After") && follows.length === 2);
  expect(bodies()).toEqual(["Oldest", "This message is too long to show in the browser.", "Newest",
    "This message is too long to show in the browser.", "After"]);
  expect(follows.at(-1)!.since).toBe("22");
});

it("waits quietly while the account has its maximum of open follows, then resumes from the same cursor", async () => {
  server(); await render(); await opened();
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
  try {
    await act(async () => follows.at(-1)!.answer({ok: false, error: "too many follow requests", code: "share_access_rate_limited"}, 429));
    // Advance until the backoff timer exists and fires the next follow.
    await settle(() => {vi.advanceTimersByTime(1_000); return follows.length === 2;});
    expect(follows.at(-1)!.since).toBe("10");
    expect(container.querySelector(".chat-follow-status")).toBeNull();
    await act(async () => follows.at(-1)!.answer({shareId, channelWireId, messages: [message(11, "Third")], nextCursor: 11, hasMore: false}));
    await settle(() => text().includes("Third") && follows.length === 3);
    expect(follows.at(-1)!.since).toBe("11");
  } finally {vi.useRealTimers();}
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

it("checks the advertised post budget including author fields and JSON escaping", async () => {
  server({maxPostBytes: 400}); await render(); await opened();
  await type('"'.repeat(150));
  expect(button("Send")?.disabled).toBe(true);
  expect(status()).toContain("too long");
  expect(posts).toHaveLength(0);
  await type("x".repeat(150));
  expect(button("Send")?.disabled).toBe(false);
  await click("Send"); await settle(() => composer()?.value === "");
  expect(posts).toHaveLength(1);
});

it("shows the account owner beside an agent's name", async () => {
  server({history: () => ({shareId, channelWireId, nextCursor: 10, olderCursor: null,
    messages: [{...message(2, "Second", "Planner"), authorKind: "agent", authorOwnerDisplayName: "Alice"}]})});
  await render(); await opened();
  expect(container.querySelector(".chat-author")?.textContent).toBe("Planner");
  expect(container.querySelector(".chat-owner")?.textContent).toBe("Owned by Alice");
});

it("marks a link holder's post as a link holder, even under an account's name", async () => {
  server({history: () => ({shareId, channelWireId, nextCursor: 10, olderCursor: null,
    messages: [{...message(2, "Second", "Alice"), authorUserId: null, authorKind: "link"}, message(1, "First")]})});
  await render(); await opened();
  const [link, person] = [...container.querySelectorAll<HTMLElement>(".chat-message")].reverse();
  expect(link?.dataset.authorKind).toBe("link");
  expect(link?.querySelector(".chat-author")?.textContent).toBe("Alice");
  expect(link?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Link holder");
  expect(link?.querySelector(".chat-agent-mark")).toBeNull();
  expect(person?.querySelector('[role="img"]')).toBeNull();
});

it("refuses a page whose link post names an account", async () => {
  server({history: () => ({shareId, channelWireId, nextCursor: 10, olderCursor: null,
    messages: [{...message(2, "Second", "Alice"), authorKind: "link"}]})});
  await render(); await settle(() => text().includes("Messages didn't load."));
  expect(container.querySelector(".chat-message")).toBeNull();
});

it("returns to sign-in when a post reports the account cookie is missing", async () => {
  server({post: () => jsonResponse({ok: false, error: "signed out", code: "signed_out"}, 401)});
  await render(); await opened(); await type("Draft"); await click("Send");
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(button("Sign out")).toBeUndefined();
  expect(text()).toContain("Your session ended. Sign in again to keep reading.");
  expect(follows.every(follow => follow.signal.aborted)).toBe(true);
});

it("offers Try again when the first account check fails and opens the channel after retry", async () => {
  const fetch = server();
  fetch.mockRejectedValueOnce(new TypeError("connection failed"));
  await render(); await settle(() => Boolean(container.querySelector('[role="alert"]')));
  expect(text()).toContain("Sign in to chat");
  expect(text()).toContain("Try again");
  await click("Try again"); await opened();
  expect(fetch.mock.calls.filter(([input]) => String(input) === "/api/account/session")).toHaveLength(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

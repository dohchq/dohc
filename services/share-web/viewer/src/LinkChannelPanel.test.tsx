// @vitest-environment jsdom
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {LinkChannelPanel} from "./LinkChannelPanel";
import {jsonResponse, settle, setControlValue} from "./testing";

const message = (relaySeq: number, body: string, author = "Ada", authorKind = "human") => ({relaySeq, messageId: `m${relaySeq}`, threadId: `t${relaySeq}`,
  authorDisplayName: author, authorKind, authorOwnerDisplayName: null, createdAtMs: relaySeq * 1000, body, bodyTooLarge: false});

let container: HTMLDivElement, root: Root, posts: Array<{headers: Headers; body: Record<string, unknown>}>;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true}); posts = [];
  Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "visible"});
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

const unavailable = () => jsonResponse({ok: false, error: "This link can't be reached right now. Try again in a moment.", code: "link_unavailable"}, 503);

function server(options: {access?: "read-only" | "read-write"; profileName?: string; channels?: (attempt: number) => Promise<Response> | undefined;
  post?: (body: Record<string, unknown>, attempt: number) => Response | undefined} = {}) {
  let channelReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://viewer.test"), signal = init?.signal ?? new AbortController().signal;
    if (url.pathname === "/api/view/chat/channels") return await options.channels?.(channelReads++) ?? jsonResponse({shareId: "share",
      profileName: options.profileName ?? null, channels: [{channelWireId: "wire", name: "Team", access: options.access ?? "read-write"}]});
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push({headers: new Headers(init.headers), body});
      return options.post?.(body, posts.length - 1) ?? jsonResponse({shareId: "share", channelWireId: "wire",
        message: message(9, String(body.body), typeof body.claimedName === "string" ? body.claimedName : "Anonymous", "link")});
    }
    if (url.searchParams.has("since")) return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
    });
    return jsonResponse({shareId: "share", channelWireId: "wire", messages: [message(2, "Welcome")], nextCursor: 3, olderCursor: null});
  }));
}

const text = () => container.textContent ?? "";
const composer = () => container.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
const nameField = () => container.querySelector<HTMLInputElement>('input[name="claimedName"]');
const send = () => [...container.querySelectorAll("button")].find(node => node.textContent === "Send")!;
const tryAgain = () => [...container.querySelectorAll("button")].find(node => node.textContent === "Try again");
async function render(channelWireId: string | null = "wire") {
  await act(async () => root.render(<LinkChannelPanel session="session-a" channelWireId={channelWireId} fallback={<p>Discussion</p>}/>));
}
async function opened() {await settle(() => text().includes("Welcome"));}

it("posts from a read-write link with the name it sets once, and marks the post as a link holder's", async () => {
  server(); await render(); await opened();
  expect(container.querySelector("h2")?.textContent).toBe("Team");
  setControlValue(nameField()!, "Sam"); setControlValue(composer()!, "Count me in");
  await act(async () => send().click()); await settle(() => composer()?.value === "");
  expect(posts[0]?.body).toEqual({channelWireId: "wire", body: "Count me in", idempotencyKey: expect.any(String), claimedName: "Sam"});
  expect(posts[0]?.headers.get("x-dohc-link-session")).toBe("session-a");
  const posted = [...container.querySelectorAll<HTMLElement>(".chat-message")].at(-1);
  expect(posted?.dataset.authorKind).toBe("link");
  expect(posted?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Link holder");
  // The name is set; it shows in place of the field, and the next post sends none.
  expect(nameField()).toBeNull();
  expect(text()).toContain("Posting as Sam");
  setControlValue(composer()!, "And again"); await act(async () => send().click()); await settle(() => posts.length === 2 && composer()?.value === "");
  expect(posts[1]?.body).not.toHaveProperty("claimedName");
});

it("shows the name this browser set on an earlier visit, with no field to change it", async () => {
  server({profileName: "Sam"}); await render(); await opened();
  expect(nameField()).toBeNull();
  expect(text()).toContain("Posting as Sam");
  setControlValue(composer()!, "Back again"); await act(async () => send().click()); await settle(() => composer()?.value === "");
  expect(posts[0]?.body).not.toHaveProperty("claimedName");
});

it("shows the name another tab set first in place of the field, and the next post sends none", async () => {
  const already = "This link holder already has a name. Post with that name, or with none.";
  server({
    channels: attempt => attempt === 0 ? undefined : Promise.resolve(jsonResponse({shareId: "share", profileName: "Sam",
      channels: [{channelWireId: "wire", name: "Team", access: "read-write"}]})),
    post: (_body, attempt) => attempt === 0 ? jsonResponse({ok: false, code: "link_name_already_set", error: already}, 409) : undefined,
  });
  await render(); await opened();
  setControlValue(nameField()!, "Alex"); setControlValue(composer()!, "Count me in"); await act(async () => send().click());
  await settle(() => text().includes("Posting as Sam"));
  expect(nameField()).toBeNull();
  expect(text()).toContain(already);
  expect(composer()?.value).toBe("Count me in");
  await act(async () => send().click()); await settle(() => composer()?.value === "");
  expect(posts[1]?.body).not.toHaveProperty("claimedName");
});

it("keeps the draft when a post's answer is lost, and its Try again sends the same post", async () => {
  server({post: (_body, attempt) => attempt === 0 ? unavailable() : undefined});
  await render(); await opened(); setControlValue(composer()!, "Count me in"); await act(async () => send().click());
  await settle(() => text().includes("dohc could not confirm that your message was sent. Try again. It will not post twice."));
  expect(composer()?.value).toBe("Count me in");
  expect(container.querySelector(".chat-channel")).not.toBeNull();
  await act(async () => tryAgain()!.click()); await settle(() => composer()?.value === "");
  expect(posts.map(post => post.body.idempotencyKey)).toEqual([posts[0]?.body.idempotencyKey, posts[0]?.body.idempotencyKey]);
});

it("says why the relay refused a post, in words, and offers Try again only for a pause", async () => {
  const paused = "The owner paused posts from share links. Try again later.";
  const blocked = "The owner stopped this link holder from posting. Ask the owner to allow your posts again.";
  server({post: (_body, attempt) => attempt === 0 ? jsonResponse({ok: false, code: "link_discussion_paused", error: paused}, 403)
    : jsonResponse({ok: false, code: "link_discussion_blocked", error: blocked}, 403)});
  await render(); await opened(); setControlValue(composer()!, "Hi"); await act(async () => send().click());
  await settle(() => text().includes(paused));
  expect(composer()?.value).toBe("Hi");
  expect(tryAgain()).toBeDefined();
  await act(async () => tryAgain()!.click()); await settle(() => text().includes(blocked));
  expect(composer()?.value).toBe("Hi");
  expect(tryAgain()).toBeUndefined();
});

it("holds a post until a name that is too long is shortened", async () => {
  server(); await render(); await opened();
  setControlValue(nameField()!, "x".repeat(41)); setControlValue(composer()!, "Hi");
  expect(send().disabled).toBe(true);
  expect(text()).toContain("Use a name of up to 40 characters.");
  setControlValue(nameField()!, "Sam");
  expect(send().disabled).toBe(false);
});

it("lets a read-only link read the channel without a composer", async () => {
  server({access: "read-only"}); await render(); await opened();
  expect(composer()).toBeNull();
  expect(text()).toContain("You can read this channel but not post. The owner gave you read-only access.");
});

it("switches to read only when the relay refuses a post as a View link", async () => {
  server({post: () => jsonResponse({ok: false, error: "This link gives View access. Ask the owner for a link with the access you need.", code: "link_view_access"}, 403)});
  await render(); await opened(); setControlValue(composer()!, "Hi"); await act(async () => send().click());
  await settle(() => text().includes("You can read this channel but not post."));
  expect(composer()).toBeNull();
});

it("ends the channel when a revoked link's post is refused", async () => {
  server({post: () => jsonResponse({ok: false, error: "not found"}, 404)});
  await render(); await opened(); setControlValue(composer()!, "Hi"); await act(async () => send().click());
  await settle(() => text().includes("This link no longer opens this channel. Ask the owner for a new link."));
  expect(container.querySelector(".chat-channel")).toBeNull();
});

it("shows the link's other panel at once when the share's answer names no channel", async () => {
  server(); await render(null);
  expect(text()).toBe("Discussion");
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps the channel's place while it loads and through a failed read, then opens it after Try again", async () => {
  let answer: (response: Response) => void = () => {};
  server({channels: attempt => attempt === 0 ? new Promise<Response>(resolve => {answer = resolve;}) : undefined});
  await render();
  expect(text()).toContain("Loading messages…");
  await act(async () => answer(unavailable()));
  await settle(() => text().includes("Messages didn't load."));
  expect(text()).not.toContain("Discussion");
  await act(async () => tryAgain()!.click()); await opened();
  expect(container.querySelector("h2")?.textContent).toBe("Team");
});

it("ends the channel when the link no longer opens it", async () => {
  server({channels: async () => jsonResponse({ok: false, error: "not found"}, 404)}); await render();
  await settle(() => text().includes("This link no longer opens this channel. Ask the owner for a new link."));
  expect(text()).not.toContain("Discussion");
});

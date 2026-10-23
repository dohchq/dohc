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

function server(options: {access?: "read-only" | "read-write"; channel?: boolean; post?: (body: Record<string, unknown>) => Response} = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://viewer.test"), signal = init?.signal ?? new AbortController().signal;
    if (url.pathname === "/api/view/chat/channels") return options.channel === false ? jsonResponse({ok: false, error: "not found"}, 404)
      : jsonResponse({shareId: "share", channels: [{channelWireId: "wire", name: "Team", access: options.access ?? "read-write"}]});
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push({headers: new Headers(init.headers), body});
      return options.post?.(body) ?? jsonResponse({shareId: "share", channelWireId: "wire",
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
async function render() {await act(async () => root.render(<LinkChannelPanel session="session-a" fallback={<p>Discussion</p>}/>));}
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
  // The name is set; the next post sends none.
  expect(nameField()).toBeNull();
  setControlValue(composer()!, "And again"); await act(async () => send().click()); await settle(() => posts.length === 2 && composer()?.value === "");
  expect(posts[1]?.body).not.toHaveProperty("claimedName");
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

it("shows the link's other panel when the link has no channel", async () => {
  server({channel: false}); await render();
  await settle(() => text() === "Discussion");
  expect(container.querySelector(".link-channel")).toBeNull();
});

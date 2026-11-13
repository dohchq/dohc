// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {createGroupFollow, followMemberGroups, memberSession, openMemberGroups} from "./memberWorkspace";
import {NamedChatError, type NamedChatChannel} from "./namedChat";
import {jsonResponse} from "./testing";

// A member's workspace page reads the workspace through the grant: its Groups,
// and one follow for all of them.

const message = (relaySeq: number, body: string, author = "ana") => ({relaySeq, messageId: `m${relaySeq}`, threadId: `t${relaySeq}`,
  authorUserId: author, authorDisplayName: author, authorKind: "human", authorOwnerDisplayName: null, createdAtMs: 1000, body, bodyTooLarge: false});
let visibility: DocumentVisibilityState;
beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {configurable: true, get: () => visibility});
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

it("names the grant as the session the view routes read", () => {
  expect(memberSession("grant-1")).toBe("member.grant-1");
});

it("opens every Group the member reaches, each with its own access", async () => {
  const fetch = vi.fn(async () => jsonResponse({shareId: "share", userId: "sam", maxPostBytes: 9000, maxBodyBytes: 8000, channels: [
    {channelWireId: "wire-plans", name: "plans", kind: "channel", access: "read-write"},
    {channelWireId: "wire-food", name: "food", kind: "channel", access: "read-only"}]}));
  vi.stubGlobal("fetch", fetch);
  const opened = await openMemberGroups("grant-1", new AbortController().signal);
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe("/api/named-chat/channels?grantId=grant-1");
  expect(opened).toEqual({shareId: "share", userId: "sam", maxPostBytes: 9000, maxBodyBytes: 8000, groups: [
    {shareId: "share", userId: "sam", channelWireId: "wire-plans", name: "plans", access: "read-write", maxPostBytes: 9000, maxBodyBytes: 8000},
    {shareId: "share", userId: "sam", channelWireId: "wire-food", name: "food", access: "read-only", maxPostBytes: 9000, maxBodyBytes: 8000}]});
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({shareId: "share", userId: "sam", maxPostBytes: 9000, maxBodyBytes: 8000,
    channels: [{channelWireId: "wire-plans", name: "plans", kind: "channel", access: "owner"}]})));
  await expect(openMemberGroups("grant-1", new AbortController().signal)).rejects.toBeInstanceOf(NamedChatError);
});

it("follows every Group in one request, each message naming its Group", async () => {
  const fetch = vi.fn(async () => jsonResponse({shareId: "share", nextCursor: 12, hasMore: false,
    messages: [{...message(11, "Bring snacks"), channelWireId: "wire-food"}]}));
  vi.stubGlobal("fetch", fetch);
  const page = await followMemberGroups("share", 10, 30_000, new AbortController().signal);
  const url = new URL(String((fetch.mock.calls[0] as unknown[])[0]), "https://viewer.test");
  expect(url.pathname).toBe("/api/named-chat/messages");
  expect(Object.fromEntries(url.searchParams)).toEqual({shareId: "share", since: "10", hold: "30000", limit: "50"});
  expect(page).toEqual({nextCursor: 12, hasMore: false, messages: [{channelWireId: "wire-food", message: expect.objectContaining({relaySeq: 11, body: "Bring snacks"})}]});
});

const group = (channelWireId: string): NamedChatChannel => ({shareId: "share", userId: "sam", channelWireId, name: channelWireId,
  access: "read-write", maxPostBytes: 9000, maxBodyBytes: 8000});
type Held = {since: number; signal: AbortSignal; answer(messages: Array<[string, number, string?]>, nextCursor: number): void; fail(error: unknown): void};
function heldFollows() {
  const held: Held[] = [];
  const follow = vi.fn((_shareId: string, since: number, _hold: number, signal: AbortSignal) => new Promise<Awaited<ReturnType<typeof followMemberGroups>>>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
    const item: Held = {since, signal, fail: error => {held.splice(held.indexOf(item), 1); reject(error);}, answer: (messages, nextCursor) => {
      held.splice(held.indexOf(item), 1);
      resolve({nextCursor, hasMore: false, messages: messages.map(([channelWireId, seq, author]) =>
        ({channelWireId, message: {...message(seq, `m${seq}`, author), linkAgent: false} as never}))});
    }};
    held.push(item);
  }));
  return {follow, open: () => held.filter(item => !item.signal.aborted)};
}

it("serves each open Group from one follow, and counts others' messages in every Group", async () => {
  const {follow, open} = heldFollows(), counted: Array<Record<string, number>> = [];
  const hub = createGroupFollow({shareId: "share", userId: "sam", follow, onMessages: counts => counted.push(Object.fromEntries(counts)), onEnded: vi.fn()});
  const signal = new AbortController().signal;
  const plans = hub.client(group("wire-plans")), food = hub.client(group("wire-food"));
  const first = plans.follow(10, 30_000, signal);
  await vi.waitFor(() => expect(open()).toHaveLength(1));
  expect(open()[0]!.since).toBe(10);
  open()[0]!.answer([["wire-food", 11], ["wire-plans", 12], ["wire-food", 13, "sam"]], 14);
  expect(await first).toEqual({nextCursor: 14, hasMore: false, messages: [expect.objectContaining({relaySeq: 12})]});
  expect(counted).toEqual([{"wire-food": 1, "wire-plans": 1}]);
  // Another Group opened later reads what arrived since its own history, without another request.
  expect(await food.follow(10, 30_000, signal)).toEqual({nextCursor: 14, hasMore: false,
    messages: [expect.objectContaining({relaySeq: 11}), expect.objectContaining({relaySeq: 13})]});
  await vi.waitFor(() => expect(open()).toHaveLength(1));
  expect(open()[0]!.since).toBe(14);
  expect(follow).toHaveBeenCalledTimes(2);
  // A Group that is current waits for the next page.
  const waiting = plans.follow(14, 30_000, signal);
  open()[0]!.answer([["wire-plans", 15]], 16);
  expect((await waiting).messages.map(item => item.relaySeq)).toEqual([15]);
  hub.close();
});

it("ends every Group when the member is removed, and pauses while the tab is hidden", async () => {
  const {follow, open} = heldFollows(), onEnded = vi.fn();
  const hub = createGroupFollow({shareId: "share", userId: "sam", follow, onMessages: vi.fn(), onEnded});
  const signal = new AbortController().signal;
  const reading = hub.client(group("wire-plans")).follow(10, 30_000, signal);
  await vi.waitFor(() => expect(open()).toHaveLength(1));
  visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  expect(open()).toHaveLength(0);
  visibility = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(open()).toHaveLength(1));
  open()[0]!.fail(new NamedChatError(404, "share_access_removed"));
  await expect(reading).rejects.toMatchObject({status: 404});
  expect(onEnded).toHaveBeenCalledWith("removed");
  hub.close();
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment, markdownToYDoc } from "@dohc/ydoc-projection";
import type { NamedLiveBrowserState } from "@dohc/ydoc-projection/named-live-browser-transport";
import WorkspaceApp from "./WorkspaceApp";
import type { WorkspaceTarget } from "./workspaceTarget";
import { memberDocument, memberPageReady, openMemberPage } from "./memberLive";
import "./MemberLivePage";
import { jsonResponse, setControlValue, settle } from "./testing";
import { readDraft, writeDraft } from "./drafts";
import { linkRefusalBody } from "@dohc/security-contract/link-refusal";

// A workspace member's page in a browser: the workspace's files, a page, and
// its Groups, at the member's level, and what it says when that ends.

vi.mock("./memberLive", () => ({
  openMemberPage: vi.fn(),
  memberPageReady: vi.fn(),
  memberDocument: vi.fn(),
}));

type Level = "view" | "comment" | "edit";
const GRANT = "grant-1",
  SESSION = `member.${GRANT}`;
const FILES = [
  {
    path: "trip/plan.md",
    objectId: `share-object:v1:${"1".repeat(64)}`,
    blobSha256: "a".repeat(64),
    contentKind: "text",
  },
  {
    path: "trip/to-pack.md",
    objectId: `share-object:v1:${"2".repeat(64)}`,
    blobSha256: "b".repeat(64),
    contentKind: "text",
  },
  {
    path: "welcome/readme.md",
    objectId: `share-object:v1:${"3".repeat(64)}`,
    blobSha256: "c".repeat(64),
    contentKind: "text",
  },
];
const TEXT: Record<string, string> = {
  ["a".repeat(64)]: "Leave at nine.",
  ["b".repeat(64)]: "Fuel and food.",
  ["c".repeat(64)]: "Welcome.",
};
// A post's later messages pass `startsPost: false`; the relay marks only the message that starts a post.
const chat = (
  relaySeq: number,
  body: string,
  author = "ana",
  thread: {
    threadId?: string;
    lane?: "posts" | "chat";
    parentMessageId?: string | null;
    startsPost?: boolean;
  } = {},
) => ({
  relaySeq,
  messageId: `m${relaySeq}`,
  threadId: thread.threadId ?? `t${relaySeq}`,
  authorUserId: author,
  authorDisplayName: author === "ana" ? "Ana" : "Sam",
  authorKind: "human",
  linkAgent: false,
  authorOwnerDisplayName: null,
  createdAtMs: relaySeq * 1000,
  body,
  bodyTooLarge: false,
  lane: thread.lane ?? "posts",
  parentMessageId: thread.parentMessageId ?? null,
  startsPost: thread.startsPost ?? (thread.lane ?? "posts") === "posts",
});
type Held = {
  path: string;
  url: URL;
  signal: AbortSignal;
  // What the server would have answered when the request arrived.
  body?: unknown;
  answer(value: unknown, status?: number): void;
};

let container: HTMLDivElement,
  root: Root,
  held: Held[],
  posts: Record<string, unknown>[],
  narrow: boolean;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  held = [];
  posts = [];
  narrow = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width") ? narrow : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  // jsdom has no layout, so nothing resizes.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
});
afterEach(async () => {
  try {
    sessionStorage.clear();
  } catch {
    /* A test blocks storage. */
  }
  // A new tab starts with no kept edits, including those the page held in memory.
  writeDraft("unsent-edits", "");
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function server(
  options: {
    level?: Level;
    // A folder rule's level on a file, where it differs from the member level.
    fileLevels?: Record<string, Level>;
    levelChangedBy?: string;
    signedIn?: boolean;
    // The account's session ended while the page was open.
    expired?: boolean;
    groups?: Array<{ wire: string; name: string; type?: "posts" | "chat" | "both" }>;
    // A Group rule's level, where it differs from the member level. "none" hides the Group.
    groupRules?: Record<string, "read-only" | "read-write" | "none">;
    files?: typeof FILES;
    member?: boolean;
    groupsFail?: number;
    history?: Record<string, unknown[]>;
    older?: Record<string, unknown[]>;
    postFails?: { status: number; code: string };
    moderates?: boolean;
    deleteFails?: number;
    openHeld?: boolean;
    // Holds a read of the log that asks for no wait too, so a test can see what each read asked for.
    holdLogs?: boolean;
    user?: string;
    signOutFails?: boolean;
    // The only account the grant belongs to. Another account's reads are refused.
    memberOf?: string;
    // The read that catches an Edit member's files up to the log fails, as if the log moved on.
    catchUpFails?: boolean;
    // The workspace holds more files than a browser lists.
    tooLarge?: boolean;
    // The relay refuses the file list, as it does past its scan cap, while the grant still opens.
    currentRefused?: boolean;
    // The file list fails to arrive, as on a lost connection.
    currentUnreachable?: boolean;
    // The grant answers this many more reads, then loses its connection.
    metaAnswers?: number;
    // The account's session cannot be checked.
    sessionFails?: boolean;
    // How many reads of the Groups wait for the test to answer them.
    holdGroups?: number;
    // The relay refuses the Groups while the workspace still opens.
    groupsGone?: boolean;
    // The view session the page must send, where it is not the member's.
    session?: string;
    // The account's workspaces, and how many reads of them fail first.
    workspaces?: unknown;
    workspacesFail?: number;
    // The page's chat key, where it is not a grant's, as the owner's `owner:<workspace>`.
    shareId?: string;
    // Each wake read's answer, in turn. The last one repeats.
    wakes?: unknown[][];
  } = {},
) {
  let signedIn = options.signedIn ?? true,
    groupsFail = options.groupsFail ?? 0,
    deleteFails = options.deleteFails ?? 0,
    holdGroups = options.holdGroups ?? 0,
    workspacesFail = options.workspacesFail ?? 0;
  // A test can change the level, the rules or the files while the page is open; the next read carries them.
  const files = () =>
    (options.files ?? FILES).map((file) => ({
      ...file,
      access: options.fileLevels?.[file.path] ?? levelNow(),
    }));
  const levelNow = () => options.level ?? "comment";
  // The relay's keyed signature of the member's reach: it changes with the level or a rule.
  const reach = () =>
    JSON.stringify([levelNow(), options.fileLevels ?? {}, options.groupRules ?? {}]);
  const access = () => (levelNow() === "view" ? "read-only" : "read-write");
  // A test can add a Group, or sign in as another account, while the page is open.
  const groups = () =>
    (
      options.groups ?? [
        { wire: "wire-plans", name: "plans" },
        { wire: "wire-food", name: "food" },
      ]
    ).filter((group) => options.groupRules?.[group.wire] !== "none");
  const user = () => options.user ?? "sam";
  const meta = () => ({
    ok: true,
    effectiveSelector: { paths: [], versionId: null, wholeWorkspace: true },
    access: levelNow(),
    reach: reach(),
    subjectName: "Trip",
    lastSettledAtMs: Date.now(),
    lastSettledKnown: true,
    ...(options.levelChangedBy ? { levelChangedBy: options.levelChangedBy } : {}),
  });
  const hold = (path: string, url: URL, signal: AbortSignal, body?: unknown) =>
    new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
      const item: Held = {
        path,
        url,
        signal,
        body,
        answer: (value, status = 200) => {
          held.splice(held.indexOf(item), 1);
          // A chat follow page always lists the messages deleted since its cursor.
          const page =
            (path === "chat" || path === "comments") && status === 200
              ? { deleted: [], ...(value as object) }
              : value;
          resolve(jsonResponse(page, status));
        },
      };
      held.push(item);
    });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://share.test"),
      signal = init?.signal ?? new AbortController().signal;
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/account/session" && options.sessionFails)
      throw new TypeError("Failed to fetch");
    if (url.pathname === "/api/account/session")
      return jsonResponse({
        user:
          signedIn && !options.expired
            ? { id: user(), name: user() === "sam" ? "Sam Rivera" : "Lee Park" }
            : null,
      });
    if (url.pathname === "/api/account/sign-in") {
      signedIn = true;
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/api/account/sign-out") {
      if (options.signOutFails) return jsonResponse({ ok: false, error: "internal" }, 500);
      signedIn = false;
      return jsonResponse({ ok: true });
    }
    if (url.pathname === "/api/workspaces") {
      if (!signedIn) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      if (workspacesFail > 0) {
        workspacesFail -= 1;
        return jsonResponse({ ok: false, error: "unavailable" }, 503);
      }
      return jsonResponse(options.workspaces ?? { ok: true, owned: [], joined: [] });
    }
    // share-web gives an account that holds no membership the answer it gives an unknown grant.
    if (
      (options.member === false ||
        options.expired ||
        (options.memberOf !== undefined && options.memberOf !== user())) &&
      (url.pathname.startsWith("/api/view/") || url.pathname.startsWith("/api/named-chat/"))
    )
      return jsonResponse({ ok: false, error: "not found" }, 404);
    if (url.pathname.startsWith("/api/view/")) {
      expect(headers.get("x-dohc-link-session") ?? url.searchParams.get("session")).toBe(
        options.session ?? SESSION,
      );
      if (url.pathname === "/api/view/current" && options.openHeld)
        return hold("current", url, signal);
      if (url.pathname === "/api/view/current" && options.tooLarge)
        return jsonResponse(linkRefusalBody("link_too_many_files"), 413);
      if (url.pathname === "/api/view/current" && options.currentRefused)
        return jsonResponse({ ok: false, error: "not found" }, 404);
      if (url.pathname === "/api/view/current" && options.currentUnreachable)
        throw new TypeError("Failed to fetch");
      if (url.pathname === "/api/view/current")
        return jsonResponse({ ...meta(), files: files(), nextCursor: 7, epochLogFloor: 0 });
      if (url.pathname === "/api/view/meta") {
        if (options.metaAnswers !== undefined && options.metaAnswers-- <= 0)
          throw new TypeError("Failed to fetch");
        return jsonResponse(meta());
      }
      if (url.pathname === "/api/view/log")
        return url.searchParams.has("hold") || options.holdLogs
          ? hold("log", url, signal)
          : options.catchUpFails
            ? jsonResponse({ ok: false, error: "not found" }, 404)
            : jsonResponse({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 });
      const sha = url.pathname.slice("/api/view/blob/".length);
      return new Response(TEXT[sha] ?? "", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/api/named-chat/channels" && options.groupsGone)
      return jsonResponse({ ok: false, error: "not found" }, 404);
    if (url.pathname === "/api/named-chat/channels" && groupsFail > 0) {
      groupsFail -= 1;
      return jsonResponse({ ok: false, error: "unavailable" }, 503);
    }
    const listing = () => ({
      shareId: options.shareId ?? "share",
      userId: user(),
      maxPostBytes: 9000,
      maxBodyBytes: 8000,
      moderates: options.moderates ?? false,
      channels: groups().map((group) => ({
        channelWireId: group.wire,
        name: group.name,
        kind: "channel",
        type: group.type ?? "both",
        access: options.groupRules?.[group.wire] ?? access(),
      })),
    });
    if (url.pathname === "/api/named-chat/channels" && holdGroups > 0) {
      holdGroups -= 1;
      return hold("groups", url, signal, listing());
    }
    if (url.pathname === "/api/named-chat/channels") return jsonResponse(listing());
    if (url.pathname === "/api/named-chat/wakes") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ wakes: body });
      const answers = options.wakes ?? [[]];
      return jsonResponse({
        shareId: body.shareId,
        channelWireId: body.channelWireId,
        messageId: body.messageId,
        wakes: answers.length > 1 ? answers.shift() : answers[0],
      });
    }
    if (url.pathname === "/api/named-chat/messages/delete") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ deleted: body });
      if (deleteFails > 0) {
        deleteFails -= 1;
        return jsonResponse({ ok: false, error: "not found" }, 404);
      }
      return jsonResponse({
        shareId: options.shareId ?? "share",
        deleted: { messageId: body.messageId, threadId: body.threadId, deletedAtMs: 50_000 },
      });
    }
    // The relay answers 404 for a file or Group the member no longer reaches.
    const gone = (place: { path?: unknown; channelWireId?: unknown }) =>
      typeof place.path === "string"
        ? !files().some((file) => file.path === place.path)
        : typeof place.channelWireId === "string" &&
          !groups().some((group) => group.wire === place.channelWireId);
    if (url.pathname === "/api/named-chat/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (gone(body)) return jsonResponse({ ok: false, error: "not found" }, 404);
      if (options.postFails)
        return jsonResponse(
          { ok: false, error: "refused", code: options.postFails.code },
          options.postFails.status,
        );
      const place =
        typeof body.path === "string" ? { path: body.path } : { channelWireId: body.channelWireId };
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined,
        parentMessageId = typeof body.parentMessageId === "string" ? body.parentMessageId : null;
      return jsonResponse({
        shareId: options.shareId ?? "share",
        ...place,
        message: chat(39 + posts.length, String(body.body), "sam", {
          threadId,
          parentMessageId,
          lane: body.lane === "chat" || parentMessageId || threadId === "t-chat" ? "chat" : "posts",
          startsPost: threadId === undefined && body.lane !== "chat",
        }),
      });
    }
    // A file's Comments, by the file's path.
    const path = url.searchParams.get("path");
    if (
      url.pathname === "/api/named-chat/messages" &&
      gone({ path: path ?? undefined, channelWireId: url.searchParams.get("channelWireId") })
    )
      return jsonResponse({ ok: false, error: "not found" }, 404);
    if (url.pathname === "/api/named-chat/messages" && path !== null) {
      if (url.searchParams.has("since")) return hold("comments", url, signal);
      return jsonResponse({
        shareId: options.shareId ?? "share",
        path,
        nextCursor: 30,
        olderCursor: null,
        // The relay keeps Comments on the file's object, so a new file at the same path has none.
        messages: files().some((file) => file.path === path && file.objectId === FILES[0]!.objectId)
          ? [chat(9, "Nine is early")]
          : [],
      });
    }
    if (url.pathname === "/api/named-chat/messages" && url.searchParams.has("since"))
      return hold("chat", url, signal);
    if (url.pathname === "/api/named-chat/messages") {
      const wire = url.searchParams.get("channelWireId") ?? "",
        older = options.older?.[wire];
      // A Group with an older page names its cursor, and that page has none.
      if (url.searchParams.has("before"))
        return jsonResponse({
          shareId: options.shareId ?? "share",
          channelWireId: wire,
          nextCursor: 20,
          olderCursor: null,
          messages: older ?? [],
        });
      return jsonResponse({
        shareId: options.shareId ?? "share",
        channelWireId: wire,
        nextCursor: 20,
        olderCursor: older ? 2 : null,
        messages:
          options.history?.[wire] ??
          (wire === "wire-plans" ? [chat(3, "Plans start here")] : [chat(5, "Bring snacks")]),
      });
    }
    throw Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const text = () => container.textContent ?? "";
const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) =>
  buttons().find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
async function click(label: string) {
  const control = button(label);
  expect(control, label).toBeDefined();
  await act(async () => control!.click());
}
async function render(target: WorkspaceTarget | null = { kind: "member", grantId: GRANT }) {
  await act(async () => root.render(<WorkspaceApp target={target} />));
}
const following = (path: "log" | "chat" | "comments") =>
  held.filter((item) => item.path === path && !item.signal.aborted);
async function opened() {
  await settle(
    () =>
      text().includes("Leave at nine.") &&
      text().includes("Plans start here") &&
      following("chat").length === 1,
  );
}
const groupPanel = () => container.querySelector<HTMLElement>("#workspace-chats")!;
const commentsPanel = () => container.querySelector<HTMLElement>("#workspace-comments")!;

it("asks a signed-out browser to sign in with the invited account, then opens the workspace", async () => {
  server({ signedIn: false });
  await render();
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(container.querySelector(".state-page > .bar-mark")).not.toBeNull();
  expect(container.querySelector(".state-message h1")?.textContent).toBe(
    "Sign in to open this workspace",
  );
  await act(async () => {
    setControlValue(container.querySelector('input[name="email"]')!, "sam@dohc.test");
    setControlValue(container.querySelector('input[name="password"]')!, "secret");
  });
  await click("Sign in");
  await opened();
  expect(container.querySelector(".workspace-name")?.textContent).toBe("Trip");
  expect(text()).toContain("Sam Rivera");
});

it("shows the workspace's tree and a page's settled text at View, and its Groups without a composer", async () => {
  server({ level: "view" });
  await render();
  await opened();
  const tree = container.querySelector('nav[aria-label="Workspace files"]')!;
  expect(
    [...tree.querySelectorAll(".folder span, .file span")].map((node) => node.textContent),
  ).toEqual(["trip", "plan.md", "to-pack.md", "welcome", "readme.md"]);
  expect(container.querySelector(".page-title")?.textContent).toBe("plan");
  expect(container.querySelector(".workspace-page .badge")?.textContent).toBe("View only");
  expect(groupPanel().textContent).toContain("Only people who can comment post here.");
  expect(groupPanel().querySelector('textarea[name="body"]')).toBeNull();
  await act(async () =>
    [...tree.querySelectorAll<HTMLButtonElement>(".file")]
      .find((node) => node.textContent === "to-pack.md")!
      .click(),
  );
  await settle(() => text().includes("Fuel and food."));
  expect(container.querySelector(".file.selected")?.textContent).toBe("to-pack.md");
  expect(vi.mocked(openMemberPage)).not.toHaveBeenCalled();
});

it("follows the member level in an open Group: a raise offers the composer, and a downgrade keeps the draft to copy or discard", async () => {
  const options: { level: Level } = { level: "view" };
  const fetch = server(options);
  await render();
  await opened();
  const composer = () => groupPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]');
  expect(composer()).toBeNull();
  // The owner raised members to Comment. The next read of the workspace carries it, with no reload.
  options.level = "comment";
  // A read that moves the cursor follows again at once.
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 8, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => composer() !== null);
  expect(groupPanel().textContent).not.toContain("Only people who can comment post here.");
  await act(async () => setControlValue(composer()!, "Bring a map"));
  // The owner lowered members to View again.
  options.level = "view";
  await settle(() => following("log").length === 1);
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 9, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => composer() === null);
  expect(groupPanel().textContent).toContain("Only people who can comment post here.");
  expect(
    groupPanel().querySelector<HTMLTextAreaElement>('[aria-label="Your unsent message"]')?.value,
  ).toBe("Bring a map");
  expect(
    [...groupPanel().querySelectorAll(".chat-unsent-actions button")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["Copy", "Discard"]);
  // The open Group stayed mounted: its messages read once. The Groups read once, then again after each level change,
  // because a Group can hold its own level.
  expect(text()).toContain("Plans start here");
  const reads = (path: string) =>
    fetch.mock.calls.filter(
      ([input]) =>
        new URL(String(input), "https://share.test").pathname === path &&
        !new URL(String(input), "https://share.test").searchParams.has("since"),
    ).length;
  expect(reads("/api/named-chat/channels")).toBe(3);
});

it("says in a toast who changed the members' level, in the desktop's words, with no Try again", async () => {
  const options: { level: Level; levelChangedBy?: string } = { level: "comment" };
  server(options);
  await render();
  await opened();
  expect(container.querySelector(".workspace-toast")).toBeNull();
  options.level = "view";
  options.levelChangedBy = "Ana";
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 8, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => container.querySelector(".workspace-toast") !== null);
  const toast = () => container.querySelector<HTMLElement>(".workspace-toast")!;
  expect(toast().textContent).toContain("Ana now lets members view only.");
  expect([...toast().querySelectorAll("button")].map((node) => node.textContent)).not.toContain(
    "Try again",
  );
  // It reports a change, not a failure, so it has nothing to copy.
  expect(toast().querySelector('[aria-label="Copy message"]')).toBeNull();
  options.level = "comment";
  await settle(() => following("log").length === 1);
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 9, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => toast().textContent?.includes("Ana now lets members comment.") === true);
  expect(container.querySelectorAll(".workspace-toast")).toHaveLength(1);
  await act(async () =>
    toast().querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click(),
  );
  expect(container.querySelector(".workspace-toast")).toBeNull();
});

it("moves through the file tree with the arrow keys, folds a folder, and opens a file with Enter", async () => {
  server({ level: "view" });
  await render();
  await opened();
  const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
  expect(tree.getAttribute("aria-label")).toBe("Workspace files");
  const items = () => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const named = (name: string) => items().find((node) => node.textContent === name)!;
  // One item takes Tab: the open file.
  expect(items().filter((node) => node.tabIndex === 0)).toEqual([named("plan.md")]);
  expect(named("plan.md").getAttribute("aria-selected")).toBe("true");
  expect(named("trip").getAttribute("aria-level")).toBe("1");
  expect(named("plan.md").getAttribute("aria-level")).toBe("2");
  const press = async (key: string) =>
    act(async () => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  named("plan.md").focus();
  await press("ArrowDown");
  expect(document.activeElement).toBe(named("to-pack.md"));
  await press("ArrowDown");
  expect(document.activeElement).toBe(named("welcome"));
  await press("ArrowLeft");
  expect(named("welcome").getAttribute("aria-expanded")).toBe("false");
  expect(items().map((node) => node.textContent)).toEqual([
    "trip",
    "plan.md",
    "to-pack.md",
    "welcome",
  ]);
  await press("ArrowRight");
  expect(named("welcome").getAttribute("aria-expanded")).toBe("true");
  await press("ArrowRight");
  expect(document.activeElement).toBe(named("readme.md"));
  await press("ArrowLeft");
  expect(document.activeElement).toBe(named("welcome"));
  await press("Home");
  expect(document.activeElement).toBe(named("trip"));
  await press("End");
  expect(document.activeElement).toBe(named("readme.md"));
  await press("ArrowUp");
  expect(document.activeElement).toBe(named("welcome"));
  await press("ArrowDown");
  await press("Enter");
  await settle(() => text().includes("Welcome."));
  expect(named("readme.md").getAttribute("aria-selected")).toBe("true");
  expect(items().filter((node) => node.tabIndex === 0)).toEqual([named("readme.md")]);
});

it("raises a toast with Try again and copy when the Groups don't load, and keeps one line in their place", async () => {
  server({ groupsFail: 1 });
  await render();
  await settle(
    () => text().includes("Leave at nine.") && groupPanel().querySelector(".load-failed") !== null,
  );
  // The list keeps its heading, as on the desktop.
  expect(groupPanel().querySelector(".chats-head h2")?.textContent).toBe("Groups");
  // One line in their place: the toast's words and Try again in a row. One read lists both, so both say so.
  const row = groupPanel().querySelector<HTMLElement>(".load-failed")!;
  expect(row.textContent).toBe("dohc could not load Groups and comments.Try again");
  await click("Comments");
  expect(
    container.querySelector<HTMLElement>("#workspace-comments .load-failed")?.textContent,
  ).toBe("dohc could not load Groups and comments.Try again");
  await click("Chats");
  const toast = () => container.querySelector<HTMLElement>(".toast-slot [role=alert]");
  expect(toast()?.querySelector(".edit-notice-title")?.textContent).toBe(
    "dohc could not load Groups and comments",
  );
  expect(toast()?.textContent).toContain("Check your connection.");
  const copy = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: copy } });
  await act(async () =>
    toast()!.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click(),
  );
  expect(copy).toHaveBeenCalledWith(
    "dohc could not load Groups and comments\nCheck your connection.",
  );
  await act(async () =>
    [...toast()!.querySelectorAll("button")]
      .find((node) => node.textContent === "Try again")!
      .click(),
  );
  await settle(() => text().includes("Plans start here"));
  expect(toast()).toBeNull();
});

it("posts in a Group at Comment, counts another Group's new messages, and opens it from the list", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  expect(following("chat")[0]!.url.searchParams.get("channelWireId")).toBeNull();
  const box = groupPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
  expect(box.placeholder).toBe("What's happening in #plans?");
  setControlValue(box, "Count me in");
  await click("Send");
  await settle(() => posts.length === 1);
  expect(posts[0]).toMatchObject({
    shareId: "share",
    channelWireId: "wire-plans",
    lane: "posts",
    body: "Count me in",
    authorKind: "human",
  });
  await act(async () =>
    following("chat")[0]!.answer({
      shareId: "share",
      nextCursor: 22,
      hasMore: false,
      messages: [{ ...chat(21, "Bring snacks too"), channelWireId: "wire-food" }],
    }),
  );
  // The count is part of the back button's name, so a screen reader hears it too.
  await settle(() => button("All Groups, 1 unread")?.textContent === "1");
  await click("All Groups, 1 unread");
  const food = buttons().find((node) => node.textContent?.startsWith("food"))!;
  expect(food.textContent).toBe("food1 unread");
  await act(async () => food.click());
  await settle(() => groupPanel().textContent?.includes("Bring snacks too") === true);
  expect(groupPanel().querySelector("h2")?.textContent).toBe("food");
  // One follow serves every Group, whichever is open.
  await settle(() => following("chat").length === 1);
});

it("never reads where a member's post woke an agent", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  setControlValue(composer(), "@claude plan it");
  await click("Send");
  await settle(() => groupPanel().textContent!.includes("@claude plan it"));
  await settle(() => posts.length === 1);
  for (let tick = 0; tick < 5; tick += 1) await act(async () => Promise.resolve());
  expect(posts.filter((post) => "wakes" in post)).toEqual([]);
  expect(groupPanel().querySelector(".chat-wake")).toBeNull();
});

it("stops counting a Group's new messages once a rule hides that Group", async () => {
  const options: { level: Level; groupRules?: GroupRules } = { level: "comment" };
  server(options);
  await render();
  await opened();
  await act(async () =>
    following("chat")[0]!.answer({
      shareId: "share",
      nextCursor: 22,
      hasMore: false,
      messages: [{ ...chat(21, "Bring snacks too"), channelWireId: "wire-food" }],
    }),
  );
  const chatsTab = () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) =>
      tab.textContent?.startsWith("Chats"),
    )!;
  await settle(() => chatsTab().textContent === "Chats1 unread");
  await click("All Groups, 1 unread");
  // The owner hid food. The relay refuses the files' held read, as for any rule change.
  options.groupRules = { "wire-food": "none" };
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => !groupPanel().textContent?.includes("food"));
  expect(groupPanel().textContent).toContain("plans");
  expect(chatsTab().textContent).toBe("Chats");
});

const channelReads = (fetch: ReturnType<typeof server>) =>
  fetch.mock.calls.filter(
    ([input]) =>
      new URL(String(input), "https://share.test").pathname === "/api/named-chat/channels",
  ).length;

it("shows a Group added just after the workspace opened, as soon as it reaches the relay, even when it had none", async () => {
  const options: { groups: Array<{ wire: string; name: string }> } = { groups: [] };
  const fetch = server(options);
  await render();
  await settle(
    () =>
      groupPanel().textContent?.includes("No Groups in this workspace yet.") === true &&
      following("chat").length === 1,
  );
  expect(following("chat")[0]!.url.searchParams.get("since")).toBe("7");
  options.groups = [{ wire: "wire-plans", name: "plans" }];
  await act(async () =>
    following("chat")[0]!.answer({ shareId: "share", messages: [], nextCursor: 8, hasMore: false }),
  );
  await settle(() => groupPanel().textContent?.includes("Plans start here") === true);
  expect(channelReads(fetch)).toBe(2);
  await settle(() => following("chat").length === 1);
  await act(async () =>
    following("chat")[0]!.answer({ shareId: "share", messages: [], nextCursor: 8, hasMore: false }),
  );
  await settle(() => following("chat").length === 1);
  expect(channelReads(fetch)).toBe(2);
});

it("lists a new Group as soon as a message in it arrives, and keeps the open Group following", async () => {
  const options: { groups: Array<{ wire: string; name: string }> } = {
    groups: [{ wire: "wire-plans", name: "plans" }],
  };
  server(options);
  await render();
  await opened();
  options.groups = [...options.groups, { wire: "wire-trains", name: "trains" }];
  await act(async () =>
    following("chat")[0]!.answer({
      shareId: "share",
      nextCursor: 22,
      hasMore: false,
      messages: [{ ...chat(21, "Tickets booked"), channelWireId: "wire-trains" }],
    }),
  );
  await settle(() => button("All Groups, 1 unread") !== undefined);
  // The open Group still follows: a new message in it arrives.
  await settle(() => following("chat").length === 1);
  await act(async () =>
    following("chat")[0]!.answer({
      shareId: "share",
      nextCursor: 24,
      hasMore: false,
      messages: [{ ...chat(23, "Train at ten"), channelWireId: "wire-plans" }],
    }),
  );
  await settle(() => groupPanel().textContent?.includes("Train at ten") === true);
  await click("All Groups, 1 unread");
  expect(buttons().find((node) => node.textContent?.startsWith("trains"))?.textContent).toBe(
    "trains1 unread",
  );
});

const composer = () => groupPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
const listed = () =>
  [...groupPanel().querySelectorAll(".chat-list > .chat-message .chat-body")].map((node) =>
    node.textContent?.trim(),
  );

it("shows a Posts Group's posts with their reply counts, and replies in a post's thread", async () => {
  server({
    groups: [{ wire: "wire-plans", name: "plans", type: "posts" }],
    history: {
      "wire-plans": [
        chat(3, "Plans start here", "ana", { threadId: "t-plan" }),
        chat(4, "Agreed", "sam", { threadId: "t-plan", startsPost: false }),
        chat(6, "Train or car?", "ana", { threadId: "t-ride" }),
      ],
    },
  });
  await render();
  await opened();
  expect(listed()).toEqual(["Plans start here", "Train or car?"]);
  expect(groupPanel().querySelector('[role="tablist"]')).toBeNull();
  expect(composer().placeholder).toBe("What's happening in #plans?");
  setControlValue(composer(), "Who books the hotel?");
  await click("Send");
  await settle(() => posts.length === 1);
  expect(posts[0]).toMatchObject({
    channelWireId: "wire-plans",
    lane: "posts",
    body: "Who books the hotel?",
  });
  expect(posts[0]).not.toHaveProperty("threadId");

  await click("1 reply");
  await settle(() => listed().includes("Agreed"));
  expect(listed()).toEqual(["Plans start here", "Agreed"]);
  expect(composer().placeholder).toBe("Reply…");
  // Focus moves into the thread, onto its back control.
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Back to posts");
  setControlValue(composer(), "I'll book it");
  await click("Send");
  await settle(() => posts.length === 2);
  expect(posts[1]).toMatchObject({
    channelWireId: "wire-plans",
    threadId: "t-plan",
    body: "I'll book it",
  });
  expect(posts[1]).not.toHaveProperty("lane");
  await click("Back to posts");
  expect(listed()).toEqual(["Plans start here", "Train or car?", "Who books the hotel?"]);
  expect(button("2 replies")).toBeDefined();
  // And back to the control that opened the thread.
  expect(document.activeElement).toBe(button("2 replies"));
  expect(composer().placeholder).toBe("What's happening in #plans?");
});

it("shows a reply count at View only where a post has replies, and still opens that thread", async () => {
  server({
    level: "view",
    groups: [{ wire: "wire-plans", name: "plans", type: "posts" }],
    history: {
      "wire-plans": [
        chat(3, "Plans start here", "ana", { threadId: "t-plan" }),
        chat(4, "Agreed", "ana", { threadId: "t-plan", startsPost: false }),
        chat(6, "Train or car?", "ana", { threadId: "t-ride" }),
      ],
    },
  });
  await render();
  await opened();
  expect(listed()).toEqual(["Plans start here", "Train or car?"]);
  // A person who can't post has nothing to reply with, so a post with no replies shows nothing.
  expect(
    [...groupPanel().querySelectorAll(".chat-replies")].map((node) => node.textContent),
  ).toEqual(["1 reply"]);
  expect(button("Reply")).toBeUndefined();
  await click("1 reply");
  await settle(() => listed().includes("Agreed"));
  expect(groupPanel().querySelector('textarea[name="body"]')).toBeNull();
});

it("reopens a post's thread at View while it holds an unsent first reply, so the person can copy it", async () => {
  const options: Parameters<typeof server>[0] = {
    level: "comment",
    groups: [{ wire: "wire-plans", name: "plans", type: "posts" }],
    history: { "wire-plans": [chat(6, "Train or car?", "ana", { threadId: "t-ride" })] },
  };
  server(options);
  await render();
  await settle(() => listed().includes("Train or car?"));
  await click("Reply");
  setControlValue(composer(), "Car, I think");
  // The member is lowered to View, and the page opens again, as Try again opens it after a failed read.
  await act(async () => root.unmount());
  root = createRoot(container);
  held = [];
  options.level = "view";
  await render();
  await settle(() => listed().includes("Train or car?"));
  await click("Unsent reply");
  await settle(
    () =>
      groupPanel().querySelector<HTMLTextAreaElement>('textarea[aria-label="Your unsent message"]')
        ?.value === "Car, I think",
  );
  expect(groupPanel().querySelector('textarea[name="body"]')).toBeNull();
  await click("Discard");
  await click("Back to posts");
  expect(button("Unsent reply")).toBeUndefined();
});

// History arrives a page at a time, newest first, so a post's replies can arrive a page before the message that starts it.
it("shows a post only once the message that starts it loads, with all its replies", async () => {
  server({
    groups: [{ wire: "wire-plans", name: "plans", type: "posts" }],
    history: {
      "wire-plans": [
        chat(8, "Agreed", "sam", { threadId: "t-plan", startsPost: false }),
        chat(9, "Train or car?", "ana", { threadId: "t-ride" }),
        chat(10, "Me too", "ana", { threadId: "t-plan", startsPost: false }),
      ],
    },
    older: { "wire-plans": [chat(3, "Plans start here", "ana", { threadId: "t-plan" })] },
  });
  await render();
  await settle(() => listed().includes("Train or car?") && following("chat").length === 1);
  // A reply is not the post it answers.
  expect(listed()).toEqual(["Train or car?"]);
  expect(
    [...groupPanel().querySelectorAll(".chat-replies")].map((node) => node.textContent),
  ).toEqual(["Reply"]);
  await click("Load earlier messages");
  await settle(() => listed().includes("Plans start here"));
  expect(listed()).toEqual(["Plans start here", "Train or car?"]);
  expect(
    [...groupPanel().querySelectorAll(".chat-replies")].map((node) => node.textContent),
  ).toEqual(["2 replies", "Reply"]);
  await click("2 replies");
  await settle(() => listed().includes("Agreed"));
  expect(listed()).toEqual(["Plans start here", "Agreed", "Me too"]);
});

it("shows a Chat Group as one conversation, and answers a message in its thread", async () => {
  server({
    groups: [{ wire: "wire-plans", name: "plans", type: "chat" }],
    history: {
      "wire-plans": [
        chat(3, "Plans start here", "ana", { threadId: "t-chat", lane: "chat" }),
        chat(4, "Agreed", "sam", { threadId: "t-chat", lane: "chat", parentMessageId: "m3" }),
        chat(6, "Train or car?", "ana", { threadId: "t-chat", lane: "chat" }),
      ],
    },
  });
  await render();
  await opened();
  expect(listed()).toEqual(["Plans start here", "Train or car?"]);
  expect(composer().placeholder).toBe("Message #plans");
  setControlValue(composer(), "Train");
  await click("Send");
  await settle(() => posts.length === 1);
  expect(posts[0]).toMatchObject({ channelWireId: "wire-plans", lane: "chat", body: "Train" });

  await click("1 reply");
  await settle(() => listed().includes("Agreed"));
  expect(composer().placeholder).toBe("Reply…");
  setControlValue(composer(), "Same");
  await click("Send");
  await settle(() => posts.length === 2);
  expect(posts[1]).toMatchObject({ threadId: "t-chat", parentMessageId: "m3", body: "Same" });
  await click("Back to the conversation");
  expect(composer().placeholder).toBe("Message #plans");
  expect(document.activeElement).toBe(button("2 replies"));
});

it("orders a Chat Group by when each message was sent, as the desktop does", async () => {
  server({
    groups: [{ wire: "wire-plans", name: "plans", type: "chat" }],
    history: {
      // Sam sent first, but the relay took Ana's message first.
      "wire-plans": [
        chat(4, "Train at 8", "ana", { threadId: "t-ana", lane: "chat" }),
        {
          ...chat(5, "Ferry at 9", "sam", { threadId: "t-sam", lane: "chat" }),
          createdAtMs: 3_500,
        },
      ],
    },
  });
  await render();
  await settle(() => listed().length === 2);
  expect(listed()).toEqual(["Ferry at 9", "Train at 8"]);
});

it("switches a Group with both lanes between Posts and Chat", async () => {
  server({
    history: {
      "wire-plans": [
        chat(3, "Plans start here"),
        chat(4, "Quick question", "sam", { threadId: "t-chat", lane: "chat" }),
      ],
    },
  });
  await render();
  await opened();
  const lanes = () => [
    ...groupPanel().querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]'),
  ];
  expect(lanes().map((tab) => tab.textContent)).toEqual(["Posts", "Chat"]);
  expect(listed()).toEqual(["Plans start here"]);
  await act(async () => lanes()[1]!.click());
  expect(listed()).toEqual(["Quick question"]);
  expect(composer().placeholder).toBe("Message #plans");
  // The arrow keys move between the lanes, as between the workspace's tabs, and one lane takes Tab.
  const press = async (key: string) =>
    act(async () => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  lanes()[1]!.focus();
  expect(lanes().map((tab) => tab.tabIndex)).toEqual([-1, 0]);
  await press("ArrowRight");
  expect(document.activeElement).toBe(lanes()[0]);
  expect(listed()).toEqual(["Plans start here"]);
  await press("ArrowLeft");
  expect(document.activeElement).toBe(lanes()[1]);
  await press("Home");
  expect(lanes()[0]!.getAttribute("aria-selected")).toBe("true");
  await press("End");
  expect(listed()).toEqual(["Quick question"]);
});

it("keeps a Group's draft and a file's comment draft while the person moves around, and clears each after its send", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  setControlValue(composer(), "Half a thought");
  await click("All Groups");
  await act(async () =>
    buttons()
      .find((node) => node.textContent?.startsWith("food"))!
      .click(),
  );
  await settle(() => groupPanel().textContent?.includes("Bring snacks") === true);
  expect(composer().value).toBe("");
  await click("All Groups");
  await act(async () =>
    buttons()
      .find((node) => node.textContent?.startsWith("plans"))!
      .click(),
  );
  await settle(() => groupPanel().textContent?.includes("Plans start here") === true);
  expect(composer().value).toBe("Half a thought");

  await showComments();
  const comment = () =>
    commentsPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
  setControlValue(comment(), "Nine works");
  await click("Chats");
  await click("Comments");
  await settle(() => commentsPanel().textContent?.includes("Nine is early") === true);
  expect(comment().value).toBe("Nine works");
  await act(async () =>
    commentsPanel().querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );
  await settle(() => posts.length === 1 && comment().value === "");
  await click("Chats");
  await click("Comments");
  await settle(() => commentsPanel().textContent?.includes("Nine is early") === true);
  expect(comment().value).toBe("");

  // A new page load in the same tab finds the Group's draft.
  await act(async () => root.unmount());
  root = createRoot(container);
  held = [];
  await render();
  await opened();
  expect(composer().value).toBe("Half a thought");
});

it("keeps drafts when the tab's storage is unavailable", async () => {
  vi.stubGlobal("sessionStorage", {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  });
  server({ level: "comment" });
  await render();
  await opened();
  setControlValue(composer(), "Still here");
  await click("All Groups");
  await act(async () =>
    buttons()
      .find((node) => node.textContent?.startsWith("plans"))!
      .click(),
  );
  await settle(() => groupPanel().textContent?.includes("Plans start here") === true);
  expect(composer().value).toBe("Still here");
});

it("keeps unsent text to copy once the person can no longer post", async () => {
  server({ level: "comment", postFails: { status: 403, code: "share_read_only" } });
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await render();
  await opened();
  setControlValue(composer(), "Not sent yet");
  await click("Send");
  await settle(
    () => groupPanel().textContent?.includes("Only people who can comment post here.") === true,
  );
  expect(
    groupPanel().querySelector<HTMLTextAreaElement>('textarea[aria-label="Your unsent message"]')
      ?.value,
  ).toBe("Not sent yet");
  await act(async () =>
    groupPanel()
      .querySelector<HTMLButtonElement>('button[aria-label="Copy unsent message"]')!
      .click(),
  );
  expect(writeText).toHaveBeenCalledWith("Not sent yet");
  expect(
    groupPanel().querySelector<HTMLButtonElement>('button[aria-label="Copy unsent message"]')!
      .textContent,
  ).toBe("Copied");
  // A screen reader hears the result.
  const heard = () => groupPanel().querySelector('.copy-status[role="status"]')?.textContent;
  expect(heard()).toBe("Copied");
  writeText.mockRejectedValueOnce(new Error("denied"));
  await act(async () =>
    groupPanel()
      .querySelector<HTMLButtonElement>('button[aria-label="Copy unsent message"]')!
      .click(),
  );
  expect(groupPanel().querySelector(".copy-failed")?.textContent).toBe(
    "dohc could not copy the message. Select it, then copy it.",
  );
  expect(heard()).toBe("dohc could not copy the message. Select it, then copy it.");
  expect(
    groupPanel().querySelector<HTMLTextAreaElement>('textarea[aria-label="Your unsent message"]')
      ?.value,
  ).toBe("Not sent yet");
  await click("Discard");
  expect(groupPanel().querySelector('textarea[aria-label="Your unsent message"]')).toBeNull();
});

it("says it kept a Group draft the person can no longer post, and brings it back with Undo after Discard", async () => {
  server({ level: "comment", postFails: { status: 403, code: "share_read_only" } });
  await render();
  await opened();
  setControlValue(composer(), "Bring sunscreen");
  await click("Send");
  await settle(
    () => groupPanel().textContent?.includes("Only people who can comment post here.") === true,
  );
  // The same pattern as a page's unsent edits: a warning mark, what and where, then where the text lives.
  const title = groupPanel().querySelector(".chat-unsent-title")!;
  expect(title.textContent).toBe("Unsent message to #plans");
  expect(title.querySelector(".icon")).not.toBeNull();
  expect(groupPanel().querySelector(".chat-unsent-note")?.textContent).toBe(
    "Only this tab has it. Copy it before you close it.",
  );
  const stored = () =>
    Object.values(sessionStorage).some((value) => value.includes("Bring sunscreen"));
  expect(stored()).toBe(true);
  // Discard takes the text away and leaves a line with Undo, as the kept page edits do.
  await click("Discard");
  expect(groupPanel().querySelector('textarea[aria-label="Your unsent message"]')).toBeNull();
  expect(groupPanel().textContent).toContain("Discarded your unsent message.");
  expect(stored()).toBe(false);
  await click("Undo");
  expect(
    groupPanel().querySelector<HTMLTextAreaElement>('textarea[aria-label="Your unsent message"]')
      ?.value,
  ).toBe("Bring sunscreen");
  expect(groupPanel().textContent).not.toContain("Discarded your unsent message.");
  expect(stored()).toBe(true);
  // Dismiss leaves nothing behind.
  await click("Discard");
  await click("Dismiss");
  expect(groupPanel().textContent).not.toContain("Discarded your unsent message.");
  expect(groupPanel().querySelector('textarea[aria-label="Your unsent message"]')).toBeNull();
});

function liveSession() {
  const doc = markdownToYDoc("Leave at nine."),
    listeners = new Set<(value: NamedLiveBrowserState) => void>();
  let state: NamedLiveBrowserState = {
    status: "authorizing",
    reason: null,
    binding: null,
    hostEpoch: null,
    pendingUpdates: 0,
    pendingBytes: 0,
    lastApplied: null,
    membership: null,
    typingStopped: false,
    typingAhead: false,
    holds: false,
  };
  const notify = () => {
    for (const listener of listeners) listener(state);
  };
  const session = {
    doc,
    state: () => state,
    subscribe(listener: (value: NamedLiveBrowserState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRemovedText: vi.fn(() => () => {}),
    close: vi.fn(),
    reconnect: vi.fn(async () => {
      state = { ...state, status: "live", holds: true };
      notify();
    }),
    disconnect: vi.fn(),
    // An edit that has not reached the workspace yet.
    type(text: string) {
      const body = getDohcYDocBodyFragment(doc),
        paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(text)]);
      body.insert(body.length, [paragraph]);
      state = { ...state, pendingUpdates: 1 };
      notify();
    },
    // The connection drops or the session stops taking changes.
    drop(status: NamedLiveBrowserState["status"]) {
      state = { ...state, status };
      notify();
    },
    edit(change: () => void) {
      if (state.status !== "live") return false;
      change();
      return true;
    },
  };
  return session;
}
const ADMITTED = {
  kind: "open",
  discriminator: "abcdefghijkl",
  objectId: "object-plan",
  userId: "sam",
  token: "ab".repeat(32),
  limits: {},
} as const;

it("opens a page in the live editor at Edit, as the signed-in account", async () => {
  server({ level: "edit" });
  const session = liveSession();
  vi.mocked(openMemberPage).mockResolvedValue(ADMITTED);
  vi.mocked(memberDocument).mockReturnValue({ session: session as never, close: vi.fn() });
  await render();
  await settle(
    () =>
      container.querySelector('[role="textbox"]') !== null &&
      !container.querySelector(".named-body-editor")?.hasAttribute("hidden"),
  );
  expect(vi.mocked(openMemberPage)).toHaveBeenCalledWith(
    { grantId: GRANT },
    "trip/plan.md",
    expect.any(AbortSignal),
  );
  expect(vi.mocked(memberDocument)).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { grantId: GRANT },
      path: "trip/plan.md",
      accountId: "sam",
      admission: ADMITTED,
    }),
  );
  expect(container.querySelector('[role="textbox"]')?.textContent).toContain("Leave at nine.");
  // The header names the level, as at View and Comment. Only a save on its way shows beside it.
  expect(container.querySelector(".workspace-page .badge")?.textContent).toBe("Can edit");
  expect(container.querySelector("header .named-document-status")).toBeNull();
  await act(async () => session.type("Leave at ten."));
  expect(container.querySelector("header .named-document-status")?.textContent).toBe(
    "Saving changes…",
  );
  // Saving on a healthy connection is not a draft to recover.
  expect(container.querySelector('[aria-label="Unsent edits"]')).toBeNull();
});

// The unsent edits need the person only once dohc cannot send them.
it.each([
  [
    "quarantined",
    "Editing stopped. dohc could not send your unsent edits. Copy or download them, then discard them to keep editing.",
    null,
  ],
  ["disconnected", "Editing paused. Check your connection.", "Retry connection"],
] as const)(
  "shows a %s session's unsent edits above the page, with the state in the band",
  async (status, sentence, retry) => {
    const session = await editing({ level: "edit" });
    expect(container.querySelector('[aria-label="Unsent edits"]')).toBeNull();
    await act(async () => session.drop(status));
    await settle(() => container.querySelector('[aria-label="Unsent edits"]') !== null);
    // The same row as kept edits, between the band and the page, with Copy, Download and Discard.
    const row = container.querySelector(
      'header + .page-band ~ .workspace-kept > [aria-label="Unsent edits"]',
    )!;
    expect(row.querySelector(".unsent-name")?.textContent).toBe("Unsent edits to plan.md");
    expect(row.querySelector(".icon")).not.toBeNull();
    expect(row.querySelector("textarea")?.value).toContain("Leave at ten.");
    expect(
      [...row.querySelectorAll(".unsent-actions > :is(button, a)")].map(
        (node) => node.getAttribute("aria-label") ?? node.textContent,
      ),
    ).toEqual(["Copy unsent edits", "Download", "Discard"]);
    // The state sits in the band, with the warning mark, as waiting and refusals do.
    const band = container.querySelector("header + .page-band")!;
    expect(band.querySelector("[role=status]")?.textContent).toBe(sentence);
    expect(band.querySelector("[role=status] .icon")).not.toBeNull();
    expect(band.querySelector("button")?.textContent ?? null).toBe(retry);
    expect(container.querySelector("main .named-document-status")).toBeNull();
    expect(text()).not.toContain("Review your draft");
    expect(button("Open current file")).toBeUndefined();
    if (retry) {
      await act(async () => band.querySelector<HTMLButtonElement>("button")!.click());
      expect(session.reconnect).toHaveBeenCalledTimes(2);
    }
  },
);

it("waits for the owner's dohc with the page readable, raises a toast after 15 seconds, and opens by itself once ready", async () => {
  server({ level: "edit" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const session = liveSession();
  let ready!: (value: boolean) => void;
  vi.mocked(openMemberPage)
    .mockResolvedValueOnce({ kind: "refused", code: "live-document-without-lineage" })
    .mockResolvedValue(ADMITTED);
  vi.mocked(memberPageReady).mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  vi.mocked(memberDocument).mockReturnValue({ session: session as never, close: vi.fn() });
  await render();
  await settle(
    () =>
      text().includes("Editing starts once the owner's dohc is online.") &&
      text().includes("Leave at nine.") &&
      ready !== undefined,
  );
  // As on the desktop, the state line sits in a band between the header and the page. dohc is already trying, so it has no Try again.
  const band = container.querySelector("header + .page-band")!;
  expect(band.querySelector("[role=status]")?.textContent).toBe(
    "Editing starts once the owner's dohc is online.",
  );
  expect(band.querySelector(".live-ring")).not.toBeNull();
  expect(band.querySelector("button")).toBeNull();
  expect(container.querySelector("header")?.textContent).not.toContain("Editing starts");
  expect(container.querySelector(".workspace-toast")).toBeNull();
  await act(async () => vi.advanceTimersByTime(15_000));
  const toast = container.querySelector(".workspace-toast")!;
  // Waiting is a state dohc is fixing, so the toast says what is happening, with the desktop's title and the warning mark.
  expect(toast.querySelector(".edit-notice-title")?.textContent).toBe('Waiting to edit "plan.md"');
  expect(toast.getAttribute("role")).toBe("status");
  expect(toast.querySelector(".tile.warn")).not.toBeNull();
  expect(toast.querySelector(".tile.bad")).toBeNull();
  expect(toast.textContent).toContain(
    "Editing starts once the owner's dohc is online. You can still read it.",
  );
  await act(async () => ready(true));
  await settle(
    () =>
      container.querySelector('[role="textbox"]') !== null &&
      container.querySelector(".workspace-toast") === null,
  );
  expect(vi.mocked(openMemberPage)).toHaveBeenCalledTimes(2);
});

it.each([
  ["live_paused_by_owner", "The owner paused live editing for this page. You can still read it."],
  ["live_host_full", "The server is editing too many pages right now. You can still read it."],
])(
  "keeps a page readable when the host refuses it (%s), with Try again",
  async (code, sentence) => {
    server({ level: "edit" });
    vi.mocked(openMemberPage).mockResolvedValue({ kind: "refused", code });
    await render();
    await settle(
      () =>
        container.querySelector(".workspace-toast") !== null && text().includes("Leave at nine."),
    );
    expect(container.querySelector(".workspace-toast")?.textContent).toContain(sentence);
    const band = container.querySelector("header + .page-band")!;
    expect(band.querySelector("[role=status]")?.textContent).toBe(sentence);
    expect(band.querySelector(".live-ring")).toBeNull();
    await act(async () => band.querySelector<HTMLButtonElement>("button")!.click());
    await settle(() => vi.mocked(openMemberPage).mock.calls.length === 2);
  },
);

async function editing(options: { level?: Level; member?: boolean; catchUpFails?: boolean }) {
  server(options);
  const session = liveSession();
  vi.mocked(openMemberPage).mockResolvedValue(ADMITTED);
  vi.mocked(memberDocument).mockReturnValue({ session: session as never, close: vi.fn() });
  await render();
  await settle(
    () => container.querySelector('[role="textbox"]') !== null && following("log").length === 1,
  );
  // The person typed, and the edit has not reached the workspace yet.
  await act(async () => session.type("Leave at ten."));
  return session;
}
const recovery = () => container.querySelector<HTMLElement>('[aria-label="Unsent edits"]');

it("keeps a later draft's unsent text after the person discarded an earlier one", async () => {
  const options: { level: Level } = { level: "edit" };
  const first = await editing(options);
  const next = liveSession();
  vi.mocked(memberDocument).mockReturnValueOnce({ session: next as never, close: vi.fn() });
  await act(async () => first.drop("disconnected"));
  await settle(() => recovery() !== null);
  // Discard acts at once and opens the current file. Its row above the page keeps Undo, so nothing asks first.
  await act(async () =>
    [...recovery()!.querySelectorAll("button")]
      .find((node) => node.textContent === "Discard")!
      .click(),
  );
  expect(container.querySelector("dialog")).toBeNull();
  await settle(() => next.reconnect.mock.calls.length === 1);
  const gone = () => container.querySelector<HTMLElement>('[aria-label="Discarded edits"]');
  expect(gone()?.textContent).toContain("Discarded your unsent edits to plan.md.");
  expect(Object.values(sessionStorage).some((value) => value.includes("Leave at ten."))).toBe(
    false,
  );
  await act(async () => next.type("Leave at eleven."));
  options.level = "comment";
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => container.querySelector('[role="textbox"]') === null && recovery() !== null);
  // Only the discarded draft went.
  expect(container.querySelectorAll('[aria-label="Unsent edits"]')).toHaveLength(1);
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at eleven.");
  // Undo brings the discarded text back beside the later one.
  await act(async () =>
    [...gone()!.querySelectorAll("button")].find((node) => node.textContent === "Undo")!.click(),
  );
  expect(
    [...container.querySelectorAll('[aria-label="Unsent edits"] textarea')].map(
      (node) => (node as HTMLTextAreaElement).value,
    ),
  ).toEqual([
    expect.stringContaining("Leave at ten."),
    expect.stringContaining("Leave at eleven."),
  ]);
});

it("asks before another file closes a page with unsent edits, with Cancel and a danger Discard", async () => {
  const session = await editing({ level: "edit" });
  await act(async () => session.drop("disconnected"));
  await settle(() => recovery() !== null);
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("#workspace-files .file")]
      .find((node) => node.textContent === "to-pack.md")!
      .click(),
  );
  const dialog = container.querySelector("dialog")!;
  expect(dialog.querySelector("h2")?.textContent).toBe("Discard your unsent edits?");
  expect([...dialog.querySelectorAll("button")].map((node) => node.textContent)).toEqual([
    "Cancel",
    "Discard",
  ]);
  expect(dialog.querySelector("button:last-of-type")?.className).toBe("handoff-button danger");
  await act(async () =>
    [...dialog.querySelectorAll("button")].find((node) => node.textContent === "Cancel")!.click(),
  );
  expect(container.querySelector("dialog")).toBeNull();
  expect(container.querySelector(".file.selected")?.textContent).toBe("plan.md");
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
});

it("names the open page's unsent edits by its folder when a kept row has the same file name", async () => {
  writeDraft(
    "unsent-edits",
    JSON.stringify([{ id: 1, accountId: "sam", path: "welcome/plan.md", text: "Hello." }]),
  );
  const session = await editing({ level: "edit" });
  await act(async () => session.drop("disconnected"));
  await settle(() => container.querySelectorAll('[aria-label="Unsent edits"]').length === 2);
  expect(
    [...container.querySelectorAll('[aria-label="Unsent edits"] summary')].map(
      (node) => node.textContent,
    ),
  ).toEqual([
    // The kept row names itself against the other kept rows only.
    "Unsent edits to plan.md",
    "Unsent edits to trip/plan.md",
  ]);
});

it("keeps the unsent text when Try again opens the page again", async () => {
  await editing({ level: "edit" });
  await act(async () =>
    vi.mocked(memberDocument).mock.calls[0]![0].onRefused("live_paused_by_owner"),
  );
  await settle(() => container.querySelector(".workspace-toast") !== null);
  await act(async () =>
    [...container.querySelector(".workspace-toast")!.querySelectorAll("button")]
      .find((node) => node.textContent === "Try again")!
      .click(),
  );
  await settle(() => recovery() !== null);
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
});

// Item 3: the files never go out of date without a sign.
it("marks the files as possibly out of date while their reads fail, raises a toast with Try again and copy, and clears both once they catch up", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const options: NonNullable<Parameters<typeof server>[0]> = { level: "comment" };
  server(options);
  await render();
  await opened();
  options.holdLogs = true;
  const asksToWait = () => following("log")[0]!.url.searchParams.has("hold");
  const dated = () => container.querySelector<HTMLElement>("header .workspace-dated");
  const toast = () =>
    [...container.querySelectorAll<HTMLElement>(".workspace-toast")].find((node) =>
      node.textContent?.includes("dohc could not update this workspace's files"),
    );
  expect(dated()).toBeNull();
  for (const [index, wait] of [1000, 2000, 4000].entries()) {
    await settle(() => following("log").length === 1);
    // After a failure, the next read asks the server to answer at once, so a recovery shows at once.
    expect(asksToWait()).toBe(index === 0);
    await act(async () => following("log")[0]!.answer({ ok: false, error: "unavailable" }, 500));
    await settle(() => dated() !== null);
    // The last files that arrived stay readable, marked in the desktop's words.
    expect(dated()!.textContent).toBe("May be out of date");
    expect(text()).toContain("Leave at nine.");
    // A failure or two passes in silence. The third raises the toast.
    if (index < 2) {
      expect(toast()).toBeUndefined();
      await act(async () => vi.advanceTimersByTime(wait));
    }
  }
  await settle(() => toast() !== undefined);
  expect(toast()!.textContent).toContain("Check your connection.");
  expect(toast()!.querySelector('[aria-label="Copy message"]')).not.toBeNull();
  // Try again reads at once, with no wait.
  await act(async () =>
    [...toast()!.querySelectorAll("button")]
      .find((node) => node.textContent === "Try again")!
      .click(),
  );
  await settle(() => following("log").length === 1);
  expect(asksToWait()).toBe(false);
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 8, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => dated() === null && toast() === undefined);
  // Caught up, the page waits on the server for changes again.
  await settle(() => following("log").length === 1);
  expect(asksToWait()).toBe(true);
});

// Item 5: another account signed in on the same tab sees none of the first one's unsent work.
it("keeps each account's drafts and unsent edits from another account signed in on the same tab", async () => {
  const options: { level: Level; user?: string } = { level: "edit" };
  await editing(options);
  await settle(() => groupPanel().querySelector('textarea[name="body"]') !== null);
  setControlValue(composer(), "Half a thought");
  options.level = "comment";
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => recovery() !== null);
  const signInAs = async (user: string) => {
    await click("Sign out");
    await settle(() => Boolean(container.querySelector('input[name="email"]')));
    options.user = user;
    held = [];
    await act(async () => {
      setControlValue(container.querySelector('input[name="email"]')!, `${user}@dohc.test`);
      setControlValue(container.querySelector('input[name="password"]')!, "secret");
    });
    await click("Sign in");
    await opened();
  };
  await signInAs("lee");
  expect(recovery()).toBeNull();
  expect(composer().value).toBe("");
  await signInAs("sam");
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
  expect(composer().value).toBe("Half a thought");
});

it("shows kept edits only while their account is signed in: none before sign-in or after sign-out, and only that account's", async () => {
  writeDraft(
    "unsent-edits",
    JSON.stringify([
      { id: 1, accountId: "sam", path: "trip/plan.md", text: "Leave at ten." },
      { id: 2, accountId: "lee", path: "trip/to-pack.md", text: "Socks." },
    ]),
  );
  const options: { signedIn: boolean; user?: string } = { signedIn: false };
  server(options);
  await render();
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(recovery()).toBeNull();
  expect(text()).not.toContain("Unsent edits");
  options.user = "lee";
  await act(async () => {
    setControlValue(container.querySelector('input[name="email"]')!, "lee@dohc.test");
    setControlValue(container.querySelector('input[name="password"]')!, "secret");
  });
  await click("Sign in");
  await opened();
  expect(
    [...container.querySelectorAll('[aria-label="Unsent edits"] summary')].map(
      (node) => node.textContent,
    ),
  ).toEqual(["Unsent edits to to-pack.md"]);
  // Signed out, the sign-in form may be filled by someone else, so it shows no kept text. The tab still keeps it.
  await click("Sign out");
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(recovery()).toBeNull();
  expect(container.innerHTML).not.toContain("Socks.");
  expect(JSON.parse(readDraft("unsent-edits"))).toHaveLength(2);
});

it("stops editing when the person loses Edit, and keeps the unsent text to copy, download or discard with Undo", async () => {
  const options: { level: Level } = { level: "edit" };
  await editing(options);
  options.level = "comment";
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => container.querySelector('[role="textbox"]') === null && recovery() !== null);
  // One compact row under the page's band, in the page's flow, that opens in place to the text.
  expect(recovery()!.querySelector("summary")?.textContent).toBe("Unsent edits to plan.md");
  expect(recovery()!.closest(".workspace-corner")).toBeNull();
  expect(
    container.querySelector("#workspace-main > .page-band + .workspace-kept")?.contains(recovery()),
  ).toBe(true);
  // It says where the text lives.
  expect(recovery()!.textContent).toContain(
    "Only this tab has them. Copy or download them before you close it.",
  );
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () =>
    recovery()!.querySelector<HTMLButtonElement>('button[aria-label="Copy unsent edits"]')!.click(),
  );
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Leave at ten."));
  expect(
    recovery()!.querySelector<HTMLButtonElement>('button[aria-label="Copy unsent edits"]')!
      .textContent,
  ).toBe("Copied");
  expect(recovery()!.querySelector('.copy-status[role="status"]')?.textContent).toBe("Copied");
  const download = recovery()!.querySelector<HTMLAnchorElement>("a[download]")!;
  expect(download.getAttribute("download")).toBe("plan (unsent edits).md");
  // Discard takes the text away, and Undo brings it back.
  await act(async () =>
    [...recovery()!.querySelectorAll("button")]
      .find((node) => node.textContent === "Discard")!
      .click(),
  );
  expect(recovery()).toBeNull();
  const discarded = container.querySelector<HTMLElement>('[aria-label="Discarded edits"]')!;
  expect(discarded.textContent).toContain("Discarded your unsent edits to plan.md.");
  await act(async () =>
    [...discarded.querySelectorAll("button")].find((node) => node.textContent === "Undo")!.click(),
  );
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
  expect(container.querySelector('[aria-label="Discarded edits"]')).toBeNull();
});

it("keeps unsent edits through a reload of the tab, and warns before the tab closes until they are discarded", async () => {
  const options: { level: Level } = { level: "edit" };
  await editing(options);
  options.level = "comment";
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => container.querySelector('[role="textbox"]') === null && recovery() !== null);
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(unload()).toBe(true);
  expect(Object.values(sessionStorage).some((value) => value.includes("Leave at ten."))).toBe(true);
  // The tab reloads: a new page reads what the tab kept.
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await settle(() => recovery() !== null);
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
  expect(unload()).toBe(true);
  await act(async () =>
    [...recovery()!.querySelectorAll("button")]
      .find((node) => node.textContent === "Discard")!
      .click(),
  );
  expect(unload()).toBe(false);
  expect(Object.values(sessionStorage).some((value) => value.includes("Leave at ten."))).toBe(
    false,
  );
});

it("says in place when it could not copy the unsent edits, and keeps them with Download", async () => {
  const options: { level: Level } = { level: "edit" };
  await editing(options);
  options.level = "comment";
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => recovery() !== null);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => {
        throw new Error("denied");
      }),
    },
  });
  await act(async () =>
    recovery()!.querySelector<HTMLButtonElement>('button[aria-label="Copy unsent edits"]')!.click(),
  );
  expect(recovery()!.querySelector(".copy-failed")?.textContent).toBe(
    "dohc could not copy the edits. Download them instead.",
  );
  expect(recovery()!.querySelector('.copy-status[role="status"]')?.textContent).toBe(
    "dohc could not copy the edits. Download them instead.",
  );
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
  expect(recovery()!.querySelector("a[download]")).not.toBeNull();
});

it("names kept edits to two files of the same name by their folders", async () => {
  writeDraft(
    "unsent-edits",
    JSON.stringify([
      { id: 1, accountId: "sam", path: "trip/plan.md", text: "Leave at ten." },
      { id: 2, accountId: "sam", path: "welcome/plan.md", text: "Hello." },
      { id: 3, accountId: "sam", path: "trip/to-pack.md", text: "Socks." },
    ]),
  );
  server();
  await render();
  await settle(() => container.querySelectorAll('[aria-label="Unsent edits"]').length === 3);
  expect(
    [...container.querySelectorAll('[aria-label="Unsent edits"] summary')].map(
      (node) => node.textContent,
    ),
  ).toEqual([
    "Unsent edits to trip/plan.md",
    "Unsent edits to welcome/plan.md",
    "Unsent edits to to-pack.md",
  ]);
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Unsent edits"] button')]
      .find((node) => node.textContent === "Discard")!
      .click(),
  );
  expect(container.querySelector('[aria-label="Discarded edits"]')?.textContent).toContain(
    "Discarded your unsent edits to trip/plan.md.",
  );
});

it("keeps the unsent text after the membership ends, with none of the workspace", async () => {
  const options: { level: Level; member: boolean } = { level: "edit", member: true };
  await editing(options);
  // The owner removed the member: every workspace read now refuses.
  options.member = false;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => text().includes("Your membership in Trip ended.") && recovery() !== null);
  expect(recovery()!.querySelector("textarea")?.value).toContain("Leave at ten.");
  expect(text()).not.toContain("Plans start here");
});

it("says the membership ended and shows none of the workspace once the member is removed", async () => {
  const options: { level: Level; member?: boolean } = { level: "comment" };
  server(options);
  await render();
  await opened();
  // The owner removed the member: every workspace read now refuses, so a fresh read confirms it.
  options.member = false;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => text().includes("Your membership in Trip ended."));
  // A browser keeps no copy of the workspace. The next step is one a browser can take.
  expect(container.querySelector(".state-message h1")?.textContent).toBe(
    "Your membership in Trip ended.",
  );
  expect(container.querySelector(".state-message p")?.textContent).toBe(
    "Ask the owner to invite you again to keep working in it.",
  );
  expect(container.querySelector('nav[aria-label="Workspace files"]')).toBeNull();
  expect(text()).not.toContain("Leave at nine.");
  expect(text()).not.toContain("Plans start here");
  // The browser is still signed in, so it names the account and offers Sign out.
  expect(text()).toContain("Signed in as Sam Rivera · Sign out");
  await click("Sign out");
  await settle(() => text().includes("Sign in to open this workspace"));
});

it("refuses an account that is not a member, names it, and offers Switch account", async () => {
  server({ member: false });
  await render();
  await settle(() => text().includes("dohc could not open this workspace with this account."));
  expect(container.querySelector(".state-message p")?.textContent).toBe(
    "This browser is signed in as Sam Rivera. Ask the owner to invite this account, or switch to another.",
  );
  await click("Switch account");
  await settle(() => text().includes("Sign in to open this workspace"));
});

it("says so when Switch account cannot sign out, and keeps the button to try again", async () => {
  server({ member: false, signOutFails: true });
  await render();
  await settle(() => text().includes("dohc could not open this workspace with this account."));
  await click("Switch account");
  await settle(() => container.querySelector('.state-message [role="alert"]') !== null);
  // It names the control on this page, with the error mark and tone.
  const alert = container.querySelector('.state-message [role="alert"]')!;
  expect(alert.textContent).toBe(
    "dohc could not sign you out. Choose Switch account to try again.",
  );
  expect(alert.classList.contains("launch-failure")).toBe(true);
  expect(alert.querySelector(".launch-failure-mark")).not.toBeNull();
  const button = [...container.querySelectorAll<HTMLButtonElement>(".state-message button")].find(
    (node) => node.textContent === "Switch account",
  );
  expect(button?.disabled).toBe(false);
});

it("loads in the shape of the workspace it opens: the files, the page and the side panel", async () => {
  server({ openHeld: true });
  await render();
  await settle(() => held.some((item) => item.path === "current"));
  const opening = container.querySelector<HTMLElement>(".workspace-opening")!;
  expect(opening.getAttribute("aria-busy")).toBe("true");
  expect(opening.textContent).toBe("Opening the workspace");
  expect([...opening.children].map((node) => node.className)).toEqual([
    "workspace-opening-files",
    "workspace-opening-page",
    "workspace-opening-side",
    "workspace-opening-tabs",
    "sr-only",
  ]);
  // A phone shows the page's header, with the mark, and the four tabs under it.
  expect(
    opening.querySelector(".workspace-opening-page > .workspace-opening-head .bar-mark"),
  ).not.toBeNull();
  expect(opening.querySelectorAll(".workspace-opening-tabs > i")).toHaveLength(4);
});

it("lays the files, the page and Chats or Comments side by side on a wide screen, and as four tabs on a phone", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  const side = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
    (tab) => !tab.closest(".chat-lanes"),
  );
  expect(side.map((tab) => tab.textContent)).toEqual(["Comments", "Chats"]);
  expect(side.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  for (const id of ["workspace-files", "workspace-main", "workspace-chats"]) {
    expect(container.querySelector(`#${id}`)?.closest("[hidden], [inert]"), id).toBeNull();
  }
  expect(commentsPanel().hasAttribute("inert")).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(container);
  held = [];
  narrow = true;
  await render();
  await opened();
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
    (tab) => !tab.closest(".chat-lanes"),
  );
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Files", "Page", "Comments", "Chats"]);
  expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
    "false",
    "true",
    "false",
    "false",
  ]);
  expect(container.querySelector("#workspace-files")?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector("#workspace-chats")?.hasAttribute("inert")).toBe(true);
  await act(async () =>
    tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[2]);
  expect(commentsPanel().hasAttribute("inert")).toBe(false);
  await settle(() => commentsPanel().textContent?.includes("Nine is early") === true);
  await act(async () =>
    tabs[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  expect(container.querySelector("#workspace-chats")?.hasAttribute("inert")).toBe(false);
  await act(async () => tabs[0]!.click());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("#workspace-files .file")]
      .find((node) => node.textContent === "readme.md")!
      .click(),
  );
  await settle(() => text().includes("Welcome."));
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
});

async function showComments() {
  await click("Comments");
  await settle(
    () =>
      commentsPanel().textContent?.includes("Nine is early") === true &&
      following("comments").length === 1,
  );
}

it("shows the open file's Comments at Comment and posts one on the file", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  await showComments();
  expect(following("comments")[0]!.url.searchParams.get("path")).toBe("trip/plan.md");
  expect(commentsPanel().querySelector("h2")?.textContent).toBe("Comments");
  expect(commentsPanel().textContent).toContain("plan.md");
  const box = commentsPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
  expect(box.getAttribute("aria-label")).toBe("Comment");
  expect(box.placeholder).toBe("Comment on this file…");
  setControlValue(box, "Ten, then");
  await act(async () =>
    commentsPanel().querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );
  await settle(() => posts.length === 1);
  expect(posts[0]).toMatchObject({
    shareId: "share",
    path: "trip/plan.md",
    body: "Ten, then",
    authorKind: "human",
  });
  expect(posts[0]).not.toHaveProperty("channelWireId");
  await settle(() => commentsPanel().textContent?.includes("Ten, then") === true);

  // Another file shows its own Comments.
  const tree = container.querySelector('nav[aria-label="Workspace files"]')!;
  await act(async () =>
    [...tree.querySelectorAll<HTMLButtonElement>(".file")]
      .find((node) => node.textContent === "to-pack.md")!
      .click(),
  );
  await settle(() => commentsPanel().textContent?.includes("No comments yet.") === true);
  await settle(
    () =>
      following("comments").length === 1 &&
      following("comments")[0]!.url.searchParams.get("path") === "trip/to-pack.md",
  );
});

it("shows a file's Comments at View with no comment controls", async () => {
  server({ level: "view" });
  await render();
  await opened();
  await showComments();
  expect(commentsPanel().querySelector("textarea, form")).toBeNull();
  expect(
    [...commentsPanel().querySelectorAll("button")].map((node) => node.textContent),
  ).not.toContain("Send");
  expect(commentsPanel().textContent).toContain("Only people who can comment post here.");
  // The lock says why there is no composer, as on the desktop.
  expect(
    commentsPanel().querySelector(".chat-read-only .chat-read-only-note .icon rect"),
  ).not.toBeNull();
});

it("copies a toast's text with the Copy button beside it", async () => {
  server({ level: "edit" });
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(openMemberPage).mockResolvedValue({ kind: "refused", code: "live_paused_by_owner" });
  await render();
  await settle(() => container.querySelector(".workspace-toast") !== null);
  const toast = container.querySelector<HTMLElement>(".workspace-toast")!;
  const copy = toast.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!;
  expect(copy).not.toBeNull();
  // Beside the text, before the actions.
  expect(copy.closest(".toast-text")).not.toBeNull();
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith(
    'dohc could not open "plan.md" for editing\nThe owner paused live editing for this page. You can still read it.',
  );
});

describe("deleting a Group message", () => {
  const history = {
    "wire-plans": [chat(3, "Plans start here"), chat(4, "Mine to take back", "sam")],
  };
  const deletes = () => [
    ...groupPanel().querySelectorAll<HTMLButtonElement>('button[aria-label="Delete message"]'),
  ];
  const dialog = () => container.querySelector<HTMLDialogElement>("dialog[open]");
  const inDialog = (label: string) =>
    [...dialog()!.querySelectorAll("button")].find((node) => node.textContent === label)!;
  async function settledOpen() {
    await settle(
      () =>
        text().includes("Mine to take back") &&
        text().includes("Plans start here") &&
        following("chat").length === 1,
    );
  }

  it("lets a member delete only their own message, says why a refused delete failed, and leaves the line", async () => {
    server({ history, deleteFails: 1 });
    await render();
    await settledOpen();
    expect(deletes()).toHaveLength(1);
    await act(async () => deletes()[0]!.click());
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Delete this message?");
    expect(dialog()!.querySelector(".chat-delete-quote")?.textContent).toBe("Mine to take back");
    expect(dialog()!.querySelector("#chat-delete-body")?.textContent).toContain(
      "This removes the message from this conversation for everyone. You can't undo it. People who already read it may keep a copy.",
    );
    // Delete takes focus, as on the desktop. A held Enter does nothing, and the arrows move between the buttons.
    expect(document.activeElement).toBe(inDialog("Delete"));
    const held = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    inDialog("Delete").dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    await act(async () =>
      inDialog("Delete").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(inDialog("Cancel"));
    await act(async () => inDialog("Delete").click());
    await settle(() => dialog()?.querySelector('[role="alert"]') !== null);
    const alert = dialog()!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(
      "dohc could not delete the message. It is gone, or your role does not let you delete it.",
    );
    expect(alert.classList.contains("chat-delete-error")).toBe(true);
    expect(alert.querySelector(".icon")).not.toBeNull();
    // Delete was disabled while it ran; Try again takes focus back.
    expect(document.activeElement).toBe(inDialog("Try again"));
    await act(async () => inDialog("Try again").click());
    await settle(() => dialog() === null && !text().includes("Mine to take back"));
    expect(posts.filter((post) => "deleted" in post)).toEqual([
      { deleted: { shareId: "share", threadId: "t4", messageId: "m4" } },
      { deleted: { shareId: "share", threadId: "t4", messageId: "m4" } },
    ]);
    // The desktop's line: the Ban mark before the words.
    const line = groupPanel().querySelector(".chat-deleted")!;
    expect(line.textContent).toBe("Message deleted");
    expect(line.querySelector(".icon circle")).not.toBeNull();
    expect(groupPanel().textContent).toContain("Plans start here");
    expect(deletes()).toHaveLength(0);
    // As on the desktop, the deleted line offers no Reply; Ana's post keeps hers.
    expect(groupPanel().querySelector('.chat-message[data-seq="4"] .chat-replies')).toBeNull();
    expect(
      groupPanel().querySelector('.chat-message[data-seq="3"] .chat-replies')?.textContent,
    ).toBe("Reply");
    // Its Delete has gone and no message follows, so focus goes to the composer, not the pane.
    expect(document.activeElement).toBe(groupPanel().querySelector(".chat-composer textarea"));
  });

  it("keeps a deleted post's replies link and puts focus on it", async () => {
    server({
      history: {
        "wire-plans": [
          chat(3, "Plans start here"),
          chat(4, "Mine to take back", "sam"),
          chat(5, "Noted", "ana", { threadId: "t4", startsPost: false }),
        ],
      },
    });
    await render();
    await settledOpen();
    await act(async () => deletes()[0]!.click());
    await act(async () => inDialog("Delete").click());
    await settle(() => dialog() === null && !text().includes("Mine to take back"));
    const replies = groupPanel().querySelector('.chat-message[data-seq="4"] .chat-replies');
    expect(replies?.textContent).toBe("1 reply");
    expect(document.activeElement).toBe(replies);
  });

  it("offers Delete on every message to the owner or an admin, and Cancel deletes nothing", async () => {
    server({ history, moderates: true });
    await render();
    await settledOpen();
    expect(deletes()).toHaveLength(2);
    await act(async () => deletes()[0]!.click());
    // Another person's message names its author.
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Delete Ana's message?");
    expect(dialog()!.querySelector(".chat-delete-quote")?.textContent).toBe("Plans start here");
    await act(async () => inDialog("Cancel").click());
    expect(dialog()).toBeNull();
    expect(posts.filter((post) => "deleted" in post)).toEqual([]);
    expect(text()).toContain("Plans start here");
    // Escape hands focus back to the Delete that opened the dialog.
    deletes()[1]!.focus();
    await act(async () => deletes()[1]!.click());
    expect(document.activeElement).toBe(inDialog("Delete"));
    await act(async () => dialog()!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(deletes()[1]);
  });

  it("removes a message another person deleted when the follow brings the delete", async () => {
    server({ history });
    await render();
    await settledOpen();
    await act(async () =>
      following("chat")[0]!.answer({
        shareId: "share",
        nextCursor: 22,
        hasMore: false,
        messages: [],
        deleted: [{ messageId: "m3", threadId: "t3", deletedAtMs: 21_000, relaySeq: 22 }],
      }),
    );
    await settle(() => !text().includes("Plans start here"));
    expect(groupPanel().textContent).toContain("Mine to take back");
  });

  it("keeps a message deleted when an older page read before the delete arrives after it", async () => {
    server({ history, older: { "wire-plans": [chat(2, "Deleted older text")] } });
    await render();
    await settledOpen();
    // The follow brings the delete of a message this page has not loaded yet.
    await act(async () =>
      following("chat")[0]!.answer({
        shareId: "share",
        nextCursor: 22,
        hasMore: false,
        messages: [],
        deleted: [{ messageId: "m2", threadId: "t2", deletedAtMs: 21_000, relaySeq: 22 }],
      }),
    );
    await click("Load earlier messages");
    await settle(() => groupPanel().querySelectorAll(".chat-message").length === 3);
    expect(groupPanel().textContent).not.toContain("Deleted older text");
    expect(groupPanel().textContent).toContain("Message deleted");
  });
});

// A folder rule gives a member a level on its files that can differ from the member level.
const badge = () => container.querySelector(".workspace-page .badge")?.textContent;
const commentBox = () => commentsPanel().querySelector('textarea[name="body"]');

it("opens the editor and the comment box where a rule gives a View member Edit, and says Can edit", async () => {
  server({ level: "view", fileLevels: { "trip/plan.md": "edit", "trip/to-pack.md": "edit" } });
  vi.mocked(openMemberPage).mockResolvedValue(ADMITTED);
  vi.mocked(memberDocument).mockReturnValue({ session: liveSession() as never, close: vi.fn() });
  await render();
  await settle(() => container.querySelector('[role="textbox"]') !== null);
  expect(vi.mocked(openMemberPage)).toHaveBeenCalledWith(
    { grantId: GRANT },
    "trip/plan.md",
    expect.any(AbortSignal),
  );
  expect(badge()).toBe("Can edit");
  await showComments();
  expect(commentBox()).not.toBeNull();
  // The member level still holds outside the folder.
  const tree = container.querySelector('nav[aria-label="Workspace files"]')!;
  await act(async () =>
    [...tree.querySelectorAll<HTMLButtonElement>(".file")]
      .find((node) => node.textContent === "readme.md")!
      .click(),
  );
  await settle(() => text().includes("Welcome.") && badge() === "View only");
  expect(commentBox()).toBeNull();
});

it("shows View only, no editor and no comment box where a rule lowers an Edit member to View", async () => {
  server({ level: "edit", fileLevels: { "trip/plan.md": "view" } });
  await render();
  await opened();
  expect(badge()).toBe("View only");
  expect(vi.mocked(openMemberPage)).not.toHaveBeenCalled();
  await click("Comments");
  await settle(() => commentsPanel().textContent?.includes("Nine is early") === true);
  expect(commentBox()).toBeNull();
});

it("reads the files again when a rule changes between reads, so a folder that opened shows its files at their level", async () => {
  const options: { level: Level; files?: typeof FILES; fileLevels?: Record<string, Level> } = {
    level: "comment",
    files: FILES.filter((file) => !file.path.startsWith("welcome/")),
  };
  server(options);
  await render();
  await opened();
  expect(text()).not.toContain("readme.md");
  // The owner opened a folder and lowered another between two reads. Its files are older than the log's cursor.
  options.files = FILES;
  options.fileLevels = { "trip/plan.md": "view" };
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => text().includes("readme.md") && badge() === "View only");
  await settle(() => following("log").length === 1);
});

it("keeps the workspace open when a rule change refuses the held read, and shows what the fresh read brings", async () => {
  const options: { level: Level; files?: typeof FILES } = { level: "comment" };
  server(options);
  await render();
  await opened();
  // The owner hid a folder. The relay refuses the read it held, as it would for a lost membership.
  options.files = FILES.filter((file) => !file.path.startsWith("welcome/"));
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => !text().includes("readme.md") && following("log").length === 1);
  expect(text()).not.toContain("membership");
  expect(text()).toContain("Leave at nine.");
});

it("treats an open file's Comments going away as the file gone, not the membership, and reads the files again", async () => {
  const options: { level: Level; files?: typeof FILES } = { level: "comment" };
  server(options);
  await render();
  await opened();
  await showComments();
  // The owner moved the file into a hidden folder while its Comments were open.
  options.files = FILES.filter((file) => file.path !== "trip/plan.md");
  await act(async () => following("comments")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(
    () =>
      !text().includes("plan.md") &&
      commentsPanel().textContent?.includes("No comments yet.") === true,
  );
  expect(text()).not.toContain("membership");
  expect(commentsPanel().textContent).toContain("to-pack.md");
});

it("treats an open Group going away as the Group gone, not the membership, and lists the rest", async () => {
  const options: {
    level: Level;
    groups?: Array<{ wire: string; name: string }>;
  } = { level: "comment" };
  server(options);
  await render();
  await opened();
  const composer = () => groupPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]');
  await act(async () => setControlValue(composer()!, "Bring a map"));
  // The owner deleted the open Group. The post comes back 404.
  options.groups = [{ wire: "wire-food", name: "food" }];
  await act(async () =>
    groupPanel().querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );
  await settle(
    () =>
      groupPanel().querySelector(".group-list") !== null &&
      !groupPanel().textContent?.includes("plans"),
  );
  expect(text()).not.toContain("membership");
  expect(text()).toContain("Leave at nine.");
});

it("says the session ended, not the membership, when it ends while the page is open", async () => {
  const options: { level: Level; expired?: boolean } = { level: "comment" };
  server(options);
  await render();
  await opened();
  options.expired = true;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => text().includes("Your session ended. Sign in again to keep reading."));
  expect(text()).not.toContain("membership");
});

// A Group rule gives a member a level in that Group that can differ from the member level.
type GroupRules = Record<string, "read-only" | "read-write" | "none">;
const groupComposer = () =>
  groupPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]');

it("offers the message box to a View member in a Group set to Can post", async () => {
  server({ level: "view", groupRules: { "wire-plans": "read-write" } });
  await render();
  await opened();
  expect(groupComposer()).not.toBeNull();
  expect(groupPanel().textContent).not.toContain("Only people who can comment post here.");
});

it("offers no message box to a Comment member in a Group set to View only", async () => {
  server({ level: "comment", groupRules: { "wire-plans": "read-only" } });
  await render();
  await opened();
  expect(groupComposer()).toBeNull();
  // The member can comment, so the Group's own rule is why, and the note says who posts.
  expect(groupPanel().textContent).toContain("Only admins and the owner post in plans.");
  expect(groupPanel().textContent).not.toContain("Only people who can comment post here.");
});

it("follows a Group's own level when its rule changes while it is open, and keeps the draft", async () => {
  const options: { level: Level; groupRules?: GroupRules } = { level: "comment" };
  server(options);
  await render();
  await opened();
  await act(async () => setControlValue(groupComposer()!, "Bring a map"));
  // The owner set the open Group to View only. The member level stays Comment.
  options.groupRules = { "wire-plans": "read-only" };
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => groupComposer() === null);
  expect(
    groupPanel().querySelector<HTMLTextAreaElement>('[aria-label="Your unsent message"]')?.value,
  ).toBe("Bring a map");
  expect(text()).toContain("Plans start here");
  // Set back to Can post, the box returns with the draft.
  options.groupRules = { "wire-plans": "read-write" };
  await settle(() => following("log").length === 1);
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 8, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => groupComposer()?.value === "Bring a map");
});

it("treats an open Group set to No access as gone, not the membership, without waiting for the Groups to age", async () => {
  const options: { level: Level; groupRules?: GroupRules } = { level: "comment" };
  server(options);
  await render();
  await opened();
  // The owner hid the open Group. The relay refuses the files' held read, as for any rule change.
  options.groupRules = { "wire-plans": "none" };
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(
    () =>
      groupPanel().querySelector(".group-list") !== null &&
      !groupPanel().textContent?.includes("plans") &&
      groupPanel().textContent?.includes("food") === true,
  );
  expect(text()).not.toContain("membership");
  expect(text()).toContain("Leave at nine.");
});

it("keeps an Edit workspace open when the read that catches its files up fails while its grant still opens", async () => {
  const options: { level: Level; catchUpFails?: boolean } = { level: "edit" };
  await editing(options);
  const dated = () => container.querySelector<HTMLElement>("header .workspace-dated");
  // A rule change refuses the held read. The fresh list arrives, but the log read after it fails.
  options.catchUpFails = true;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => dated() !== null);
  expect(text()).not.toContain("membership");
  expect(container.querySelector('[role="textbox"]')).not.toBeNull();
  options.catchUpFails = false;
  await settle(() => dated() === null && following("log").length === 1);
});

it("says another account signed in, not that the membership ended, when another tab switches accounts", async () => {
  writeDraft(
    "unsent-edits",
    JSON.stringify([{ id: 1, accountId: "sam", path: "trip/plan.md", text: "Bring the tickets." }]),
  );
  const options: { level: Level; memberOf: string; user?: string } = {
    level: "comment",
    memberOf: "sam",
  };
  server(options);
  await render();
  await opened();
  expect(recovery()!.querySelector("textarea")?.value).toBe("Bring the tickets.");
  // Another tab signed this browser in as Lee. Sam's grant now refuses every read.
  options.user = "lee";
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => text().includes("This browser is now signed in as Lee Park."));
  expect(container.querySelector(".state-message p")?.textContent).toBe(
    "Sign in as Sam Rivera to keep working in Trip.",
  );
  expect(text()).not.toContain("membership");
  expect(text()).not.toContain("Leave at nine.");
  // Lee sees none of Sam's kept edits, here or on the sign-in form.
  expect(recovery()).toBeNull();
  expect(container.innerHTML).not.toContain("Bring the tickets.");
  await click("Switch account");
  await settle(() => text().includes("Sign in to open this workspace"));
  expect(recovery()).toBeNull();
  expect(container.innerHTML).not.toContain("Bring the tickets.");
  // Sam's edits are still kept, and come back once Sam signs in again.
  options.user = "sam";
  held = [];
  await act(async () => {
    setControlValue(container.querySelector('input[name="email"]')!, "sam@dohc.test");
    setControlValue(container.querySelector('input[name="password"]')!, "secret");
  });
  await click("Sign in");
  await opened();
  expect(recovery()!.querySelector("textarea")?.value).toBe("Bring the tickets.");
});

it("offers Try again, not an ended membership, when it cannot check the account after a refusal", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const options: { level: Level; member?: boolean; sessionFails?: boolean } = {
    level: "comment",
  };
  server(options);
  await render();
  await opened();
  const dated = () => container.querySelector<HTMLElement>("header .workspace-dated");
  const toast = () =>
    [...container.querySelectorAll<HTMLElement>(".workspace-toast")].find((node) =>
      node.textContent?.includes("dohc could not update this workspace's files"),
    );
  options.member = false;
  options.sessionFails = true;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => dated() !== null);
  for (const wait of [1000, 2000]) await act(async () => vi.advanceTimersByTime(wait));
  await settle(() => toast() !== undefined);
  expect(text()).not.toContain("membership");
  expect(text()).toContain("Leave at nine.");
  options.member = true;
  options.sessionFails = false;
  await act(async () =>
    [...toast()!.querySelectorAll("button")]
      .find((node) => node.textContent === "Try again")!
      .click(),
  );
  await settle(() => dated() === null && toast() === undefined && following("log").length === 1);
});

it("says a workspace too large for a browser is too large, and names the desktop app", async () => {
  server({ level: "comment", tooLarge: true });
  await render();
  await settle(() => text().includes("This workspace is too large to open in a browser."));
  expect(container.querySelector(".state-message p")?.textContent).toBe(
    "Open it in the dohc desktop app.",
  );
  expect(text()).not.toContain("invite");
});

it("says the workspace grew too large for a browser, not that the membership ended", async () => {
  const options: { level: Level; tooLarge?: boolean } = { level: "comment" };
  server(options);
  await render();
  await opened();
  options.tooLarge = true;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => text().includes("This workspace is too large to open in a browser."));
  expect(text()).not.toContain("membership");
});

it("stops offering the old level's controls when the level changes and the files cannot read again", async () => {
  const options: { level: Level; currentRefused?: boolean } = { level: "comment" };
  server(options);
  await render();
  await opened();
  await click("Comments");
  await settle(() => commentBox() !== null);
  // The owner lowered the members to View, and the relay refuses the fresh file list while the grant still opens.
  options.level = "view";
  options.currentRefused = true;
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => text().includes("dohc could not open this workspace."));
  expect(container.querySelector('textarea[name="body"]')).toBeNull();
  expect(text()).not.toContain("Can comment");
  expect(text()).not.toContain("membership");
  // Try again opens the workspace at its new level once the files read.
  options.currentRefused = false;
  await click("Try again");
  await settle(() => text().includes("Leave at nine.") && badge() === "View only");
});

it("opens a replaced file's own Comments, not its predecessor's", async () => {
  const options: { level: Level; files?: typeof FILES } = { level: "comment" };
  server(options);
  await render();
  await opened();
  await showComments();
  expect(commentsPanel().textContent).toContain("Nine is early");
  const box = () => commentsPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
  await settle(() => commentBox() !== null);
  setControlValue(box(), "Meant for the old plan");
  // The owner put a different file at the same path. The old file's follow ends.
  const before = options.files;
  options.files = FILES.map((file) =>
    file.path === "trip/plan.md"
      ? { ...file, objectId: `share-object:v1:${"4".repeat(64)}`, blobSha256: "c".repeat(64) }
      : file,
  );
  await act(async () => following("comments")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(
    () =>
      text().includes("Welcome.") &&
      commentsPanel().textContent?.includes("No comments yet.") === true &&
      following("comments").length === 1,
  );
  expect(commentsPanel().textContent).not.toContain("Nine is early");
  expect(text()).not.toContain("membership");
  // The draft typed on the old file stays with it, so Send cannot post it to the new one.
  expect(box().value).toBe("");
  // The old file coming back brings its draft back.
  options.files = before;
  await act(async () => following("comments")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => commentsPanel().textContent?.includes("Nine is early") === true);
  await settle(() => box().value === "Meant for the old plan");
});

it.each(["currentRefused", "currentUnreachable"] as const)(
  "stops offering the old level's controls when a level change refuses the held read and the files then fail (%s)",
  async (failure) => {
    const options: {
      level: Level;
      currentRefused?: boolean;
      currentUnreachable?: boolean;
    } = { level: "comment" };
    server(options);
    await render();
    await opened();
    await click("Comments");
    await settle(() => commentBox() !== null);
    // The owner lowered the members to View. The relay refuses the read it held, and the fresh file list fails.
    options.level = "view";
    options[failure] = true;
    await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
    await settle(() => text().includes("dohc could not open this workspace."));
    expect(container.querySelector('textarea[name="body"]')).toBeNull();
    expect(text()).not.toContain("Can comment");
    options[failure] = false;
    await click("Try again");
    await settle(() => text().includes("Leave at nine.") && badge() === "View only");
  },
);

it("goes by the grant's first answer when a later read of it fails after a level change", async () => {
  const options: { level: Level; currentRefused?: boolean; metaAnswers?: number } = {
    level: "comment",
  };
  server(options);
  await render();
  await opened();
  await click("Comments");
  await settle(() => commentBox() !== null);
  // The grant answers once, at View, and its next read fails.
  options.level = "view";
  options.currentRefused = true;
  options.metaAnswers = 1;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => text().includes("dohc could not open this workspace."));
  expect(container.querySelector('textarea[name="body"]')).toBeNull();
  options.currentRefused = false;
  options.metaAnswers = undefined;
  await click("Try again");
  await settle(() => text().includes("Leave at nine.") && badge() === "View only");
});

it("asks the grant when the file poll fails, and opens the new level it reports", async () => {
  const options: { level: Level } = { level: "comment" };
  server(options);
  await render();
  await opened();
  await click("Comments");
  await settle(() => commentBox() !== null);
  // The owner lowered the members to View, and the poll that would have said so failed.
  options.level = "view";
  await act(async () => following("log")[0]!.answer({ ok: false, error: "unavailable" }, 503));
  await settle(() => text().includes("Leave at nine.") && badge() === "View only");
  expect(container.querySelector('textarea[name="body"]')).toBeNull();
});

it("stops editing when the files read again at a lower level but their catch-up fails", async () => {
  const options: { level: Level; catchUpFails?: boolean } = { level: "edit" };
  await editing(options);
  options.level = "view";
  options.catchUpFails = true;
  await act(async () => following("log")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => container.querySelector('[role="textbox"]') === null && recovery() !== null);
  expect(text()).not.toContain("membership");
});

it("keeps each file's comment draft apart when the relay lists files without their identity", async () => {
  // A development relay without a link key lists files with no object identity.
  server({
    level: "comment",
    files: FILES.map(({ objectId: _, ...file }) => file) as typeof FILES,
  });
  await render();
  await settle(() => text().includes("Leave at nine."));
  await click("Comments");
  const box = () => commentsPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]');
  await settle(() => box() !== null);
  setControlValue(box()!, "About the plan");
  await act(async () =>
    [...container.querySelectorAll<HTMLElement>(".file")]
      .find((node) => node.textContent === "to-pack.md")!
      .click(),
  );
  await settle(() => text().includes("Fuel and food.") && box() !== null);
  expect(box()!.value).toBe("");
});

it("follows a file's Comments again once the files read again still list it", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  await showComments();
  // The follow came back 404, but the file is still there.
  await act(async () => following("comments")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => following("comments").length === 1);
  expect(commentsPanel().textContent).toContain("Nine is early");
  expect(text()).not.toContain("membership");
});

it("opens a replaced file's own Comments when the files read again, before its old follow ends", async () => {
  const options: { level: Level; files?: typeof FILES; fileLevels?: Record<string, Level> } = {
    level: "comment",
  };
  server(options);
  await render();
  await opened();
  await showComments();
  // The owner put a different file at the same path and changed a rule, so the files read again.
  options.files = FILES.map((file) =>
    file.path === "trip/plan.md"
      ? { ...file, objectId: `share-object:v1:${"4".repeat(64)}`, blobSha256: "c".repeat(64) }
      : file,
  );
  options.fileLevels = { "welcome/readme.md": "view" };
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(
    () =>
      text().includes("Welcome.") &&
      commentsPanel().textContent?.includes("No comments yet.") === true,
  );
  expect(commentsPanel().textContent).not.toContain("Nine is early");
});

it("applies a rule change that lands while the first read of the Groups is still out", async () => {
  const options: { level: Level; groupRules?: GroupRules; holdGroups: number } = {
    level: "comment",
    holdGroups: 1,
  };
  server(options);
  await render();
  await settle(
    () =>
      text().includes("Leave at nine.") &&
      following("log").length === 1 &&
      held.some((item) => item.path === "groups"),
  );
  const first = held.find((item) => item.path === "groups")!;
  // The owner set the Group to View only. The files read again before the first listing arrives.
  options.groupRules = { "wire-plans": "read-only" };
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => following("log").length === 1);
  // The listing sent before the change arrives last.
  await act(async () => first.answer(first.body));
  await settle(
    () => groupPanel().textContent?.includes("Only admins and the owner post in plans.") === true,
  );
  expect(groupComposer()).toBeNull();
});

it("follows the Groups again once the Groups read again after their follow came back 404", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  // The follow came back 404, but the membership and the Group are still there.
  await act(async () => following("chat")[0]!.answer({ ok: false, error: "not found" }, 404));
  await settle(() => following("chat").length === 1);
  expect(groupPanel().textContent).toContain("Plans start here");
  expect(text()).not.toContain("membership");
});

it("follows the Groups again from All Groups, with no Group open, after their follow came back 404", async () => {
  server({ level: "comment" });
  await render();
  await opened();
  await act(async () =>
    following("chat")[0]!.answer({
      shareId: "share",
      nextCursor: 22,
      hasMore: false,
      messages: [],
    }),
  );
  await settle(() => following("chat").length === 1);
  await click("All Groups");
  await settle(() => groupPanel().querySelector("h2")?.textContent === "Groups");
  await act(async () => following("chat")[0]!.answer({ ok: false, error: "not found" }, 404));
  // The new follow starts where the last one stopped, so the list still counts new messages.
  await settle(() => following("chat").length === 1);
  expect(following("chat")[0]!.url.searchParams.get("since")).toBe("22");
  await act(async () =>
    following("chat")[0]!.answer({
      shareId: "share",
      nextCursor: 24,
      hasMore: false,
      messages: [{ ...chat(23, "Bring snacks too"), channelWireId: "wire-food" }],
    }),
  );
  await settle(
    () =>
      buttons().find((node) => node.textContent?.startsWith("food"))?.textContent ===
      "food1 unread",
  );
  expect(text()).not.toContain("membership");
});

it("reads the Groups once when the relay refuses them while the workspace still opens", async () => {
  const fetch = server({ level: "comment", groupsGone: true });
  await render();
  const currentReads = () =>
    fetch.mock.calls.filter(
      ([input]) => new URL(String(input), "https://share.test").pathname === "/api/view/current",
    ).length;
  // The refusal asks the page to read the files again. That read opens, so the Groups keep their Try again.
  await settle(
    () =>
      currentReads() === 2 &&
      following("log").length === 1 &&
      groupPanel().querySelector(".load-failed") !== null,
  );
  expect(channelReads(fetch)).toBe(1);
  expect(text()).not.toContain("membership");
});

describe("the owner's page", () => {
  const OWNER = { kind: "owner", workspaceId: "ws-1" } as const,
    OWNER_SESSION = "owner.ws-1";
  const paths = (fetch: ReturnType<typeof server>) =>
    fetch.mock.calls.map(([input]) => new URL(String(input), "https://share.test").pathname);

  it("reads the files with the owner's session, opens Markdown live as the owner, and reads the Groups by workspace", async () => {
    const fetch = server({ level: "edit", session: OWNER_SESSION });
    const admitted = {
      kind: "owner",
      objectId: "object-plan",
      lineageClaimId: "c".repeat(64),
      token: "ab".repeat(32),
      limits: {},
    } as const;
    vi.mocked(openMemberPage).mockResolvedValue(admitted);
    vi.mocked(memberDocument).mockReturnValue({ session: liveSession() as never, close: vi.fn() });
    await render(OWNER);
    await settle(() => container.querySelector('[role="textbox"]') !== null);
    expect(container.querySelector(".workspace-name")?.textContent).toBe("Trip");
    expect(container.querySelector(".badge")?.textContent).toBe("Owner");
    expect(vi.mocked(openMemberPage)).toHaveBeenCalledWith(
      { workspaceId: "ws-1" },
      "trip/plan.md",
      expect.any(AbortSignal),
    );
    expect(vi.mocked(memberDocument)).toHaveBeenCalledWith(
      expect.objectContaining({ target: { workspaceId: "ws-1" }, admission: admitted }),
    );
    await settle(() => groupPanel().textContent!.includes("plans"));
    expect(
      [...container.querySelectorAll('.side-tabs [role="tab"], .workspace-tabs [role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["Comments", "Chats"]);
    const all = container.querySelector<HTMLAnchorElement>('a[aria-label="All workspaces"]');
    expect(all?.getAttribute("href")).toBe("/workspaces");
    const views = fetch.mock.calls.filter(([input]) =>
      new URL(String(input), "https://share.test").pathname.startsWith("/api/view/"),
    );
    expect(views.length).toBeGreaterThan(0);
    for (const [input, init] of views)
      expect(
        new Headers(init?.headers).get("x-dohc-link-session") ??
          new URL(String(input), "https://share.test").searchParams.get("session"),
      ).toBe(OWNER_SESSION);
    expect(paths(fetch).filter((path) => path.startsWith("/api/live"))).toEqual([]);
    const listings = fetch.mock.calls
      .map(([input]) => new URL(String(input), "https://share.test"))
      .filter((url) => url.pathname === "/api/named-chat/channels");
    expect(listings.map((url) => url.search)).toEqual(["?workspaceId=ws-1"]);
  });

  const wakeReads = () => posts.filter((post) => "wakes" in post).map((post) => post.wakes);
  const wake = (state: string) => ({ wakeId: "w-1", state, agentName: "Claude" });
  async function ownerPost(options: Parameters<typeof server>[0]) {
    server({ level: "edit", session: OWNER_SESSION, shareId: "owner:ws-1", ...options });
    vi.mocked(openMemberPage).mockResolvedValue({ kind: "refused", code: "paused" });
    await render(OWNER);
    await settle(() => groupPanel().textContent!.includes("Plans start here"));
    setControlValue(
      groupPanel().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!,
      "@claude plan it",
    );
    await click("Send");
  }

  it("shows the owner where the agent their post woke stands, until it starts or fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const plans: unknown[] = [chat(3, "Plans start here")];
    await ownerPost({
      history: { "wire-plans": plans },
      wakes: [[wake("waiting")], [wake("claimed")], [wake("unclaimed")]],
    });
    const line = () => groupPanel().querySelector(".chat-wake")?.textContent;
    await settle(() => groupPanel().textContent!.includes("@claude plan it"));
    await act(async () => vi.advanceTimersByTime(2_000));
    await settle(() => line() === "Claude is waiting for a computer");
    expect(
      groupPanel().querySelector(".chat-wake")?.closest(".chat-message")?.textContent,
    ).toContain("@claude plan it");
    expect(wakeReads()).toEqual([
      {
        shareId: "owner:ws-1",
        channelWireId: "wire-plans",
        threadId: expect.any(String),
        messageId: expect.any(String),
      },
    ]);
    // A hidden tab reads nothing, and reads again once it shows.
    const visibility = (state: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    visibility("hidden");
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(wakeReads()).toHaveLength(1);
    await act(async () => visibility("visible"));
    await settle(() => line() === "Claude is starting on a computer");
    // Another Group and back keeps the line, and reads on. The Group's history now holds the post.
    plans.unshift(chat(40, "@claude plan it", "sam"));
    await click("All Groups");
    await act(async () =>
      buttons()
        .find((node) => node.textContent?.startsWith("food"))!
        .click(),
    );
    await settle(() => groupPanel().querySelector("h2")?.textContent === "food");
    expect(groupPanel().querySelector(".chat-wake")).toBeNull();
    await click("All Groups");
    await act(async () =>
      buttons()
        .find((node) => node.textContent?.startsWith("plans"))!
        .click(),
    );
    await act(async () => vi.advanceTimersByTime(2_000));
    await settle(() => line() === "Claude didn't start");
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(wakeReads()).toHaveLength(3);
  });

  it("reads a post's wakes 2 seconds after it, so a computer that is on shows it starting, never waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ownerPost({
      user: "lee",
      history: { "wire-plans": [chat(3, "Plans start here")] },
      wakes: [[wake("claimed")], [wake("unclaimed")]],
    });
    const line = () => groupPanel().querySelector(".chat-wake")?.textContent;
    await settle(() => groupPanel().textContent!.includes("@claude plan it"));
    await act(async () => vi.advanceTimersByTime(1_999));
    expect(wakeReads()).toEqual([]);
    expect(line()).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(1));
    await settle(() => line() === "Claude is starting on a computer");
    await act(async () => vi.advanceTimersByTime(1_999));
    expect(wakeReads()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1));
    await settle(() => line() === "Claude didn't start");
  });

  it("stops reading a post's wakes once the owner deletes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ownerPost({ user: "kim", moderates: true, wakes: [[wake("waiting")]] });
    const post = () =>
      [...groupPanel().querySelectorAll(".chat-message")].find((node) =>
        node.textContent?.includes("@claude plan it"),
      );
    await settle(() => post() !== undefined);
    await act(async () => vi.advanceTimersByTime(2_000));
    await settle(() => post()?.querySelector(".chat-wake") != null);
    await act(async () =>
      post()!.querySelector<HTMLButtonElement>('button[aria-label="Delete message"]')!.click(),
    );
    const confirm = [...container.querySelectorAll("dialog[open] button")].find(
      (node) => node.textContent === "Delete",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    await settle(() => post() === undefined && groupPanel().querySelector(".chat-wake") === null);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(wakeReads()).toHaveLength(1);
  });

  it("tells the owner a post would start too many agents, with no Try again", async () => {
    await ownerPost({ user: "ana", postFails: { status: 400, code: "too_many_wakes" } });
    await settle(() =>
      groupPanel().textContent!.includes(
        "dohc could not send this message. It would start too many agents on your computers. Mention fewer agents.",
      ),
    );
    expect(
      [...groupPanel().querySelectorAll("button")].some((node) => node.textContent === "Try again"),
    ).toBe(false);
    expect(wakeReads()).toEqual([]);
  });

  it("tells the owner to open a page on a computer first, in the band alone", async () => {
    server({ level: "edit", session: OWNER_SESSION });
    vi.mocked(openMemberPage).mockResolvedValue({
      kind: "refused",
      code: "live-document-without-lineage",
    });
    await render(OWNER);
    const sentence = "Open this page on a computer once to edit it here. You can still read it.";
    await settle(() => container.querySelector("header + .page-band [role=status]") !== null);
    expect(container.querySelector("header + .page-band [role=status]")?.textContent).toBe(
      sentence,
    );
    expect(container.querySelector(".workspace-toast")).toBeNull();
    expect(
      [...container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Try again",
      ),
    ).toHaveLength(1);
    expect(text()).toContain("Leave at nine.");
    expect(vi.mocked(memberPageReady)).not.toHaveBeenCalled();
  });

  // `paused` is the relay's answer to the owner's open of a paused page (phonePages.test.ts).
  it.each([
    ["paused", "Live editing is paused for this page. Resume it in dohc to edit here."],
    [
      "conflict-parent-withheld",
      "A conflict was resolved in this page, so live editing can't resume. Open Live documents in dohc to make a copy that can go live.",
    ],
    [
      "session-host-diverged",
      "The server's copy of this workspace no longer matches the synced one, so live editing stopped. Contact the server's operator.",
    ],
    [
      "note-format-off",
      "The server turned off the newer note format this page uses. Ask the server's operator to turn it back on.",
    ],
  ])("tells the owner why a page refused with %s", async (code, sentence) => {
    server({ level: "edit", session: OWNER_SESSION });
    vi.mocked(openMemberPage).mockResolvedValue({ kind: "refused", code });
    await render(OWNER);
    await settle(() => container.querySelector("header + .page-band [role=status]") !== null);
    expect(container.querySelector("header + .page-band [role=status]")?.textContent).toBe(
      `${sentence} You can still read it.`,
    );
  });

  it("leaves the page to read, with no toast or Try again, on a server that edits no pages live", async () => {
    server({ level: "edit", session: OWNER_SESSION });
    vi.mocked(openMemberPage).mockResolvedValue({
      kind: "refused",
      code: "live_hosting_unsupported",
    });
    await render(OWNER);
    await settle(() => vi.mocked(openMemberPage).mock.calls.length === 1);
    await settle(() => !container.querySelector(".named-document-status"));
    expect(text()).toContain("Leave at nine.");
    expect(container.querySelector(".workspace-toast")).toBeNull();
    expect(container.querySelector("header + .page-band")?.textContent ?? "").toBe("");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Try again",
      ),
    ).toBe(false);
  });

  it("keeps opening the owner's page while the server prepares it, with no toast", async () => {
    server({ level: "edit", session: OWNER_SESSION });
    vi.mocked(openMemberPage).mockResolvedValue({ kind: "preparing" });
    await render(OWNER);
    await settle(() => vi.mocked(openMemberPage).mock.calls.length === 1);
    expect(container.querySelector(".named-document-status")?.textContent).toBe(
      "Opening the file…",
    );
    expect(container.querySelector(".workspace-toast")).toBeNull();
    expect(container.querySelector("header + .page-band [role=status]")).toBeNull();
    expect(vi.mocked(memberPageReady)).not.toHaveBeenCalled();
  });

  it("shows Files, Page, Comments and Chats on a phone", async () => {
    narrow = true;
    server({ level: "edit", session: OWNER_SESSION });
    await render(OWNER);
    await settle(() => text().includes("Leave at nine."));
    expect(
      [...container.querySelectorAll('.side-tabs [role="tab"], .workspace-tabs [role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["Files", "Page", "Comments", "Chats"]);
  });

  it("asks a signed-out browser to sign in with the account that owns the workspace", async () => {
    server({ signedIn: false, level: "edit", session: OWNER_SESSION });
    await render(OWNER);
    await settle(() => Boolean(container.querySelector('input[name="email"]')));
    expect(container.querySelector(".state-message h1")?.textContent).toBe(
      "Sign in to open this workspace",
    );
    expect(text()).toContain("Use the account that owns this workspace.");
    expect(text()).not.toContain("invited");
    expect(container.querySelector('a[href^="/account/sign-up"]')).toBeNull();
  });

  it("refuses an account that does not own the workspace and offers Switch account", async () => {
    server({ member: false, session: OWNER_SESSION });
    await render(OWNER);
    await settle(() => text().includes("dohc could not open this workspace with this account."));
    expect(container.querySelector(".state-message p")?.textContent).toBe(
      "This browser is signed in as Sam Rivera. Switch to the account that owns this workspace.",
    );
    expect(button("Switch account")).toBeDefined();
  });
});

describe("the list of workspaces", () => {
  const LIST = { kind: "list" } as const;
  const WORKSPACES = {
    ok: true,
    owned: [
      { workspaceId: "ws:1", name: "Trip" },
      { workspaceId: "ws-3", name: null },
    ],
    joined: [{ workspaceId: "ws-9", name: "Fundraiser", grantId: "grant-9" }],
  };
  const rows = (heading: string) =>
    [...container.querySelectorAll("section")]
      .find((section) => section.querySelector("h2")?.textContent === heading)!
      .querySelectorAll("li");

  it("links each owned and joined workspace to its page", async () => {
    server({ workspaces: WORKSPACES });
    await render(LIST);
    await settle(() => text().includes("Joined"));
    const owned = [...rows("Your workspaces")];
    expect(owned.map((row) => row.querySelector("a")?.getAttribute("href") ?? null)).toEqual([
      "/s/workspace/owner/ws%3A1",
      "/s/workspace/owner/ws-3",
    ]);
    expect(owned[1]!.textContent).toBe("Unnamed workspace");
    const joined = [...rows("Joined")];
    expect(joined.map((row) => row.querySelector("a")?.getAttribute("href"))).toEqual([
      "/s/workspace/grant-9",
    ]);
    expect(joined[0]!.textContent).toBe("Fundraiser");
    expect(text()).toContain("Signed in as Sam Rivera");
    await click("Sign out");
    await settle(() => text().includes("Sign in to see your workspaces"));
  });

  it("says when the account has no workspaces", async () => {
    server();
    await render(LIST);
    await settle(() => text().includes("No workspaces on this account yet."));
    expect(container.querySelector("section")).toBeNull();
  });

  it("asks a signed-out browser to sign in, then lists its workspaces", async () => {
    server({ signedIn: false, workspaces: WORKSPACES });
    await render(LIST);
    await settle(() => Boolean(container.querySelector('input[name="email"]')));
    expect(container.querySelector(".state-message h1")?.textContent).toBe(
      "Sign in to see your workspaces",
    );
    expect(container.querySelector(".state-message p:not(.join-aside)")).toBeNull();
    // An invitation email opens this page, so someone new can create an account and come back.
    expect(container.querySelector('a[href^="/account/sign-up"]')?.getAttribute("href")).toBe(
      "/account/sign-up?next=%2Fworkspaces",
    );
    await act(async () => {
      setControlValue(container.querySelector('input[name="email"]')!, "sam@dohc.test");
      setControlValue(container.querySelector('input[name="password"]')!, "secret");
    });
    await click("Sign in");
    await settle(() => text().includes("Fundraiser"));
  });

  it("says when the list could not load, with copy and Try again", async () => {
    server({ workspaces: WORKSPACES, workspacesFail: 1 });
    await render(LIST);
    await settle(() => container.querySelector('.load-failed[role="alert"]') !== null);
    expect(text()).toContain("dohc could not load your workspaces. Check your connection.");
    expect(button("Copy message")).toBeDefined();
    await click("Try again");
    await settle(() => text().includes("Fundraiser"));
  });
});

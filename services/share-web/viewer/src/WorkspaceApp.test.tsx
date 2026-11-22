// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment, markdownToYDoc } from "@dohc/ydoc-projection";
import type { NamedLiveBrowserState } from "@dohc/ydoc-projection/named-live-browser-transport";
import WorkspaceApp from "./WorkspaceApp";
import { memberDocument, memberPageReady, openMemberPage } from "./memberLive";
import "./MemberLivePage";
import { jsonResponse, setControlValue, settle } from "./testing";
import { writeDraft } from "./drafts";

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
    objectId: "object-plan",
    blobSha256: "a".repeat(64),
    contentKind: "text",
  },
  {
    path: "trip/to-pack.md",
    objectId: "object-pack",
    blobSha256: "b".repeat(64),
    contentKind: "text",
  },
  {
    path: "welcome/readme.md",
    objectId: "object-readme",
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
    openHeld?: boolean;
    user?: string;
    signOutFails?: boolean;
  } = {},
) {
  let signedIn = options.signedIn ?? true,
    groupsFail = options.groupsFail ?? 0;
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
  const hold = (path: string, url: URL, signal: AbortSignal) =>
    new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
      const item: Held = {
        path,
        url,
        signal,
        answer: (value, status = 200) => {
          held.splice(held.indexOf(item), 1);
          resolve(jsonResponse(value, status));
        },
      };
      held.push(item);
    });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://share.test"),
      signal = init?.signal ?? new AbortController().signal;
    const headers = new Headers(init?.headers);
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
    // share-web gives an account that holds no membership the answer it gives an unknown grant.
    if (
      (options.member === false || options.expired) &&
      (url.pathname.startsWith("/api/view/") || url.pathname.startsWith("/api/named-chat/"))
    )
      return jsonResponse({ ok: false, error: "not found" }, 404);
    if (url.pathname.startsWith("/api/view/")) {
      expect(headers.get("x-dohc-link-session") ?? url.searchParams.get("session")).toBe(SESSION);
      if (url.pathname === "/api/view/current" && options.openHeld)
        return hold("current", url, signal);
      if (url.pathname === "/api/view/current")
        return jsonResponse({ ...meta(), files: files(), nextCursor: 7, epochLogFloor: 0 });
      if (url.pathname === "/api/view/meta") return jsonResponse(meta());
      if (url.pathname === "/api/view/log")
        return url.searchParams.has("hold")
          ? hold("log", url, signal)
          : jsonResponse({ ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0 });
      const sha = url.pathname.slice("/api/view/blob/".length);
      return new Response(TEXT[sha] ?? "", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/api/named-chat/channels" && groupsFail > 0) {
      groupsFail -= 1;
      return jsonResponse({ ok: false, error: "unavailable" }, 503);
    }
    if (url.pathname === "/api/named-chat/channels")
      return jsonResponse({
        shareId: "share",
        userId: user(),
        maxPostBytes: 9000,
        maxBodyBytes: 8000,
        channels: groups().map((group) => ({
          channelWireId: group.wire,
          name: group.name,
          kind: "channel",
          type: group.type ?? "both",
          access: options.groupRules?.[group.wire] ?? access(),
        })),
      });
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
        shareId: "share",
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
        shareId: "share",
        path,
        nextCursor: 30,
        olderCursor: null,
        messages: path === "trip/plan.md" ? [chat(9, "Nine is early")] : [],
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
          shareId: "share",
          channelWireId: wire,
          nextCursor: 20,
          olderCursor: null,
          messages: older ?? [],
        });
      return jsonResponse({
        shareId: "share",
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
async function render(grantId: string | null = GRANT) {
  await act(async () => root.render(<WorkspaceApp grantId={grantId} />));
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

const channelReads = (fetch: ReturnType<typeof server>) =>
  fetch.mock.calls.filter(
    ([input]) =>
      new URL(String(input), "https://share.test").pathname === "/api/named-chat/channels",
  ).length;

it("shows a Group added while the workspace is open, even when it had none", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const options: { groups: Array<{ wire: string; name: string }> } = { groups: [] };
  const fetch = server(options);
  await render();
  await settle(
    () =>
      text().includes("Leave at nine.") &&
      groupPanel().textContent?.includes("No Groups in this workspace yet.") === true &&
      following("log").length === 1,
  );
  options.groups = [{ wire: "wire-plans", name: "plans" }];
  // A files update soon after the Groups arrived reads them no sooner.
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 8, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => following("log").length === 1);
  // The first files update a hold after the last read of the Groups reads them again.
  vi.setSystemTime(Date.now() + 30_000);
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 9, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => groupPanel().textContent?.includes("Plans start here") === true);
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
  };
  const notify = () => {
    for (const listener of listeners) listener(state);
  };
  const session = {
    doc,
    body: getDohcYDocBodyFragment(doc),
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
      state = { ...state, status: "live" };
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
    GRANT,
    "trip/plan.md",
    expect.any(AbortSignal),
  );
  expect(vi.mocked(memberDocument)).toHaveBeenCalledWith(
    expect.objectContaining({
      grantId: GRANT,
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

async function editing(options: { level?: Level; member?: boolean }) {
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
  server({ level: "comment" });
  await render();
  await opened();
  const dated = () => container.querySelector<HTMLElement>("header .workspace-dated");
  const toast = () =>
    [...container.querySelectorAll<HTMLElement>(".workspace-toast")].find((node) =>
      node.textContent?.includes("dohc could not update this workspace's files"),
    );
  expect(dated()).toBeNull();
  for (const [index, wait] of [1000, 2000, 4000].entries()) {
    await settle(() => following("log").length === 1);
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
  await act(async () =>
    following("log")[0]!.answer({ ops: [], nextCursor: 8, hasMore: false, epochLogFloor: 0 }),
  );
  await settle(() => dated() === null && toast() === undefined);
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

it("shows no account's kept edits on a fresh load before sign-in, then only the signed-in account's, still after its session ends", async () => {
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
  // Signed out on the same page, the person still sees their own kept text, and only theirs.
  await click("Sign out");
  await settle(() => Boolean(container.querySelector('input[name="email"]')));
  expect(
    [...container.querySelectorAll('[aria-label="Unsent edits"] summary')].map(
      (node) => node.textContent,
    ),
  ).toEqual(["Unsent edits to to-pack.md"]);
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
    GRANT,
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
  expect(groupPanel().textContent).toContain("Only people who can comment post here.");
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

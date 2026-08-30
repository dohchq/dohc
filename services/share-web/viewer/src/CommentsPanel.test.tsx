// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./CommentsPanel";

const FIRST_SESSION = "abcdefghijkl";
const SECOND_SESSION = "mnopqrstuvwx";
const THIRD_SESSION = "zyxwvutsrqpo";
const SETTLE_TURN_LIMIT = 200;

const NAMED_MESSAGE = {
  messageId: "message-named",
  createdAtMs: 1_000,
  deleted: false as const,
  body: "Named body",
  author: { kind: "named" as const, displayName: "Named Person" },
};
const LINK_MESSAGE = {
  messageId: "message-link",
  createdAtMs: 2_000,
  deleted: false as const,
  body: "Link body",
  author: {
    kind: "link" as const,
    displayName: "Link Person",
    unverified: true as const,
  },
};
const TOMBSTONE = {
  messageId: "message-deleted",
  createdAtMs: 3_000,
  deleted: true as const,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function heldJsonResponse(status: number): {
  bodyStarted: () => boolean;
  release: (value: unknown) => void;
  response: Response;
} {
  let bodyStarted = false;
  let releaseBody: (value: unknown) => void = () => {
    throw new Error("held response body is not ready");
  };
  const body = new Promise<unknown>((resolve) => {
    releaseBody = resolve;
  });
  const response = new Response(null, { status });
  vi.spyOn(response, "json").mockImplementation(() => {
    bodyStarted = true;
    return body as ReturnType<Response["json"]>;
  });
  return {
    bodyStarted: () => bodyStarted,
    release: (value) => releaseBody(value),
    response,
  };
}

function discussionPage(
  messages: readonly unknown[] = [],
  nextCursor: string | null = null,
): Response {
  return jsonResponse({
    ok: true,
    activityRevision: 7,
    messages: [...messages].reverse(),
    nextCursor,
    profileName: null,
  });
}

function discussionPageAt(
  activityRevision: number,
  messages: readonly unknown[] = [],
  nextCursor: string | null = null,
): Response {
  return jsonResponse({
    ok: true,
    activityRevision,
    messages: [...messages].reverse(),
    nextCursor,
    profileName: null,
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;
  const url = new URL(input.url);
  return `${url.pathname}${url.search}`;
}

function requestSession(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("x-dohc-link-session");
}

async function settle(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURN_LIMIT; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (condition()) return;
  }
  throw new Error("Condition did not settle");
}

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("control value setter is missing");
  act(() => {
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CommentsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(access: "view" | "comment", session = FIRST_SESSION): Promise<void> {
    await act(async () => {
      root.render(<CommentsPanel access={access} session={session} />);
    });
    await settle(() => container.querySelector(".comments-panel") !== null);
  }

  function nameInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[name="claimedName"]');
    if (!input) throw new Error("name input is missing");
    return input;
  }

  function bodyInput(): HTMLTextAreaElement {
    const input = container.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (!input) throw new Error("body input is missing");
    return input;
  }

  function submitButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Post comment");
    if (!button) throw new Error("submit button is missing");
    return button;
  }

  function submit(): void {
    act(() => {
      submitButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function clickButton(label: string): void {
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === label);
    if (!button) throw new Error(`${label} button is missing`);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("shows the Comments shell while the first page is loading", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      await new Promise<Response>(() => undefined)
    ));

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={FIRST_SESSION} />);
    });

    expect(container.querySelector("h2")?.textContent).toBe("Comments");
    expect(container.textContent).toContain("Loading comments…");
    expect(container.querySelector("form")).toBeNull();
  });

  it("keeps the viewer visible and offers retry after the first page fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 503 })
    ));

    await act(async () => {
      root.render(
        <>
          <main>Rendered file</main>
          <CommentsPanel access="comment" session={FIRST_SESSION} />
        </>,
      );
    });
    await settle(() => container.textContent?.includes("Comments didn't load.") === true);

    expect(container.textContent).toContain("Rendered file");
    expect(container.querySelector("h2")?.textContent).toBe("Comments");
    expect(container.textContent).toContain("Comments didn't load.");
    expect([...container.querySelectorAll("button")]
      .some((button) => button.textContent === "Try again")).toBe(true);
    expect(container.querySelector("form")).toBeNull();
  });

  it("retries the first page and reveals the timeline and composer only after success", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      attempts += 1;
      if (attempts === 1) return new Response(null, { status: 503 });
      if (attempts === 2) return discussionPage([NAMED_MESSAGE]);
      return await new Promise<Response>(() => undefined);
    }));

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={FIRST_SESSION} />);
    });
    await settle(() => container.textContent?.includes("Comments didn't load.") === true);
    clickButton("Try again");
    await settle(() => container.textContent?.includes("Named body") === true);

    expect(attempts).toBe(3);
    expect(container.textContent).not.toContain("Comments didn't load.");
    expect(container.textContent).not.toContain("Loading comments…");
    expect(bodyInput().disabled).toBe(false);
  });

  it.each(["success", "failure"] as const)(
    "does not apply a held retry %s after session replacement",
    async (outcome) => {
      let firstSessionAttempts = 0;
      let resolveRetry: ((response: Response) => void) | undefined;
      let rejectRetry: ((reason: Error) => void) | undefined;
      let retrySignal: AbortSignal | undefined;
      let replacementSignal: AbortSignal | undefined;
      const heldRetry = new Promise<Response>((resolve, reject) => {
        resolveRetry = resolve;
        rejectRetry = reject;
      });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
        if (requestSession(init) === FIRST_SESSION) {
          firstSessionAttempts += 1;
          if (firstSessionAttempts === 1) return new Response(null, { status: 503 });
          retrySignal = init?.signal ?? undefined;
          return await heldRetry;
        }
        replacementSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }));

      await act(async () => {
        root.render(<CommentsPanel access="comment" session={FIRST_SESSION} />);
      });
      await settle(() => container.textContent?.includes("Comments didn't load.") === true);
      clickButton("Try again");
      await settle(() => retrySignal !== undefined);
      await act(async () => {
        root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
      });
      await settle(() => replacementSignal !== undefined);
      expect(retrySignal?.aborted).toBe(true);

      if (outcome === "success") {
        resolveRetry?.(discussionPage([{ ...NAMED_MESSAGE, body: "Stale retry body" }]));
      } else {
        rejectRetry?.(new Error("stale retry failed"));
      }
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.textContent).toContain("Loading comments…");
      expect(container.textContent).not.toContain("Stale retry body");
      expect(container.textContent).not.toContain("Comments didn't load.");
      expect(container.querySelector("form")).toBeNull();
    },
  );

  it("does not apply a late first-page failure after unmount", async () => {
    let rejectLoad: ((reason: Error) => void) | undefined;
    let loadSignal: AbortSignal | undefined;
    const heldLoad = new Promise<Response>((_resolve, reject) => {
      rejectLoad = reject;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      loadSignal = init?.signal ?? undefined;
      return await heldLoad;
    }));

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={FIRST_SESSION} />);
    });
    await settle(() => loadSignal !== undefined);
    await act(async () => {
      root.render(<main>Replacement viewer</main>);
    });
    expect(loadSignal?.aborted).toBe(true);

    rejectLoad?.(new Error("late load failure"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toBe("Replacement viewer");
    expect(container.textContent).not.toContain("Comments didn't load.");
  });

  it.each(["view", "comment"] as const)(
    "renders the same strict mixed timeline for a %s link",
    async (access) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
        discussionPage([NAMED_MESSAGE, LINK_MESSAGE, TOMBSTONE])
      ));

      await render(access);

      expect(container.querySelector("h2")?.textContent).toBe("Comments");
      expect(container.textContent).toContain(
        access === "view"
          ? "Anyone with the link can read what you selected."
          : "Anyone with the link can also comment. Names they give are not verified.",
      );
      expect(container.textContent).toContain("Named PersonNamed body");
      expect(container.textContent).toContain("Link PersonUnverifiedLink body");
      expect(container.textContent).toContain("Comment deleted by the owner");
      expect(container.textContent).not.toContain("message-deleted");
      expect(container.querySelectorAll("form")).toHaveLength(access === "comment" ? 1 : 0);
      if (access === "comment") {
        expect(nameInput().labels?.[0]?.textContent).toBe("Name (optional)");
        expect(container.textContent).toContain(
          "Shown with your comments, marked unverified. It can't be changed later.",
        );
      }
    },
  );

  it("renders the settled empty timeline", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => discussionPage()));
    await render("view");
    expect(container.textContent).toContain("No comments yet.");
  });

  it("restores and locks the committed profile name after a new session", async () => {
    let committedName: string | null = null;
    const messages: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      const session = requestSession(init);
      if (path === "/api/view/discussion" && init?.method === "POST") {
        const posted = JSON.parse(String(init.body)) as {
          body: string;
          claimedName?: string;
        };
        committedName = posted.claimedName ?? null;
        const message = {
          ...LINK_MESSAGE,
          messageId: "committed-profile-message",
          body: posted.body,
          author: {
            ...LINK_MESSAGE.author,
            displayName: committedName ?? "Unnamed",
          },
        };
        messages.push(message);
        return jsonResponse({ ok: true, message });
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 7,
          messages,
          nextCursor: null,
          profileName: session === THIRD_SESSION ? null : committedName,
        });
      }
      return discussionPageAt(7);
    }));

    await render("comment", FIRST_SESSION);
    await settle(() => container.querySelector('input[name="claimedName"]') !== null);
    expect(nameInput().value).toBe("");
    expect(nameInput().disabled).toBe(false);

    setControlValue(nameInput(), "Stable Name");
    setControlValue(bodyInput(), "First comment");
    submit();
    await settle(() => nameInput().disabled && nameInput().value === "Stable Name");

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
    });
    await settle(() => nameInput().disabled && nameInput().value === "Stable Name");
    expect(bodyInput().value).toBe("");

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={THIRD_SESSION} />);
    });
    await settle(() => nameInput().value === "" && !nameInput().disabled);
    expect(container.textContent).toContain("Stable NameUnverifiedFirst comment");
    for (const internal of [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION, "profile-sentinel"]) {
      expect(container.textContent).not.toContain(internal);
    }
  });

  it("renders hostile names and bodies as inert React text", async () => {
    const hostileName = '<img src="https://probe.invalid/name" onerror="attack()">';
    const hostileBody = [
      '<script>window.attack=true</script>',
      "[Markdown probe](https://probe.invalid/markdown)",
      "javascript:window.attack=true",
      "data:text/html,<script>attack()</script>",
      "\u202e bidi e\u0301 😀 %3Cscript%3E &lt;script&gt;",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => discussionPage([{
      ...LINK_MESSAGE,
      body: hostileBody,
      author: { ...LINK_MESSAGE.author, displayName: hostileName },
    }])));

    await render("view");

    const row = container.querySelector(".comment-row");
    expect(row?.textContent).toBe(`${hostileName}Unverified${hostileBody}`);
    expect(row?.querySelectorAll("a, img, script, style, svg, iframe, object, embed, form"))
      .toHaveLength(0);
    expect(row?.querySelectorAll("[href], [src], [onerror], [onload], [onclick]"))
      .toHaveLength(0);
    expect(row?.innerHTML).toContain("&lt;script&gt;");
    expect(row?.innerHTML).not.toContain("<script>");
    expect(row?.querySelector("article.markdown")).toBeNull();
  });

  it("keeps one intent key through a generic failure and deliberate retry, then changes it on edit", async () => {
    let releaseFirst: (() => void) | undefined;
    const heldFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const posted: Array<Record<string, unknown>> = [];
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      if (requestPath(input) !== "/api/view/discussion" || init?.method !== "POST") {
        return discussionPage();
      }
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      posts += 1;
      if (posts === 1) {
        await heldFirst;
        return new Response(null, { status: 404 });
      }
      return jsonResponse({
        ok: true,
        message: {
          ...LINK_MESSAGE,
          messageId: `posted-${String(posts)}`,
          createdAtMs: 3_000 + posts,
          body: String(posted.at(-1)?.body),
        },
      });
    }));

    await render("comment");
    setControlValue(nameInput(), "Claimed Name");
    setControlValue(bodyInput(), "First draft");
    submit();
    submit();
    expect(posts).toBe(1);
    expect(submitButton().disabled).toBe(true);
    releaseFirst?.();
    await settle(() => container.textContent?.includes("The comment didn't post. Try again.") === true);

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(bodyInput().value).toBe("First draft");
    expect(bodyInput().getAttribute("aria-describedby")).toContain(status?.id);
    submit();
    await settle(() => container.textContent?.includes("First draft") === true && posts === 2);
    expect(posted[0]).toEqual({
      body: "First draft",
      idempotencyKey: posted[0]?.idempotencyKey,
      claimedName: "Claimed Name",
    });
    expect(posted[1]?.idempotencyKey).toBe(posted[0]?.idempotencyKey);
    expect(container.querySelectorAll(".comment-row")).toHaveLength(1);

    setControlValue(bodyInput(), "Edited draft");
    submit();
    await settle(() => posts === 3);
    expect(posted[2]?.idempotencyKey).not.toBe(posted[1]?.idempotencyKey);
  });

  it.each(["success", "blocked", "paused"] as const)(
    "keeps a generic failure visible through a held %s retry body",
    async (outcome) => {
      const held = heldJsonResponse(outcome === "success" ? 200 : 403);
      const posted: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        if (requestPath(input) !== "/api/view/discussion" || init?.method !== "POST") {
          return discussionPage();
        }
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return posted.length === 1
          ? new Response(null, { status: 404 })
          : held.response;
      }));

      await render("comment");
      setControlValue(bodyInput(), "Retry draft");
      submit();
      await settle(() =>
        container.textContent?.includes("The comment didn't post. Try again.") === true
      );
      submit();
      await settle(held.bodyStarted);

      expect(posted).toHaveLength(2);
      expect(posted[1]?.idempotencyKey).toBe(posted[0]?.idempotencyKey);
      expect(container.textContent).toContain("The comment didn't post. Try again.");
      expect(bodyInput().value).toBe("Retry draft");
      expect(submitButton().disabled).toBe(true);

      held.release(outcome === "success"
        ? {
            ok: true,
            message: {
              ...LINK_MESSAGE,
              messageId: "retry-terminal",
              createdAtMs: 4_000,
              body: "Retry draft",
            },
          }
        : { ok: false, state: outcome });
      if (outcome === "success") {
        await settle(() => container.textContent?.includes("Retry draft") === true);
        expect(container.textContent).not.toContain("The comment didn't post. Try again.");
        expect(bodyInput().value).toBe("");
        expect(bodyInput().disabled).toBe(false);
      } else {
        const stateCopy = outcome === "blocked"
          ? "The owner turned off comments for this browser."
          : "The owner paused comments. You can still read everything.";
        await settle(() => container.textContent?.includes(stateCopy) === true);
        expect(container.textContent).not.toContain("The comment didn't post. Try again.");
        expect(bodyInput().value).toBe("Retry draft");
        expect(bodyInput().disabled).toBe(true);
      }
    },
  );

  it("reuses the intent key across an automatic transport retry", async () => {
    vi.useFakeTimers();
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      if (requestPath(input) !== "/api/view/discussion" || init?.method !== "POST") {
        return discussionPage();
      }
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (posted.length === 1) return new Response(null, { status: 503 });
      return jsonResponse({ ok: true, message: { ...LINK_MESSAGE, body: "Retried" } });
    }));

    await render("comment");
    setControlValue(bodyInput(), "Retried");
    submit();
    await settle(() => posted.length === 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle(() => posted.length === 2);
    expect(posted[1]?.idempotencyKey).toBe(posted[0]?.idempotencyKey);
    expect(container.querySelectorAll(".comment-row")).toHaveLength(1);
  });

  it("absorbs a late successful append after activity already tombstoned it", async () => {
    const posted = {
      ...LINK_MESSAGE,
      messageId: "message-post-delete-race",
      createdAtMs: 4_000,
      body: "Deleted before acknowledgment",
    };
    const deleted = {
      messageId: posted.messageId,
      createdAtMs: posted.createdAtMs,
      deleted: true as const,
    };
    const heldPost = heldJsonResponse(200);
    const heldDeletion = heldJsonResponse(200);
    let finalParkSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion" && init?.method === "POST") {
        return heldPost.response;
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          ok: true,
          access: "comment",
          latestRevision: 7,
          cursorRevision: 7,
          hasMore: false,
          messages: [],
          composerState: "available",
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        return heldDeletion.response;
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        finalParkSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("comment");
    await settle(heldDeletion.bodyStarted);
    setControlValue(bodyInput(), posted.body);
    submit();
    await settle(heldPost.bodyStarted);

    heldDeletion.release({
      ok: true,
      access: "comment",
      latestRevision: 8,
      cursorRevision: 8,
      hasMore: false,
      messages: [deleted],
      composerState: "available",
    });
    await settle(() =>
      container.textContent?.includes("Comment deleted by the owner") === true &&
      finalParkSignal !== undefined
    );

    heldPost.release({ ok: true, message: posted });
    await settle(() =>
      bodyInput().value === "" ||
      container.textContent?.includes("The comment didn't post. Try again.") === true
    );

    expect(bodyInput().value).toBe("");
    expect(container.textContent).not.toContain("Deleted before acknowledgment");
    expect(container.textContent).not.toContain("The comment didn't post. Try again.");
    expect(container.querySelectorAll(".comment-row.comment-deleted")).toHaveLength(1);
  });

  it.each([
    ["blocked", "The owner turned off comments for this browser."],
    ["paused", "The owner paused comments. You can still read everything."],
  ] as const)("learns %s only from POST and keeps the timeline", async (state, copy) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) =>
      init?.method === "POST"
        ? jsonResponse({ ok: false, state }, 403)
        : discussionPage([NAMED_MESSAGE])
    ));

    await render("comment");
    expect(container.textContent).not.toContain(copy);
    setControlValue(bodyInput(), "Refused draft");
    submit();
    await settle(() => container.textContent?.includes(copy) === true);
    expect(container.textContent).toContain("Named body");
    expect(bodyInput().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).not.toContain("The comment didn't post. Try again.");
  });

  it("renders the newest page before activity and loads one earlier page on request", async () => {
    const initialActivity = heldJsonResponse(200);
    const paths: string[] = [];
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      paths.push(path);
      if (
        path === "/api/view/discussion" ||
        path === "/api/view/discussion?direction=newest-first"
      ) {
        return discussionPage([LINK_MESSAGE, TOMBSTONE], "cursor_one");
      }
      if (
        path === "/api/view/discussion?cursor=cursor_one" ||
        path === "/api/view/discussion?direction=newest-first&cursor=cursor_one"
      ) {
        return discussionPage([NAMED_MESSAGE]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return initialActivity.response;
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("view");
    await settle(initialActivity.bodyStarted);
    expect(paths).toEqual([
      "/api/view/discussion?direction=newest-first",
      "/api/view/discussion/activity?since=7&hold=0&limit=100",
    ]);
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Link PersonUnverifiedLink body",
        "Comment deleted by the owner",
      ]);
    clickButton("Load earlier comments");
    await settle(() => container.textContent?.includes("Named body") === true);
    expect(paths.filter((path) => path.includes("cursor=cursor_one"))).toEqual([
      "/api/view/discussion?direction=newest-first&cursor=cursor_one",
    ]);
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Named PersonNamed body",
        "Link PersonUnverifiedLink body",
        "Comment deleted by the owner",
      ]);

    initialActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 7,
      cursorRevision: 7,
      hasMore: false,
      messages: [],
      composerState: "available",
    });
    await settle(() => parkedSignal !== undefined);
  });

  it("keeps same-millisecond activity before a complete initial history", async () => {
    const initial = {
      ...LINK_MESSAGE,
      messageId: "message-b",
      createdAtMs: 4_000,
      body: "Initial body",
    };
    const concurrent = {
      ...NAMED_MESSAGE,
      messageId: "message-a",
      createdAtMs: initial.createdAtMs,
      body: "Concurrent body",
    };
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7, [initial]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          ok: true,
          access: "view",
          latestRevision: 8,
          cursorRevision: 8,
          hasMore: false,
          messages: [concurrent],
          composerState: "available",
        });
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("view");
    await settle(() => parkedSignal !== undefined);

    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Named PersonConcurrent body",
        "Link PersonUnverifiedInitial body",
      ]);
  });

  it("retries one failed earlier page only after another click", async () => {
    let earlierAttempts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPage([LINK_MESSAGE], "cursor_retry");
      }
      if (
        path ===
        "/api/view/discussion?direction=newest-first&cursor=cursor_retry"
      ) {
        earlierAttempts += 1;
        return earlierAttempts === 1
          ? new Response(null, { status: 503 })
          : discussionPage([NAMED_MESSAGE]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("view");
    await settle(() => container.textContent?.includes("Load earlier comments") === true);
    clickButton("Load earlier comments");
    await settle(() =>
      container.textContent?.includes("Earlier comments didn't load.") === true
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(earlierAttempts).toBe(1);
    expect(container.textContent).not.toContain("Named body");

    clickButton("Load earlier comments");
    await settle(() => container.textContent?.includes("Named body") === true);
    expect(earlierAttempts).toBe(2);
    expect(container.textContent).not.toContain("Earlier comments didn't load.");
    expect(container.textContent).not.toContain("Load earlier comments");
  });

  it("refuses a repeated earlier-page cursor without adding its messages", async () => {
    let earlierAttempts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPage([LINK_MESSAGE], "cursor_repeat");
      }
      if (
        path ===
        "/api/view/discussion?direction=newest-first&cursor=cursor_repeat"
      ) {
        earlierAttempts += 1;
        return discussionPage([NAMED_MESSAGE], "cursor_repeat");
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("view");
    await settle(() => container.textContent?.includes("Load earlier comments") === true);
    clickButton("Load earlier comments");
    await settle(() =>
      container.textContent?.includes("Earlier comments didn't load.") === true
    );

    expect(earlierAttempts).toBe(1);
    expect(container.textContent).not.toContain("Named body");
    expect(container.textContent).toContain("Link body");
  });

  it("aborts a held earlier-page request when the session changes", async () => {
    let earlierSignal: AbortSignal | undefined;
    let replacementActivitySignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      const session = requestSession(init);
      if (path === "/api/view/discussion?direction=newest-first") {
        return session === FIRST_SESSION
          ? discussionPage([LINK_MESSAGE], "cursor_held")
          : discussionPage([{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }
      if (
        path ===
        "/api/view/discussion?direction=newest-first&cursor=cursor_held"
      ) {
        earlierSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      if (session === FIRST_SESSION) {
        return await new Promise<Response>(() => undefined);
      }
      replacementActivitySignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    }));

    await render("view");
    await settle(() => container.textContent?.includes("Load earlier comments") === true);
    clickButton("Load earlier comments");
    await settle(() => earlierSignal !== undefined);
    await act(async () => {
      root.render(<CommentsPanel access="view" session={SECOND_SESSION} />);
    });
    await settle(() => replacementActivitySignal !== undefined);

    expect(earlierSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("Replacement timeline");
    expect(container.textContent).not.toContain("Earlier comments didn't load.");
  });

  it("converges ordered activity from the first-page revision without duplicates or hot loops", async () => {
    const external = {
      ...LINK_MESSAGE,
      messageId: "message-external",
      createdAtMs: 2_500,
      body: "External body",
    };
    const deletedExternal = {
      messageId: external.messageId,
      createdAtMs: external.createdAtMs,
      deleted: true as const,
    };
    const appendDelta = heldJsonResponse(200);
    const deleteDelta = heldJsonResponse(200);
    const pausedDelta = heldJsonResponse(200);
    const availableDelta = heldJsonResponse(200);
    const timeoutDelta = heldJsonResponse(200);
    const paths: string[] = [];
    let finalParkSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      paths.push(path);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7, [NAMED_MESSAGE, LINK_MESSAGE, external]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return appendDelta.response;
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        return deleteDelta.response;
      }
      if (path === "/api/view/discussion/activity?since=9&hold=30000&limit=100") {
        return pausedDelta.response;
      }
      if (path === "/api/view/discussion/activity?since=10&hold=0&limit=100") {
        return availableDelta.response;
      }
      if (path === "/api/view/discussion/activity?since=11&hold=30000&limit=100") {
        if (!timeoutDelta.bodyStarted()) return timeoutDelta.response;
        finalParkSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("comment");
    await settle(appendDelta.bodyStarted);
    expect([...container.querySelectorAll(".comment-body")]
      .filter((row) => row.textContent === "External body")).toHaveLength(1);
    appendDelta.release({
      ok: true,
      access: "comment",
      latestRevision: 8,
      cursorRevision: 8,
      hasMore: false,
      messages: [external],
      composerState: "available",
    });
    await settle(deleteDelta.bodyStarted);
    expect([...container.querySelectorAll(".comment-body")]
      .filter((row) => row.textContent === "External body")).toHaveLength(1);
    deleteDelta.release({
      ok: true,
      access: "comment",
      latestRevision: 9,
      cursorRevision: 9,
      hasMore: false,
      messages: [deletedExternal],
      composerState: "blocked",
    });
    await settle(() =>
      deleteDelta.bodyStarted() &&
      container.textContent?.includes("The owner turned off comments for this browser.") === true
    );
    await settle(pausedDelta.bodyStarted);
    expect(bodyInput().disabled).toBe(true);
    pausedDelta.release({
      ok: true,
      access: "comment",
      latestRevision: 11,
      cursorRevision: 10,
      hasMore: true,
      messages: [],
      composerState: "paused",
    });
    await settle(() =>
      container.textContent?.includes("The owner paused comments. You can still read everything.") ===
      true
    );
    await settle(availableDelta.bodyStarted);
    expect(bodyInput().disabled).toBe(true);
    availableDelta.release({
      ok: true,
      access: "comment",
      latestRevision: 11,
      cursorRevision: 11,
      hasMore: false,
      messages: [],
      composerState: "available",
    });
    await settle(() => bodyInput().disabled === false);
    await settle(timeoutDelta.bodyStarted);
    timeoutDelta.release({
      ok: true,
      access: "comment",
      latestRevision: 11,
      cursorRevision: 11,
      hasMore: false,
      messages: [],
      composerState: "available",
    });
    await settle(() => finalParkSignal !== undefined);

    expect(paths.slice(0, 6)).toEqual([
      "/api/view/discussion?direction=newest-first",
      "/api/view/discussion/activity?since=7&hold=0&limit=100",
      "/api/view/discussion/activity?since=8&hold=30000&limit=100",
      "/api/view/discussion/activity?since=9&hold=30000&limit=100",
      "/api/view/discussion/activity?since=10&hold=0&limit=100",
      "/api/view/discussion/activity?since=11&hold=30000&limit=100",
    ]);
    expect(paths.at(-1)).toBe(
      "/api/view/discussion/activity?since=11&hold=30000&limit=100",
    );
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Named PersonNamed body",
        "Link PersonUnverifiedLink body",
        "Comment deleted by the owner",
      ]);
    expect(container.textContent).not.toContain("External body");
    expect(bodyInput().disabled).toBe(false);
  });

  it("synchronizes the current composer state before the first activity park", async () => {
    const paths: string[] = [];
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      paths.push(path);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7, [NAMED_MESSAGE]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          ok: true,
          access: "comment",
          latestRevision: 7,
          cursorRevision: 7,
          hasMore: false,
          messages: [],
          composerState: "blocked",
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("comment");
    await settle(() => parkedSignal !== undefined);

    expect(paths.slice(0, 3)).toEqual([
      "/api/view/discussion?direction=newest-first",
      "/api/view/discussion/activity?since=7&hold=0&limit=100",
      "/api/view/discussion/activity?since=7&hold=30000&limit=100",
    ]);
    expect(container.textContent).toContain(
      "The owner turned off comments for this browser.",
    );
    expect(bodyInput().disabled).toBe(true);
  });

  it("reports the exact current link access from fresh activity", async () => {
    const onAccessChange = vi.fn();
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7, [NAMED_MESSAGE]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          ok: true,
          access: "view",
          latestRevision: 7,
          cursorRevision: 7,
          hasMore: false,
          messages: [],
          composerState: "available",
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await act(async () => {
      root.render(
        <CommentsPanel
          access="comment"
          session={FIRST_SESSION}
          onAccessChange={onAccessChange}
        />,
      );
    });
    await settle(() => parkedSignal !== undefined);

    expect(onAccessChange.mock.calls).toEqual([[FIRST_SESSION, "view"]]);
  });

  it("backs off transport and relay failures without leaving the current session", async () => {
    vi.useFakeTimers();
    let activityAttempts = 0;
    let recoveredSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7);
      }
      if (path !== "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        throw new Error(`unexpected request: ${path}`);
      }
      activityAttempts += 1;
      if (activityAttempts === 1) return new Response(null, { status: 429 });
      if (activityAttempts === 2) return new Response(null, { status: 503 });
      if (activityAttempts === 3) throw new Error("transport failed");
      recoveredSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    }));

    await render("view");
    await settle(() => activityAttempts === 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(activityAttempts).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(activityAttempts).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(activityAttempts).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(activityAttempts).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_999);
    });
    expect(activityAttempts).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(activityAttempts).toBe(4);
    expect(recoveredSignal?.aborted).toBe(false);
  });

  it("resumes activity after a superseded viewer capability response", async () => {
    vi.useFakeTimers();
    const replacement = {
      ...LINK_MESSAGE,
      messageId: "message-after-capability-replacement",
      createdAtMs: 4_000,
      body: "Replacement capability stayed live",
    };
    let activityAttempts = 0;
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        activityAttempts += 1;
        return activityAttempts === 1
          ? new Response(null, { status: 409 })
          : jsonResponse({
              ok: true,
              access: "comment",
              latestRevision: 8,
              cursorRevision: 8,
              hasMore: false,
              messages: [replacement],
              composerState: "available",
            });
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("view");
    await settle(() => activityAttempts === 1);
    await settle(() => vi.getTimerCount() > 0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(activityAttempts).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle(() => parkedSignal !== undefined);

    expect(activityAttempts).toBe(2);
    expect(container.textContent).toContain("Replacement capability stayed live");
    expect(parkedSignal?.aborted).toBe(false);
  });

  it("fences an activity body after session replacement and aborts every parked lifecycle", async () => {
    const heldOldActivity = heldJsonResponse(200);
    let oldActivitySignal: AbortSignal | undefined;
    let replacementParkSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      const session = requestSession(init);
      if (path === "/api/view/discussion?direction=newest-first") {
        return session === FIRST_SESSION
          ? discussionPageAt(7, [NAMED_MESSAGE])
          : discussionPageAt(20, [{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }
      if (session === FIRST_SESSION) {
        oldActivitySignal = init?.signal ?? undefined;
        return heldOldActivity.response;
      }
      replacementParkSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    }));

    await render("comment");
    await settle(heldOldActivity.bodyStarted);
    await act(async () => {
      root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
    });
    await settle(() => replacementParkSignal !== undefined);
    expect(oldActivitySignal?.aborted).toBe(true);

    heldOldActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 8,
      cursorRevision: 8,
      hasMore: false,
      messages: [{ ...LINK_MESSAGE, body: "Old activity body" }],
      composerState: "blocked",
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Replacement timeline");
    expect(container.textContent).not.toContain("Old activity body");
    expect(container.textContent).not.toContain(
      "The owner turned off comments for this browser.",
    );
    expect(bodyInput().disabled).toBe(false);

    act(() => root.unmount());
    expect(replacementParkSignal?.aborted).toBe(true);
    root = createRoot(container);
  });

  it("does not apply a held page from a replaced session even when the mock ignores abort", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const heldOld = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      if (requestSession(init) === FIRST_SESSION) {
        oldSignal = init?.signal ?? undefined;
        return heldOld;
      }
      return discussionPage([{ ...NAMED_MESSAGE, body: "New session body" }]);
    }));

    await act(async () => {
      root.render(<CommentsPanel access="view" session={FIRST_SESSION} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<CommentsPanel access="view" session={SECOND_SESSION} />);
    });
    await settle(() => container.textContent?.includes("New session body") === true);
    resolveOld?.(discussionPage([{ ...NAMED_MESSAGE, body: "Old session body" }]));
    await settle(() => oldSignal?.aborted === true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("New session body");
    expect(container.textContent).not.toContain("Old session body");
  });

  it.each(["success", "blocked"] as const)(
    "does not apply a held %s append to a replacement session",
    async (outcome) => {
      let resolveOld: ((response: Response) => void) | undefined;
      let oldSignal: AbortSignal | undefined;
      const heldOld = new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        if (init?.method === "POST") {
          oldSignal = init.signal ?? undefined;
          return heldOld;
        }
        return requestSession(init) === FIRST_SESSION
          ? discussionPage()
          : discussionPage([{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }));

      await render("comment");
      setControlValue(bodyInput(), "Old draft");
      submit();
      await act(async () => {
        root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
      });
      await settle(() => container.textContent?.includes("Replacement timeline") === true);
      setControlValue(bodyInput(), "Replacement draft");
      resolveOld?.(outcome === "success"
        ? jsonResponse({
            ok: true,
            message: { ...LINK_MESSAGE, body: "Old committed body" },
          })
        : jsonResponse({ ok: false, state: "blocked" }, 403));
      await settle(() => oldSignal?.aborted === true);
      await act(async () => {
        await Promise.resolve();
      });

      expect(bodyInput().value).toBe("Replacement draft");
      expect(bodyInput().disabled).toBe(false);
      expect(container.textContent).toContain("Replacement timeline");
      expect(container.textContent).not.toContain("Old committed body");
      expect(container.textContent).not.toContain(
        "The owner turned off comments for this browser.",
      );
    },
  );

  it.each(["success", "blocked", "paused"] as const)(
    "does not apply a held %s append body to a replacement session",
    async (outcome) => {
      const held = heldJsonResponse(outcome === "success" ? 200 : 403);
      let oldSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
        if (init?.method === "POST") {
          oldSignal = init.signal ?? undefined;
          return held.response;
        }
        return requestSession(init) === FIRST_SESSION
          ? discussionPage()
          : discussionPage([{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }));

      await render("comment");
      setControlValue(bodyInput(), "Old draft");
      submit();
      await settle(held.bodyStarted);
      await act(async () => {
        root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
      });
      await settle(() => container.textContent?.includes("Replacement timeline") === true);
      setControlValue(bodyInput(), "Replacement draft");
      held.release(outcome === "success"
        ? {
            ok: true,
            message: { ...LINK_MESSAGE, body: "Old committed body" },
          }
        : { ok: false, state: outcome });
      await settle(() => oldSignal?.aborted === true);
      await act(async () => {
        await Promise.resolve();
      });

      expect(bodyInput().value).toBe("Replacement draft");
      expect(bodyInput().disabled).toBe(false);
      expect(container.textContent).toContain("Replacement timeline");
      expect(container.textContent).not.toContain("Old committed body");
      expect(container.textContent).not.toContain(
        "The owner turned off comments for this browser.",
      );
      expect(container.textContent).not.toContain(
        "The owner paused comments. You can still read everything.",
      );
    },
  );
});

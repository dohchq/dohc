// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./CommentsPanel";

const FIRST_SESSION = "abcdefghijkl";
const SECOND_SESSION = "mnopqrstuvwx";
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

function discussionPage(
  messages: readonly unknown[] = [],
  nextCursor: string | null = null,
): Response {
  return jsonResponse({ ok: true, messages, nextCursor });
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

  it("loads every ordered keyset page with opaque cursor encoding", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      paths.push(path);
      return path === "/api/view/discussion"
        ? discussionPage([NAMED_MESSAGE], "cursor_one")
        : discussionPage([LINK_MESSAGE, TOMBSTONE]);
    }));

    await render("view");
    expect(paths).toEqual([
      "/api/view/discussion",
      "/api/view/discussion?cursor=cursor_one",
    ]);
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Named PersonNamed body",
        "Link PersonUnverifiedLink body",
        "Comment deleted by the owner",
      ]);
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
});

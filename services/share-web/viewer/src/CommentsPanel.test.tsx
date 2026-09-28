// @vitest-environment jsdom
import {
  jsonResponse,
  heldJsonResponse,
  requestPath,
  settle,
  setControlValue,
} from "./testing";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./CommentsPanel";
import {LINK_REFUSALS, linkRefusalBody} from "@dohc/security-contract/link-refusal";

const FIRST_SESSION = "abcdefghijkl";
const SECOND_SESSION = "mnopqrstuvwx";
const THIRD_SESSION = "zyxwvutsrqpo";

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

function failedBodyResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("activity body interrupted"));
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
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

function availableActivityAt(activityRevision: number): Response {
  return jsonResponse({
    profileName: null,
    ok: true,
    access: "comment",
    latestRevision: activityRevision,
    cursorRevision: activityRevision,
    hasMore: false,
    messages: [],
    composerState: "available",
  });
}

function requestSession(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("x-dohc-link-session");
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

  it.each(["link_read_rate_limited", "link_live_unavailable", "link_unavailable", "link_view_access"] as const)("shows %s when loading fails, retaining the last refusal after retries", async code => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(linkRefusalBody(code), LINK_REFUSALS[code].status));
    vi.stubGlobal("fetch", fetcher);
    await render("comment");
    await act(async () => {await vi.advanceTimersByTimeAsync(120_000);});
    await settle(() => container.textContent!.includes(LINK_REFUSALS[code].error));
    if (code === "link_read_rate_limited") expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    else expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["recovered", "stopped"])("clears the retryable activity refusal when the follower is %s", async outcome => {
    vi.useFakeTimers();
    const message = LINK_REFUSALS.link_read_rate_limited.error;
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (!requestPath(input).includes("/activity")) return Promise.resolve(discussionPage());
      attempts++;
      if (attempts === 1) return Promise.resolve(jsonResponse(linkRefusalBody("link_read_rate_limited"), 429));
      if (attempts === 2) return Promise.resolve(outcome === "recovered" ? availableActivityAt(7) : jsonResponse({ok: false, error: "not found"}, 404));
      return new Promise<Response>(() => {});
    }));
    await render("comment");
    await settle(() => container.textContent!.includes(message));
    await act(async () => {await vi.advanceTimersByTimeAsync(1_000);});
    await settle(() => outcome === "recovered" ? !bodyInput().disabled : container.textContent!.includes("Comments stopped updating."));
    expect(container.textContent).not.toContain(message);
    expect(attempts).toBe(outcome === "recovered" ? 3 : 2);
  });

  it.each(["link_read_rate_limited", "link_live_unavailable", "link_unavailable", "link_view_access"] as const)("shows %s on post and preserves the draft", async code => {
    vi.useFakeTimers();
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {posts++;return Promise.resolve(jsonResponse(linkRefusalBody(code), LINK_REFUSALS[code].status));}
      const path = requestPath(input);
      if (!path.includes("/activity")) return Promise.resolve(discussionPage());
      if (path.includes("hold=0")) return Promise.resolve(availableActivityAt(7));
      return new Promise<Response>(() => {});
    }));
    await render("comment");
    await settle(() => !bodyInput().disabled);
    setControlValue(bodyInput(), "Keep this draft");
    submit();
    await act(async () => {await vi.advanceTimersByTimeAsync(120_000);});
    await settle(() => container.textContent!.includes(LINK_REFUSALS[code].error));
    expect(bodyInput().value).toBe("Keep this draft");
    if (code === "link_view_access") expect(posts).toBe(1);
    else expect(posts).toBeGreaterThan(1);
  });

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
      if (attempts === 3) return availableActivityAt(7);
      return await new Promise<Response>(() => undefined);
    }));

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={FIRST_SESSION} />);
    });
    await settle(() => container.textContent?.includes("Comments didn't load.") === true);
    clickButton("Try again");
    await settle(() =>
      container.textContent?.includes("Named body") === true &&
      bodyInput().disabled === false
    );

    expect(attempts).toBe(4);
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
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return availableActivityAt(7);
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render("comment", FIRST_SESSION);
    await settle(() =>
      container.querySelector('input[name="claimedName"]') !== null &&
      nameInput().disabled === false
    );
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

  it.each([
    ["2,001 normalized code points", "\u00e9".repeat(2_001)],
    [
      "a raw UTF-8-over-limit value that NFC could otherwise shrink",
      "\u1100\u1161\u11a8".repeat(889),
    ],
  ] as const)(
    "blocks %s locally and recovers after the draft becomes valid",
    async (_case, invalidDraft) => {
      const posted: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path.includes("/activity?")) {
          if (path.includes("hold=0")) return availableActivityAt(7);
          return await new Promise<Response>(() => undefined);
        }
        if (path !== "/api/view/discussion" || init?.method !== "POST") {
          return discussionPage();
        }
        const intent = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(intent);
        return jsonResponse({
          ok: true,
          message: {
            ...LINK_MESSAGE,
            messageId: "recovered-post",
            createdAtMs: 4_000,
            body: intent.body,
          },
        });
      }));

      await render("comment");
      setControlValue(bodyInput(), invalidDraft);

      expect(bodyInput().value).toBe(invalidDraft);
      expect(bodyInput().disabled).toBe(false);
      expect(submitButton().disabled).toBe(true);
      expect(submitButton().textContent).toBe("Post comment");
      const submitStatus = container.querySelector(".comment-submit-status");
      expect(submitStatus?.textContent).toBe(
        "This comment is too long. Shorten it before posting.",
      );
      expect(submitStatus?.id).toBe("comment-submit-status");
      expect(bodyInput().getAttribute("aria-describedby")).toContain(submitStatus?.id);
      submit();
      await act(async () => {
        await Promise.resolve();
      });
      expect(posted).toHaveLength(0);

      const validDraft = "Recovered e\u0301";
      setControlValue(bodyInput(), validDraft);

      expect(container.querySelector(".comment-submit-status")?.textContent).toBe("");
      expect(submitButton().disabled).toBe(false);
      submit();
      await settle(() => posted.length === 1 && bodyInput().value === "");

      expect(posted).toHaveLength(1);
      expect(posted[0]?.body).toBe("Recovered \u00e9");
    },
  );

  it.each([
    ["leading", "\u0000hello", "hello"],
    ["interior", "hello\u0000world", "helloworld"],
  ] as const)(
    "removes a %s NUL before a public draft can post",
    async (_case, draft, visible) => {
      const posted: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path.includes("/activity?")) {
          if (path.includes("hold=0")) return availableActivityAt(7);
          return await new Promise<Response>(() => undefined);
        }
        if (path !== "/api/view/discussion" || init?.method !== "POST") {
          return discussionPage();
        }
        const intent = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(intent);
        return jsonResponse({
          ok: true,
          message: {
            ...LINK_MESSAGE,
            messageId: `nul-${_case}`,
            createdAtMs: 4_000,
            body: intent.body,
          },
        });
      }));

      await render("comment");
      setControlValue(bodyInput(), draft);

      expect(bodyInput().value).toBe(visible);
      expect(container.querySelector(".comment-submit-status")?.textContent).toBe("");
      expect(submitButton().disabled).toBe(false);
      submit();
      await settle(() => posted.length === 1 && bodyInput().value === "");

      expect(posted[0]?.body).toBe(visible);
      expect(String(posted[0]?.body)).not.toContain("\u0000");
    },
  );

  it("keeps one intent key through a generic failure and deliberate retry, then changes it on edit", async () => {
    let releaseFirst: (() => void) | undefined;
    const heldFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const posted: Array<Record<string, unknown>> = [];
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path.includes("/activity?")) {
        if (path.includes("hold=0")) return availableActivityAt(7);
        return await new Promise<Response>(() => undefined);
      }
      if (path !== "/api/view/discussion" || init?.method !== "POST") {
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

  it("changes the retry intent when live activity adopts a committed profile name", async () => {
    const adoptedActivity = heldJsonResponse(200);
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPage();
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return availableActivityAt(8);
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        return adoptedActivity.response;
      }
      if (path === "/api/view/discussion/activity?since=9&hold=30000&limit=100") {
        return await new Promise<Response>(() => undefined);
      }
      if (path === "/api/view/discussion" && init?.method === "POST") {
        const intent = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(intent);
        if (posted.length === 1) return new Response(null, { status: 404 });
        return jsonResponse({
          ok: true,
          message: {
            ...LINK_MESSAGE,
            messageId: "adopted-profile-retry",
            createdAtMs: 4_000,
            body: String(intent.body),
            author: {
              ...LINK_MESSAGE.author,
              displayName: String(intent.claimedName),
            },
          },
        });
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("comment");
    await settle(() => {
      const input = container.querySelector<HTMLTextAreaElement>(
        'textarea[name="body"]',
      );
      return input?.disabled === false && adoptedActivity.bodyStarted();
    });
    setControlValue(nameInput(), "Draft Name");
    setControlValue(bodyInput(), "Unchanged body");
    submit();
    await settle(() =>
      container.textContent?.includes("The comment didn't post. Try again.") === true
    );

    adoptedActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 9,
      cursorRevision: 9,
      hasMore: false,
      messages: [],
      composerState: "available",
      profileName: "Adopted Name",
    });
    await settle(() => nameInput().value === "Adopted Name" && nameInput().disabled);
    expect(bodyInput().value).toBe("Unchanged body");

    submit();
    await settle(() => posted.length === 2);
    expect(posted[0]?.claimedName).toBe("Draft Name");
    expect(posted[1]?.claimedName).toBe("Adopted Name");
    expect(posted[1]?.idempotencyKey).not.toBe(posted[0]?.idempotencyKey);
  });

  it.each(["success", "blocked", "paused"] as const)(
    "keeps a generic failure visible through a held %s retry body",
    async (outcome) => {
      const held = heldJsonResponse(outcome === "success" ? 200 : 403);
      const posted: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path.includes("/activity?")) {
          if (path.includes("hold=0")) return availableActivityAt(7);
          return await new Promise<Response>(() => undefined);
        }
        if (path !== "/api/view/discussion" || init?.method !== "POST") {
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
        : { ok: false, state: outcome, activityRevision: 7 });
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
      const path = requestPath(input);
      if (path.includes("/activity?")) {
        if (path.includes("hold=0")) return availableActivityAt(7);
        return await new Promise<Response>(() => undefined);
      }
      if (path !== "/api/view/discussion" || init?.method !== "POST") {
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
          profileName: null,
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
      profileName: null,
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

  it("clears an exact retry intent when the durable result is already deleted", async () => {
    const submittedBody = "Committed before its response was lost";
    const deleted = {
      messageId: "message-lost-response",
      createdAtMs: 4_000,
      deleted: true as const,
    };
    const heldDeletion = heldJsonResponse(200);
    const posted: Array<Record<string, unknown>> = [];
    let finalParkSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return posted.length === 1
          ? new Response(null, { status: 404 })
          : jsonResponse({ ok: true, message: deleted });
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          profileName: null,
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
    setControlValue(bodyInput(), submittedBody);
    submit();
    await settle(() =>
      container.textContent?.includes("The comment didn't post. Try again.") === true
    );

    heldDeletion.release({
      profileName: null,
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

    submit();
    await settle(() => posted.length === 2 && bodyInput().value === "");

    expect(posted[1]?.idempotencyKey).toBe(posted[0]?.idempotencyKey);
    expect(container.textContent).not.toContain(submittedBody);
    expect(container.textContent).not.toContain("The comment didn't post. Try again.");
    expect(container.querySelectorAll(".comment-row.comment-deleted")).toHaveLength(1);
  });

  it.each([
    ["blocked", "The owner turned off comments for this browser."],
    ["paused", "The owner paused comments. You can still read everything."],
  ] as const)("learns %s only from POST and keeps the timeline", async (state, copy) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST") return jsonResponse({ ok: false, state, activityRevision: 7 }, 403);
      const path = requestPath(input);
      if (path.includes("/activity?")) {
        if (path.includes("hold=0")) return availableActivityAt(7);
        return await new Promise<Response>(() => undefined);
      }
      return discussionPage([NAMED_MESSAGE]);
    }));

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

  it.each(["available", "paused", "blocked"] as const)(
    "latches a durable comment limit through later %s activity",
    async (laterState) => {
      const heldActivity = heldJsonResponse(200);
      const activityMessage = {
        ...LINK_MESSAGE,
        messageId: `message-after-limit-${laterState}`,
        createdAtMs: 4_000,
        body: `Readable after ${laterState}`,
      };
      let posts = 0;
      let parkedSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path === "/api/view/discussion" && init?.method === "POST") {
          posts += 1;
          return jsonResponse({ ok: false, state: "limit-reached" }, 413);
        }
        if (path === "/api/view/discussion?direction=newest-first") {
          return discussionPageAt(7, [NAMED_MESSAGE]);
        }
        if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
          return availableActivityAt(7);
        }
        if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
          return heldActivity.response;
        }
        if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
          parkedSignal = init?.signal ?? undefined;
          return await new Promise<Response>(() => undefined);
        }
        throw new Error(`unexpected request: ${path}`);
      }));

      await render("comment");
      await settle(heldActivity.bodyStarted);
      setControlValue(nameInput(), "Retained Name");
      setControlValue(bodyInput(), "Retained draft");
      submit();
      await settle(() => container.textContent?.includes(
        "You can't post more comments here. You can still read everything.",
      ) === true);

      expect(posts).toBe(1);
      expect(container.textContent).toContain("Named body");
      expect(nameInput().value).toBe("Retained Name");
      expect(bodyInput().value).toBe("Retained draft");
      expect(nameInput().disabled).toBe(true);
      expect(bodyInput().disabled).toBe(true);
      expect(submitButton().disabled).toBe(true);
      expect(container.textContent).not.toContain("Try again");
      submit();
      expect(posts).toBe(1);

      heldActivity.release({
        profileName: null,
        ok: true,
        access: "comment",
        latestRevision: 8,
        cursorRevision: 8,
        hasMore: false,
        messages: [activityMessage],
        composerState: laterState,
      });
      await settle(() =>
        container.textContent?.includes(activityMessage.body) === true &&
        parkedSignal !== undefined
      );

      expect(container.textContent).toContain("Named body");
      expect(container.textContent).toContain(activityMessage.body);
      expect(bodyInput().value).toBe("Retained draft");
      expect(bodyInput().disabled).toBe(true);
      expect(submitButton().disabled).toBe(true);
      expect(container.textContent).toContain(
        "You can't post more comments here. You can still read everything.",
      );
      expect(container.textContent).not.toContain("Try again");
      expect(posts).toBe(1);
    },
  );

  it("resets a durable comment limit only for a replacement session", async () => {
    const heldOldActivity = heldJsonResponse(200);
    let oldActivitySignal: AbortSignal | undefined;
    let replacementParkSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      const session = requestSession(init);
      if (path === "/api/view/discussion" && init?.method === "POST") {
        return jsonResponse({ ok: false, state: "limit-reached" }, 413);
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return session === FIRST_SESSION
          ? discussionPageAt(7, [NAMED_MESSAGE])
          : discussionPageAt(20, [{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }
      if (
        session === FIRST_SESSION &&
        path === "/api/view/discussion/activity?since=7&hold=0&limit=100"
      ) {
        return availableActivityAt(7);
      }
      if (
        session === FIRST_SESSION &&
        path === "/api/view/discussion/activity?since=7&hold=30000&limit=100"
      ) {
        oldActivitySignal = init?.signal ?? undefined;
        return heldOldActivity.response;
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=0&limit=100"
      ) {
        return jsonResponse({
          profileName: null,
          ok: true,
          access: "comment",
          latestRevision: 20,
          cursorRevision: 20,
          hasMore: false,
          messages: [],
          composerState: "available",
        });
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=30000&limit=100"
      ) {
        replacementParkSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${session} ${path}`);
    }));

    await render("comment");
    await settle(heldOldActivity.bodyStarted);
    setControlValue(bodyInput(), "Old limited draft");
    submit();
    await settle(() => bodyInput().disabled);
    expect(container.textContent).toContain(
      "You can't post more comments here. You can still read everything.",
    );

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
    });
    await settle(() => replacementParkSignal !== undefined);

    expect(oldActivitySignal?.aborted).toBe(true);
    expect(container.textContent).toContain("Replacement timeline");
    expect(container.textContent).not.toContain("Named body");
    expect(container.textContent).not.toContain(
      "You can't post more comments here. You can still read everything.",
    );
    expect(bodyInput().value).toBe("");
    expect(bodyInput().disabled).toBe(false);
    expect(submitButton().disabled).toBe(true);
    setControlValue(bodyInput(), "Replacement draft");
    expect(submitButton().disabled).toBe(false);
  });

  it.each([
    [403, "limit-reached", { ok: false, state: "limit-reached" }],
    [413, "blocked", { ok: false, state: "blocked", activityRevision: 7 }],
    [413, "paused", { ok: false, state: "paused", activityRevision: 7 }],
  ] as const)(
    "keeps the %i and %s write-state cross-pair retryable",
    async (status, _state, refusal) => {
      let posts = 0;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        if (init?.method !== "POST") {
          const path = requestPath(input);
          if (path.includes("/activity?")) {
            if (path.includes("hold=0")) return availableActivityAt(7);
            return await new Promise<Response>(() => undefined);
          }
          return discussionPage([NAMED_MESSAGE]);
        }
        posts += 1;
        return jsonResponse(refusal, status);
      }));

      await render("comment");
      setControlValue(bodyInput(), "Retryable cross-pair draft");
      submit();
      await settle(() => container.textContent?.includes(
        "The comment didn't post. Try again.",
      ) === true);

      expect(container.textContent).toContain("Named body");
      expect(container.textContent).not.toContain(
        "You can't post more comments here. You can still read everything.",
      );
      expect(bodyInput().value).toBe("Retryable cross-pair draft");
      expect(bodyInput().disabled).toBe(false);
      expect(submitButton().disabled).toBe(false);
      submit();
      await settle(() => posts === 2);
      expect(bodyInput().disabled).toBe(false);
      expect(submitButton().disabled).toBe(false);
    },
  );

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
      profileName: null,
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

  it("loads an earlier page after concurrent activity advances", async () => {
    const stalePageMessage = {
      ...LINK_MESSAGE,
      messageId: "message-page-race",
      createdAtMs: 2_000,
      body: "Stale page body",
    };
    const deletedPageMessage = {
      messageId: stalePageMessage.messageId,
      createdAtMs: stalePageMessage.createdAtMs,
      deleted: true as const,
    };
    const earlierMessage = {
      ...NAMED_MESSAGE,
      messageId: "message-earlier",
      createdAtMs: 1_000,
      body: "Earlier history",
    };
    const initialTail = {
      ...NAMED_MESSAGE,
      messageId: "message-initial-tail",
      createdAtMs: 4_000,
      body: "Initial tail",
    };
    const concurrentMessage = {
      ...LINK_MESSAGE,
      messageId: "message-concurrent",
      createdAtMs: 5_000,
      body: "Concurrent activity",
    };
    const activity = heldJsonResponse(200);
    const earlierPage = heldJsonResponse(200);
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(
          7,
          [initialTail],
          "cursor_concurrent",
        );
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return activity.response;
      }
      if (
        path ===
        "/api/view/discussion?direction=newest-first&cursor=cursor_concurrent"
      ) {
        return earlierPage.response;
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("view");
    await settle(activity.bodyStarted);
    clickButton("Load earlier comments");
    await settle(earlierPage.bodyStarted);

    activity.release({
      profileName: null,
      ok: true,
      access: "view",
      latestRevision: 8,
      cursorRevision: 8,
      hasMore: false,
      messages: [deletedPageMessage, concurrentMessage],
      composerState: "available",
    });
    await settle(() =>
      parkedSignal !== undefined &&
      container.textContent?.includes("Concurrent activity") === true
    );
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Named PersonInitial tail",
        "Link PersonUnverifiedConcurrent activity",
      ]);
    expect(container.textContent).not.toContain("Comment deleted by the owner");
    expect(container.textContent).not.toContain("Stale page body");

    earlierPage.release({
      ok: true,
      activityRevision: 7,
      messages: [earlierMessage, stalePageMessage].reverse(),
      nextCursor: null,
      profileName: null,
    });
    await settle(() =>
      container.textContent?.includes("Earlier history") === true ||
      container.textContent?.includes("Earlier comments didn't load.") === true
    );

    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Named PersonEarlier history",
        "Comment deleted by the owner",
        "Named PersonInitial tail",
        "Link PersonUnverifiedConcurrent activity",
      ]);
    expect(container.textContent).not.toContain("Stale page body");
    expect(container.textContent).not.toContain("Earlier comments didn't load.");
    expect(container.textContent).not.toContain("Load earlier comments");
  });

  it("keeps backdated activity before a complete initial history and follows its revision", async () => {
    const initial = {
      ...LINK_MESSAGE,
      messageId: "message-b",
      createdAtMs: 4_000,
      body: "Initial body",
    };
    const concurrent = {
      ...NAMED_MESSAGE,
      messageId: "message-a",
      createdAtMs: initial.createdAtMs - 1_000,
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
          profileName: null,
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

  it("accepts a committed backdated submit and clears its draft", async () => {
    const initial = {
      ...LINK_MESSAGE,
      messageId: "message-submit-tail",
      createdAtMs: 4_000,
      body: "Existing tail",
    };
    const committed = {
      ...LINK_MESSAGE,
      messageId: "message-backdated-submit",
      createdAtMs: 3_000,
      body: "Backdated submit",
    };
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion" && init?.method === "POST") {
        posts += 1;
        return jsonResponse({ ok: true, message: committed });
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7, [initial]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return availableActivityAt(7);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("comment");
    setControlValue(bodyInput(), committed.body);
    submit();
    await settle(() => bodyInput().value === "" ||
      container.textContent?.includes("The comment didn't post. Try again.") === true);

    expect(posts).toBe(1);
    expect(bodyInput().value).toBe("");
    expect(container.textContent).not.toContain("The comment didn't post. Try again.");
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Link PersonUnverifiedBackdated submit",
        "Link PersonUnverifiedExisting tail",
      ]);
  });

  it("adds a backdated live revision to a partial window without importing its tombstone", async () => {
    const loadedOldest = {
      ...LINK_MESSAGE,
      messageId: "message-loaded-oldest",
      createdAtMs: 4_000,
      body: "Loaded oldest",
    };
    const loadedTail = {
      ...NAMED_MESSAGE,
      messageId: "message-loaded-tail",
      createdAtMs: 6_000,
      body: "Loaded tail",
    };
    const hiddenTombstone = {
      messageId: "message-hidden-deleted",
      createdAtMs: 2_000,
      deleted: true as const,
    };
    const backdatedLive = {
      ...NAMED_MESSAGE,
      messageId: "message-backdated-live",
      createdAtMs: 3_000,
      body: "Backdated live",
    };
    const paths: string[] = [];
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      paths.push(path);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7, [loadedOldest, loadedTail], "cursor_hidden");
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          profileName: null,
          ok: true,
          access: "view",
          latestRevision: 8,
          cursorRevision: 8,
          hasMore: false,
          messages: [hiddenTombstone, backdatedLive],
          composerState: "available",
        });
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      if (
        path ===
        "/api/view/discussion?direction=newest-first&cursor=cursor_hidden"
      ) {
        return discussionPageAt(8, [hiddenTombstone]);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("view");
    await settle(() => parkedSignal !== undefined);

    expect(paths.filter((path) => path.includes("cursor=cursor_hidden"))).toHaveLength(0);
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Named PersonBackdated live",
        "Link PersonUnverifiedLoaded oldest",
        "Named PersonLoaded tail",
      ]);

    clickButton("Load earlier comments");
    await settle(() =>
      container.textContent?.includes("Comment deleted by the owner") === true
    );
    expect(paths.filter((path) => path.includes("cursor=cursor_hidden"))).toEqual([
      "/api/view/discussion?direction=newest-first&cursor=cursor_hidden",
    ]);
    expect([...container.querySelectorAll(".comment-row")].map((row) => row.textContent))
      .toEqual([
        "Comment deleted by the owner",
        "Named PersonBackdated live",
        "Link PersonUnverifiedLoaded oldest",
        "Named PersonLoaded tail",
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
      profileName: null,
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
      profileName: null,
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
      profileName: null,
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
      profileName: null,
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
      profileName: null,
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
          profileName: null,
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

  it.each([
    ["available", ""],
    ["paused", "The owner paused comments. You can still read everything."],
    ["blocked", "The owner turned off comments for this browser."],
  ] as const)(
    "keeps the composer gated until the first %s activity state arrives",
    async (composerState, expectedCopy) => {
      const firstActivity = heldJsonResponse(200);
      let parkedSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path === "/api/view/discussion?direction=newest-first") {
          return discussionPageAt(7);
        }
        if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
          return firstActivity.response;
        }
        if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
          parkedSignal = init?.signal ?? undefined;
          return await new Promise<Response>(() => undefined);
        }
        throw new Error(`unexpected request: ${path}`);
      }));

      await render("comment");
      await settle(firstActivity.bodyStarted);

      expect(nameInput().disabled).toBe(true);
      expect(bodyInput().disabled).toBe(true);
      expect(submitButton().disabled).toBe(true);

      firstActivity.release({
        profileName: null,
        ok: true,
        access: "comment",
        latestRevision: 7,
        cursorRevision: 7,
        hasMore: false,
        messages: [],
        composerState,
      });
      await settle(() => parkedSignal !== undefined);

      if (composerState === "available") {
        expect(nameInput().disabled).toBe(false);
        expect(bodyInput().disabled).toBe(false);
        setControlValue(bodyInput(), "Ready after activity");
        expect(submitButton().disabled).toBe(false);
      } else {
        expect(nameInput().disabled).toBe(true);
        expect(bodyInput().disabled).toBe(true);
        expect(submitButton().disabled).toBe(true);
        expect(container.textContent).toContain(expectedCopy);
      }
    },
  );

  it("gates a replacement session until its first activity state arrives", async () => {
    const replacementActivity = heldJsonResponse(200);
    let firstParkSignal: AbortSignal | undefined;
    let replacementParkSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      const session = requestSession(init);
      if (path === "/api/view/discussion?direction=newest-first") {
        return session === FIRST_SESSION
          ? discussionPageAt(7)
          : discussionPageAt(20, [{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }
      if (
        session === FIRST_SESSION &&
        path === "/api/view/discussion/activity?since=7&hold=0&limit=100"
      ) {
        return jsonResponse({
          profileName: null,
          ok: true,
          access: "comment",
          latestRevision: 7,
          cursorRevision: 7,
          hasMore: false,
          messages: [],
          composerState: "available",
        });
      }
      if (
        session === FIRST_SESSION &&
        path === "/api/view/discussion/activity?since=7&hold=30000&limit=100"
      ) {
        firstParkSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=0&limit=100"
      ) {
        return replacementActivity.response;
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=30000&limit=100"
      ) {
        replacementParkSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${session} ${path}`);
    }));

    await render("comment");
    await settle(() => firstParkSignal !== undefined && bodyInput().disabled === false);
    await act(async () => {
      root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
    });
    await settle(() =>
      replacementActivity.bodyStarted() &&
      container.textContent?.includes("Replacement timeline") === true
    );

    expect(firstParkSignal?.aborted).toBe(true);
    expect(nameInput().disabled).toBe(true);
    expect(bodyInput().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);

    replacementActivity.release({
      profileName: null,
      ok: true,
      access: "comment",
      latestRevision: 20,
      cursorRevision: 20,
      hasMore: false,
      messages: [],
      composerState: "available",
    });
    await settle(() => replacementParkSignal !== undefined && bodyInput().disabled === false);
  });

  it("keeps the composer gated through retryable first-activity failures", async () => {
    vi.useFakeTimers();
    const availableActivity = heldJsonResponse(200);
    let activityAttempts = 0;
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        activityAttempts += 1;
        if (activityAttempts === 1) return new Response(null, { status: 429 });
        if (activityAttempts === 2) return new Response(null, { status: 503 });
        if (activityAttempts === 3) throw new Error("transport failed");
        return availableActivity.response;
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("comment");
    await settle(() => activityAttempts === 1);
    expect(bodyInput().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(activityAttempts).toBe(2);
    expect(bodyInput().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(activityAttempts).toBe(3);
    expect(bodyInput().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await settle(availableActivity.bodyStarted);
    expect(activityAttempts).toBe(4);
    expect(bodyInput().disabled).toBe(true);

    availableActivity.release({
      profileName: null,
      ok: true,
      access: "comment",
      latestRevision: 7,
      cursorRevision: 7,
      hasMore: false,
      messages: [],
      composerState: "available",
    });
    await settle(() => parkedSignal !== undefined && bodyInput().disabled === false);
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
          profileName: null,
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

  it("retries a failed 200 activity body from the same cursor and applies recovery", async () => {
    vi.useFakeTimers();
    const recovered = {
      ...LINK_MESSAGE,
      messageId: "message-after-body-retry",
      createdAtMs: 4_000,
      body: "Body retry stayed live",
    };
    const paths: string[] = [];
    let activityAttempts = 0;
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      paths.push(path);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        activityAttempts += 1;
        return activityAttempts === 1
          ? failedBodyResponse()
          : jsonResponse({
              profileName: null,
              ok: true,
              access: "view",
              latestRevision: 8,
              cursorRevision: 8,
              hasMore: false,
              messages: [recovered],
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
    expect(paths.filter((path) =>
      path === "/api/view/discussion/activity?since=7&hold=0&limit=100"
    )).toHaveLength(2);
    expect(paths.at(-1)).toBe(
      "/api/view/discussion/activity?since=8&hold=30000&limit=100",
    );
    expect(container.textContent).toContain("Body retry stayed live");
    expect(parkedSignal?.aborted).toBe(false);
  });

  it.each([
    [
      "non-retryable response",
      () => new Response(null, { status: 404 }),
    ],
    [
      "malformed JSON",
      () => new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "schema-invalid JSON",
      () => jsonResponse({
        profileName: null,
        ok: true,
        access: "comment",
        latestRevision: 7,
        cursorRevision: 7,
        hasMore: false,
        messages: [],
        composerState: "blocked",
        internal: true,
      }),
    ],
    [
      "regressed cursor",
      () => jsonResponse({
        profileName: null,
        ok: true,
        access: "comment",
        latestRevision: 7,
        cursorRevision: 6,
        hasMore: true,
        messages: [],
        composerState: "available",
      }),
    ],
    [
      "refused message merge",
      () => jsonResponse({
        profileName: null,
        ok: true,
        access: "comment",
        latestRevision: 8,
        cursorRevision: 8,
        hasMore: false,
        messages: [{ ...NAMED_MESSAGE, body: "Conflicting body" }],
        composerState: "available",
      }),
    ],
  ])("stops after terminal %s activity", async (_label, activityResponse) => {
    vi.useFakeTimers();
    let activityAttempts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return discussionPageAt(7, [NAMED_MESSAGE]);
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        activityAttempts += 1;
        return activityResponse();
      }
      throw new Error(`unexpected request: ${path}`);
    }));

    await render("comment");
    await settle(() => activityAttempts === 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(activityAttempts).toBe(1);
    expect(container.textContent).toContain("Named body");
    expect(container.textContent).not.toContain(
      "The owner turned off comments for this browser.",
    );
    expect(container.textContent).toContain("Comments stopped updating.");
    expect(bodyInput().disabled).toBe(true);
    expect([...container.querySelectorAll("button")]
      .some((button) => button.textContent === "Try again")).toBe(true);
  });

  it("cancels recovery and fences its late page after unmount", async () => {
    let newestLoads = 0;
    let recoverySignal: AbortSignal | undefined;
    let recoveryActivityRequests = 0;
    let resolveRecoveryPage: ((response: Response) => void) | undefined;
    const heldRecoveryPage = new Promise<Response>((resolve) => {
      resolveRecoveryPage = resolve;
    });
    const lateRecoveryPage = discussionPageAt(9);
    const lateRecoveryBody = lateRecoveryPage.body;
    if (!lateRecoveryBody) throw new Error("recovery page body is missing");
    const cancelLateRecoveryBody = vi.spyOn(lateRecoveryBody, "cancel");
    const onAccessChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        newestLoads += 1;
        if (newestLoads === 1) return discussionPageAt(7, [NAMED_MESSAGE]);
        recoverySignal = init?.signal ?? undefined;
        return await heldRecoveryPage;
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return new Response(null, { status: 404 });
      }
      if (path === "/api/view/discussion/activity?since=9&hold=0&limit=100") {
        recoveryActivityRequests += 1;
        return availableActivityAt(9);
      }
      if (path === "/api/view/discussion/activity?since=9&hold=30000&limit=100") {
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
    await settle(() => container.textContent?.includes("Comments stopped updating.") === true);
    clickButton("Try again");
    await settle(() => recoverySignal !== undefined);

    act(() => root.unmount());
    resolveRecoveryPage?.(lateRecoveryPage);
    await settle(() =>
      cancelLateRecoveryBody.mock.calls.length > 0 || onAccessChange.mock.calls.length > 0
    );

    expect(recoverySignal?.aborted).toBe(true);
    expect(recoveryActivityRequests).toBe(0);
    expect(onAccessChange).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("cancels a pending body retry across session replacement and unmount", async () => {
    vi.useFakeTimers();
    let oldActivityAttempts = 0;
    let oldActivitySignal: AbortSignal | undefined;
    let replacementParkSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      const session = requestSession(init);
      if (path === "/api/view/discussion?direction=newest-first") {
        return session === FIRST_SESSION
          ? discussionPageAt(7)
          : discussionPageAt(20, [{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }
      if (
        session === FIRST_SESSION &&
        path === "/api/view/discussion/activity?since=7&hold=0&limit=100"
      ) {
        oldActivityAttempts += 1;
        oldActivitySignal = init?.signal ?? undefined;
        return failedBodyResponse();
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=0&limit=100"
      ) {
        return jsonResponse({
          profileName: null,
          ok: true,
          access: "comment",
          latestRevision: 20,
          cursorRevision: 20,
          hasMore: false,
          messages: [],
          composerState: "available",
        });
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=30000&limit=100"
      ) {
        replacementParkSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${session} ${path}`);
    }));

    await render("comment");
    await settle(() => oldActivityAttempts === 1 && vi.getTimerCount() > 0);
    await act(async () => {
      root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
    });
    await settle(() => replacementParkSignal !== undefined);

    expect(oldActivitySignal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(oldActivityAttempts).toBe(1);
    expect(container.textContent).toContain("Replacement timeline");

    act(() => root.unmount());
    expect(replacementParkSignal?.aborted).toBe(true);
    root = createRoot(container);
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
              profileName: null,
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
      if (
        session === FIRST_SESSION &&
        path === "/api/view/discussion/activity?since=7&hold=0&limit=100"
      ) {
        oldActivitySignal = init?.signal ?? undefined;
        return heldOldActivity.response;
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=0&limit=100"
      ) {
        return availableActivityAt(20);
      }
      if (
        session === SECOND_SESSION &&
        path === "/api/view/discussion/activity?since=20&hold=30000&limit=100"
      ) {
        replacementParkSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      throw new Error(`unexpected request: ${session} ${path}`);
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
      profileName: "Old Profile",
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Replacement timeline");
    expect(container.textContent).not.toContain("Old activity body");
    expect(container.textContent).not.toContain(
      "The owner turned off comments for this browser.",
    );
    expect(nameInput().value).toBe("");
    expect(nameInput().disabled).toBe(false);
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
        if (requestPath(input).includes("/activity?")) {
          if (requestPath(input).includes("hold=0")) return availableActivityAt(7);
          return await new Promise<Response>(() => undefined);
        }
        return requestSession(init) === FIRST_SESSION
          ? discussionPage()
          : discussionPage([{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }));

      await render("comment");
      await settle(() => bodyInput().disabled === false);
      setControlValue(bodyInput(), "Old draft");
      submit();
      await act(async () => {
        root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
      });
      await settle(() => container.textContent?.includes("Replacement timeline") === true);
      await settle(() => bodyInput().disabled === false);
      setControlValue(bodyInput(), "Replacement draft");
      resolveOld?.(outcome === "success"
        ? jsonResponse({
            ok: true,
            message: { ...LINK_MESSAGE, body: "Old committed body" },
          })
        : jsonResponse({ activityRevision: 7, ok: false, state: "blocked" }, 403));
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
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        if (init?.method === "POST") {
          oldSignal = init.signal ?? undefined;
          return held.response;
        }
        if (requestPath(input).includes("/activity?")) {
          if (requestPath(input).includes("hold=0")) return availableActivityAt(7);
          return await new Promise<Response>(() => undefined);
        }
        return requestSession(init) === FIRST_SESSION
          ? discussionPage()
          : discussionPage([{ ...NAMED_MESSAGE, body: "Replacement timeline" }]);
      }));

      await render("comment");
      await settle(() => bodyInput().disabled === false);
      setControlValue(bodyInput(), "Old draft");
      submit();
      await settle(held.bodyStarted);
      await act(async () => {
        root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
      });
      await settle(() => container.textContent?.includes("Replacement timeline") === true);
      await settle(() => bodyInput().disabled === false);
      setControlValue(bodyInput(), "Replacement draft");
      held.release(outcome === "success"
        ? {
            ok: true,
            message: { ...LINK_MESSAGE, body: "Old committed body" },
          }
        : { ok: false, state: outcome, activityRevision: 7 });
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

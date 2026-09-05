// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./CommentsPanel";

const FIRST_SESSION = "abcdefghijkl";
const SECOND_SESSION = "mnopqrstuvwx";
const SETTLE_TURN_LIMIT = 300;

const OLD_MESSAGE = {
  messageId: "message-old",
  createdAtMs: 1_000,
  deleted: false as const,
  body: "Old timeline",
  author: { kind: "named" as const, displayName: "Owner" },
};

const NEW_MESSAGE = {
  messageId: "message-new",
  createdAtMs: 2_000,
  deleted: false as const,
  body: "Recovered timeline",
  author: { kind: "named" as const, displayName: "Owner" },
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

function page(input: {
  activityRevision?: number;
  messages?: readonly unknown[];
  nextCursor?: string | null;
  profileName?: string | null;
} = {}): Response {
  return jsonResponse({
    ok: true,
    activityRevision: input.activityRevision ?? 7,
    messages: [...(input.messages ?? [])].reverse(),
    nextCursor: input.nextCursor ?? null,
    profileName: input.profileName ?? null,
  });
}

function activity(input: {
  composerState?: "available" | "blocked" | "paused";
  cursorRevision: number;
  hasMore?: boolean;
  latestRevision?: number;
  messages?: readonly unknown[];
  profileName?: string | null;
}): Response {
  return jsonResponse({
    ok: true,
    access: "comment",
    latestRevision: input.latestRevision ?? input.cursorRevision,
    cursorRevision: input.cursorRevision,
    hasMore: input.hasMore ?? false,
    messages: input.messages ?? [],
    composerState: input.composerState ?? "available",
    profileName: input.profileName ?? null,
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;
  const url = new URL(input.url);
  return `${url.pathname}${url.search}`;
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

describe("CommentsPanel monotonic composer", () => {
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(session = FIRST_SESSION): Promise<void> {
    await act(async () => {
      root.render(<CommentsPanel access="comment" session={session} />);
    });
    await settle(() => container.querySelector('textarea[name="body"]') !== null);
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

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === label);
    if (!match) throw new Error(`${label} button is missing`);
    return match;
  }

  function click(label: string): void {
    act(() => {
      button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("admits only normalized names and reports body errors before name errors", async () => {
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "POST") {
        const intent = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(intent);
        return jsonResponse({
          ok: true,
          message: {
            messageId: `posted-${String(posted.length)}`,
            createdAtMs: 3_000 + posted.length,
            deleted: false,
            body: intent.body,
            author: {
              kind: "link",
              displayName: intent.claimedName ?? "Anonymous",
              unverified: true,
            },
          },
        });
      }
      const path = requestPath(input);
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return activity({ cursorRevision: 7 });
      }
      if (path.includes("/activity?")) {
        return await new Promise<Response>(() => undefined);
      }
      return page();
    }));

    await render();
    await settle(() => bodyInput().disabled === false);
    setControlValue(bodyInput(), "Valid body");
    setControlValue(nameInput(), "a".repeat(41));
    expect(button("Post comment").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "This name is too long. Use 40 characters or fewer.",
    );
    expect(nameInput().getAttribute("aria-describedby")).toContain("comment-submit-status");
    click("Post comment");
    expect(posted).toHaveLength(0);

    setControlValue(nameInput(), "\u202e\u0000");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "This name has no visible characters. Type a name or clear the field.",
    );
    setControlValue(bodyInput(), "x".repeat(2_001));
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "This comment is too long. Shorten it before posting.",
    );

    setControlValue(bodyInput(), "Normalized body");
    setControlValue(nameInput(), "  Jose\u0301   Reader  ");
    click("Post comment");
    await settle(() => posted.length === 1);
    expect(posted[0]?.claimedName).toBe("Jos\u00e9 Reader");

    await act(async () => {
      root.render(<CommentsPanel access="comment" session={SECOND_SESSION} />);
    });
    await settle(() =>
      nameInput().value === "" &&
      bodyInput().value === "" &&
      bodyInput().disabled === false
    );
    setControlValue(bodyInput(), "No claimed name");
    click("Post comment");
    await settle(() => posted.length === 2);
    expect(posted[1]).not.toHaveProperty("claimedName");
  });

  it("adopts and locks only a non-null current activity name", async () => {
    const namedActivity = heldJsonResponse(200);
    const nullActivity = heldJsonResponse(200);
    let activityCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        return page({ nextCursor: "old_cursor" });
      }
      if (
        path ===
          "/api/view/discussion?direction=newest-first&cursor=old_cursor"
      ) {
        return page({ profileName: "Wrong Earlier Name" });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        activityCalls += 1;
        return namedActivity.response;
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        activityCalls += 1;
        return nullActivity.response;
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(namedActivity.bodyStarted);
    setControlValue(nameInput(), "Conflicting Name");
    setControlValue(bodyInput(), "Unposted body");
    namedActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 8,
      cursorRevision: 8,
      hasMore: false,
      messages: [],
      composerState: "available",
      profileName: "Stable Name",
    });
    await settle(() => nameInput().value === "Stable Name" && nameInput().disabled);
    expect(bodyInput().value).toBe("Unposted body");

    await settle(nullActivity.bodyStarted);
    nullActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 9,
      cursorRevision: 9,
      hasMore: false,
      messages: [],
      composerState: "available",
      profileName: null,
    });
    await settle(() => activityCalls === 2);
    expect(nameInput().value).toBe("Stable Name");
    expect(nameInput().disabled).toBe(true);
    expect(bodyInput().value).toBe("Unposted body");
    click("Load earlier comments");
    await act(async () => {
      await Promise.resolve();
    });
    expect(nameInput().value).toBe("Stable Name");
    expect(nameInput().disabled).toBe(true);
  });

  it("orders reversible refusals by latest activity and preserves the exact retry", async () => {
    const heldActivity = heldJsonResponse(200);
    const heldRefusal = heldJsonResponse(403);
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (posted.length === 1) return heldRefusal.response;
        return jsonResponse({
          ok: true,
          message: {
            messageId: "retried",
            createdAtMs: 4_000,
            deleted: false,
            body: "Held draft",
            author: { kind: "link", displayName: "Visitor", unverified: true },
          },
        });
      }
      if (path === "/api/view/discussion?direction=newest-first") return page();
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return activity({ cursorRevision: 7 });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        return heldActivity.bodyStarted()
          ? await new Promise<Response>(() => undefined)
          : heldActivity.response;
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(() => heldActivity.bodyStarted() && bodyInput().disabled === false);
    setControlValue(bodyInput(), "Held draft");
    click("Post comment");
    await settle(heldRefusal.bodyStarted);
    heldActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 9,
      cursorRevision: 8,
      hasMore: true,
      messages: [],
      composerState: "available",
      profileName: null,
    });
    await act(async () => {
      await Promise.resolve();
    });
    heldRefusal.release({ ok: false, state: "blocked", activityRevision: 8 });
    await settle(() => container.textContent?.includes("The comment didn't post. Try again.") === true);

    expect(bodyInput().value).toBe("Held draft");
    expect(bodyInput().disabled).toBe(false);
    expect(container.textContent).not.toContain("The owner turned off comments");
    click("Post comment");
    await settle(() => posted.length === 2);
    expect(posted[1]?.idempotencyKey).toBe(posted[0]?.idempotencyKey);
  });

  it("applies an equal or newer refusal without clearing the draft", async () => {
    const heldActivity = heldJsonResponse(200);
    const heldRefusal = heldJsonResponse(403);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") return heldRefusal.response;
      if (path === "/api/view/discussion?direction=newest-first") return page();
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return activity({ cursorRevision: 7 });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        return heldActivity.response;
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(() => heldActivity.bodyStarted() && bodyInput().disabled === false);
    setControlValue(bodyInput(), "Refused draft");
    click("Post comment");
    await settle(heldRefusal.bodyStarted);
    heldActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 8,
      cursorRevision: 8,
      hasMore: false,
      messages: [],
      composerState: "available",
      profileName: null,
    });
    await act(async () => {
      await Promise.resolve();
    });
    heldRefusal.release({ ok: false, state: "blocked", activityRevision: 9 });
    await settle(() => container.textContent?.includes(
      "The owner turned off comments for this browser.",
    ) === true);

    expect(bodyInput().value).toBe("Refused draft");
    expect(bodyInput().disabled).toBe(true);
    expect(container.textContent).not.toContain("The comment didn't post. Try again.");
  });

  it("keeps a newer blocked refusal after an older activity body arrives", async () => {
    const heldActivity = heldJsonResponse(200);
    const heldRefusal = heldJsonResponse(403);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") return heldRefusal.response;
      if (path === "/api/view/discussion?direction=newest-first") return page();
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return activity({ cursorRevision: 7 });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        return heldActivity.bodyStarted()
          ? await new Promise<Response>(() => undefined)
          : heldActivity.response;
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(() => heldActivity.bodyStarted() && bodyInput().disabled === false);
    setControlValue(bodyInput(), "Blocked draft");
    click("Post comment");
    await settle(heldRefusal.bodyStarted);
    heldRefusal.release({ ok: false, state: "blocked", activityRevision: 8 });
    await settle(() => container.textContent?.includes(
      "The owner turned off comments for this browser.",
    ) === true);

    expect(bodyInput().value).toBe("Blocked draft");
    expect(bodyInput().disabled).toBe(true);

    await act(async () => {
      heldActivity.release({
        ok: true,
        access: "comment",
        latestRevision: 7,
        cursorRevision: 7,
        hasMore: false,
        messages: [],
        composerState: "available",
        profileName: null,
      });
      await Promise.resolve();
    });

    expect(bodyInput().value).toBe("Blocked draft");
    expect(bodyInput().disabled).toBe(true);
    expect(container.textContent).toContain(
      "The owner turned off comments for this browser.",
    );
  });

  it("recovers from a terminal follower only after a newest page and valid activity", async () => {
    const terminal = heldJsonResponse(200);
    const recoveryPage = heldJsonResponse(200);
    const recoveryActivity = heldJsonResponse(200);
    const hiddenLive = {
      messageId: "message-hidden",
      createdAtMs: 500,
      deleted: false as const,
      body: "Recovered earlier live row",
      author: { kind: "named" as const, displayName: "Owner" },
    };
    const hiddenTombstone = {
      messageId: hiddenLive.messageId,
      createdAtMs: hiddenLive.createdAtMs,
      deleted: true as const,
    };
    const posted: Array<Record<string, unknown>> = [];
    let newestLoads = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return posted.length === 1
          ? new Response(null, { status: 404 })
          : jsonResponse({ ok: false, state: "blocked", activityRevision: 11 }, 403);
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        newestLoads += 1;
        return newestLoads === 1
          ? page({ messages: [OLD_MESSAGE], nextCursor: "old_cursor" })
          : recoveryPage.response;
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          ok: true,
          access: "comment",
          latestRevision: 8,
          cursorRevision: 8,
          hasMore: false,
          messages: [hiddenTombstone],
          composerState: "available",
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=8&hold=30000&limit=100") {
        return terminal.response;
      }
      if (path === "/api/view/discussion/activity?since=12&hold=0&limit=100") {
        return recoveryActivity.response;
      }
      if (
        path ===
          "/api/view/discussion?direction=newest-first&cursor=new_cursor"
      ) {
        return page({ messages: [hiddenLive] });
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(terminal.bodyStarted);
    setControlValue(nameInput(), "Typed Name");
    setControlValue(bodyInput(), "Preserved draft");
    click("Post comment");
    await settle(() => posted.length === 1 &&
      container.textContent?.includes("The comment didn't post. Try again.") === true);
    expect(posted[0]?.body).toBe("Preserved draft");
    expect(posted[0]?.claimedName).toBe("Typed Name");

    terminal.release({ ok: true, internal: true });
    await settle(() => container.textContent?.includes("Comments stopped updating.") === true);
    expect(container.textContent).toContain("Old timeline");
    expect(nameInput().value).toBe("Typed Name");
    expect(bodyInput().value).toBe("Preserved draft");
    expect(bodyInput().disabled).toBe(true);

    click("Try again");
    await settle(recoveryPage.bodyStarted);
    expect(button("Try again").disabled).toBe(true);
    expect(container.textContent).toContain("Old timeline");
    recoveryPage.release({
      ok: true,
      activityRevision: 12,
      messages: [NEW_MESSAGE],
      nextCursor: "new_cursor",
      profileName: null,
    });
    await settle(recoveryActivity.bodyStarted);
    expect(container.textContent).toContain("Recovered timeline");
    expect(container.textContent).not.toContain("Old timeline");
    expect(container.textContent).toContain("Comments stopped updating.");
    expect(bodyInput().disabled).toBe(true);
    expect(nameInput().value).toBe("Typed Name");
    expect(bodyInput().value).toBe("Preserved draft");

    recoveryActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 13,
      cursorRevision: 13,
      hasMore: false,
      messages: [],
      composerState: "available",
      profileName: "Stable Name",
    });
    await settle(() => !container.textContent?.includes("Comments stopped updating.") &&
      nameInput().value === "Stable Name");
    expect(nameInput().disabled).toBe(true);
    expect(bodyInput().value).toBe("Preserved draft");
    expect(bodyInput().disabled).toBe(false);
    expect(container.textContent).toContain("The comment didn't post. Try again.");

    click("Load earlier comments");
    await settle(() => container.textContent?.includes(hiddenLive.body) === true);
    expect(container.textContent).not.toContain("Comment deleted by the owner");

    click("Post comment");
    await settle(() => posted.length === 2);
    expect(posted[1]?.body).toBe("Preserved draft");
    expect(posted[1]?.claimedName).toBe("Stable Name");
    expect(posted[1]?.idempotencyKey).not.toBe(posted[0]?.idempotencyKey);
    expect(bodyInput().value).toBe("Preserved draft");
    expect(bodyInput().disabled).toBe(false);
    expect(container.textContent).toContain("The comment didn't post. Try again.");
    expect(container.textContent).not.toContain("The owner turned off comments");
  });

  it.each(["success", "failure"] as const)(
    "ignores a live-started earlier %s settlement after the follower stops",
    async (settlement) => {
      const heldEarlier = heldJsonResponse(200);
      const terminal = heldJsonResponse(200);
      const earlierRequests: string[] = [];
      const staleEarlier = {
        messageId: "message-stale-earlier",
        createdAtMs: 500,
        deleted: false as const,
        body: "Stale earlier timeline",
        author: { kind: "named" as const, displayName: "Owner" },
      };
      const recoveredEarlier = {
        messageId: "message-recovered-earlier",
        createdAtMs: 1_500,
        deleted: false as const,
        body: "Recovered earlier timeline",
        author: { kind: "named" as const, displayName: "Owner" },
      };
      let newestLoads = 0;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/view/discussion?direction=newest-first") {
          newestLoads += 1;
          return newestLoads === 1
            ? page({ messages: [OLD_MESSAGE], nextCursor: "old_cursor" })
            : page({
                activityRevision: 12,
                messages: [NEW_MESSAGE],
                nextCursor: "new_cursor",
              });
        }
        if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
          return terminal.response;
        }
        if (path === "/api/view/discussion/activity?since=12&hold=0&limit=100") {
          return activity({ cursorRevision: 12 });
        }
        if (path.includes("/api/view/discussion?direction=newest-first&cursor=")) {
          earlierRequests.push(path);
          if (path.endsWith("cursor=old_cursor")) return heldEarlier.response;
          if (path.endsWith("cursor=new_cursor")) {
            return page({ messages: [recoveredEarlier] });
          }
        }
        return await new Promise<Response>(() => undefined);
      }));

      await render();
      await settle(terminal.bodyStarted);
      click("Load earlier comments");
      await settle(heldEarlier.bodyStarted);
      terminal.release({ ok: true, internal: true });
      await settle(() => container.textContent?.includes(
        "Comments stopped updating.",
      ) === true);

      await act(async () => {
        heldEarlier.release(settlement === "success"
          ? {
              ok: true,
              activityRevision: 7,
              messages: [staleEarlier],
              nextCursor: "held_cursor",
              profileName: null,
            }
          : { ok: true, internal: true });
        await Promise.resolve();
      });

      expect(container.textContent).toContain("Comments stopped updating.");
      expect(container.textContent).toContain("Old timeline");
      expect(container.textContent).not.toContain(staleEarlier.body);
      expect(container.textContent).not.toContain("Earlier comments didn't load.");

      if (settlement === "success") {
        click("Try again");
        await settle(() =>
          container.textContent?.includes("Comments stopped updating.") === false &&
          container.textContent?.includes("Recovered timeline") === true
        );
        click("Load earlier comments");
        await settle(() => earlierRequests.length === 2);

        expect(earlierRequests).toEqual([
          "/api/view/discussion?direction=newest-first&cursor=old_cursor",
          "/api/view/discussion?direction=newest-first&cursor=new_cursor",
        ]);
        await settle(() => container.textContent?.includes(recoveredEarlier.body) === true);
        expect(container.textContent).not.toContain(staleEarlier.body);
      }
    },
  );

  it("keeps earlier history behind recovery and adopts the recovery cursor", async () => {
    const terminal = heldJsonResponse(200);
    const recoveryPage = heldJsonResponse(200);
    const recoveryActivity = heldJsonResponse(200);
    const earlierRequests: string[] = [];
    let newestLoads = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/discussion?direction=newest-first") {
        newestLoads += 1;
        return newestLoads === 1
          ? page({ messages: [OLD_MESSAGE], nextCursor: "old_cursor" })
          : recoveryPage.response;
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return terminal.response;
      }
      if (path === "/api/view/discussion/activity?since=12&hold=0&limit=100") {
        return recoveryActivity.response;
      }
      if (path.includes("/api/view/discussion?direction=newest-first&cursor=")) {
        earlierRequests.push(path);
        if (path.endsWith("cursor=new_cursor")) {
          return page({
            messages: [{
              messageId: "message-earlier-recovered",
              createdAtMs: 1_500,
              deleted: false,
              body: "Earlier recovered timeline",
              author: { kind: "named", displayName: "Owner" },
            }],
          });
        }
        return await new Promise<Response>(() => undefined);
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(terminal.bodyStarted);
    terminal.release({ ok: true, internal: true });
    await settle(() => container.textContent?.includes("Comments stopped updating.") === true);

    click("Try again");
    await settle(recoveryPage.bodyStarted);
    expect(button("Load earlier comments").disabled).toBe(true);

    const guardedEarlierButton = button("Load earlier comments");
    guardedEarlierButton.disabled = false;
    click("Load earlier comments");
    await act(async () => {
      await Promise.resolve();
    });
    expect(earlierRequests).toEqual([]);

    recoveryPage.release({
      ok: true,
      activityRevision: 12,
      messages: [NEW_MESSAGE],
      nextCursor: "new_cursor",
      profileName: null,
    });
    await settle(recoveryActivity.bodyStarted);
    expect(container.textContent).toContain("Recovered timeline");
    expect(container.textContent).not.toContain("Old timeline");

    recoveryActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 13,
      cursorRevision: 13,
      hasMore: false,
      messages: [],
      composerState: "available",
      profileName: null,
    });
    await settle(() => button("Load earlier comments").disabled === false);
    click("Load earlier comments");
    await settle(() => earlierRequests.length === 1);

    expect(earlierRequests).toEqual([
      "/api/view/discussion?direction=newest-first&cursor=new_cursor",
    ]);
    await settle(() =>
      container.textContent?.includes("Earlier recovered timeline") === true
    );
    expect(container.textContent).toContain("Recovered timeline");
    expect(container.textContent).not.toContain("Old timeline");
  });

  it("preserves a pending post through terminal entry and recovery", async () => {
    const heldPost = heldJsonResponse(403);
    const terminal = heldJsonResponse(200);
    const recoveryActivity = heldJsonResponse(200);
    let newestLoads = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") return heldPost.response;
      if (path === "/api/view/discussion?direction=newest-first") {
        newestLoads += 1;
        return page({ activityRevision: newestLoads === 1 ? 7 : 9 });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return activity({ cursorRevision: 7 });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        return terminal.response;
      }
      if (path === "/api/view/discussion/activity?since=9&hold=0&limit=100") {
        return recoveryActivity.response;
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(() => terminal.bodyStarted() && bodyInput().disabled === false);
    setControlValue(nameInput(), "Pending Name");
    setControlValue(bodyInput(), "Pending body");
    click("Post comment");
    await settle(heldPost.bodyStarted);
    terminal.release({ ok: true, internal: true });
    await settle(() => container.textContent?.includes("Comments stopped updating.") === true);
    expect(nameInput().value).toBe("Pending Name");
    expect(bodyInput().value).toBe("Pending body");
    expect(button("Post comment").disabled).toBe(true);

    click("Try again");
    await settle(recoveryActivity.bodyStarted);
    expect(nameInput().value).toBe("Pending Name");
    expect(bodyInput().value).toBe("Pending body");
    expect(button("Post comment").disabled).toBe(true);

    recoveryActivity.release({
      ok: true,
      access: "comment",
      latestRevision: 9,
      cursorRevision: 9,
      hasMore: false,
      messages: [],
      composerState: "available",
      profileName: null,
    });
    await settle(() => !container.textContent?.includes("Comments stopped updating."));
    expect(nameInput().value).toBe("Pending Name");
    expect(bodyInput().value).toBe("Pending body");
    expect(button("Post comment").disabled).toBe(true);

    heldPost.release({ ok: false, state: "blocked", activityRevision: 8 });
    await settle(() => container.textContent?.includes("The comment didn't post. Try again.") === true);
    expect(button("Post comment").disabled).toBe(false);
  });

  it("keeps a durable limit latched across stopped recovery", async () => {
    const terminal = heldJsonResponse(200);
    let newestLoads = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (init?.method === "POST") {
        return jsonResponse({ ok: false, state: "limit-reached" }, 413);
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        newestLoads += 1;
        return page({ activityRevision: newestLoads === 1 ? 7 : 10 });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return activity({ cursorRevision: 7 });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        return terminal.response;
      }
      if (path === "/api/view/discussion/activity?since=10&hold=0&limit=100") {
        return activity({ cursorRevision: 10, composerState: "available" });
      }
      return await new Promise<Response>(() => undefined);
    }));

    await render();
    await settle(() => terminal.bodyStarted() && bodyInput().disabled === false);
    setControlValue(bodyInput(), "Limited body");
    click("Post comment");
    await settle(() => container.textContent?.includes("You can't post more comments here.") === true);
    terminal.release({ ok: true, internal: true });
    await settle(() => container.textContent?.includes("Comments stopped updating.") === true);
    click("Try again");
    await settle(() => !container.textContent?.includes("Comments stopped updating."));

    expect(bodyInput().value).toBe("Limited body");
    expect(bodyInput().disabled).toBe(true);
    expect(button("Post comment").disabled).toBe(true);
    expect(container.textContent).toContain(
      "You can't post more comments here. You can still read everything.",
    );
  });

  it.each(["page", "first follower"] as const)(
    "returns to stopped intact after a terminal recovery %s failure",
    async (failure) => {
      const terminal = heldJsonResponse(200);
      let newestLoads = 0;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/view/discussion?direction=newest-first") {
          newestLoads += 1;
          if (newestLoads === 1) return page({ messages: [OLD_MESSAGE] });
          return failure === "page"
            ? new Response(null, { status: 503 })
            : page({
                activityRevision: 9,
                messages: [NEW_MESSAGE],
                profileName: "Committed Recovery Name",
              });
        }
        if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
          return terminal.response;
        }
        if (path === "/api/view/discussion/activity?since=9&hold=0&limit=100") {
          return new Response(null, { status: 404 });
        }
        return await new Promise<Response>(() => undefined);
      }));

      await render();
      await settle(terminal.bodyStarted);
      setControlValue(nameInput(), "Recovery Name");
      setControlValue(bodyInput(), "Recovery body");
      terminal.release({ ok: true, internal: true });
      await settle(() => container.textContent?.includes("Comments stopped updating.") === true);
      click("Try again");
      await settle(() =>
        container.textContent?.includes("Comments stopped updating.") === true &&
        button("Try again").disabled === false
      );

      expect(container.textContent).toContain(
        failure === "page" ? "Old timeline" : "Recovered timeline",
      );
      expect(container.textContent).not.toContain("Comments didn't load.");
      expect(nameInput().value).toBe(
        failure === "page" ? "Recovery Name" : "Committed Recovery Name",
      );
      expect(nameInput().disabled).toBe(true);
      expect(bodyInput().value).toBe("Recovery body");
      expect(bodyInput().disabled).toBe(true);
    },
  );
});

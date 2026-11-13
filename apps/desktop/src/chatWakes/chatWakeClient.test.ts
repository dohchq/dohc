import { describe, expect, it } from "vitest";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import {
  CHAT_WAKE_MUTATION_MS,
  ChatWakeAnswerError,
  ChatWakeBusyError,
  ChatWakeMissingError,
  createChatWakeClient,
} from "./chatWakeClient";

const WAKE = `wake-${"a".repeat(32)}`;
const view = {
  wakeId: WAKE,
  workspaceId: "ws",
  messageId: "m1",
  threadId: "t1",
  generation: 1,
  state: "claimed",
  prerequisiteMessageId: null,
  winnerLabel: "Mac",
};
const waiting = {
  ...view,
  state: "waiting",
  winnerLabel: null,
  candidate: { installId: "mac", agentId: "default", label: "Mac", matched: { handle: "claude" } },
};

type Sent = { url: string; init: RequestInit };

/** A relay answering each request with the next body, recording what it was sent, and the deadlines asked for. */
function world(...answers: Array<{ status?: number; body: unknown } | "hang">) {
  const sent: Sent[] = [];
  const deadlines: number[] = [];
  const timeouts: AbortController[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    sent.push({ url: String(input), init });
    const answer = answers.shift();
    if (answer === undefined || answer === "hang") {
      return await new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return new Response(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
      { status: answer.status ?? 200 },
    );
  };
  const client = createChatWakeClient({
    relay: { baseUrl: "https://relay.test/", token: "secret", fetch },
    timeout: (ms) => {
      deadlines.push(ms);
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    },
  });
  return { client, sent, deadlines, timeouts, signal: new AbortController().signal };
}

describe("the chat wake client", () => {
  it("waits with a deadline past the hold and reads the page", async () => {
    const w = world({ body: { ok: true, cursor: "12", wakes: [waiting] } });
    const page = await w.client.waitWakes({ installId: "mac", since: 4, holdMs: 25_000 }, w.signal);
    expect(page).toEqual({ cursor: 12, wakes: [waiting] });
    expect(w.sent[0]!.url).toBe("https://relay.test/sync/wakes?installId=mac&since=4&wait=25000");
    expect(new Headers(w.sent[0]!.init.headers).get("authorization")).toBe("Bearer secret");
    expect(w.deadlines).toEqual([40_000]);
  });

  it("ends a wait at its own deadline", async () => {
    const w = world("hang");
    const read = w.client.waitWakes({ installId: "mac", since: 0, holdMs: 99_000 }, w.signal);
    expect(w.deadlines).toEqual([40_000]);
    w.timeouts[0]!.abort(new DOMException("deadline", "TimeoutError"));
    await expect(read).rejects.toThrow("deadline");
  });

  it.each<[string, unknown]>([
    ["an extra field", { ok: true, cursor: "1", wakes: [], more: true }],
    ["a cursor that isn't a sequence", { ok: true, cursor: "01", wakes: [] }],
    [
      "a row that isn't waiting",
      { ok: true, cursor: "1", wakes: [{ ...waiting, state: "claimed" }] },
    ],
    [
      "another computer's candidate",
      {
        ok: true,
        cursor: "1",
        wakes: [{ ...waiting, candidate: { ...waiting.candidate, installId: "pc" } }],
      },
    ],
    [
      "a personal agent",
      {
        ok: true,
        cursor: "1",
        wakes: [{ ...waiting, candidate: { ...waiting.candidate, agentId: "p-ana" } }],
      },
    ],
    ["a malformed wake ID", { ok: true, cursor: "1", wakes: [{ ...waiting, wakeId: "wake-1" }] }],
    ["text that isn't JSON", "{"],
  ])("refuses a page with %s", async (_name, body) => {
    const w = world({ body });
    await expect(
      w.client.waitWakes({ installId: "mac", since: 0, holdMs: 0 }, w.signal),
    ).rejects.toBeInstanceOf(ChatWakeAnswerError);
  });

  it("claims with exactly the install ID and a short deadline", async () => {
    const w = world({ body: { ok: true, won: true, wake: view } });
    expect(await w.client.claimWake(WAKE, "mac", w.signal)).toEqual({ won: true, wake: view });
    expect(w.sent[0]!.url).toBe(`https://relay.test/sync/wakes/${WAKE}/claim`);
    expect(w.sent[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(w.sent[0]!.init.body))).toEqual({ installId: "mac" });
    expect(w.deadlines).toEqual([CHAT_WAKE_MUTATION_MS]);
  });

  it.each<[string, { status?: number; body: unknown }, new (...args: never[]) => Error]>([
    [
      "another wake",
      { body: { ok: true, won: true, wake: { ...view, wakeId: `wake-${"b".repeat(32)}` } } },
      ChatWakeAnswerError,
    ],
    ["no won flag", { body: { ok: true, wake: view } }, ChatWakeAnswerError],
    [
      "an unknown state",
      { body: { ok: true, won: true, wake: { ...view, state: "started" } } },
      ChatWakeAnswerError,
    ],
    [
      "not found",
      { status: 404, body: { ok: false, error: "not found", code: "not_found" } },
      ChatWakeMissingError,
    ],
    [
      "busy",
      { status: 503, body: { ok: false, error: "busy", code: "server_busy" } },
      ChatWakeBusyError,
    ],
    [
      "an expired sign-in",
      { status: 401, body: { ok: false, error: "no", code: "unauthorized" } },
      RelayUnauthorizedError,
    ],
  ])("answers a claim with %s as its error", async (_name, answer, error) => {
    const w = world(answer);
    await expect(w.client.claimWake(WAKE, "mac", w.signal)).rejects.toBeInstanceOf(error);
  });

  it("confirms only an answer about the wake it named", async () => {
    const queued = { ...view, state: "queued" };
    const w = world(
      { body: { ok: true, wake: queued } },
      { body: { ok: true, wake: { ...queued, wakeId: `wake-${"b".repeat(32)}` } } },
    );
    expect(await w.client.confirmQueued(WAKE, "mac", w.signal)).toEqual(queued);
    await expect(w.client.confirmQueued(WAKE, "mac", w.signal)).rejects.toBeInstanceOf(
      ChatWakeAnswerError,
    );
    expect(w.sent[0]!.url).toBe(`https://relay.test/sync/wakes/${WAKE}/queued`);
  });

  it("ends a confirmation at its deadline as an unknown outcome", async () => {
    const w = world("hang");
    const confirming = w.client.confirmQueued(WAKE, "mac", w.signal);
    w.timeouts[0]!.abort(new DOMException("deadline", "TimeoutError"));
    await expect(confirming).rejects.toThrow("deadline");
  });

  it("replaces runners with exactly the declaration and checks the count", async () => {
    const declaration = {
      installId: "mac",
      computerLabel: "Mac",
      runners: [{ agentId: "default", displayName: "Claude", enabled: true }],
    };
    const w = world(
      { body: { ok: true, workspaceId: "ws", installId: "mac", runners: 1 } },
      { body: { ok: true, workspaceId: "ws", installId: "mac", runners: 0 } },
    );
    await w.client.replaceRunners("ws", declaration, w.signal);
    expect(w.sent[0]!.init.method).toBe("PUT");
    expect(w.sent[0]!.url).toBe("https://relay.test/sync/workspaces/ws/runners");
    expect(JSON.parse(String(w.sent[0]!.init.body))).toEqual(declaration);
    await expect(w.client.replaceRunners("ws", declaration, w.signal)).rejects.toBeInstanceOf(
      ChatWakeAnswerError,
    );
  });
});

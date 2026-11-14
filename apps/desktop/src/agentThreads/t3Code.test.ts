import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  T3CodeError,
  listT3CodeProjects,
  listT3CodeThreads,
  openT3CodeSession,
  answerT3CodeQuestion,
  readT3CodeAddress,
  readT3CodeQuestion,
  readT3CodeRun,
  readT3CodeThread,
  sendToT3CodeThread,
  signInToT3Code,
  t3CodeOriginOnThisComputer,
} from "./t3Code";
import { T3CodeSignInNotKept, createT3CodeSignInStore } from "./t3CodeSignInStore";
import { AgentThreadAnswers } from "../ipc/bridgeContract";
import { browser, startFakeT3Code } from "../testing/fakeT3Code";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Each test's stand-in for T3 Code's server is closed when the test ends.
async function fakeT3Code() {
  const fake = await startFakeT3Code();
  cleanups.push(fake.close);
  return fake;
}

const signInAt = (origin: string) => ({
  origin,
  token: "token-1",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
});

describe("T3 Code's address", () => {
  it("takes plain http on this computer by number and nothing else", () => {
    expect(t3CodeOriginOnThisComputer("http://127.0.0.1:3773")).toBe("http://127.0.0.1:3773");
    expect(t3CodeOriginOnThisComputer("http://[::1]:3773")).toBe("http://[::1]:3773");
    for (const elsewhere of [
      "http://localhost:3773",
      "https://127.0.0.1:3773",
      "http://127.0.0.2:3773",
      "http://192.168.1.4:3773",
      "http://example.com:3773",
      "http://user@127.0.0.1:3773",
      "http://127.0.0.1:3773/mcp",
      "http://127.0.0.1.example.com:3773",
      "not a url",
    ])
      expect(t3CodeOriginOnThisComputer(elsewhere), elsewhere).toBeNull();
  });

  it("reads the file T3 Code keeps while it runs, and refuses a server that is not on this computer", async () => {
    const home = await mkdtemp(join(tmpdir(), "dohc-t3-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await expect(readT3CodeAddress(home)).resolves.toBeNull();
    await mkdir(join(home, "userdata"));
    const write = (file: unknown) =>
      writeFile(join(home, "userdata", "server-runtime.json"), JSON.stringify(file));
    await write({
      version: 1,
      host: "127.0.0.1",
      port: 3773,
      origin: "http://127.0.0.1:3773",
      serverVersion: "0.1.10",
    });
    await expect(readT3CodeAddress(home)).resolves.toEqual({
      origin: "http://127.0.0.1:3773",
      version: "0.1.10",
    });
    await write({ origin: "http://collector.example:3773" });
    await expect(readT3CodeAddress(home)).rejects.toMatchObject({ problem: "not-this-computer" });
    await writeFile(join(home, "userdata", "server-runtime.json"), "{ not json");
    await expect(readT3CodeAddress(home)).resolves.toBeNull();
  });
});

describe("signing in to T3 Code", () => {
  it("signs in after the person allows, proving the code is its own", async () => {
    const t3 = await fakeT3Code();
    const signIn = await signInToT3Code({ origin: t3.origin, open: browser, nowMs: () => 1_000 });
    expect(signIn).toEqual({
      origin: t3.origin,
      token: "token-1",
      expiresAtMs: 1_000 + 2_592_000_000,
    });
    // The redirect is on this computer by number, and dohc registers as a client with no secret.
    expect(t3.registrations).toEqual([
      {
        client_name: "dohc",
        redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/t3-code$/u)],
        token_endpoint_auth_method: "none",
      },
    ]);
    const asked = t3.authorizations[0]!;
    expect(Object.fromEntries(asked)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      code_challenge_method: "S256",
      resource: `${t3.origin}/mcp`,
    });
    expect(asked.get("code_challenge")).toMatch(/^[\w-]{43}$/u);
  });

  it("rejects when the person declines, does not answer in time, or cancels", async () => {
    const t3 = await fakeT3Code();
    t3.decline = true;
    await expect(signInToT3Code({ origin: t3.origin, open: browser })).rejects.toMatchObject({
      problem: "not-allowed",
    });
    await expect(
      signInToT3Code({ origin: t3.origin, open: () => undefined, timeoutMs: 20 }),
    ).rejects.toMatchObject({ problem: "not-allowed" });
    const cancel = new AbortController();
    await expect(
      signInToT3Code({ origin: t3.origin, open: () => cancel.abort(), signal: cancel.signal }),
    ).rejects.toMatchObject({ problem: "not-allowed" });
  });

  it("stops every step when the person cancels, and when nobody answers while the browser is still opening", async () => {
    const t3 = await fakeT3Code();
    // Cancelled before it began: nothing is asked of T3 Code.
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      signInToT3Code({ origin: t3.origin, open: browser, signal: cancelled.signal }),
    ).rejects.toMatchObject({
      problem: "not-allowed",
      message: "The sign-in to T3 Code was cancelled.",
    });
    expect(t3.registrations).toEqual([]);
    // The step that opens the browser never returns, and the person cancels during it.
    const during = new AbortController();
    let entered = false;
    const open = () => {
      entered = true;
      during.abort();
      return new Promise<void>(() => undefined);
    };
    await expect(
      signInToT3Code({ origin: t3.origin, open, signal: during.signal }),
    ).rejects.toMatchObject({
      problem: "not-allowed",
      message: "The sign-in to T3 Code was cancelled.",
    });
    expect(entered).toBe(true);
    // Time runs out while an answer's body is still arriving. The reason is the time, not the unread answer.
    const slowBody: typeof fetch = (_url, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener("abort", () => controller.error(new Error("stopped")));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await expect(
      signInToT3Code({ origin: t3.origin, open: browser, fetch: slowBody, timeoutMs: 20 }),
    ).rejects.toMatchObject({
      problem: "not-allowed",
      message: "Nobody allowed dohc in T3 Code in time.",
    });
  });

  it("says so when this T3 Code offers no sign-in to other programs", async () => {
    const t3 = await fakeT3Code();
    t3.noSignIn = true;
    await expect(signInToT3Code({ origin: t3.origin, open: browser })).rejects.toMatchObject({
      problem: "refused",
    });
  });

  it("takes only the answer that carries its own state", async () => {
    const t3 = await fakeT3Code();
    const signIn = await signInToT3Code({
      origin: t3.origin,
      open: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
        // Another page on this computer guesses the address but not the state.
        expect((await fetch(`${redirect.href}?code=stolen&state=guess`)).status).toBe(404);
        // A path that is not a URL is refused too, and the sign-in goes on.
        expect((await fetch(`${redirect.origin}//[`)).status).toBe(404);
        await browser(url);
      },
    });
    expect(signIn.token).toBe("token-1");
  });

  it("sends nothing when T3 Code's sign-in is not on this computer", async () => {
    const t3 = await fakeT3Code();
    t3.metadataOrigin = "http://collector.example";
    let opened = false;
    await expect(
      signInToT3Code({
        origin: t3.origin,
        open: () => {
          opened = true;
        },
      }),
    ).rejects.toMatchObject({ problem: "not-this-computer" });
    expect(opened).toBe(false);
    expect(t3.registrations).toEqual([]);
    await expect(
      signInToT3Code({ origin: "http://collector.example", open: () => undefined }),
    ).rejects.toMatchObject({ problem: "not-this-computer" });
    await expect(
      openT3CodeSession({
        origin: "http://collector.example",
        signIn: signInAt("http://collector.example"),
      }),
    ).rejects.toMatchObject({ problem: "not-this-computer" });
  });

  it("says T3 Code is not running when nothing answers", async () => {
    const t3 = await fakeT3Code();
    const origin = t3.origin;
    await cleanups.pop()!();
    await expect(signInToT3Code({ origin, open: () => undefined })).rejects.toMatchObject({
      problem: "not-running",
    });
    await expect(openT3CodeSession({ origin, signIn: signInAt(origin) })).rejects.toMatchObject({
      problem: "not-running",
    });
  });
});

describe("T3 Code's thread tools", () => {
  it("lists projects and threads, gives a thread a message once, and reads what it is doing", async () => {
    const t3 = await fakeT3Code();
    t3.tools.t3_project_list = ({ cursor }) =>
      cursor === 0
        ? {
            projects: [
              { id: "p1", title: "dohc", archivedAt: null, deletedAt: null },
              { id: "p2", title: "Old", archivedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
            ],
            nextCursor: 2,
          }
        : {
            projects: [{ id: "p3", title: "garage", archivedAt: null, deletedAt: null }],
            nextCursor: null,
          };
    t3.tools.t3_thread_list = () => ({
      threads: [
        {
          threadId: "t1",
          projectId: "p1",
          title: "Chief of Staff",
          status: "running",
          updatedAt: "2026-11-13T10:00:00.000Z",
          extra: 1,
        },
      ],
      nextCursor: 50,
      total: 11_552,
    });
    t3.tools.t3_thread_send = () => ({
      threadId: "t1",
      runId: "run-9",
      status: "starting",
      delivery: "started",
    });
    t3.tools.t3_thread_read = () => ({
      recentRuns: [
        {
          runId: "run-9",
          status: "running",
          requestedAt: "2026-11-13T00:00:01.000Z",
          startedAt: "2026-11-13T00:00:02.000Z",
          completedAt: null,
        },
        {
          runId: "run-8",
          status: "queued",
          requestedAt: "2026-11-13T00:00:03.000Z",
          startedAt: null,
          completedAt: null,
        },
        {
          runId: "run-7",
          status: "interrupted",
          requestedAt: "2026-11-12T00:00:00.000Z",
          startedAt: "2026-11-12T00:00:01.000Z",
          completedAt: "2026-11-12T00:00:09.000Z",
        },
        {
          runId: "run-6",
          status: "a status dohc does not know",
          requestedAt: "2026-11-11T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
        },
      ],
      thread: {
        title: "Chief of Staff",
        activeRunId: "run-9",
        pendingRequestCount: 1,
        archived: false,
        settled: false,
      },
    });
    const session = await openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) });
    cleanups.push(() => session.close());

    await expect(listT3CodeProjects(session)).resolves.toEqual([
      { id: "p1", title: "dohc" },
      { id: "p3", title: "garage" },
    ]);
    await expect(
      listT3CodeThreads(session, { projectId: "p1", titleContains: "chief", cursor: 50 }),
    ).resolves.toEqual({
      threads: [
        {
          id: "t1",
          projectId: "p1",
          title: "Chief of Staff",
          status: "running",
          updatedAt: "2026-11-13T10:00:00.000Z",
        },
      ],
      nextCursor: 50,
    });
    await expect(
      sendToT3CodeThread(session, {
        threadId: "t1",
        message: "status?",
        how: "line",
        forwardId: "f1",
      }),
    ).resolves.toEqual({ runId: "run-9" });
    await sendToT3CodeThread(session, {
      threadId: "t1",
      message: "now",
      how: "steer",
      forwardId: "f2",
    });
    await expect(readT3CodeThread(session, "t1")).resolves.toEqual({
      title: "Chief of Staff",
      working: true,
      activeRunId: "run-9",
      waitingOnPerson: true,
      questionId: null,
      closed: false,
      // Each run is in line, going, or over. One with a status dohc does not
      // know is going until T3 Code gives it an end.
      runs: [
        {
          id: "run-9",
          state: "working",
          requestedAtMs: Date.parse("2026-11-13T00:00:01.000Z"),
          startedAtMs: Date.parse("2026-11-13T00:00:02.000Z"),
          endedAtMs: null,
        },
        {
          id: "run-8",
          state: "in-line",
          requestedAtMs: Date.parse("2026-11-13T00:00:03.000Z"),
          startedAtMs: null,
          endedAtMs: null,
        },
        {
          id: "run-7",
          state: "ended",
          requestedAtMs: Date.parse("2026-11-12T00:00:00.000Z"),
          startedAtMs: Date.parse("2026-11-12T00:00:01.000Z"),
          endedAtMs: Date.parse("2026-11-12T00:00:09.000Z"),
        },
        {
          id: "run-6",
          state: "working",
          requestedAtMs: Date.parse("2026-11-11T00:00:00.000Z"),
          startedAtMs: null,
          endedAtMs: null,
        },
      ],
    });
    expect(t3.calls.findLast((call) => call.tool === "t3_thread_read")?.args.runLimit).toBe(50);

    expect(t3.calls.filter((call) => call.tool === "t3_thread_list")).toEqual([
      {
        tool: "t3_thread_list",
        args: {
          projectId: "p1",
          limit: 50,
          includeSubagents: false,
          settled: false,
          cursor: 50,
          titleContains: "chief",
        },
      },
    ]);
    // The forward's own id travels with it, so T3 Code can tell a second send of the same message.
    expect(
      t3.calls.filter((call) => call.tool === "t3_thread_send").map((call) => call.args),
    ).toEqual([
      { threadId: "t1", message: "status?", mode: "queue", clientRequestId: "f1" },
      { threadId: "t1", message: "now", mode: "steer", clientRequestId: "f2" },
    ]);
  });

  it("sends a sign-in only to the address it was issued at, and ends a session whose handshake failed", async () => {
    const t3 = await fakeT3Code();
    await expect(
      openT3CodeSession({ origin: t3.origin, signIn: signInAt("http://127.0.0.1:1") }),
    ).rejects.toMatchObject({ problem: "not-allowed" });
    expect(t3.ended).toBe(0);
    t3.badHandshake = true;
    await expect(
      openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) }),
    ).rejects.toMatchObject({ problem: "unexpected" });
    expect(t3.ended).toBe(1);
  });

  it("reads an answer sent as an event stream", async () => {
    const t3 = await fakeT3Code();
    t3.eventStream = true;
    t3.tools.t3_thread_read = () => ({
      recentRuns: [],
      thread: {
        title: "Quiet",
        activeRunId: null,
        pendingRequestCount: 0,
        archived: true,
        settled: false,
      },
    });
    const session = await openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) });
    await expect(readT3CodeThread(session, "t1")).resolves.toEqual({
      title: "Quiet",
      working: false,
      activeRunId: null,
      waitingOnPerson: false,
      questionId: null,
      closed: true,
      runs: [],
    });
  });

  it("asks T3 Code where one run stands, and takes a run the thread does not have as over", async () => {
    const t3 = await fakeT3Code();
    const session = await openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) });
    const asked = { threadId: "t1", runId: "r1" };
    const states: string[] = [];
    for (const status of ["queued", "preparing", "waiting", "running"]) {
      t3.tools.t3_thread_wait = () => ({ runId: "r1", status, timedOut: true });
      states.push(await readT3CodeRun(session, asked));
    }
    for (const status of ["cancelled", "completed"]) {
      t3.tools.t3_thread_wait = () => ({ runId: "r1", status, timedOut: false });
      states.push(await readT3CodeRun(session, asked));
    }
    expect(states).toEqual(["in-line", "working", "working", "working", "ended", "ended"]);
    // T3 Code restarted in the middle of the run and has yet to continue it: the work is not over.
    t3.tools.t3_thread_wait = () => ({ runId: "r1", status: "interrupted", timedOut: true });
    await expect(readT3CodeRun(session, asked)).resolves.toBe("working");
    // No time to wait: T3 Code answers with the status the run has now.
    expect(t3.calls.findLast((call) => call.tool === "t3_thread_wait")?.args).toEqual({
      ...asked,
      timeoutMs: 1,
    });

    t3.refusals.t3_thread_wait = "run_not_found: Run r1 does not belong to thread t1.";
    await expect(readT3CodeRun(session, asked)).resolves.toBe("ended");
    // Any other refusal is not an answer about the run.
    t3.refusals.t3_thread_wait = "thread_not_found: Thread t1 is no longer available.";
    await expect(readT3CodeRun(session, asked)).rejects.toMatchObject({ problem: "thread-gone" });
  });

  it("tells a question that waits on the person from anything else that does", async () => {
    const t3 = await fakeT3Code();
    const session = await openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) });
    let pending = 0;
    t3.tools.t3_thread_read = () => ({
      recentRuns: [],
      thread: {
        title: "Chief",
        activeRunId: "run-1",
        pendingRequestCount: pending,
        archived: false,
        settled: false,
      },
    });
    const listed = () => t3.calls.filter((call) => call.tool === "t3_pending_request");

    // Nothing waits: dohc does not ask for the questions.
    await expect(readT3CodeThread(session, "t1")).resolves.toMatchObject({
      waitingOnPerson: false,
      questionId: null,
    });
    expect(listed()).toEqual([]);

    // Something waits, and T3 Code lists no question: an approval, say.
    pending = 1;
    t3.tools.t3_pending_request = () => ({ requestIds: [] });
    await expect(readT3CodeThread(session, "t1")).resolves.toMatchObject({
      waitingOnPerson: true,
      questionId: null,
    });
    expect(listed().at(-1)?.args).toEqual({ action: "list", threadId: "t1" });

    // One thing waits, and it is a question.
    t3.tools.t3_pending_request = () => ({ requestIds: ["q-1"] });
    await expect(readT3CodeThread(session, "t1")).resolves.toMatchObject({
      waitingOnPerson: true,
      questionId: "q-1",
    });
    // A question and an approval wait: an answer here would leave the thread waiting.
    pending = 2;
    await expect(readT3CodeThread(session, "t1")).resolves.toMatchObject({
      waitingOnPerson: true,
      questionId: null,
    });
    // Two questions wait and nothing else: the first T3 Code lists is given.
    t3.tools.t3_pending_request = () => ({ requestIds: ["q-1", "q-2"] });
    await expect(readT3CodeThread(session, "t1")).resolves.toMatchObject({
      waitingOnPerson: true,
      questionId: "q-1",
    });
    // An id too long to carry is no reason to lose what the thread is doing.
    pending = 1;
    t3.tools.t3_pending_request = () => ({ requestIds: ["q".repeat(513)] });
    await expect(readT3CodeThread(session, "t1")).resolves.toMatchObject({
      waitingOnPerson: true,
      questionId: null,
    });

    // A T3 Code that refuses the list still says the thread waits.
    t3.refusals.t3_pending_request = "capability_denied: This credential cannot control threads.";
    await expect(readT3CodeThread(session, "t1")).resolves.toMatchObject({
      waitingOnPerson: true,
      questionId: null,
    });
    // A thread that is gone is not a thread with no question.
    t3.refusals.t3_pending_request = "thread_not_found: The thread was not found.";
    await expect(readT3CodeThread(session, "t1")).rejects.toMatchObject({
      problem: "thread-gone",
    });
  });

  it("reads a thread's question box as the person is to see it", async () => {
    const t3 = await fakeT3Code();
    const session = await openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) });
    const asked = { threadId: "t1", requestId: "q-1" };
    t3.tools.t3_pending_request = () => ({
      requestId: "q-1",
      questions: [
        {
          id: "where",
          header: "Target",
          question: "Which build?",
          options: [
            { label: "Mac", description: "The signed build", value: "mac" },
            { label: "Windows", description: "" },
          ],
          multiSelect: true,
          allowCustomAnswer: false,
          required: false,
          initialAnswer: "",
        },
        { id: "why", header: "", question: "Why?", options: [] },
      ],
    });

    await expect(readT3CodeQuestion(session, asked)).resolves.toEqual({
      status: "open",
      requestId: "q-1",
      questions: [
        {
          id: "where",
          header: "Target",
          question: "Which build?",
          // An option with no value of its own is answered with its label.
          options: [
            { label: "Mac", description: "The signed build", value: "mac" },
            { label: "Windows", description: "", value: "Windows" },
          ],
          multiSelect: true,
          allowCustomAnswer: false,
          required: false,
        },
        // What a question leaves out is as T3 Code takes it: one choice, the
        // person's own text allowed, and an answer wanted.
        {
          id: "why",
          header: "",
          question: "Why?",
          options: [],
          multiSelect: false,
          allowCustomAnswer: true,
          required: true,
        },
      ],
    });
    expect(t3.calls.at(-1)).toEqual({
      tool: "t3_pending_request",
      args: { action: "read", ...asked },
    });

    // A provider may name a question by its own words, however long they are.
    const words = "Which of these should I do first? ".repeat(100);
    t3.tools.t3_pending_request = () => ({
      requestId: "q-1",
      questions: [{ id: words, header: "", question: words, options: [] }],
    });
    await expect(readT3CodeQuestion(session, asked)).resolves.toMatchObject({
      status: "open",
      questions: [{ id: words }],
    });
    // Every id dohc shows a question under comes through the answer's own check.
    const ids = [words, "constructor", "toString", "hasOwnProperty"];
    expect(
      Object.keys(AgentThreadAnswers.parse(Object.fromEntries(ids.map((id) => [id, "yes"])))),
    ).toEqual(ids);
    // The one id an answer cannot be keyed by: such a box is answered in T3 Code.
    t3.tools.t3_pending_request = () => ({
      requestId: "q-1",
      questions: [{ id: "__proto__", header: "", question: "?", options: [] }],
    });
    await expect(readT3CodeQuestion(session, asked)).rejects.toMatchObject({
      problem: "unexpected",
    });
    expect(
      Object.keys(AgentThreadAnswers.parse(Object.fromEntries([["__proto__", "yes"]]))),
    ).toEqual([]);

    // A box too large to lay out at once is not shown.
    t3.tools.t3_pending_request = () => ({
      requestId: "q-1",
      questions: Array.from({ length: 20 }, (_, index) => ({
        id: `q${index}`,
        header: "",
        question: "?".repeat(15_000),
        options: [],
      })),
    });
    await expect(readT3CodeQuestion(session, asked)).rejects.toMatchObject({
      problem: "unexpected",
      message: "This question is too long for dohc to show.",
    });

    // A box larger than dohc shows is one the person answers in T3 Code.
    t3.tools.t3_pending_request = () => ({
      requestId: "q-1",
      questions: Array.from({ length: 21 }, (_, index) => ({
        id: `q${index}`,
        header: "",
        question: "?",
        options: [],
      })),
    });
    await expect(readT3CodeQuestion(session, asked)).rejects.toMatchObject({
      problem: "unexpected",
    });

    for (const [words, status] of [
      ["invalid_request: The user-input request was already answered.", "already-answered"],
      ["invalid_request: The user-input request is no longer pending (expired).", "closed"],
      ["invalid_request: The pending user-input request was not found.", "closed"],
    ] as const) {
      t3.refusals.t3_pending_request = words;
      await expect(readT3CodeQuestion(session, asked)).resolves.toEqual({ status });
    }
    t3.refusals.t3_pending_request = "orchestration_error: The operation could not be completed.";
    await expect(readT3CodeQuestion(session, asked)).rejects.toMatchObject({
      problem: "refused",
    });
  });

  it("answers a thread's question, and says when someone answered first", async () => {
    const t3 = await fakeT3Code();
    const session = await openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) });
    const answer = {
      threadId: "t1",
      requestId: "q-1",
      answers: { where: ["mac", "Windows"], why: "The release is today." },
    };
    t3.tools.t3_pending_request = () => ({ sequence: 12 });

    await expect(answerT3CodeQuestion(session, answer)).resolves.toBe("answered");
    expect(t3.calls.at(-1)).toEqual({
      tool: "t3_pending_request",
      args: { action: "respond", ...answer },
    });

    for (const [words, status] of [
      ["invalid_request: The user-input request was already answered.", "already-answered"],
      // The same, when the other answer landed while this one was on its way.
      ["orchestration_error: Runtime request q-1 is resolved.", "already-answered"],
      ["orchestration_error: Runtime request q-1 is cancelled.", "closed"],
      ["orchestration_error: Runtime request q-1 was not found.", "closed"],
      ["invalid_request: The user-input request is no longer pending (cancelled).", "closed"],
    ] as const) {
      t3.refusals.t3_pending_request = words;
      await expect(answerT3CodeQuestion(session, answer)).resolves.toBe(status);
    }
    // An answer T3 Code does not take is not an answer someone else gave.
    t3.refusals.t3_pending_request = "orchestration_error: Answer each question before sending.";
    await expect(answerT3CodeQuestion(session, answer)).rejects.toMatchObject({
      problem: "refused",
      message: "orchestration_error: Answer each question before sending.",
    });
    t3.refusals.t3_pending_request =
      "capability_denied: This tool changes the environment, and this MCP client was approved for read-only access.";
    await expect(answerT3CodeQuestion(session, answer)).rejects.toMatchObject({
      problem: "refused",
    });
  });

  it("tells a sign-in T3 Code no longer takes from a call it refused and an answer it cannot read", async () => {
    const t3 = await fakeT3Code();
    await expect(
      openT3CodeSession({
        origin: t3.origin,
        signIn: { ...signInAt(t3.origin), token: "old-token" },
      }),
    ).rejects.toMatchObject({ problem: "not-allowed" });
    const session = await openT3CodeSession({ origin: t3.origin, signIn: signInAt(t3.origin) });
    await expect(session.call("t3_thread_delete", {})).rejects.toMatchObject({
      problem: "refused",
      message: "No thread tool named t3_thread_delete.",
    });
    t3.tools.t3_thread_read = () => ({ thread: { title: 7 } });
    const unread = await readT3CodeThread(session, "t1").catch((error: unknown) => error);
    expect(unread).toBeInstanceOf(T3CodeError);
    expect(unread).toMatchObject({ problem: "unexpected" });
  });
});

describe("keeping the sign-in to T3 Code", () => {
  const cipher = (available: boolean) => ({
    isAvailable: () => available,
    encrypt: (plain: string) => Buffer.from(`sealed:${plain}`).toString("base64"),
    decrypt: (sealed: string) =>
      Buffer.from(sealed, "base64").toString("utf8").slice("sealed:".length),
  });

  it("keeps it encrypted, gives it back until it runs out, and drops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-t3-store-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let now = 1_000;
    const store = createT3CodeSignInStore({ dir, cipher: cipher(true), nowMs: () => now });
    await expect(store.load()).resolves.toBeNull();
    await store.save({ origin: "http://127.0.0.1:3773", token: "token-1", expiresAtMs: 5_000 });
    expect(await readFile(join(dir, "dohc-t3-code.json"), "utf8")).not.toContain("token-1");
    await expect(store.load()).resolves.toEqual({
      origin: "http://127.0.0.1:3773",
      token: "token-1",
      expiresAtMs: 5_000,
    });
    now = 5_000;
    await expect(store.load()).resolves.toBeNull();
    await store.clear();
    await store.clear();
    now = 1_000;
    await expect(store.load()).resolves.toBeNull();
  });

  it("drops a sign-in whose save was still going when it was cleared, and one that decrypts to something no header can carry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-t3-store-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = createT3CodeSignInStore({ dir, cipher: cipher(true), nowMs: () => 1_000 });
    await Promise.all([
      store.save({ origin: "http://127.0.0.1:3773", token: "token-1", expiresAtMs: 5_000 }),
      store.clear(),
    ]);
    await expect(store.load()).resolves.toBeNull();
    const garbled = createT3CodeSignInStore({
      dir,
      cipher: { ...cipher(true), decrypt: () => "token\u0000one" },
      nowMs: () => 1_000,
    });
    await garbled.save({ origin: "http://127.0.0.1:3773", token: "token-1", expiresAtMs: 5_000 });
    await expect(garbled.load()).resolves.toBeNull();
  });

  it("keeps nothing when this computer cannot encrypt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-t3-store-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    for (const store of [
      createT3CodeSignInStore({ dir, cipher: cipher(false) }),
      createT3CodeSignInStore({ dir }),
    ]) {
      expect(store.canKeep()).toBe(false);
      await expect(
        store.save({ origin: "http://127.0.0.1:3773", token: "token-1", expiresAtMs: 5_000 }),
      ).rejects.toBeInstanceOf(T3CodeSignInNotKept);
      await expect(store.load()).resolves.toBeNull();
    }
    await expect(readFile(join(dir, "dohc-t3-code.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

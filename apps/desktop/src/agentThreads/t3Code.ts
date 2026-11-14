import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";

// dohc's side of T3 Code's interface for outside programs: find T3 Code's
// server on this computer, sign in once with the person's Allow, and call its
// thread tools. dohc reaches T3 Code only here, and only on this computer
// (docs/engineering/adr/0016-chat-forwards-to-an-agent-thread.md).
//
// dohc cannot tell which program answers at an address. Another program
// running as the same person can take T3 Code's port, or rewrite the file
// that names it, and receive what dohc sends there.

/** Why T3 Code could not be used. Each reason is a state a person can act on. */
export type T3CodeProblem =
  /** T3 Code's server is not answering on this computer. */
  | "not-running"
  /** T3 Code's file names a server that is not on this computer. dohc sends its sign-in nowhere else. */
  | "not-this-computer"
  /** The person has not allowed dohc in T3 Code, declined, or the sign-in ran out. */
  | "not-allowed"
  /** The thread runs with more access than the person gave dohc on T3 Code's page. */
  | "needs-more-access"
  /** The thread is no longer in T3 Code. */
  | "thread-gone"
  /** T3 Code has no run with this id in the thread. */
  | "run-gone"
  /** T3 Code refused the call for another reason. */
  | "refused"
  /** T3 Code answered in a shape dohc does not know. */
  | "unexpected";

export class T3CodeError extends Error {
  constructor(
    readonly problem: T3CodeProblem,
    message: string,
  ) {
    super(message);
    this.name = "T3CodeError";
  }
}

export interface T3CodeAddress {
  origin: string;
  version: string | null;
}

const RuntimeFile = z.object({ origin: z.string(), serverVersion: z.string().optional() });

/**
 * `origin` when it is plain http on this computer by number, spelled as T3
 * Code writes it, else null. A host name is refused: it can resolve elsewhere.
 */
export function t3CodeOriginOnThisComputer(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const onThisComputer = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "http:" &&
    onThisComputer &&
    url.username === "" &&
    url.password === "" &&
    url.origin === origin.replace(/\/$/u, "")
    ? url.origin
    : null;
}

/**
 * Where T3 Code's server answers, from the file it keeps while it runs.
 * Null when there is no such file. Throws when the file names a server that
 * is not on this computer.
 */
export async function readT3CodeAddress(home: string): Promise<T3CodeAddress | null> {
  let text: string;
  try {
    text = await readFile(join(home, "userdata", "server-runtime.json"), "utf8");
  } catch {
    return null;
  }
  let file: z.infer<typeof RuntimeFile>;
  try {
    file = RuntimeFile.parse(JSON.parse(text));
  } catch {
    return null;
  }
  const origin = t3CodeOriginOnThisComputer(file.origin);
  if (origin === null)
    throw new T3CodeError("not-this-computer", "T3 Code's server is not on this computer.");
  return { origin, version: file.serverVersion ?? null };
}

type Fetch = typeof fetch;

// A redirect is refused, so nothing dohc sends follows T3 Code's address
// anywhere else. A request its caller stopped fails with the caller's reason.
async function answerOf(fetcher: Fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: "error" });
  } catch {
    if (init?.signal?.aborted && init.signal.reason instanceof T3CodeError)
      throw init.signal.reason;
    throw new T3CodeError("not-running", "T3 Code is not answering on this computer.");
  }
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new T3CodeError("unexpected", "T3 Code sent an answer dohc could not read.");
  }
}

/** Drops an answer dohc will not read, so its connection is freed, and fails with `error`. */
async function refuse(response: Response, error: T3CodeError): Promise<never> {
  await response.body?.cancel().catch(() => undefined);
  throw error;
}

function shaped<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new T3CodeError("unexpected", "T3 Code sent an answer dohc could not read.");
  return parsed.data;
}

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

const SignInMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
});
const RegisteredClient = z.object({ client_id: z.string().min(1) });
// A server may spell the token type in any case.
const IssuedToken = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((type) => type.toLowerCase() === "bearer"),
  expires_in: z.number().positive(),
});

export interface T3CodeSignIn {
  /** The address T3 Code issued it at. dohc sends the token nowhere else. */
  origin: string;
  token: string;
  expiresAtMs: number;
}

/** How long the person has to answer in T3 Code before the sign-in gives up. */
export const T3_CODE_ALLOW_TIMEOUT_MS = 5 * 60_000;

const ALLOWED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>dohc</title><p>dohc can now reach T3 Code. You can close this tab.</p>';
const DECLINED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>dohc</title><p>T3 Code did not allow dohc. You can close this tab.</p>';

interface Redirect {
  uri: string;
  code: Promise<string>;
  close(): void;
}

// T3 Code sends the person's browser here with the code. Only this computer
// can reach the listener, and only the answer that carries this sign-in's
// state is taken. The page reaches the browser before the sign-in goes on.
async function listenForRedirect(input: { state: string; issuer: string }): Promise<Redirect> {
  let settle!: { resolve(code: string): void; reject(error: Error): void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller awaits the code only after it opens the browser.
  code.catch(() => undefined);
  const server = createServer((request, response) => {
    // Any program on this computer can send the listener a request, so a path that is not a URL is refused like any other.
    let url: URL | null;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      url = null;
    }
    if (
      url === null ||
      request.method !== "GET" ||
      url.pathname !== "/t3-code" ||
      url.searchParams.get("state") !== input.state
    ) {
      response.writeHead(404, { connection: "close" }).end();
      return;
    }
    const issuer = url.searchParams.get("iss");
    const got = url.searchParams.get("code");
    const allowed = got !== null && got !== "" && (issuer === null || issuer === input.issuer);
    const answered = () => {
      if (allowed) settle.resolve(got);
      else settle.reject(new T3CodeError("not-allowed", "T3 Code did not allow dohc."));
    };
    // The browser's connection can drop before the page is written. The answer still counts.
    response.once("close", answered);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(allowed ? ALLOWED_PAGE : DECLINED_PAGE, answered);
  });
  // A connection that never sends a request cannot hold the listener open.
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/t3-code`,
    code,
    close() {
      server.close();
      server.closeIdleConnections();
    },
  };
}

/**
 * Signs dohc in to T3 Code. `open` shows the person T3 Code's own page, where
 * they allow or decline. Resolves with the sign-in T3 Code issued; rejects
 * with "not-allowed" when they decline, cancel, or do not answer in time.
 * Cancelling or running out of time stops every step, whichever one is going.
 */
export async function signInToT3Code(input: {
  origin: string;
  open(url: string): void | Promise<void>;
  signal?: AbortSignal;
  fetch?: Fetch;
  nowMs?: () => number;
  timeoutMs?: number;
}): Promise<T3CodeSignIn> {
  const origin = t3CodeOriginOnThisComputer(input.origin);
  if (origin === null)
    throw new T3CodeError("not-this-computer", "T3 Code's server is not on this computer.");
  const fetcher = input.fetch ?? fetch;
  const stop = new AbortController();
  const stopped = new Promise<never>((_, reject) =>
    stop.signal.addEventListener("abort", () => reject(stop.signal.reason as Error), {
      once: true,
    }),
  );
  stopped.catch(() => undefined);
  const timer = setTimeout(
    () => stop.abort(new T3CodeError("not-allowed", "Nobody allowed dohc in T3 Code in time.")),
    input.timeoutMs ?? T3_CODE_ALLOW_TIMEOUT_MS,
  );
  const cancel = () =>
    stop.abort(new T3CodeError("not-allowed", "The sign-in to T3 Code was cancelled."));
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  let redirect: Redirect | null = null;
  try {
    const found = await answerOf(fetcher, `${origin}/.well-known/oauth-authorization-server`, {
      signal: stop.signal,
    });
    if (!found.ok)
      await refuse(
        found,
        new T3CodeError("refused", "This T3 Code does not offer a sign-in to other programs."),
      );
    const metadata = shaped(SignInMetadata, await jsonOf(found));
    // Every address the sign-in uses must be T3 Code's own, so nothing dohc sends leaves this computer.
    const endpoints = [
      metadata.issuer,
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
    ];
    if (
      endpoints.some((endpoint) => {
        try {
          return new URL(endpoint).origin !== origin;
        } catch {
          return true;
        }
      })
    ) {
      throw new T3CodeError("not-this-computer", "T3 Code's sign-in is not on this computer.");
    }
    const verifier = base64Url(randomBytes(32));
    const state = base64Url(randomBytes(16));
    const resource = `${origin}/mcp`;
    redirect = await listenForRedirect({ state, issuer: metadata.issuer });
    const registered = await answerOf(fetcher, metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "dohc",
        redirect_uris: [redirect.uri],
        token_endpoint_auth_method: "none",
      }),
      signal: stop.signal,
    });
    if (!registered.ok)
      await refuse(
        registered,
        new T3CodeError("refused", "T3 Code did not take dohc's sign-in request."),
      );
    const client = shaped(RegisteredClient, await jsonOf(registered));
    const authorize = new URL(metadata.authorization_endpoint);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect.uri,
      code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
      resource,
    }))
      authorize.searchParams.set(name, value);
    await Promise.race([Promise.resolve(input.open(authorize.href)), stopped]);
    const code = await Promise.race([redirect.code, stopped]);
    const issued = await answerOf(fetcher, metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect.uri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource,
      }).toString(),
      signal: stop.signal,
    });
    if (!issued.ok)
      await refuse(issued, new T3CodeError("not-allowed", "T3 Code did not issue dohc a sign-in."));
    const token = shaped(IssuedToken, await jsonOf(issued));
    // A sign-in the person cancelled is not kept, even when T3 Code issued it in time.
    if (stop.signal.aborted) throw stop.signal.reason as Error;
    return {
      origin,
      token: token.access_token,
      expiresAtMs: (input.nowMs ?? Date.now)() + token.expires_in * 1000,
    };
  } catch (error) {
    // Whatever failed after the person cancelled or time ran out, that is the reason.
    if (stop.signal.aborted) throw stop.signal.reason as Error;
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    redirect?.close();
  }
}

export interface T3CodeSession {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Ends the session on T3 Code's side. */
  close(): Promise<void>;
}

const Envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});
const Initialized = z.object({ protocolVersion: z.string() });
const ToolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});

// T3 Code answers a request with JSON or with an event stream that carries
// JSON. An event's data can span lines; a blank line ends the event.
async function payloadsOf(response: Response): Promise<unknown[]> {
  const text = await response.text();
  try {
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return text
        .split(/\r?\n\r?\n/u)
        .map((event) =>
          event
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /u, ""))
            .join("\n"),
        )
        .filter((data) => data !== "")
        .map((data) => JSON.parse(data) as unknown);
    }
    if (text.trim() === "") return [];
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new T3CodeError("unexpected", "T3 Code sent an answer dohc could not read.");
  }
}

/**
 * Opens one session with T3 Code's thread tools. The token goes only to the
 * address it was issued at, which must be on this computer. A sign-in issued
 * at another address is refused, so the person signs in again.
 */
export async function openT3CodeSession(input: {
  origin: string;
  signIn: T3CodeSignIn;
  fetch?: Fetch;
}): Promise<T3CodeSession> {
  const origin = t3CodeOriginOnThisComputer(input.origin);
  if (origin === null)
    throw new T3CodeError("not-this-computer", "T3 Code's server is not on this computer.");
  if (input.signIn.origin !== origin)
    throw new T3CodeError(
      "not-allowed",
      "T3 Code moved to another address. Allow dohc in T3 Code again.",
    );
  const fetcher = input.fetch ?? fetch;
  const endpoint = `${origin}/mcp`;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;
  const headers = (): Record<string, string> => ({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${input.signIn.token}`,
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });
  const send = async (message: Record<string, unknown>): Promise<unknown[]> => {
    const response = await answerOf(fetcher, endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify(message),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (response.status === 401 || response.status === 403)
      await refuse(response, new T3CodeError("not-allowed", "dohc is not allowed in T3 Code."));
    if (!response.ok)
      await refuse(response, new T3CodeError("refused", `T3 Code answered ${response.status}.`));
    return payloadsOf(response);
  };
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = `dohc-${nextId++}`;
    const answers = (await send({ jsonrpc: "2.0", id, method, params })).map((payload) =>
      Envelope.safeParse(payload),
    );
    const answer = answers.find((entry) => entry.success && entry.data.id === id);
    if (!answer?.success)
      throw new T3CodeError("unexpected", "T3 Code sent an answer dohc could not read.");
    if (answer.data.error !== undefined)
      throw new T3CodeError("refused", answer.data.error.message ?? "T3 Code refused the call.");
    return answer.data.result;
  };
  const close = async (): Promise<void> => {
    if (sessionId === null) return;
    await answerOf(fetcher, endpoint, { method: "DELETE", headers: headers() }).then(
      (response) => response.body?.cancel(),
      () => undefined,
    );
    sessionId = null;
  };
  try {
    protocolVersion = shaped(
      Initialized,
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "dohc", version: "0.0.0" },
      }),
    ).protocolVersion;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (error) {
    // A session T3 Code opened before the handshake failed is ended, not left behind.
    await close();
    throw error;
  }
  return {
    async call(tool, args) {
      const result = shaped(
        ToolResult,
        await request("tools/call", { name: tool, arguments: args }),
      );
      if (result.isError) {
        const words = result.content?.find((block) => block.text)?.text;
        // T3 Code's words for a thread that runs with more than this client may.
        if (words && /runtime_mode_escalation_denied|broader than parent mode/u.test(words))
          throw new T3CodeError(
            "needs-more-access",
            "This thread runs with more access than dohc has in T3 Code. Allow dohc again, and pick the thread's mode on T3 Code's page.",
          );
        // T3 Code's words for a run the thread does not have.
        if (words && /run_not_found|does not belong to thread/u.test(words))
          throw new T3CodeError("run-gone", "T3 Code has no such run in this thread.");
        // T3 Code's words for a thread it no longer has.
        if (words && /thread_not_found|is no longer available/u.test(words))
          throw new T3CodeError("thread-gone", "This thread is no longer in T3 Code.");
        // T3 Code's own words reach Notices, so they are kept short.
        throw new T3CodeError("refused", words?.slice(0, 300) ?? "T3 Code refused the call.");
      }
      return result.structuredContent;
    },
    close,
  };
}

export interface T3CodeProject {
  id: string;
  title: string;
}

const ProjectPage = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      archivedAt: z.string().nullable().optional(),
      deletedAt: z.string().nullable().optional(),
    }),
  ),
  nextCursor: z.number().nullable(),
});

// A person has tens of projects, not thousands. The cap ends a list that never does.
const MAX_PROJECT_PAGES = 20;

/** The person's projects in T3 Code, without the archived and deleted ones. */
export async function listT3CodeProjects(session: T3CodeSession): Promise<T3CodeProject[]> {
  const projects: T3CodeProject[] = [];
  let cursor: number | null = 0;
  for (let page = 0; cursor !== null && page < MAX_PROJECT_PAGES; page += 1) {
    const got: z.infer<typeof ProjectPage> = shaped(
      ProjectPage,
      await session.call("t3_project_list", { cursor, limit: 100 }),
    );
    for (const project of got.projects) {
      if (!project.archivedAt && !project.deletedAt)
        projects.push({ id: project.id, title: project.title });
    }
    cursor = got.nextCursor;
  }
  return projects;
}

export interface T3CodeThread {
  id: string;
  projectId: string;
  title: string;
  /** T3 Code's word for the thread's newest run, such as "running" or "completed". */
  status: string | null;
  updatedAt: string;
}

const ThreadPage = z.object({
  threads: z.array(
    z.object({
      threadId: z.string(),
      projectId: z.string(),
      title: z.string(),
      status: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.number().nullable(),
});

/** One page of a project's threads, newest first. A person can hold thousands, so the caller pages and searches by title. */
export async function listT3CodeThreads(
  session: T3CodeSession,
  input: { projectId: string; titleContains?: string; cursor?: number },
): Promise<{ threads: T3CodeThread[]; nextCursor: number | null }> {
  const page = shaped(
    ThreadPage,
    await session.call("t3_thread_list", {
      projectId: input.projectId,
      limit: 50,
      includeSubagents: false,
      settled: false,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.titleContains ? { titleContains: input.titleContains } : {}),
    }),
  );
  return {
    threads: page.threads.map((thread) => ({
      id: thread.threadId,
      projectId: thread.projectId,
      title: thread.title,
      status: thread.status,
      updatedAt: thread.updatedAt,
    })),
    nextCursor: page.nextCursor,
  };
}

const Sent = z.object({ runId: z.string().nullable().optional() });

/**
 * Gives a thread one message. "line" puts it behind the thread's current
 * work; "steer" hands it over during that work. `forwardId` names this
 * message for its whole life, so sending it again cannot give it twice.
 */
export async function sendToT3CodeThread(
  session: T3CodeSession,
  input: { threadId: string; message: string; how: "line" | "steer"; forwardId: string },
): Promise<{ runId: string | null }> {
  const sent = shaped(
    Sent,
    await session.call("t3_thread_send", {
      threadId: input.threadId,
      message: input.message,
      mode: input.how === "steer" ? "steer" : "queue",
      clientRequestId: input.forwardId,
    }),
  );
  return { runId: sent.runId ?? null };
}

const Environment = z.object({ environmentId: z.string() });
// What an id may hold where dohc writes it into a link the system opens.
const LINK_PART = /^[A-Za-z0-9._:~-]{1,512}$/u;

/**
 * The link that opens a thread in T3 Code's own window. T3 Code names this
 * computer's part of the link at an address anyone on the computer may read.
 * dohc builds the link from that and the thread's id, and puts in it nothing
 * a link could act on.
 */
export async function t3CodeThreadLink(input: {
  origin: string;
  threadId: string;
  fetch?: Fetch;
}): Promise<string> {
  const origin = t3CodeOriginOnThisComputer(input.origin);
  if (origin === null)
    throw new T3CodeError("not-this-computer", "T3 Code's server is not on this computer.");
  const response = await answerOf(input.fetch ?? fetch, `${origin}/.well-known/t3/environment`);
  if (!response.ok)
    await refuse(response, new T3CodeError("refused", `T3 Code answered ${response.status}.`));
  const { environmentId } = shaped(Environment, await jsonOf(response));
  if (!LINK_PART.test(environmentId) || !LINK_PART.test(input.threadId))
    throw new T3CodeError("unexpected", "dohc can't write a link to this thread.");
  return `t3code://threads/${environmentId}/${input.threadId}`;
}

export interface T3CodeThreadState {
  title: string;
  working: boolean;
  /** The run that is going now. It may be older than every run in `runs`. */
  activeRunId: string | null;
  /** Something waits on the person in T3 Code: a question or an approval. */
  waitingOnPerson: boolean;
  /** The thread was archived or settled, so it takes no more work. */
  closed: boolean;
  /** The thread's newest runs, newest first, as many as T3 Code gives at once. */
  runs: T3CodeRun[];
}

/** One piece of work in a thread, such as the work a message started. */
export interface T3CodeRun {
  id: string;
  /** Behind other work, going now, or over, whatever way it ended. */
  state: "in-line" | "working" | "ended";
  /** When T3 Code took it, when it started, and when it ended, where it has. */
  requestedAtMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
}

// T3 Code gives at most this many runs with one read.
const RUNS_READ = 50;
const time = z
  .string()
  .transform((text) => Date.parse(text))
  .refine((ms) => !Number.isNaN(ms));
const ThreadRead = z.object({
  thread: z.object({
    title: z.string(),
    activeRunId: z.string().nullable(),
    pendingRequestCount: z.number(),
    archived: z.boolean(),
    settled: z.boolean(),
  }),
  recentRuns: z.array(
    z.object({
      runId: z.string(),
      status: z.string(),
      requestedAt: time,
      startedAt: time.nullable(),
      completedAt: time.nullable(),
    }),
  ),
});

// T3 Code's words for a run that is over, whatever way it ended.
const ENDED = ["completed", "interrupted", "failed", "cancelled", "rolled_back"];
const RunStatus = z.object({ status: z.string(), timedOut: z.boolean() });

/**
 * Where one run stands, asked by its id. T3 Code lists only a thread's newest
 * runs with the thread, so a run it no longer lists is asked for here. A run
 * the thread does not have is over.
 *
 * When T3 Code restarts in the middle of a run, it ends that run and continues
 * the work in another. Its answer here follows the run to the one that
 * continues it, which a thread's list of runs does not.
 */
export async function readT3CodeRun(
  session: T3CodeSession,
  input: { threadId: string; runId: string },
): Promise<T3CodeRun["state"]> {
  try {
    // T3 Code's wait answers at once with the run's status when given no time to wait.
    const { status, timedOut } = shaped(
      RunStatus,
      await session.call("t3_thread_wait", { ...input, timeoutMs: 1 }),
    );
    if (status === "queued") return "in-line";
    // A run that ended and still timed out waits for T3 Code to continue it after a restart.
    return ENDED.includes(status) && !timedOut ? "ended" : "working";
  } catch (error) {
    if (error instanceof T3CodeError && error.problem === "run-gone") return "ended";
    throw error;
  }
}

/** What a thread is doing now. */
export async function readT3CodeThread(
  session: T3CodeSession,
  threadId: string,
): Promise<T3CodeThreadState> {
  const { thread, recentRuns } = shaped(
    ThreadRead,
    await session.call("t3_thread_read", {
      threadId,
      view: "messages",
      limit: 1,
      maxCharsPerItem: 1,
      runLimit: RUNS_READ,
    }),
  );
  return {
    title: thread.title,
    working: thread.activeRunId !== null,
    activeRunId: thread.activeRunId,
    waitingOnPerson: thread.pendingRequestCount > 0,
    closed: thread.archived || thread.settled,
    runs: recentRuns.map((run) => ({
      id: run.runId,
      // A status dohc does not know is over only once T3 Code gives it an end.
      state:
        run.status === "queued"
          ? "in-line"
          : run.completedAt === null && !ENDED.includes(run.status)
            ? "working"
            : "ended",
      requestedAtMs: run.requestedAt,
      startedAtMs: run.startedAt,
      endedAtMs: run.completedAt,
    })),
  };
}

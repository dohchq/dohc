import type { ChatParseAnswer, ChatParseRequest } from "./chatMarkdownParse";

// One worker parses chat Markdown longer than the main thread's limit, for
// every chat on screen. It starts when a chat pane mounts, takes one body at
// a time, and is replaced when a body runs past the deadline or crashes it:
// a body can cost the worker a second, never the interface. The deadline
// leaves an ordinary 50,000-character reply room on a loaded machine.
export const CHAT_PARSE_DEADLINE_MS = 1000;
// A pane that remounts at once, as under React's strict mode, keeps the worker.
const IDLE_STOP_MS = 5000;

type Job = { request: Omit<ChatParseRequest, "id">; resolve: (answer: ChatParseAnswer | null) => void };

let worker: Worker | null = null;
let panes = 0;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let running: { id: number; job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
const queue: Job[] = [];

function startWorker(): Worker {
  const started = new Worker(new URL("./chatMarkdown.worker.ts", import.meta.url), { type: "module" });
  started.onmessage = ({ data }: MessageEvent<ChatParseAnswer>) => {
    if (worker === started && running?.id === data.id) finish(data);
  };
  started.onerror = () => {
    if (worker === started) replace();
  };
  return started;
}

// A worker past its deadline, or one that crashed, is stopped; the next body
// starts a new one.
function replace() {
  worker?.terminate();
  worker = null;
  if (running) finish(null);
}

function finish(answer: ChatParseAnswer | null) {
  const done = running!;
  running = null;
  clearTimeout(done.timer);
  done.job.resolve(answer);
  pump();
}

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    if (panes === 0) stopWhenIdle();
    return;
  }
  clearTimeout(idleTimer);
  try {
    worker ??= startWorker();
  } catch {
    job.resolve(null);
    pump();
    return;
  }
  const id = ++nextId;
  running = { id, job, timer: setTimeout(replace, CHAT_PARSE_DEADLINE_MS) };
  worker.postMessage({ id, ...job.request } satisfies ChatParseRequest);
}

function stopWhenIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (panes > 0 || running || queue.length > 0) return;
    worker?.terminate();
    worker = null;
  }, IDLE_STOP_MS);
}

// Called by a chat pane as it mounts, so the worker is ready before the
// first long message needs it. Returns the release.
export function retainChatParser(): () => void {
  panes++;
  clearTimeout(idleTimer);
  try {
    worker ??= startWorker();
  } catch {
    // Without workers, long bodies show as text.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    panes--;
    if (panes === 0 && !running && queue.length === 0) stopWhenIdle();
  };
}

// Resolves to null when the worker gave up on the body.
export function parseChatInWorker(request: Omit<ChatParseRequest, "id">): Promise<ChatParseAnswer | null> {
  return new Promise((resolve) => {
    queue.push({ request, resolve });
    pump();
  });
}

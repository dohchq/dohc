import {useEffect, useRef, useState} from 'react';

// A lossy note is one dohc would change in meaning by saving it from the
// editor (CONTEXT.md). The check parses the whole note, so it runs in a
// worker, never on the UI thread. Verdicts stay in this window's memory by
// the file's content hash, so reopening unchanged bytes is free. Nothing is
// written to disk.

const VERDICT_LIMIT = 256;
const IDLE_MS = 30_000;
// A 2 MB note takes a few seconds. A check that runs past this stops the
// worker, and its note opens read-only until a later read checks it again.
const DEADLINE_MS = 30_000;
const verdicts = new Map<string, boolean>();
const checks = new Map<string, Promise<boolean>>();
const requests = new Map<number, {resolve: (lossy: boolean) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;

function stop(error: Error): void {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  requests.clear();
}

function idle(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (requests.size) return;
    worker?.terminate();
    worker = null;
  }, IDLE_MS);
}

function startWorker(): Worker {
  const started = new Worker(new URL('./lossyNote.worker.ts', import.meta.url), {type: 'module'});
  started.onerror = () => {if (worker === started) stop(new Error('The note check stopped.'));};
  started.onmessage = ({data}: MessageEvent<{id: number; lossy?: boolean; error?: string}>) => {
    if (worker !== started) return;
    const request = requests.get(data.id);
    if (!request) return;
    requests.delete(data.id);
    clearTimeout(request.timer);
    if (typeof data.lossy === 'boolean') request.resolve(data.lossy);
    else request.reject(new Error(data.error ?? 'The note check failed.'));
    if (!requests.size) idle();
  };
  return started;
}

/** Starts the worker early, so its startup overlaps the file read. */
export function warmLossyNoteCheck(): void {
  try {
    worker ??= startWorker();
    if (!requests.size) idle();
  } catch {
    // The check itself reports the failure.
  }
}

export function knownLossyNoteVerdict(contentHash: string): boolean | undefined {
  return verdicts.get(contentHash);
}

/** Rejects when the worker fails; the caller treats that note as lossy. */
export function checkLossyNote(contentHash: string, markdown: string): Promise<boolean> {
  const known = verdicts.get(contentHash);
  if (known !== undefined) return Promise.resolve(known);
  const running = checks.get(contentHash);
  if (running) return running;
  const check = new Promise<boolean>((resolve, reject) => {
    clearTimeout(idleTimer);
    try {
      worker ??= startWorker();
      const id = ++nextId;
      const timer = setTimeout(() => stop(new Error('The note check took too long.')), DEADLINE_MS);
      requests.set(id, {resolve, reject, timer});
      worker.postMessage({id, markdown});
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }).then((lossy) => {
    verdicts.delete(contentHash);
    verdicts.set(contentHash, lossy);
    if (verdicts.size > VERDICT_LIMIT) verdicts.delete(verdicts.keys().next().value!);
    return lossy;
  }).finally(() => {
    checks.delete(contentHash);
  });
  checks.set(contentHash, check);
  return check;
}

export type LossyNoteCheck = 'checking' | 'lossy' | 'clear';

/**
 * The check for one open of a note in one workspace. It judges only a read
 * that answered after the open began. A clear verdict holds for the rest of
 * the open, a version switch included: the engine owns the note from then on,
 * and its own saves change the file. A lossy note is checked again on each
 * new read, so a change on disk can clear it.
 */
export function useLossyNote(input: {
  open: string;
  applies: boolean;
  markdown: string | null;
  contentHash: string | null;
  readSeq: number;
}): LossyNoteCheck {
  const opened = useRef({open: input.open, readSeq: input.readSeq, clear: false, lossy: false});
  if (opened.current.open !== input.open) {
    opened.current = {open: input.open, readSeq: input.readSeq, clear: false, lossy: false};
  }
  const current = opened.current;
  // Once clear, the engine's own saves change the file; checking them again
  // would only spend work while the person types.
  const hash = input.applies && !current.clear && input.readSeq !== current.readSeq && input.markdown !== null
    ? input.contentHash
    : null;
  const [answer, setAnswer] = useState<{open: string; contentHash: string; lossy: boolean} | null>(null);
  const verdict = hash === null
    ? undefined
    : answer?.open === input.open && answer.contentHash === hash
      ? answer.lossy
      : knownLossyNoteVerdict(hash);
  const markdown = useRef(input.markdown);
  markdown.current = input.markdown;
  const unanswered = hash !== null && verdict === undefined;
  useEffect(() => {
    if (!unanswered || hash === null || markdown.current === null) return;
    let live = true;
    const open = input.open;
    void checkLossyNote(hash, markdown.current)
      .catch(() => true)
      .then((lossy) => {
        if (live) setAnswer({open, contentHash: hash, lossy});
      });
    return () => {
      live = false;
    };
  }, [input.open, hash, unanswered]);
  if (!input.applies) return 'clear';
  if (verdict === false) current.clear = true;
  if (current.clear) return 'clear';
  if (verdict === true) current.lossy = true;
  return current.lossy ? 'lossy' : 'checking';
}

/** Tests reuse made-up content hashes for different text. */
export function forgetLossyNoteVerdictsForTests(): void {
  verdicts.clear();
}

/** For tests that need a lossy note in an engine session. */
export function rememberLossyNoteVerdictForTests(contentHash: string, lossy: boolean): void {
  verdicts.set(contentHash, lossy);
}

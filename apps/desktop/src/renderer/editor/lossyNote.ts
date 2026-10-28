import {useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import checkerUrl from './lossyNote.worker.ts?worker&url';

// A lossy note is one dohc would change in meaning by saving it from the
// editor (CONTEXT.md). The check parses the whole note, so it runs in a
// worker, never on the UI thread. Verdicts are kept by the file's content
// hash, so reopening unchanged bytes is free. This profile's storage keeps
// them across restarts, so a restart doesn't wait for the worker either.

const VERDICT_LIMIT = 256;
const IDLE_MS = 30_000;
// A 2 MB note takes a few seconds. A check that runs past this stops the
// worker, and its note opens read-only until a later read checks it again.
const DEADLINE_MS = 30_000;
const STORED_VERDICTS = 'dohc.lossyNoteVerdicts';
// Stored verdicts hold only for the checker and runtime that gave them. Vite
// names the built checker's file after its contents, and the user agent names
// the Chromium whose Unicode tables the parser uses. A dev server's file name
// doesn't change with its contents, so it stores none.
const checker = `${checkerUrl.slice(checkerUrl.lastIndexOf('/') + 1)} ${navigator.userAgent}`;
const verdicts = storedVerdicts();
const checks = new Map<string, Promise<boolean>>();
type Answer = {lossy: boolean};
const requests = new Map<number, {resolve: (answer: Answer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;

function storedVerdicts(): Map<string, boolean> {
  if (import.meta.env.DEV) return new Map();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORED_VERDICTS) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return new Map();
    const {checker: storedChecker, verdicts: entries} = stored as Record<string, unknown>;
    if (storedChecker !== checker || !Array.isArray(entries)) return new Map();
    return new Map(entries.filter((entry): entry is [string, boolean] =>
      Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean').slice(-VERDICT_LIMIT));
  } catch {
    return new Map();
  }
}

function remember(contentHash: string, lossy: boolean): void {
  verdicts.delete(contentHash);
  verdicts.set(contentHash, lossy);
  if (verdicts.size > VERDICT_LIMIT) verdicts.delete(verdicts.keys().next().value!);
  if (import.meta.env.DEV) return;
  try {
    localStorage.setItem(STORED_VERDICTS, JSON.stringify({checker, verdicts: [...verdicts]}));
  } catch {
    // The verdict stays in this window's memory.
  }
}

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
  const started = new Worker(checkerUrl, {type: 'module'});
  started.onerror = () => {if (worker === started) stop(new Error('The note check stopped.'));};
  started.onmessage = ({data}: MessageEvent<{id: number; lossy?: boolean; error?: string}>) => {
    if (worker !== started) return;
    const request = requests.get(data.id);
    if (!request) return;
    requests.delete(data.id);
    clearTimeout(request.timer);
    if (typeof data.lossy === 'boolean') request.resolve({lossy: data.lossy});
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

function ask(note: {markdown: string} | {state: Uint8Array; headSha256: string | null}): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    clearTimeout(idleTimer);
    try {
      worker ??= startWorker();
      const id = ++nextId;
      const timer = setTimeout(() => stop(new Error('The note check took too long.')), DEADLINE_MS);
      requests.set(id, {resolve, reject, timer});
      if ('state' in note) worker.postMessage({id, state: note.state, headSha256: note.headSha256}, [note.state.buffer]);
      else worker.postMessage({id, markdown: note.markdown});
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Rejects when the worker fails; the caller treats that note as lossy. */
export function checkLossyNote(contentHash: string, markdown: string): Promise<boolean> {
  const known = verdicts.get(contentHash);
  if (known !== undefined) return Promise.resolve(known);
  const running = checks.get(contentHash);
  if (running) return running;
  const check = ask({markdown}).then(({lossy}) => {
    remember(contentHash, lossy);
    return lossy;
  }).finally(() => {
    checks.delete(contentHash);
  });
  checks.set(contentHash, check);
  return check;
}

export type LossyNoteCheck = 'checking' | 'lossy' | 'clear';

/**
 * The check for one open of one version of a note. It judges only a read that
 * answered after the open began. A version switch of the same `note` keeps the
 * last version's clear verdict until a read brings the new version's text,
 * then checks that text; the session it binds meanwhile has its own check.
 * A clear verdict holds for the rest of the open: the engine owns the note
 * from then on, and its own saves change the file. A lossy note is checked
 * again on each new read, so a change on disk can clear it. A `waiting` note
 * is not checked, and reads as clear, until it stops waiting or proves lossy.
 * `checkedHash` is the content hash the clear verdict is for.
 */
export function useLossyNote(input: {
  open: string;
  note: string;
  applies: boolean;
  waiting: boolean;
  markdown: string | null;
  contentHash: string | null;
  readSeq: number;
}): {state: LossyNoteCheck; checkedHash: string | null} {
  const opened = useRef({
    open: input.open, note: input.note, readSeq: input.readSeq,
    clear: null as string | null, lossy: false, carried: null as string | null,
  });
  if (opened.current.open !== input.open) {
    const last = opened.current;
    const carried = last.note !== input.note ? null
      : last.clear ?? (last.readSeq === input.readSeq ? last.carried : null);
    opened.current = {open: input.open, note: input.note, readSeq: input.readSeq, clear: null, lossy: false, carried};
  }
  const current = opened.current;
  // Once clear, the engine's own saves change the file; checking them again
  // would only spend work while the person types.
  const hash = input.applies && current.clear === null && (!input.waiting || current.lossy)
    && input.readSeq !== current.readSeq && input.markdown !== null
    ? input.contentHash
    : null;
  const markdown = input.markdown;
  const verdict = useVerdict(input.open, hash, hash === null ? undefined : knownLossyNoteVerdict(hash), () =>
    hash === null || markdown === null ? Promise.resolve(true) : checkLossyNote(hash, markdown));
  if (!input.applies) return {state: 'clear', checkedHash: null};
  if (verdict === false && hash !== null) current.clear = hash;
  if (current.clear !== null) return {state: 'clear', checkedHash: current.clear};
  if (verdict === true) current.lossy = true;
  if (current.lossy) return {state: 'lossy', checkedHash: null};
  if (current.carried !== null && (input.readSeq === current.readSeq || input.markdown === null)) {
    return {state: 'clear', checkedHash: current.carried};
  }
  return {state: input.waiting ? 'clear' : 'checking', checkedHash: null};
}

/** Checks the saved source's meaning and the authoritative file head, including after edits. */
export function useBoundNoteCheck(input: {open: string; doc: Y.Doc | null; checkedHash: string | null; headSha256?: string | null}): LossyNoteCheck {
  const [metaRevision, setMetaRevision] = useState(0);
  useEffect(() => {
    const meta = input.doc?.getMap('meta');
    const changed = () => setMetaRevision(revision => revision + 1);
    meta?.observe(changed);
    return () => meta?.unobserve(changed);
  }, [input.doc]);
  const sha = input.doc?.getMap('meta').get('dohcMarkdownSourceSha256');
  // Keyed by the document too: sync can replace a session's document with
  // another that records the same source.
  const meta = input.doc?.getMap('meta');
  const hasWitness = meta && ['dohcMarkdownSource', 'dohcMarkdownSourceSha256', 'dohcMarkdownSourceProjectionSha256'].some(key => meta.has(key));
  const key = input.doc && hasWitness ? `session:${docId(input.doc)}:${metaRevision}:${sha}:${meta?.get('dohcMarkdownSourceProjectionSha256')}:${input.headSha256}` : null;
  const doc = useRef(input.doc);
  doc.current = input.doc;
  const verdict = useVerdict(input.open, key, undefined, () => {
    if (!doc.current || input.headSha256 === undefined) return Promise.resolve(true);
    return ask({state: Y.encodeStateAsUpdate(doc.current), headSha256: input.headSha256}).then(answer => answer.lossy);
  });
  if (key === null) return 'clear';
  return verdict === undefined ? 'checking' : verdict ? 'lossy' : 'clear';
}

const docIds = new WeakMap<Y.Doc, number>();
let nextDocId = 0;
function docId(doc: Y.Doc): number {
  let id = docIds.get(doc);
  if (id === undefined) docIds.set(doc, id = ++nextDocId);
  return id;
}

// The worker's verdict under `key`, as one open sees it: `known` when an
// earlier check answered, else undefined until `check` does. A failed check
// reads as lossy.
function useVerdict(open: string, key: string | null, known: boolean | undefined, check: () => Promise<boolean>): boolean | undefined {
  const [answer, setAnswer] = useState<{open: string; key: string; lossy: boolean} | null>(null);
  const verdict = key === null
    ? undefined
    : answer?.open === open && answer.key === key ? answer.lossy : known;
  const run = useRef(check);
  run.current = check;
  const unanswered = key !== null && verdict === undefined;
  useEffect(() => {
    if (!unanswered || key === null) return;
    let live = true;
    void run.current()
      .catch(() => true)
      .then((lossy) => {
        if (live) setAnswer({open, key, lossy});
      });
    return () => {
      live = false;
    };
  }, [open, key, unanswered]);
  return verdict;
}

/**
 * Tests reuse made-up content hashes for different text, and some stub the
 * worker, so no verdict, check or worker outlives its test.
 */
export function resetLossyNoteCheckForTests(): void {
  stop(new Error('The test ended.'));
  checks.clear();
  verdicts.clear();
}

/** For tests that need a lossy note in an engine session. */
export function rememberLossyNoteVerdictForTests(contentHash: string, lossy: boolean): void {
  verdicts.set(contentHash, lossy);
}

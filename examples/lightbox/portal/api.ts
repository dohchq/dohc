import { useCallback, useEffect, useRef, useState } from "react";
import { decodeBase64, isAppBackendError, useApp, type AppClient } from "dohc/app";

export const UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const COLOR_LABELS = ["red", "yellow", "green", "blue", "purple"] as const;
export type ColorLabel = "none" | (typeof COLOR_LABELS)[number];

export interface Cursor {
  readonly order: number;
  readonly id: string;
}

export interface PhotoSource {
  readonly id: string;
  readonly title: string;
  readonly fileId: string | null;
  readonly demoScene: string | null;
  readonly width: number;
  readonly height: number;
}

export interface ClientAsset extends PhotoSource {
  readonly mimeType: string;
  readonly sortOrder: number;
  readonly picked: boolean;
  readonly noteCount: number;
  readonly openNoteCount: number;
}

export interface StudioAsset extends PhotoSource {
  readonly shootId: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sortOrder: number;
  readonly rating: number;
  readonly colorLabel: ColorLabel;
  readonly published: boolean;
  readonly pickCount: number;
  readonly noteCount: number;
  readonly openNoteCount: number;
}

export interface Gallery {
  readonly title: string;
  readonly clientName: string;
  readonly shotOn: string;
  readonly status: "proofing" | "delivered";
  readonly selectionLimit: number;
  readonly picksUsed: number;
}

export interface Shoot {
  readonly id: string;
  readonly title: string;
  readonly clientName: string;
  readonly shotOn: string;
  readonly selectionLimit: number;
  readonly status: "draft" | "proofing" | "delivered";
  readonly internalRateCents: number;
  readonly accessCode: string;
  readonly assetCount: number;
  readonly publishedCount: number;
  readonly pickedAssetCount: number;
  readonly reviewerCount: number;
  readonly noteCount: number;
  readonly openNoteCount: number;
  readonly cover: Omit<PhotoSource, "id" | "title"> & { readonly assetId: string } | null;
}

export interface Note {
  readonly id: string;
  readonly assetId: string;
  readonly xPct: number;
  readonly yPct: number;
  readonly authorName: string;
  readonly body: string;
  readonly resolved: boolean;
  readonly createdAtMs: number;
}

export function errorMessage(error: unknown): string {
  if (isAppBackendError(error)) {
    if (error.refusal) return error.refusal.message;
    if (error.status === 413) return "That file is larger than dohc can send in one request.";
    if (error.uncertain) return "dohc didn't confirm the change. Check your connection and try again.";
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function refusalCode(error: unknown): string | null {
  return isAppBackendError(error) ? (error.refusal?.code ?? null) : null;
}

export async function invoke<T>(client: AppClient, operation: string, input: unknown): Promise<T> {
  const key = `${operation}:${crypto.randomUUID()}`;
  return runBrokerCall(() => client.invoke<T>(operation, input, key).then((reply) => reply.result));
}

export async function loadPages<T, Extra = unknown>(
  client: AppClient,
  operation: string,
  input: Record<string, unknown>,
  pick: (page: any) => readonly T[],
): Promise<{ items: T[]; first: Extra }> {
  const items: T[] = [];
  let after: unknown = null;
  let first: Extra | undefined;
  do {
    const page: any = await invoke(client, operation, after ? { ...input, after } : input);
    first ??= page as Extra;
    items.push(...pick(page));
    after = page.nextCursor;
  } while (after);
  return { items, first: first as Extra };
}

export interface Loaded<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  reload(): void;
  replace(update: (current: T) => T): void;
}

export function useLoader<T>(key: string | null, load: (client: AppClient) => Promise<T>): Loaded<T> {
  const client = useApp();
  const [state, setState] = useState<{ key: string | null; data?: T; error?: unknown }>({ key: null });
  const [version, setVersion] = useState(0);
  const mutationGen = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const startedGen = mutationGen.current;
    loadRef.current(client).then(
      (data) => current && mutationGen.current === startedGen && setState({ key, data }),
      (error: unknown) =>
        current &&
        mutationGen.current === startedGen &&
        setState((previous) => ({ key, data: previous.key === key ? previous.data : undefined, error })),
    );
    return () => {
      current = false;
    };
  }, [client, key, version]);
  const matched = state.key === key;
  return {
    data: matched ? state.data : undefined,
    error: matched ? state.error : undefined,
    loading: key !== null && (!matched || (state.data === undefined && state.error === undefined)),
    reload: useCallback(() => setVersion((value) => value + 1), []),
    replace: useCallback(
      (update: (current: T) => T) => {
        mutationGen.current++;
        setState((previous) =>
          previous.key === key && previous.data !== undefined ? { ...previous, data: update(previous.data) } : previous,
        );
      },
      [key],
    ),
  };
}

interface FileCacheEntry {
  readonly promise: Promise<string>;
  promote(): void;
  cancel(): void;
  refs: number;
  url: string | null;
  revokeOnRelease: boolean;
}

interface QueuedFileTask {
  priority: "high" | "low";
  cancelled: boolean;
  run: () => void;
}

const fileUrls = new Map<string, FileCacheEntry>();
const MAX_CACHED_FILE_URLS = 32;
const BROKER_BURST = 30;
const BROKER_REFILL_MS = 2000;
const INTERACTIVE_RESERVE = 6;
const MAX_FILE_CONCURRENCY = 2;
const MAX_FILE_RETRIES = 10;
const RATE_LIMIT_COOLDOWN_MS = 2100;
let bucketTokens = BROKER_BURST;
let bucketUpdatedAt = Date.now();
let activeFiles = 0;
let fileCooldownUntil = 0;
let fileTimer: ReturnType<typeof setTimeout> | null = null;
let fileTimerAt = Infinity;
const highFileQueue: QueuedFileTask[] = [];
const lowFileQueue: QueuedFileTask[] = [];

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentBrokerTokens(): number {
  const now = Date.now();
  bucketTokens = Math.min(BROKER_BURST, bucketTokens + (now - bucketUpdatedAt) / BROKER_REFILL_MS);
  bucketUpdatedAt = now;
  return bucketTokens;
}

function consumeBrokerToken() {
  currentBrokerTokens();
  bucketTokens = Math.max(0, bucketTokens - 1);
}

function noteRateLimit() {
  bucketTokens = 0;
  bucketUpdatedAt = Date.now();
  fileCooldownUntil = Math.max(fileCooldownUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

async function runBrokerCall<T>(work: () => Promise<T>, maxRetries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    for (;;) {
      const now = Date.now();
      const cooldownWait = fileCooldownUntil - now;
      if (cooldownWait > 0) {
        await waitMs(cooldownWait);
        continue;
      }
      const tokens = currentBrokerTokens();
      if (tokens < 1) {
        await waitMs(Math.ceil((1 - tokens) * BROKER_REFILL_MS));
        continue;
      }
      break;
    }
    consumeBrokerToken();
    try {
      return await work();
    } catch (error) {
      if (isAppBackendError(error) && error.status === 429 && attempt < maxRetries) {
        noteRateLimit();
        continue;
      }
      throw error;
    }
  }
}

function scheduleDrain(delayMs: number) {
  const clamped = Math.max(50, Math.ceil(delayMs));
  const wakeAt = Date.now() + clamped;
  if (fileTimer !== null) {
    if (wakeAt >= fileTimerAt) return;
    clearTimeout(fileTimer);
  }
  fileTimerAt = wakeAt;
  fileTimer = setTimeout(() => {
    fileTimer = null;
    fileTimerAt = Infinity;
    drainFileQueue();
  }, clamped);
}

function drainFileQueue() {
  while (activeFiles < MAX_FILE_CONCURRENCY && (highFileQueue.length > 0 || lowFileQueue.length > 0)) {
    const now = Date.now();
    if (fileCooldownUntil > now) {
      scheduleDrain(fileCooldownUntil - now);
      return;
    }
    const tokens = currentBrokerTokens();
    if (highFileQueue.length > 0) {
      if (tokens < 1) {
        scheduleDrain((1 - tokens) * BROKER_REFILL_MS);
        return;
      }
      activeFiles++;
      consumeBrokerToken();
      highFileQueue.shift()!.run();
    } else if (lowFileQueue.length > 0) {
      if (tokens <= INTERACTIVE_RESERVE) {
        scheduleDrain((INTERACTIVE_RESERVE + 1 - tokens) * BROKER_REFILL_MS);
        return;
      }
      activeFiles++;
      consumeBrokerToken();
      lowFileQueue.shift()!.run();
    }
  }
}

function runPacedFile<T>(
  priority: "high" | "low",
  work: () => Promise<T>,
): { promise: Promise<T>; promote(): void; cancel(): void } {
  const task: QueuedFileTask = { priority, cancelled: false, run: () => undefined };
  let cancelReject: ((reason?: unknown) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    cancelReject = reject;
    const attemptWork = (attempt: number) => {
      void (async () => {
        try {
          resolve(await work());
        } catch (error) {
          if (!task.cancelled && isAppBackendError(error) && error.status === 429 && attempt < MAX_FILE_RETRIES) {
            noteRateLimit();
            task.run = () => attemptWork(attempt + 1);
            (task.priority === "high" ? highFileQueue : lowFileQueue).unshift(task);
          } else {
            reject(error);
          }
        } finally {
          activeFiles--;
          drainFileQueue();
        }
      })();
    };
    task.run = () => attemptWork(0);
    (task.priority === "high" ? highFileQueue : lowFileQueue).push(task);
    drainFileQueue();
  });
  const promote = () => {
    if (task.priority === "high" || task.cancelled) return;
    task.priority = "high";
    const position = lowFileQueue.indexOf(task);
    if (position >= 0) {
      lowFileQueue.splice(position, 1);
      highFileQueue.push(task);
      drainFileQueue();
    }
  };
  const cancel = () => {
    if (task.cancelled) return;
    task.cancelled = true;
    for (const queue of [highFileQueue, lowFileQueue]) {
      const position = queue.indexOf(task);
      if (position >= 0) {
        queue.splice(position, 1);
        cancelReject?.(new Error("Cancelled."));
      }
    }
  };
  return { promise, promote, cancel };
}

function evictUnusedFileUrls() {
  if (fileUrls.size <= MAX_CACHED_FILE_URLS) return;
  for (const [key, entry] of fileUrls) {
    if (fileUrls.size <= MAX_CACHED_FILE_URLS) break;
    if (entry.refs > 0) continue;
    fileUrls.delete(key);
    entry.cancel();
    if (entry.url) URL.revokeObjectURL(entry.url);
    else entry.revokeOnRelease = true;
  }
}

function releaseEntry(key: string, entry: FileCacheEntry) {
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && entry.revokeOnRelease) {
    if (fileUrls.get(key) === entry) fileUrls.delete(key);
    entry.cancel();
    if (entry.url) URL.revokeObjectURL(entry.url);
    return;
  }
  evictUnusedFileUrls();
}

export interface PhotoFileLease {
  readonly promise: Promise<string>;
  release(): void;
}

export function acquirePhotoFileUrl(
  client: AppClient,
  fileId: string,
  operation: string,
  input: Record<string, unknown>,
  mimeType: string,
  priority: "high" | "low" = "low",
): PhotoFileLease {
  const key = `${operation}:${fileId}`;
  const bindRelease = (entry: FileCacheEntry): PhotoFileLease => {
    let released = false;
    return {
      promise: entry.promise,
      release() {
        if (released) return;
        released = true;
        releaseEntry(key, entry);
      },
    };
  };
  const cached = fileUrls.get(key);
  if (cached) {
    cached.refs++;
    fileUrls.delete(key);
    fileUrls.set(key, cached);
    if (priority === "high") cached.promote();
    return bindRelease(cached);
  }
  const entry: FileCacheEntry = {
    promise: Promise.resolve(""),
    promote: () => undefined,
    cancel: () => undefined,
    refs: 1,
    url: null,
    revokeOnRelease: false,
  };
  const task = runPacedFile(priority, () =>
    client.file(fileId, operation, input).then(({ bytesBase64 }) => {
      const bytes = decodeBase64(bytesBase64);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
      if (entry.revokeOnRelease && entry.refs <= 0) {
        URL.revokeObjectURL(url);
        return url;
      }
      entry.url = url;
      return url;
    }),
  );
  const fullEntry: FileCacheEntry = Object.assign(entry, {
    promise: task.promise,
    promote: task.promote,
    cancel: task.cancel,
  });
  task.promise.catch(() => {
    if (fileUrls.get(key) === fullEntry) fileUrls.delete(key);
  });
  fileUrls.set(key, fullEntry);
  evictUnusedFileUrls();
  return bindRelease(fullEntry);
}

export function photoFileUrl(
  client: AppClient,
  fileId: string,
  operation: string,
  input: Record<string, unknown>,
  mimeType: string,
  priority: "high" | "low" = "low",
): Promise<string> {
  return acquirePhotoFileUrl(client, fileId, operation, input, mimeType, priority).promise;
}

export function releasePhotoFileUrl(operation: string, fileId: string) {
  const key = `${operation}:${fileId}`;
  const entry = fileUrls.get(key);
  if (entry) releaseEntry(key, entry);
}

export function revokePhotoFileUrl(operation: string, fileId: string) {
  const key = `${operation}:${fileId}`;
  const entry = fileUrls.get(key);
  if (!entry) return;
  entry.revokeOnRelease = true;
  if (entry.refs === 0) {
    fileUrls.delete(key);
    entry.cancel();
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface UploadedPhoto {
  readonly fileId: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly ms: number;
}

export function checkPhoto(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name} isn't a JPEG, PNG, or WebP image.`;
  if (file.size > UPLOAD_LIMIT_BYTES)
    return `${file.name} is ${formatBytes(file.size)}. Photos can be at most ${formatBytes(UPLOAD_LIMIT_BYTES)} (5 MiB).`;
  return null;
}

export async function uploadPhoto(client: AppClient, file: File): Promise<UploadedPhoto> {
  const started = performance.now();
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  const key = `upload:${crypto.randomUUID()}`;
  const reply = await runBrokerCall(() => client.upload(file, key));
  return { fileId: reply.file.fileId, width, height, bytes: file.size, ms: performance.now() - started };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function readName(): string {
  try {
    return localStorage.getItem("lightbox.name") ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string) {
  try {
    localStorage.setItem("lightbox.name", name);
  } catch {
    return;
  }
}

export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

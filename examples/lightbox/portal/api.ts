import { useCallback, useEffect, useRef, useState } from "react";
import { isAppBackendError, useApp, type AppClient } from "dohc/app";

export const UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const COLOR_LABELS = ["red", "yellow", "green", "blue", "purple"] as const;
export type ColorLabel = "none" | (typeof COLOR_LABELS)[number];

export interface PhotoSource {
  readonly id: string;
  readonly title: string;
  readonly fileId: string | null;
  readonly previewFileId: string | null;
  readonly demoScene: string | null;
  readonly width: number;
  readonly height: number;
}

export interface ClientAsset extends PhotoSource {
  readonly mimeType: string;
  readonly sortOrder: number;
  readonly picked: boolean;
  readonly sent: boolean;
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
  readonly capture: {
    readonly camera: string | null;
    readonly lens: string | null;
    readonly iso: number | null;
    readonly fNumber: number | null;
    readonly exposureS: number | null;
    readonly focalMm: number | null;
  };
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
  readonly sentAtMs: number | null;
  readonly sentPicks: number;
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
  readonly sentCount: number;
  readonly noteCount: number;
  readonly openNoteCount: number;
  readonly cover: (Omit<PhotoSource, "id" | "title"> & { readonly assetId: string }) | null;
}

export interface Note {
  readonly id: string;
  readonly assetId: string;
  readonly xPct: number;
  readonly yPct: number;
  readonly authorName: string;
  readonly mine: boolean;
  readonly body: string;
  readonly resolved: boolean;
  readonly createdAtMs: number;
}

export function errorMessage(error: unknown): string {
  if (isAppBackendError(error)) {
    if (error.refusal) return error.refusal.message;
    if (error.status === 413) return "That file is too large to send in one request.";
    if (error.uncertain)
      return "The change could not be confirmed. Check your connection and try again.";
  }
  return error instanceof Error ? error.message : "That did not work. Try again.";
}

export function refusalCode(error: unknown): string | null {
  return isAppBackendError(error) ? (error.refusal?.code ?? null) : null;
}

export async function invoke<T>(
  client: AppClient,
  operation: string,
  input: unknown,
  key = `${operation}:${crypto.randomUUID()}`,
): Promise<T> {
  return interactive(() => client.invoke<T>(operation, input, key).then((reply) => reply.result));
}

export type Paged<Key extends string, T> = { readonly [key in Key]: readonly T[] } & {
  readonly nextCursor: unknown;
};

export async function loadPages<Page extends { readonly nextCursor: unknown }, T>(
  client: AppClient,
  operation: string,
  input: Record<string, unknown>,
  pick: (page: Page) => readonly T[],
): Promise<{ items: T[]; first: Page }> {
  const items: T[] = [];
  let after: unknown = null;
  let first: Page | undefined;
  do {
    const page: Page = await invoke<Page>(client, operation, after ? { ...input, after } : input);
    first ??= page;
    items.push(...pick(page));
    after = page.nextCursor;
  } while (after);
  return { items, first: first! };
}

export interface Loaded<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  reload(): void;
  replace(update: (current: T) => T): void;
}

export function useLoader<T>(
  key: string | null,
  load: (client: AppClient) => Promise<T>,
): Loaded<T> {
  const client = useApp();
  const [state, setState] = useState<{ key: string | null; data?: T; error?: unknown }>({
    key: null,
  });
  const [version, setVersion] = useState(0);
  const mutationGen = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null || !client.subscribe) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((value) => value + 1), 250);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, key]);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const startedGen = mutationGen.current;
    loadRef.current(client).then(
      (data) => {
        if (!current) return;
        if (mutationGen.current === startedGen) setState({ key, data });
        else setVersion((value) => value + 1);
      },
      (error: unknown) =>
        current &&
        mutationGen.current === startedGen &&
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : undefined,
          error,
        })),
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
          previous.key === key && previous.data !== undefined
            ? { ...previous, data: update(previous.data) }
            : previous,
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
  drop(): void;
  refs: number;
  url: string | null;
  revokeOnRelease: boolean;
}

const fileUrls = new Map<string, FileCacheEntry>();
const MAX_CACHED_FILE_URLS = 32;
const FILE_CONCURRENCY = 2;
const MAX_RETRIES = 10;
const BUSY_RETRY_MS = 250;

interface FileJob {
  high: boolean;
  cancelled: boolean;
  run(): void;
}

const fileJobs: FileJob[] = [];
let activeFiles = 0;
let throttled = false;
let interactiveCalls = 0;
let blockedUntil = 0;
let drainTimer: ReturnType<typeof setTimeout> | undefined;

function retryDelay(error: unknown): number | null {
  if (!isAppBackendError(error) || error.status !== 429) return null;
  return error.retryAfterMs || BUSY_RETRY_MS;
}

function holdOff(ms: number) {
  blockedUntil = Math.max(blockedUntil, Date.now() + ms);
}

async function untilUnblocked() {
  for (let wait = blockedUntil - Date.now(); wait > 0; wait = blockedUntil - Date.now()) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

async function withRetries<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await untilUnblocked();
    try {
      return await work();
    } catch (error) {
      const wait = retryDelay(error);
      if (wait === null || attempt >= MAX_RETRIES) throw error;
      holdOff(wait);
    }
  }
}

async function interactive<T>(work: () => Promise<T>): Promise<T> {
  interactiveCalls++;
  try {
    return await withRetries(work);
  } finally {
    interactiveCalls--;
    drainFiles();
  }
}

function drainFiles() {
  clearTimeout(drainTimer);
  const wait = blockedUntil - Date.now();
  if (wait > 0) {
    drainTimer = setTimeout(drainFiles, wait);
    return;
  }
  while (
    activeFiles < (throttled ? 1 : FILE_CONCURRENCY) &&
    interactiveCalls === 0 &&
    fileJobs.length > 0
  ) {
    const [job] = fileJobs.splice(
      Math.max(
        0,
        fileJobs.findIndex((queued) => queued.high),
      ),
      1,
    );
    activeFiles++;
    job.run();
  }
}

function queueFile<T>(
  high: boolean,
  work: () => Promise<T>,
  wanted: () => boolean,
): { promise: Promise<T>; promote(): void; cancel(): void; drop(): void } {
  const job: FileJob = { high, cancelled: false, run: () => undefined };
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, fail) => {
    reject = fail;
    job.run = () =>
      void work()
        .then(
          (value) => {
            throttled = false;
            resolve(value);
          },
          (error: unknown) => {
            const wait = retryDelay(error);
            if (wait !== null) holdOff(wait);
            if (wait === null || job.cancelled || !wanted()) return fail(error);
            throttled = true;
            fileJobs.unshift(job);
          },
        )
        .finally(() => {
          activeFiles--;
          drainFiles();
        });
  });
  fileJobs.push(job);
  drainFiles();
  const drop = () => {
    const index = fileJobs.indexOf(job);
    if (index < 0) return;
    fileJobs.splice(index, 1);
    reject(new Error("Cancelled."));
  };
  return {
    promise,
    promote: () => void (job.high = true),
    cancel: () => {
      job.cancelled = true;
      drop();
    },
    drop,
  };
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
  if (entry.refs > 0) return;
  if (entry.revokeOnRelease) {
    if (fileUrls.get(key) === entry) fileUrls.delete(key);
    entry.cancel();
    if (entry.url) URL.revokeObjectURL(entry.url);
    return;
  }
  queueMicrotask(() => {
    if (entry.refs === 0) entry.drop();
  });
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
  const job = queueFile(
    priority === "high",
    () =>
      client.file(fileId, operation, input).then(({ bytes }) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        if (entry.revokeOnRelease && entry.refs <= 0) URL.revokeObjectURL(url);
        else entry.url = url;
        return url;
      }),
    () => entry.refs > 0,
  );
  const entry: FileCacheEntry = { ...job, refs: 1, url: null, revokeOnRelease: false };
  job.promise.catch(() => {
    if (fileUrls.get(key) === entry) fileUrls.delete(key);
  });
  fileUrls.set(key, entry);
  evictUnusedFileUrls();
  return bindRelease(entry);
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

export interface UploadedPhoto {
  readonly fileId: string;
  readonly previewFileId: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly ms: number;
}

export function checkPhoto(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name} is not a JPEG, PNG, or WebP image.`;
  if (file.size > UPLOAD_LIMIT_BYTES)
    return `${file.name} is ${formatBytes(file.size)}. Photos can be at most ${formatBytes(UPLOAD_LIMIT_BYTES)} (20 MiB).`;
  return null;
}

export async function uploadPhoto(
  client: AppClient,
  file: File,
  key: string,
): Promise<UploadedPhoto> {
  const started = performance.now();
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  const preview = await previewOf(file, bitmap).finally(() => bitmap.close());
  const previewReply = await withRetries(() => client.upload(preview, `preview:${key}`));
  const reply = await withRetries(() => client.upload(file, `upload:${key}`));
  return {
    fileId: reply.file.fileId,
    previewFileId: previewReply.file.fileId,
    width,
    height,
    bytes: file.size,
    ms: performance.now() - started,
  };
}

const PREVIEW_EDGE = 2048;
const PREVIEW_LIMIT_BYTES = 1024 * 1024;

async function previewOf(file: File, bitmap: ImageBitmap): Promise<File> {
  const name = `${file.name.replace(/\.[A-Za-z0-9]{1,5}$/, "")}-preview.jpg`;
  for (const edge of [PREVIEW_EDGE, 1600, 1200]) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (!context) break;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.72]) {
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      if (blob.size <= PREVIEW_LIMIT_BYTES) return new File([blob], name, { type: "image/jpeg" });
    }
  }
  throw new Error(`Could not make a preview of ${file.name}.`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes >= 10 || Number.isInteger(megabytes) ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
}

export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

let rememberedName = "";

export function readName(): string {
  try {
    return localStorage.getItem("lightbox.name") ?? rememberedName;
  } catch {
    return rememberedName;
  }
}

export function saveName(name: string) {
  rememberedName = name;
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

import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as appKit from "../../packages/app-kit/src/app.tsx";
import type { AppClient, InvokeReply } from "../../packages/app-kit/src/app.tsx";

interface LightboxApiModule {
  invoke<T>(client: AppClient, operation: string, input: unknown): Promise<T>;
  acquirePhotoFileUrl(
    client: AppClient,
    fileId: string,
    operation: string,
    input: Record<string, unknown>,
    mimeType: string,
    priority?: "high" | "low",
  ): { promise: Promise<string>; release(): void };
  revokePhotoFileUrl(operation: string, fileId: string): void;
  uploadPhoto(
    client: AppClient,
    file: File,
    key: string,
  ): Promise<{ fileId: string; width: number; height: number; bytes: number; ms: number }>;
}

const LIGHTBOX_API = resolve(import.meta.dirname, "portal/api.ts");

async function loadLightboxApi(): Promise<{
  api: LightboxApiModule;
  AppBackendError: typeof appKit.AppBackendError;
}> {
  vi.doMock("react", () => ({}));
  vi.doMock("dohc/app", () => appKit);
  const api = (await import(/* @vite-ignore */ LIGHTBOX_API)) as LightboxApiModule;
  return { api, AppBackendError: appKit.AppBackendError };
}

function thumb(api: LightboxApiModule, client: AppClient, id: string, priority: "high" | "low" = "low") {
  return api.acquirePhotoFileUrl(client, id, "assetFileAccess", { code: "GOLDHOUR2026", assetId: id }, "image/jpeg", priority);
}

function makeThrottledBroker(
  AppBackendError: typeof appKit.AppBackendError,
  { burst = 30, refillMs = 2000, maxPending = 4 } = {},
) {
  let tokens = burst;
  let updated = Date.now();
  let pending = 0;
  const started: string[] = [];
  const uploadKeys = new Map<string, string[]>();
  const take = (label: string) => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + (now - updated) / refillMs);
    updated = now;
    if (pending >= maxPending) throw new AppBackendError(429);
    if (tokens < 1) throw new AppBackendError(429, undefined, undefined, Math.ceil((1 - tokens) * refillMs));
    tokens--;
    pending++;
    started.push(label);
  };
  let failFirstUploadOnce = true;
  const client: AppClient = {
    async invoke<T>(operation: string, _input?: unknown, idempotencyKey?: string): Promise<InvokeReply<T>> {
      take(`invoke:${operation}`);
      try {
        return {
          revision: 1,
          replayed: false,
          result: { ok: true, idempotencyKey } as T,
        };
      } finally {
        pending--;
      }
    },
    async upload(file, idempotencyKey) {
      const name = file.name;
      const contentType = file instanceof File ? file.type : file.contentType;
      const byteLength = file instanceof File ? file.size : 3;
      const seen = uploadKeys.get(name) ?? [];
      seen.push(idempotencyKey);
      uploadKeys.set(name, seen);
      if (failFirstUploadOnce && name === "shot_0.jpg") {
        failFirstUploadOnce = false;
        throw new AppBackendError(429);
      }
      take(`upload:${name}`);
      try {
        return {
          replayed: false,
          file: {
            fileId: `f_${name}`,
            name,
            contentType,
            byteLength,
            sha256: "a".repeat(64),
          },
        };
      } finally {
        pending--;
      }
    },
    async file(fileId) {
      take(`file:${fileId}`);
      try {
        const bytes = new Uint8Array([0]).buffer;
        return {
          file: {
            fileId,
            name: `${fileId}.jpg`,
            contentType: "image/jpeg",
            byteLength: 1,
            sha256: "a".repeat(64),
          },
          bytes,
          blob: () => new Blob([bytes], { type: "image/jpeg" }),
        };
      } finally {
        pending--;
      }
    },
    read: async () => {
      throw new Error("unused");
    },
    attempt: async () => {
      throw new Error("unused");
    },
    close: () => undefined,
    dataset: () => client,
  };
  return { client, started, uploadKeys };
}

let blobCounter = 0;
let revokedUrls: string[] = [];

beforeEach(() => {
  blobCounter = 0;
  revokedUrls = [];
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T00:00:00Z"));
  vi.stubGlobal("createImageBitmap", async () => ({ width: 1200, height: 800, close() {} }));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { fillStyle: "", fillRect() {}, drawImage() {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(64)], { type: "image/jpeg" });
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++blobCounter}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revokedUrls.push(url);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses a host's larger broker budget without pacing thumbnails", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, started } = makeThrottledBroker(AppBackendError, { burst: 120, refillMs: 50, maxPending: 16 });

  const thumbs = Array.from({ length: 90 }, (_, index) => thumb(api, client, `photo_${index}`));
  await vi.advanceTimersByTimeAsync(0);
  expect(started.filter((entry) => entry.startsWith("file:"))).toHaveLength(90);
  await expect(Promise.all(thumbs.map((lease) => lease.promise))).resolves.toHaveLength(90);
});

it("waits out a share link's retry time, sends a click before queued thumbnails, and promotes a requested one", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, started } = makeThrottledBroker(AppBackendError);
  const files = () => started.filter((entry) => entry.startsWith("file:"));

  const thumbs = Array.from({ length: 34 }, (_, index) => thumb(api, client, `photo_${index}`));
  await vi.advanceTimersByTimeAsync(0);
  expect(files()).toHaveLength(30);

  const picked = api.invoke(client, "toggleClientPick", { assetId: "photo_0", selected: true });
  const promoted = thumb(api, client, "photo_33", "high");
  expect(promoted.promise).toBe(thumbs[33]!.promise);
  await vi.advanceTimersByTimeAsync(1999);
  expect(started).toHaveLength(30);
  await vi.advanceTimersByTimeAsync(1);
  await expect(picked).resolves.toMatchObject({ ok: true });
  expect(started[30]).toBe("invoke:toggleClientPick");

  await vi.advanceTimersByTimeAsync(2000);
  expect(started[31]).toBe("file:photo_33");
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(Promise.all(thumbs.map((lease) => lease.promise))).resolves.toHaveLength(34);
});

it("drops a released thumbnail's queued download so the one on screen goes next, and keeps retrying a rate-limited one that is still wanted", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, started } = makeThrottledBroker(AppBackendError);

  const thumbs = Array.from({ length: 31 }, (_, index) => thumb(api, client, `photo_${index}`));
  await vi.advanceTimersByTimeAsync(0);
  thumbs[30]!.release();
  await expect(thumbs[30]!.promise).rejects.toThrow("Cancelled.");
  const onScreen = thumb(api, client, "on_screen");

  await vi.advanceTimersByTimeAsync(10_000);
  await expect(onScreen.promise).resolves.toMatch(/^blob:test-/);
  expect(started.slice(30)).toEqual(["file:on_screen"]);
});

it("stops retrying a rate-limited download whose thumbnail was released while it ran", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, started } = makeThrottledBroker(AppBackendError);

  const thumbs = Array.from({ length: 30 }, (_, index) => thumb(api, client, `photo_${index}`));
  await vi.advanceTimersByTimeAsync(0);
  await expect(Promise.all(thumbs.map((lease) => lease.promise))).resolves.toHaveLength(30);
  const scrolledPast = thumb(api, client, "scrolled_past");
  scrolledPast.release();
  await expect(scrolledPast.promise).rejects.toMatchObject({ status: 429 });
  const onScreen = thumb(api, client, "on_screen");

  await vi.advanceTimersByTimeAsync(10_000);
  await expect(onScreen.promise).resolves.toMatch(/^blob:test-/);
  expect(started.slice(30)).toEqual(["file:on_screen"]);
});

it("paces 18 sequential photo uploads and registrations across the 30-token burst and reuses idempotency key on 429", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, uploadKeys } = makeThrottledBroker(AppBackendError);

  const run = (async () => {
    const ids: string[] = [];
    for (let index = 0; index < 18; index++) {
      const file = new File([new Uint8Array([1, 2, 3])], `shot_${index}.jpg`, { type: "image/jpeg" });
      const sent = await api.uploadPhoto(client, file, `key-${index}`);
      await api.invoke(client, "uploadAsset", {
        shootId: "shoot_positano",
        fileId: sent.fileId,
        previewFileId: sent.previewFileId,
        width: sent.width,
        height: sent.height,
      });
      ids.push(sent.fileId);
    }
    return ids;
  })();

  await vi.advanceTimersByTimeAsync(140_000);
  const uploadedIds = await run;
  expect(uploadedIds).toHaveLength(18);
  const firstKeys = uploadKeys.get("shot_0.jpg")!;
  expect(firstKeys).toEqual(["upload:key-0", "upload:key-0"]);
  expect(uploadKeys.get("shot_0-preview.jpg")).toEqual(["preview:key-0"]);
  expect(new Set([...uploadKeys.values()].map((keys) => keys[0])).size).toBe(36);
});

it("evicts and revokes unused photo blob URLs past the cache cap and on explicit revoke", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client } = makeThrottledBroker(AppBackendError);

  const urls: string[] = [];
  for (let index = 0; index < 35; index++) {
    const lease = api.acquirePhotoFileUrl(client, `evict_${index}`, "studioFileAccess", { assetId: `evict_${index}` }, "image/jpeg", "high");
    await vi.advanceTimersByTimeAsync(2500);
    urls.push(await lease.promise);
    lease.release();
  }
  expect(revokedUrls).toEqual(expect.arrayContaining([urls[0], urls[1], urls[2]]));
  api.revokePhotoFileUrl("studioFileAccess", "evict_34");
  expect(revokedUrls).toContain(urls[34]);
});

it("binds each release to the specific cache entry so a failed view's cleanup never revokes a retried entry", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  let failOnce = true;
  const base = makeThrottledBroker(AppBackendError).client;
  const client: AppClient = {
    ...base,
    async file(fileId, operation, input) {
      if (failOnce && fileId === "flaky") {
        failOnce = false;
        throw new AppBackendError(503);
      }
      return base.file(fileId, operation, input);
    },
  };

  const first = api.acquirePhotoFileUrl(client, "flaky", "studioFileAccess", { assetId: "flaky" }, "image/jpeg", "high");
  const second = api.acquirePhotoFileUrl(client, "flaky", "studioFileAccess", { assetId: "flaky" }, "image/jpeg", "high");
  await expect(first.promise).rejects.toThrow();
  await expect(second.promise).rejects.toThrow();

  const retried = api.acquirePhotoFileUrl(client, "flaky", "studioFileAccess", { assetId: "flaky" }, "image/jpeg", "high");
  const url = await retried.promise;
  first.release();
  second.release();

  for (let index = 0; index < 35; index++) {
    const lease = api.acquirePhotoFileUrl(
      client,
      `fill_${index}`,
      "studioFileAccess",
      { assetId: `fill_${index}` },
      "image/jpeg",
      "high",
    );
    await vi.advanceTimersByTimeAsync(2500);
    await lease.promise;
    lease.release();
  }
  expect(revokedUrls).not.toContain(url);
  retried.release();
});

it("cancels undispatched queued downloads when their cache entry is evicted", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, started } = makeThrottledBroker(AppBackendError);

  const leases = Array.from({ length: 36 }, (_, index) =>
    api.acquirePhotoFileUrl(
      client,
      `abandon_${index}`,
      "assetFileAccess",
      { code: "GOLDHOUR2026", assetId: `abandon_${index}` },
      "image/jpeg",
      "low",
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(started.filter((entry) => entry.startsWith("file:"))).toHaveLength(30);
  for (const lease of leases) lease.release();

  const replacement = Array.from({ length: 34 }, (_, index) =>
    api.acquirePhotoFileUrl(
      client,
      `next_${index}`,
      "assetFileAccess",
      { code: "GOLDHOUR2026", assetId: `next_${index}` },
      "image/jpeg",
      "low",
    ),
  );
  await Promise.allSettled(leases.map((lease) => lease.promise));
  await vi.advanceTimersByTimeAsync(120_000);
  await expect(Promise.all(replacement.map((lease) => lease.promise))).resolves.toHaveLength(34);
  expect(started).not.toContain("file:abandon_35");
  for (const lease of replacement) lease.release();
});

function exifJpeg(order: "II" | "MM", odd: { iso?: number; fastShutter?: boolean; make?: string } = {}): Uint8Array {
  const little = order === "II";
  const tiff: number[] = [];
  const u16 = (value: number) => tiff.push(...(little ? [value & 255, value >> 8] : [value >> 8, value & 255]));
  const u32 = (value: number) => {
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    tiff.push(...(little ? bytes.reverse() : bytes));
  };
  tiff.push(order.charCodeAt(0), order.charCodeAt(1));
  u16(42);
  u32(8);
  const modelAt = 8 + 2 + 3 * 12 + 4;
  const make = odd.make ?? "FUJIFILM";
  const exifAt = modelAt + 8 + make.length + 1;
  u16(3);
  u16(0x010f);
  u16(2);
  u32(make.length + 1);
  u32(modelAt + 8);
  u16(0x0110);
  u16(2);
  u32(6);
  u32(modelAt);
  u16(0x8769);
  u16(4);
  u32(1);
  u32(exifAt);
  u32(0);
  for (const char of `X100V\0\0\0${make}`) tiff.push(char.charCodeAt(0));
  tiff.push(0);
  const valuesAt = exifAt + 2 + 4 * 12 + 4;
  u16(4);
  u16(0x829a);
  u16(5);
  u32(1);
  u32(valuesAt);
  u16(0x829d);
  u16(5);
  u32(1);
  u32(valuesAt + 8);
  u16(0x8827);
  u16(3);
  u32(1);
  u16(odd.iso ?? 400);
  u16(0);
  u16(0x920a);
  u16(5);
  u32(1);
  u32(valuesAt + 16);
  u32(0);
  for (const value of [1, odd.fastShutter ? 1000000 : 250, 2, 1, 23, 1]) u32(value);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xd9]);
}

it("reads camera settings from JPEG EXIF in either byte order, and nothing from other files", async () => {
  const camera = (await import(resolve(import.meta.dirname, "camera.ts"))) as typeof import("./camera.ts");
  for (const order of ["II", "MM"] as const) {
    const file = new File([exifJpeg(order)], "x.jpg", { type: "image/jpeg" });
    expect(await camera.readCameraSettings(file)).toEqual({ camera: "FUJIFILM X100V", iso: 400, fNumber: 2, exposureS: 0.004, focalMm: 23 });
  }
  expect(camera.describeExposure({ iso: 400, fNumber: 2, exposureS: 0.004, focalMm: 23 })).toEqual(["ISO 400", "f/2", "1/250 s", "23 mm"]);
  expect(await camera.readCameraSettings(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "x.jpg", { type: "image/jpeg" }))).toBeNull();
  expect(await camera.readCameraSettings(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 2])], "x.jpg", { type: "image/jpeg" }))).toBeNull();
  expect(await camera.readCameraSettings(new File([exifJpeg("II")], "x.png", { type: "image/png" }))).toBeNull();
  const odd = exifJpeg("MM", { iso: 0, fastShutter: true, make: "FUJI\u0007FILM" });
  expect(await camera.readCameraSettings(new File([odd], "x.jpg", { type: "image/jpeg" }))).toEqual({ camera: "FUJIFILM X100V", fNumber: 2, focalMm: 23 });
});

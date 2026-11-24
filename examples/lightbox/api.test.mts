import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as appKit from "../../packages/app-kit/src/app.tsx";
import type { AppClient, InvokeReply } from "../../packages/app-kit/src/app.tsx";

interface LightboxApiModule {
  invoke<T>(client: AppClient, operation: string, input: unknown): Promise<T>;
  photoFileUrl(
    client: AppClient,
    fileId: string,
    operation: string,
    input: Record<string, unknown>,
    mimeType: string,
    priority?: "high" | "low",
  ): Promise<string>;
  releasePhotoFileUrl(operation: string, fileId: string): void;
  revokePhotoFileUrl(operation: string, fileId: string): void;
  uploadPhoto(
    client: AppClient,
    file: File,
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

function makeThrottledBroker(AppBackendError: typeof appKit.AppBackendError) {
  let tokens = 30;
  let updated = Date.now();
  let pending = 0;
  const started: string[] = [];
  const uploadKeys = new Map<string, string[]>();
  const take = (label: string) => {
    const now = Date.now();
    tokens = Math.min(30, tokens + (now - updated) / 2000);
    updated = now;
    if (pending >= 4 || tokens < 1) throw new AppBackendError(429);
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
        return {
          file: {
            fileId,
            name: `${fileId}.jpg`,
            contentType: "image/jpeg",
            byteLength: 1,
            sha256: "a".repeat(64),
          },
          bytesBase64: "AA==",
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

it("reserves broker capacity for interactive calls and promotes a queued thumbnail on high-priority cache hit", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, started } = makeThrottledBroker(AppBackendError);

  const thumbs = Array.from({ length: 32 }, (_, index) =>
    api.photoFileUrl(
      client,
      `photo_${index}`,
      "assetFileAccess",
      { code: "GOLDHOUR2026", assetId: `photo_${index}` },
      "image/jpeg",
      "low",
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(started.filter((entry) => entry.startsWith("file:"))).toHaveLength(24);
  expect(started).not.toContain("file:photo_31");

  await expect(api.invoke(client, "toggleClientPick", { assetId: "photo_0", selected: true })).resolves.toMatchObject({
    ok: true,
  });

  const promoted = api.photoFileUrl(
    client,
    "photo_31",
    "assetFileAccess",
    { code: "GOLDHOUR2026", assetId: "photo_31" },
    "image/jpeg",
    "high",
  );
  expect(promoted).toBe(thumbs[31]);
  await expect(promoted).resolves.toMatch(/^blob:test-/);
  expect(started).toContain("file:photo_31");
  expect(started).not.toContain("file:photo_25");

  await vi.advanceTimersByTimeAsync(30_000);
  await expect(Promise.all(thumbs)).resolves.toHaveLength(32);
});

it("paces 18 sequential photo uploads and registrations across the 30-token burst and reuses idempotency key on 429", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client, uploadKeys } = makeThrottledBroker(AppBackendError);

  const run = (async () => {
    const ids: string[] = [];
    for (let index = 0; index < 18; index++) {
      const file = new File([new Uint8Array([1, 2, 3])], `shot_${index}.jpg`, { type: "image/jpeg" });
      const sent = await api.uploadPhoto(client, file);
      await api.invoke(client, "uploadAsset", {
        shootId: "shoot_positano",
        fileId: sent.fileId,
        width: sent.width,
        height: sent.height,
      });
      ids.push(sent.fileId);
    }
    return ids;
  })();

  await vi.advanceTimersByTimeAsync(90_000);
  const uploadedIds = await run;
  expect(uploadedIds).toHaveLength(18);
  const firstKeys = uploadKeys.get("shot_0.jpg")!;
  expect(firstKeys).toHaveLength(2);
  expect(firstKeys[0]).toBe(firstKeys[1]);
});

it("evicts and revokes unused photo blob URLs past the cache cap and on explicit revoke", async () => {
  const { api, AppBackendError } = await loadLightboxApi();
  const { client } = makeThrottledBroker(AppBackendError);

  const urls: string[] = [];
  for (let index = 0; index < 35; index++) {
    const promise = api.photoFileUrl(
      client,
      `evict_${index}`,
      "studioFileAccess",
      { assetId: `evict_${index}` },
      "image/jpeg",
      "high",
    );
    await vi.advanceTimersByTimeAsync(2500);
    urls.push(await promise);
    api.releasePhotoFileUrl("studioFileAccess", `evict_${index}`);
  }
  expect(revokedUrls).toEqual(expect.arrayContaining([urls[0], urls[1], urls[2]]));
  api.revokePhotoFileUrl("studioFileAccess", "evict_34");
  expect(revokedUrls).toContain(urls[34]);
});

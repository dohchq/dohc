import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccount, type AccountState } from "./account";
import { createServerClient, ServerError } from "./client";
import { fileWriteOperations } from "./fileWrites";
import { collectionOperations } from "./phoneCollections";
import { memoryStore, serveSessionEnd, testServer } from "./testServer";

const files = new Map<string, Uint8Array>();
const dirs = new Set<string>();
const deletedDirs: string[] = [];
let beforeFileWrite: ((uri: string, bytes: Uint8Array) => void) | null = null;
let mockFileSizeOverride: number | undefined;
let bytesReadCount = 0;

vi.mock("expo-file-system", () => {
  class MockFile {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri =
        typeof parent === "string" ? parent : `${parent.uri.replace(/\/$/u, "")}/${name ?? ""}`;
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      return mockFileSizeOverride ?? files.get(this.uri)?.byteLength ?? 0;
    }
    async write(bytes: Uint8Array) {
      beforeFileWrite?.(this.uri, bytes);
      files.set(this.uri, new Uint8Array(bytes));
    }
    async bytes() {
      bytesReadCount += 1;
      const data = files.get(this.uri);
      if (!data) throw new Error("missing");
      return new Uint8Array(data);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  class MockDirectory {
    readonly uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri.replace(/\/$/u, "")}/${name}`;
    }
    get exists() {
      return dirs.has(this.uri);
    }
    create() {
      dirs.add(this.uri);
    }
    delete() {
      deletedDirs.push(this.uri);
      dirs.delete(this.uri);
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${this.uri}/`)) files.delete(key);
      }
    }
  }
  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { cache: { uri: "file:///cache" } },
  };
});

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(),
}));

import * as DocumentPicker from "expo-document-picker";
import {
  BINARY_CACHE_DIR,
  classifyFilePreview,
  clearBinaryCacheOnSignInChange,
  clearBinaryFileCache,
  downloadCollectionAttachment,
  downloadWorkspaceFile,
  encodeBase64,
  isPdfMagic,
  MAX_TEXT_PREVIEW_BYTES,
  pickDocument,
  safeUploadContentType,
  sanitizeUploadFileName,
  writeCachedBinary,
} from "./binaryFiles";

beforeEach(() => {
  files.clear();
  dirs.clear();
  deletedDirs.length = 0;
  beforeFileWrite = null;
  mockFileSizeOverride = undefined;
  bytesReadCount = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("binary preview classification and safety", () => {
  it("verifies %PDF- magic bytes and rejects spoofed PDFs", () => {
    const validPdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
    const spoofedHtmlPdf = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const shortPdf = new TextEncoder().encode("%PDF");
    expect(isPdfMagic(validPdf)).toBe(true);
    expect(isPdfMagic(spoofedHtmlPdf)).toBe(false);
    expect(isPdfMagic(shortPdf)).toBe(false);
    expect(classifyFilePreview("invoice.pdf", validPdf)).toEqual({ kind: "pdf" });
    expect(classifyFilePreview("invoice.PDF", spoofedHtmlPdf)).toEqual({ kind: "other" });
  });

  it("never classifies SVG or HTML as executable image or inline text preview", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    );
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    for (const name of [
      "icon.svg",
      "ICON.SVG",
      "icon.svgz",
      "page.html",
      "page.htm",
      "page.xhtml",
    ]) {
      expect(classifyFilePreview(name, name.includes("svg") ? svg : html), name).toEqual({
        kind: "other",
      });
    }
    expect(classifyFilePreview("photo.png", new Uint8Array([137, 80, 78, 71]))).toEqual({
      kind: "image",
    });
    expect(classifyFilePreview("photo.HEIC", new Uint8Array([0, 0, 0, 24]))).toEqual({
      kind: "image",
    });
  });

  it("caps plain-text inline preview at 512 KiB and rejects invalid UTF-8 or NUL bytes", () => {
    const exact = new Uint8Array(MAX_TEXT_PREVIEW_BYTES).fill(0x61);
    const over = new Uint8Array(MAX_TEXT_PREVIEW_BYTES + 1).fill(0x61);
    const withNul = new Uint8Array([0x61, 0x00, 0x62]);
    const badUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(classifyFilePreview("notes.txt", exact)).toEqual({
      kind: "text",
      text: "a".repeat(MAX_TEXT_PREVIEW_BYTES),
    });
    expect(classifyFilePreview("notes.txt", over)).toEqual({ kind: "other", reason: "too-large" });
    expect(classifyFilePreview("notes.txt", withNul)).toEqual({ kind: "other" });
    expect(classifyFilePreview("notes.txt", badUtf8)).toEqual({ kind: "other" });
  });

  it("sanitizes upload names and falls back to octet-stream when signature mismatches", () => {
    expect(sanitizeUploadFileName("receipt.pdf")).toBe("receipt.pdf");
    expect(sanitizeUploadFileName("folder/photo.png")).toBe("photo.png");
    for (const bad of [
      "note.md",
      "Note.MD",
      "guide.markdown",
      "board.excalidraw",
      "collection.yaml",
      "dataset.json",
      "schema.sql",
      "operations.js",
      "automations.yaml",
      ".env",
      ".dohc-folder",
      "CON.png",
      "",
    ]) {
      expect(sanitizeUploadFileName(bad), bad).toBeNull();
    }
    expect(
      safeUploadContentType("image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    ).toBe("image/png");
    expect(safeUploadContentType("image/png", new TextEncoder().encode("not a png"))).toBe(
      "application/octet-stream",
    );
    expect(safeUploadContentType("application/pdf", new TextEncoder().encode("%PDF-1.4"))).toBe(
      "application/pdf",
    );
    expect(safeUploadContentType("application/pdf", new TextEncoder().encode("<html>"))).toBe(
      "application/octet-stream",
    );
  });
});

describe("binary cache hygiene on Sign out and sign-in changes", () => {
  it("wipes the scoped cache directory on Sign out and on 401 sign-in end, and discards late writes racing clear", async () => {
    const cached = await writeCachedBinary("receipt.pdf", new Uint8Array([1, 2, 3]));
    expect(cached).not.toBeNull();
    expect(cached!.uri).toMatch(new RegExp(`^file:///cache/${BINARY_CACHE_DIR}/.*\\.pdf$`));
    expect(files.has(cached!.uri)).toBe(true);

    const server = testServer();
    serveSessionEnd(server);
    const store = memoryStore({
      origin: server.origin,
      token: "tok-secret",
      userId: "u1",
      email: "a@example.com",
    });
    const account = createAccount({
      store: store.store,
      fetch: server.fetch,
      onSignOut: async (leave) => {
        clearBinaryFileCache();
        await leave();
      },
    });
    await account.restore();
    const stop = clearBinaryCacheOnSignInChange(account);
    try {
      await account.signOut();
      expect(deletedDirs).toContain(`file:///cache/${BINARY_CACHE_DIR}`);
      expect(files.size).toBe(0);
    } finally {
      stop();
    }

    const second = await writeCachedBinary("diagram.png", new Uint8Array([4, 5, 6]));
    expect(second).not.toBeNull();
    expect(files.has(second!.uri)).toBe(true);
    let state: AccountState = {
      status: "signed-in",
      signIn: {
        origin: "https://dohc.example.com",
        userId: "u1",
        email: "a@example.com",
        client: {} as never,
        accountName: async () => null,
        isCurrent: () => true,
      },
    };
    const listeners = new Set<() => void>();
    const unsub = clearBinaryCacheOnSignInChange({
      state: () => state,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    });
    state = {
      status: "signed-out",
      origin: "https://dohc.example.com",
      ended: true,
      forgetFailed: false,
      pendingSignOut: null,
    };
    for (const fn of listeners) fn();
    unsub();
    expect(files.size).toBe(0);

    beforeFileWrite = () => {
      beforeFileWrite = null;
      clearBinaryFileCache();
    };
    const raced = await writeCachedBinary("secret.pdf", new Uint8Array([9, 9, 9]));
    expect(raced).toBeNull();
    expect(files.size).toBe(0);

    beforeFileWrite = (uri) => {
      beforeFileWrite = null;
      clearBinaryFileCache();
      dirs.add(`file:///cache/${BINARY_CACHE_DIR}`);
      files.set(uri, new Uint8Array([9]));
      throw new Error("ENOSPC");
    };
    await expect(writeCachedBinary("partial.pdf", new Uint8Array([9, 9, 9]))).rejects.toThrow(
      "ENOSPC",
    );
    expect(files.size).toBe(0);
  });

  it("catches native document picker rejections and checks local file size before reading bytes", async () => {
    vi.mocked(DocumentPicker.getDocumentAsync).mockRejectedValueOnce(
      new Error("File provider failed to copy file"),
    );
    await expect(pickDocument(1024)).resolves.toEqual({ ok: false, reason: "unreadable" });

    files.set("file:///cache/picked.bin", new Uint8Array([1, 2, 3]));
    mockFileSizeOverride = 2048;
    vi.mocked(DocumentPicker.getDocumentAsync).mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: "picked.bin", uri: "file:///cache/picked.bin", lastModified: 1 }],
    });
    await expect(pickDocument(1024)).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(bytesReadCount).toBe(0);
    expect(files.has("file:///cache/picked.bin")).toBe(false);
  });
});

describe("Bearer-header-only binary downloads and idempotent upload retries", () => {
  it("sends Authorization Bearer header only (never in URL), omits cookies, rejects redirects, and handles 401", async () => {
    const server = testServer();
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\nhello");
    const rawInits: Array<Parameters<typeof server.fetch>[1]> = [];
    const spyingFetch: typeof server.fetch = (url, init) => {
      rawInits.push(init);
      return server.fetch(url, init);
    };
    let signedOut = 0;
    const controller = new AbortController();
    const client = createServerClient({
      origin: server.origin,
      token: "secret-bearer-token-123",
      fetch: spyingFetch,
      signal: controller.signal,
      onSignedOut: () => {
        signedOut += 1;
      },
    });

    server.on("GET", "/sync/w1/ops/fileBytes?path=docs%2Freport.pdf", {
      status: 200,
      bytes: pdfBytes,
      headers: {
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
    const gotFile = await downloadWorkspaceFile(client, "w1", "docs/report.pdf");
    expect(gotFile).toEqual(pdfBytes);
    expect(server.calls[0]!.path).not.toContain("secret-bearer-token-123");
    expect(server.calls[0]!.headers.authorization).toBe("Bearer secret-bearer-token-123");
    expect(rawInits[0]!.credentials).toBe("omit");
    expect(rawInits[0]!.redirect).toBe("error");

    server.on("POST", "/sync/w1/ops/collectionAttachmentRead", {
      status: 200,
      bytes: pdfBytes,
    });
    const gotAttachment = await downloadCollectionAttachment(client, "w1", {
      datasetId: "ds-1",
      tableId: "tb-1",
      recordId: "r-1",
      fieldId: "f-1",
      fileId: "file-1234567890abcdef",
    });
    expect(gotAttachment).toEqual(pdfBytes);
    expect(server.calls[1]!.path).not.toContain("secret-bearer-token-123");
    expect(server.calls[1]!.headers.authorization).toBe("Bearer secret-bearer-token-123");
    expect(rawInits[1]!.credentials).toBe("omit");
    expect(rawInits[1]!.redirect).toBe("error");

    server.on("GET", "/sync/w1/ops/fileBytes?path=expired.bin", { status: 401, body: {} });
    await expect(downloadWorkspaceFile(client, "w1", "expired.bin")).rejects.toMatchObject({
      problem: "signed-out",
      status: 401,
    } satisfies Partial<ServerError>);
    expect(signedOut).toBe(1);
  });

  it("preserves requestId and idempotencyKey across retries for workspace and attachment uploads", async () => {
    const server = testServer();
    const controller = new AbortController();
    const client = createServerClient({
      origin: server.origin,
      token: "tok",
      fetch: server.fetch,
      signal: controller.signal,
    });
    const payload = {
      path: "photo.png",
      requestId: "req-fixed-1",
      bytesBase64: encodeBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    };
    server.on("POST", "/sync/w1/ops/uploadFile", "offline", {
      status: 200,
      body: { ok: true, result: { ok: true, path: "photo.png", objectId: "obj-1" } },
    });
    const ops = fileWriteOperations(client, "w1");
    await expect(ops.uploadFile(payload)).rejects.toMatchObject({ problem: "offline" });
    await expect(ops.uploadFile(payload)).resolves.toEqual({
      ok: true,
      path: "photo.png",
      objectId: "obj-1",
    });
    expect(server.calls[0]!.body).toEqual(payload);
    expect(server.calls[1]!.body).toEqual(payload);

    const attachmentPayload = {
      datasetId: "ds-1",
      tableId: "tb-1",
      fieldId: "f-1",
      revision: 1,
      revisionSha256: "a".repeat(64),
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      name: "receipt.pdf",
      contentType: "application/pdf",
      bytesBase64: encodeBase64(new TextEncoder().encode("%PDF-1.7")),
    };
    server.on("POST", "/sync/w1/ops/collectionAttachmentUpload", "offline", {
      status: 200,
      body: {
        ok: true,
        result: {
          file: {
            fileId: "file-1234567890abcdef",
            name: "receipt.pdf",
            contentType: "application/pdf",
            byteLength: 8,
            sha256: "b".repeat(64),
          },
          replayed: true,
        },
      },
    });
    const colOps = collectionOperations(client, "w1", controller.signal);
    await expect(colOps.uploadAttachment(attachmentPayload)).rejects.toMatchObject({
      problem: "offline",
    });
    const uploaded = await colOps.uploadAttachment(attachmentPayload);
    expect(uploaded).toMatchObject({
      kind: "uploaded",
      replayed: true,
      file: { fileId: "file-1234567890abcdef", name: "receipt.pdf" },
    });
    expect(server.calls[2]!.body).toEqual(attachmentPayload);
    expect(server.calls[3]!.body).toEqual(attachmentPayload);
  });
});

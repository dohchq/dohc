import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecretFileStore, VersionedTextStore } from "@dohc/workspace-contracts/engine";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  MAX_SECRET_FILE_BYTES,
  SECRET_FILE_STORE_RELATIVE_PATH,
  SECRET_KEY_RELATIVE_PATH,
  SecretFileStoreError,
  createSecretFileStore,
} from "./secretFileStore";
import { VersionedTextStoreError, createVersionedTextStore } from "./versionedTextStore";
import { createLinkedChatStore } from "./linkedChatStore";
import { searchWorkspaceEngine } from "./workspaceSearch";

interface RawSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface RawSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawSqliteDb;
};

const WORKSPACE_ID = "workspace-1";
// The adversarial plaintext marker: if these bytes ever appear anywhere in
// engine.db (or its WAL), the secret boundary is broken.
const MARKER = "SUPER_SECRET_MARKER_9f8e7d6c";
const ENV_TEXT = `API_KEY=${MARKER}\nDB_URL=postgres://localhost/db\n`;

let root: string;
let now = 1000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-secret-store-"));
  now = 1000;
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

function textStore(): VersionedTextStore {
  const counters = { conflict: 0, moment: 0, object: 0, version: 0 };
  return createVersionedTextStore(root, {
    nowMs: () => {
      now += 10;
      return now;
    },
    createId: (kind) => {
      counters[kind] += 1;
      return `${kind}-${counters[kind]}`;
    },
  });
}

function secretStore(): SecretFileStore {
  let momentCounter = 0;
  return createSecretFileStore(root, {
    nowMs: () => {
      now += 10;
      return now;
    },
    createId: () => {
      momentCounter += 1;
      return `secret-moment-${momentCounter}`;
    },
  });
}

async function withStores(
  task: (stores: { texts: VersionedTextStore; secrets: SecretFileStore }) => Promise<void>,
): Promise<void> {
  const texts = textStore();
  const secrets = secretStore();
  try {
    await texts.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    await task({ texts, secrets });
  } finally {
    await secrets.close();
    await texts.close();
  }
}

async function engineDbBytes(): Promise<Buffer> {
  const base = join(root, SECRET_FILE_STORE_RELATIVE_PATH);
  const chunks: Buffer[] = [];
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      chunks.push(await readFile(path));
    } catch {
      // Absent WAL/SHM files simply don't contribute bytes.
    }
  }
  return Buffer.concat(chunks);
}

function rawDb(): RawSqliteDb {
  return new DatabaseSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH));
}

describe("secretFileStore encryption", () => {
  it("round-trips secret content through the single authorized materialization", async () => {
    await withStores(async ({ secrets }) => {
      const write = await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file", summary: "Updated .env" },
      });
      expect(write.changed).toBe(true);
      expect(write.moment?.protected).toBe(true);
      const materialized = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(materialized).toEqual({ present: true, text: ENV_TEXT });
    });
  });

  it("ADVERSARIAL: no plaintext marker anywhere in engine.db bytes (db + wal + shm)", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file", summary: "Updated .env" },
      });
      // Also exercise delete + rewrite so moments accumulate.
      await secrets.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
    });
    const bytes = await engineDbBytes();
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
    // Defense-in-depth: neither UTF-16 nor base64 encodings of the marker
    // (base64 of the ciphertext could never contain it, but a buggy
    // implementation that base64ed PLAINTEXT would).
    expect(bytes.includes(Buffer.from(MARKER, "utf16le"))).toBe(false);
    expect(
      bytes.includes(Buffer.from(Buffer.from(ENV_TEXT, "utf8").toString("base64"), "utf8")),
    ).toBe(false);
  });

  it("uses a fresh random IV per write (same plaintext re-encrypted differs)", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: "OTHER=1\n",
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
    });
    const db = rawDb();
    try {
      const rows = db
        .prepare(
          "SELECT after_iv_base64, after_ciphertext_base64 FROM secret_moments WHERE after_present = 1 ORDER BY moment_order",
        )
        .all();
      expect(rows.length).toBe(3);
      // First and third writes hold the SAME plaintext but must differ at rest.
      expect(rows[0].after_iv_base64).not.toBe(rows[2].after_iv_base64);
      expect(rows[0].after_ciphertext_base64).not.toBe(rows[2].after_ciphertext_base64);
    } finally {
      db.close();
    }
  });

  it("fails closed when the ciphertext is tampered (auth tag mismatch)", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
    });
    const db = rawDb();
    try {
      const row = db.prepare("SELECT ciphertext_base64 FROM secret_files").get();
      const bytes = Buffer.from(String(row?.ciphertext_base64), "base64");
      bytes[0] = bytes[0] ^ 0xff;
      db.prepare("UPDATE secret_files SET ciphertext_base64 = ?").run(bytes.toString("base64"));
    } finally {
      db.close();
    }
    const secrets = secretStore();
    try {
      await expect(
        secrets.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
        }),
      ).rejects.toMatchObject({ code: "decrypt-failed" });
    } finally {
      await secrets.close();
    }
  });

  it("fails closed when ciphertext rows are spliced across paths (AAD binding)", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "prod.env",
        text: "PROD=1\n",
        metadata: { origin: "local-file" },
      });
    });
    const db = rawDb();
    try {
      const row = db
        .prepare("SELECT iv_base64, auth_tag_base64, ciphertext_base64 FROM secret_files WHERE path = '.env'")
        .get();
      db.prepare(
        "UPDATE secret_files SET iv_base64 = ?, auth_tag_base64 = ?, ciphertext_base64 = ? WHERE path = 'prod.env'",
      ).run(String(row?.iv_base64), String(row?.auth_tag_base64), String(row?.ciphertext_base64));
    } finally {
      db.close();
    }
    const secrets = secretStore();
    try {
      await expect(
        secrets.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "prod.env",
        }),
      ).rejects.toMatchObject({ code: "decrypt-failed" });
    } finally {
      await secrets.close();
    }
  });

  it("fails closed under a wrong key (never returns garbage plaintext)", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
    });
    // Replace the key with a DIFFERENT well-formed key.
    const wrongKey = Buffer.alloc(32, 7).toString("base64");
    await writeFile(join(root, SECRET_KEY_RELATIVE_PATH), `dohc-secret-key-v1:${wrongKey}\n`, {
      mode: 0o600,
    });
    const secrets = secretStore();
    try {
      await expect(
        secrets.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
        }),
      ).rejects.toMatchObject({ code: "decrypt-failed" });
    } finally {
      await secrets.close();
    }
  });
});

describe("secretFileStore key custody", () => {
  it("creates the per-workspace key file on first secret capture with owner-only mode", async () => {
    await withStores(async ({ secrets }) => {
      const keyPath = join(root, SECRET_KEY_RELATIVE_PATH);
      await expect(stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const info = await stat(keyPath);
      if (process.platform === "win32") {
        // Windows has no POSIX modes: the 0o600 create mode is ignored and
        // protection comes from the workspace directory's inherited NTFS
        // ACLs. The store's chmod healing is a guarded no-op there.
        expect(info.isFile()).toBe(true);
      } else {
        expect(info.mode & 0o777).toBe(0o600);
      }
      const content = await readFile(keyPath, "utf8");
      expect(content.startsWith("dohc-secret-key-v1:")).toBe(true);
      // The key file must not contain the secret itself.
      expect(content.includes(MARKER)).toBe(false);
    });
  });

  it("reuses the same key across store instances", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
    });
    const reopened = secretStore();
    try {
      const materialized = await reopened.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(materialized).toEqual({ present: true, text: ENV_TEXT });
    } finally {
      await reopened.close();
    }
  });

  it("fails closed on a malformed key file instead of regenerating over it", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
    });
    const keyPath = join(root, SECRET_KEY_RELATIVE_PATH);
    const original = await readFile(keyPath, "utf8");
    await writeFile(keyPath, "garbage-not-a-key\n", { mode: 0o600 });
    const secrets = secretStore();
    try {
      await expect(
        secrets.writeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
          text: "NEW=1\n",
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "key-corrupt" });
      // The malformed file must be left untouched (never regenerated).
      expect(await readFile(keyPath, "utf8")).toBe("garbage-not-a-key\n");
      expect(await readFile(keyPath, "utf8")).not.toBe(original);
    } finally {
      await secrets.close();
    }
  });

  it("fails closed when the key file is missing but protected data exists", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
    });
    await rm(join(root, SECRET_KEY_RELATIVE_PATH));
    const secrets = secretStore();
    try {
      await expect(
        secrets.materializeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
        }),
      ).rejects.toMatchObject({ code: "key-corrupt" });
      // The WRITE path must fail closed too — never mint a fresh key beside
      // rows sealed under the lost one (that would silently orphan them).
      await expect(
        secrets.writeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "other.env",
          text: "NEW=1\n",
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "key-corrupt" });
      await expect(stat(join(root, SECRET_KEY_RELATIVE_PATH))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await secrets.close();
    }
  });
});

describe("secretFileStore metadata-only surfaces", () => {
  it("moments and stats are metadata-only: no plaintext reaches any non-materialize result", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file", summary: "Updated .env" },
      });
      await secrets.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        metadata: { origin: "local-file", summary: "Deleted .env" },
      });
      const write = await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file", summary: "Updated .env" },
      });
      const moments = await secrets.listSecretMoments({ workspaceId: WORKSPACE_ID });
      const files = await secrets.listSecretFiles({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
      });
      const one = await secrets.getSecretMoment({
        workspaceId: WORKSPACE_ID,
        momentId: write.moment?.id ?? "",
      });
      const restore = await secrets.restoreSecretFileToBeforeMoment({
        workspaceId: WORKSPACE_ID,
        momentId: write.moment?.id ?? "",
        metadata: { origin: "restore", summary: "Restored .env" },
      });
      const compare = await secrets.compareSecretFileVersions({
        workspaceId: WORKSPACE_ID,
        targetVersionId: "main",
        sourceVersionId: "main",
      });
      // The COMPLETE set of non-materialize outputs, serialized: the marker
      // must not appear anywhere.
      const serialized = JSON.stringify({ write, moments, files, one, restore, compare });
      expect(serialized.includes(MARKER)).toBe(false);
      expect(moments.length).toBeGreaterThan(0);
      expect(moments[0].metadata.summary).toBeDefined();
      // The moment type has no content field at all.
      for (const moment of moments) {
        expect("text" in moment).toBe(false);
        expect("payload" in moment).toBe(false);
      }
    });
  });

  it("refuses non-secret paths (fail closed both directions)", async () => {
    await withStores(async ({ secrets }) => {
      await expect(
        secrets.writeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "notes.md",
          text: "hello",
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "not-secret-path" });
    });
  });

  it("classifies percent-encoded .env paths as secret (floor parity)", async () => {
    await withStores(async ({ secrets }) => {
      const write = await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "secrets%2eenv",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      expect(write.changed).toBe(true);
      // Stored under the DECODED path.
      expect(write.moment?.path).toBe("secrets.env");
    });
  });

  it("enforces the size cap and UTF-8 round-trip", async () => {
    await withStores(async ({ secrets }) => {
      await expect(
        secrets.writeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
          text: "x".repeat(MAX_SECRET_FILE_BYTES + 1),
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "invalid-text" });
      await expect(
        secrets.writeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
          text: "bad\udc00surrogate",
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "invalid-text" });
    });
  });

  it("rejects unknown versions (fail closed)", async () => {
    await withStores(async ({ secrets }) => {
      await expect(
        secrets.writeSecretFile({
          workspaceId: WORKSPACE_ID,
          versionId: "nope",
          path: ".env",
          text: ENV_TEXT,
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "invalid-version" });
    });
  });

  it("suppresses no-op writes (content equality) like the text store", async () => {
    await withStores(async ({ secrets }) => {
      const first = await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const second = await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      const moments = await secrets.listSecretMoments({ workspaceId: WORKSPACE_ID });
      expect(moments.length).toBe(1);
    });
  });
});

describe("secretFileStore versions", () => {
  async function createNamedVersion(
    texts: VersionedTextStore,
    secrets: SecretFileStore,
    name: string,
  ): Promise<string> {
    const version = await texts.createNamedVersion({
      workspaceId: WORKSPACE_ID,
      name,
      fromVersionId: "main",
    });
    await secrets.forkVersion({
      workspaceId: WORKSPACE_ID,
      fromVersionId: "main",
      toVersionId: version.id,
    });
    return version.id;
  }

  it("forks copy secret tips so secrets follow versions", async () => {
    await withStores(async ({ texts, secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const versionId = await createNamedVersion(texts, secrets, "Experiment");
      const materialized = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: ".env",
      });
      expect(materialized).toEqual({ present: true, text: ENV_TEXT });
      // Diverge the fork; Main must keep its own copy.
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: ".env",
        text: "EXPERIMENT=1\n",
        metadata: { origin: "local-file" },
      });
      const main = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(main).toEqual({ present: true, text: ENV_TEXT });
    });
  });

  it("compares versions metadata-only", async () => {
    await withStores(async ({ texts, secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const versionId = await createNamedVersion(texts, secrets, "Experiment");
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: ".env",
        text: "CHANGED=1\n",
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: "extra.env",
        text: "EXTRA=1\n",
        metadata: { origin: "local-file" },
      });
      const entries = await secrets.compareSecretFileVersions({
        workspaceId: WORKSPACE_ID,
        targetVersionId: "main",
        sourceVersionId: versionId,
      });
      expect(entries).toEqual([
        { path: ".env", status: "modified" },
        { path: "extra.env", status: "added" },
      ]);
      expect(JSON.stringify(entries).includes(MARKER)).toBe(false);
    });
  });

  it("treats re-encrypted identical plaintext as same in comparisons", async () => {
    await withStores(async ({ texts, secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const versionId = await createNamedVersion(texts, secrets, "Experiment");
      // Rewrite the same content in the fork: fresh IV, same plaintext.
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: ".env",
        text: "TEMP=1\n",
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const entries = await secrets.compareSecretFileVersions({
        workspaceId: WORKSPACE_ID,
        targetVersionId: "main",
        sourceVersionId: versionId,
      });
      expect(entries).toEqual([]);
    });
  });

  it("merges a changed secret from a version into Main (incoming wins, history preserved)", async () => {
    await withStores(async ({ texts, secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const versionId = await createNamedVersion(texts, secrets, "Experiment");
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: ".env",
        text: "MERGED=1\n",
        metadata: { origin: "local-file" },
      });
      const applied = await secrets.applySecretFileFromVersion({
        workspaceId: WORKSPACE_ID,
        targetVersionId: "main",
        sourceVersionId: versionId,
        path: ".env",
        metadata: { origin: "api", summary: 'Updated .env from version "Experiment"' },
      });
      expect(applied.changed).toBe(true);
      const main = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(main).toEqual({ present: true, text: "MERGED=1\n" });
      // Main's previous state stays restorable one protected moment back.
      const restore = await secrets.restoreSecretFileToBeforeMoment({
        workspaceId: WORKSPACE_ID,
        momentId: applied.moment?.id ?? "",
        metadata: { origin: "restore", summary: "Restored .env" },
      });
      expect(restore.restored).toBe("text");
      const restored = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(restored).toEqual({ present: true, text: ENV_TEXT });
    });
  });

  it("does not delete or overwrite a secret Main gained after the fork (fork-base rule)", async () => {
    await withStores(async ({ texts, secrets }) => {
      const versionId = await createNamedVersion(texts, secrets, "Experiment");
      // Main gains .env AFTER the fork; the fork never had it.
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const applied = await secrets.applySecretFileFromVersion({
        workspaceId: WORKSPACE_ID,
        targetVersionId: "main",
        sourceVersionId: versionId,
        path: ".env",
        metadata: { origin: "api" },
      });
      expect(applied.changed).toBe(false);
      const main = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(main).toEqual({ present: true, text: ENV_TEXT });
    });
  });

  it("merges a deletion made in the version (changed relative to fork base)", async () => {
    await withStores(async ({ texts, secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const versionId = await createNamedVersion(texts, secrets, "Experiment");
      await secrets.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId,
        path: ".env",
        metadata: { origin: "local-file" },
      });
      const applied = await secrets.applySecretFileFromVersion({
        workspaceId: WORKSPACE_ID,
        targetVersionId: "main",
        sourceVersionId: versionId,
        path: ".env",
        metadata: { origin: "api" },
      });
      expect(applied.changed).toBe(true);
      expect(applied.moment?.operation).toBe("delete");
      const main = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(main).toEqual({ present: false });
    });
  });

  it("restores through the encrypted path (delete moments restore the prior content)", async () => {
    await withStores(async ({ secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const deleted = await secrets.deleteSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        metadata: { origin: "local-file" },
      });
      const restore = await secrets.restoreSecretFileToBeforeMoment({
        workspaceId: WORKSPACE_ID,
        momentId: deleted.moment?.id ?? "",
        metadata: { origin: "restore", summary: "Restored .env" },
      });
      expect(restore.restored).toBe("text");
      const materialized = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(materialized).toEqual({ present: true, text: ENV_TEXT });
      // Restoring to before the CREATING moment removes the file.
      const moments = await secrets.listSecretMoments({ workspaceId: WORKSPACE_ID });
      const creating = moments[moments.length - 1];
      const undo = await secrets.restoreSecretFileToBeforeMoment({
        workspaceId: WORKSPACE_ID,
        momentId: creating.id,
        metadata: { origin: "restore", summary: "Restored .env" },
      });
      expect(undo.restored).toBe("deleted");
      const afterUndo = await secrets.materializeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
      });
      expect(afterUndo).toEqual({ present: false });
    });
  });
});

describe("plaintext-store floor (policy can never unmark)", () => {
  it("versionedTextStore refuses to store a secret-classified path as plaintext", async () => {
    const texts = textStore();
    try {
      await texts.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await expect(
        texts.writeTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: ".env",
          text: ENV_TEXT,
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      await expect(
        texts.writeTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "config/production.env",
          text: ENV_TEXT,
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      // Percent-encoded evasion is normalized first.
      await expect(
        texts.writeTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "secrets%2eenv",
          text: ENV_TEXT,
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
    } finally {
      await texts.close();
    }
  });

  it("versionedTextStore refuses renaming a tracked file ONTO a secret path", async () => {
    const texts = textStore();
    try {
      await texts.ensureMainVersion({ workspaceId: WORKSPACE_ID });
      await texts.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "notes.md",
        text: "hello",
        metadata: { origin: "local-file" },
      });
      await expect(
        texts.renameTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          fromPath: "notes.md",
          toPath: ".env",
          metadata: { origin: "local-file" },
        }),
      ).rejects.toMatchObject({ code: "invalid-path" });
      expect(
        await texts.readTextFile({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          path: "notes.md",
        }),
      ).not.toBeNull();
    } finally {
      await texts.close();
    }
  });

  it("error classes stay distinct", () => {
    expect(new SecretFileStoreError("invalid-input", "x")).toBeInstanceOf(Error);
    expect(new VersionedTextStoreError("invalid-input", "x")).toBeInstanceOf(Error);
  });
});

describe("search cannot surface secret content", () => {
  it("engine search returns nothing for secret content even with a permissive policy", async () => {
    await withStores(async ({ texts, secrets }) => {
      await texts.writeTextFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "notes.md",
        text: "ordinary findable text",
        metadata: { origin: "local-file" },
      });
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file" },
      });
      const chats = createLinkedChatStore(root);
      try {
        const forMarker = await searchWorkspaceEngine({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          query: MARKER,
          versions: texts,
          chats,
          // A malicious/buggy policy claiming everything searchable must not
          // resurrect secret content: it is simply not reachable by search.
          policy: { fileVisibility: () => ({ searchable: true }) },
        });
        expect(forMarker).toEqual([]);
        const forText = await searchWorkspaceEngine({
          workspaceId: WORKSPACE_ID,
          versionId: "main",
          query: "findable",
          versions: texts,
          chats,
        });
        expect(forText.length).toBe(1);
      } finally {
        await chats.close();
      }
    });
  });

  it("the floor drops a .env snapshot even if a (corrupt/legacy) text store returns one", async () => {
    // Simulates a store that somehow holds a secret path (predates the write
    // gate): the search floor must still exclude it, and a permissive policy
    // must not override the floor (baseline visibility wins).
    const fakeTexts = {
      async listTextFiles() {
        return [
          {
            objectId: "object-1",
            versionId: "main",
            path: ".env",
            text: ENV_TEXT,
            updatedAtMs: 1,
            latestMomentId: "moment-1",
            metadata: { origin: "local-file" as const },
          },
        ];
      },
    } as unknown as VersionedTextStore;
    const fakeChats = {
      async listThreads() {
        return [];
      },
    } as unknown as Parameters<typeof searchWorkspaceEngine>[0]["chats"];
    const results = await searchWorkspaceEngine({
      workspaceId: WORKSPACE_ID,
      versionId: "main",
      query: MARKER,
      versions: fakeTexts,
      chats: fakeChats,
      policy: { fileVisibility: () => ({ searchable: true }) },
    });
    expect(results).toEqual([]);
  });
});

describe("no plaintext accessor except materializeSecretFile", () => {
  it("every store method except materializeSecretFile is content-free", async () => {
    await withStores(async ({ texts, secrets }) => {
      await secrets.writeSecretFile({
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        text: ENV_TEXT,
        metadata: { origin: "local-file", summary: "Updated .env" },
      });
      const version = await texts.createNamedVersion({
        workspaceId: WORKSPACE_ID,
        name: "Probe",
        fromVersionId: "main",
      });
      await secrets.forkVersion({
        workspaceId: WORKSPACE_ID,
        fromVersionId: "main",
        toVersionId: version.id,
      });
      // Enumerate the REAL API surface so a newly added accessor cannot dodge
      // this test by not being listed here.
      const methodNames = Object.keys(secrets) as Array<keyof SecretFileStore>;
      expect(methodNames).toContain("materializeSecretFile");
      const outputs: unknown[] = [];
      for (const name of methodNames) {
        if (name === "materializeSecretFile" || name === "close") continue;
        switch (name) {
          case "writeSecretFile":
            outputs.push(
              await secrets.writeSecretFile({
                workspaceId: WORKSPACE_ID,
                versionId: "main",
                path: ".env",
                text: ENV_TEXT,
                metadata: { origin: "local-file" },
              }),
            );
            break;
          case "deleteSecretFile":
            outputs.push(
              await secrets.deleteSecretFile({
                workspaceId: WORKSPACE_ID,
                versionId: version.id,
                path: ".env",
                metadata: { origin: "local-file" },
              }),
            );
            break;
          case "listSecretFiles":
            outputs.push(
              await secrets.listSecretFiles({ workspaceId: WORKSPACE_ID, versionId: "main" }),
            );
            break;
          case "listSecretMoments":
            outputs.push(await secrets.listSecretMoments({ workspaceId: WORKSPACE_ID }));
            break;
          case "getSecretMoment": {
            const moments = await secrets.listSecretMoments({ workspaceId: WORKSPACE_ID });
            outputs.push(
              await secrets.getSecretMoment({
                workspaceId: WORKSPACE_ID,
                momentId: moments[0]?.id ?? "",
              }),
            );
            break;
          }
          case "forkVersion":
            outputs.push(
              await secrets.forkVersion({
                workspaceId: WORKSPACE_ID,
                fromVersionId: "main",
                toVersionId: version.id,
              }),
            );
            break;
          case "compareSecretFileVersions":
            outputs.push(
              await secrets.compareSecretFileVersions({
                workspaceId: WORKSPACE_ID,
                targetVersionId: "main",
                sourceVersionId: version.id,
              }),
            );
            break;
          case "applySecretFileFromVersion":
            outputs.push(
              await secrets.applySecretFileFromVersion({
                workspaceId: WORKSPACE_ID,
                targetVersionId: "main",
                sourceVersionId: version.id,
                path: ".env",
                metadata: { origin: "api" },
              }),
            );
            break;
          case "applyReplicationOp": {
            const db = rawDb();
            try {
              const row = db
                .prepare(
                  `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
                   FROM replication_log
                   WHERE workspace_id = ?
                   ORDER BY origin_seq
                   LIMIT 1`,
                )
                .get(WORKSPACE_ID);
              outputs.push(
                await secrets.applyReplicationOp({
                  workspaceId: String(row?.workspace_id),
                  originId: String(row?.origin_id),
                  originSeq: Number(row?.origin_seq),
                  opKind: String(row?.op_kind) as never,
                  payload: JSON.parse(String(row?.payload_json)) as never,
                  recordedAtMs: Number(row?.recorded_at_ms),
                }),
              );
            } finally {
              db.close();
            }
            break;
          }
          case "restoreSecretFileToBeforeMoment": {
            const moments = await secrets.listSecretMoments({ workspaceId: WORKSPACE_ID });
            outputs.push(
              await secrets.restoreSecretFileToBeforeMoment({
                workspaceId: WORKSPACE_ID,
                momentId: moments[0]?.id ?? "",
                metadata: { origin: "restore" },
              }),
            );
            break;
          }
          default: {
            // A method this test does not know how to call is a NEW API
            // surface: fail loudly so it gets an explicit leak review.
            const exhaustive: never = name;
            throw new Error(`Unreviewed secret store method: ${String(exhaustive)}`);
          }
        }
      }
      expect(JSON.stringify(outputs).includes(MARKER)).toBe(false);
    });
  });
});

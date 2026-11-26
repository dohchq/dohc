import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  MAX_SECRET_ALLOWED_HOSTS,
  MAX_WORKSPACE_SECRETS,
  normalizeSecretAllowedHost,
  validateSecretHeaderValue,
  validateSecretHttpUrl,
  WorkspaceSecretName,
  WorkspaceSecretWriteInput,
  type WorkspaceSecretSummary,
} from "@dohc/workspace-contracts/workspace-secrets";
import { atomicReplaceFile } from "../atomicReplaceFile";
import type { TokenCipher } from "./cloudCredentialStore";
import { openJson, SealedJson, sealJson } from "./localSealedJson";

const VAULT_AAD_TAG = "dohc-local-workspace-secrets-v2";

const StoredEntryBase = {
  value: z.string().min(1),
  generation: z.number().int().min(1),
  createdAtMs: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0),
};

const StoredSecretEntry = z.discriminatedUnion("usage", [
  z
    .object({
      ...StoredEntryBase,
      usage: z.literal("http-header"),
      allowedHosts: z
        .array(z.string())
        .min(1)
        .max(MAX_SECRET_ALLOWED_HOSTS)
        .refine(
          (hosts) =>
            hosts.every((host) => normalizeSecretAllowedHost(host) === host) &&
            new Set(hosts).size === hosts.length,
        ),
    })
    .strict(),
  z
    .object({
      ...StoredEntryBase,
      usage: z.literal("http-url"),
      allowedHosts: z.array(z.string()).length(0),
    })
    .strict(),
]);

const StoredEntries = z
  .record(z.string(), StoredSecretEntry)
  .refine(
    (entries) =>
      Object.keys(entries).length <= MAX_WORKSPACE_SECRETS &&
      Object.entries(entries).every(
        ([name, entry]) =>
          WorkspaceSecretName.safeParse(name).success &&
          (entry.usage === "http-header"
            ? validateSecretHeaderValue(entry.value)
            : validateSecretHttpUrl(entry.value) !== null),
      ),
  );

const StoredWorkspaceSecretFile = z
  .object({
    version: z.literal(2),
    workspaceId: z.string().min(1),
    sealed: SealedJson,
  })
  .strict();

type StoredFile = { entries: z.output<typeof StoredEntries> };

export class WorkspaceSecretStorageUnavailableError extends Error {
  constructor() {
    super(
      "This computer's system keychain is unavailable, so dohc cannot save workspace secrets here.",
    );
    this.name = "WorkspaceSecretStorageUnavailableError";
  }
}

export class WorkspaceSecretLimitError extends Error {
  constructor(count: number, limit: number) {
    super(
      `Workspace secret limit reached (${count} of ${limit} secrets). Delete an unused secret first.`,
    );
    this.name = "WorkspaceSecretLimitError";
  }
}

export class WorkspaceSecretVaultCorruptError extends Error {
  constructor(
    message = "This workspace's secrets on this computer are damaged or were changed outside dohc, so dohc won't use them. Delete them and add them again.",
  ) {
    super(message);
    this.name = "WorkspaceSecretVaultCorruptError";
  }
}

export class WorkspaceSecretVaultOutdatedError extends WorkspaceSecretVaultCorruptError {
  constructor() {
    super(
      "This workspace's secrets on this computer were saved by an older dohc and can't be checked for changes, so dohc won't use them. Delete them and add them again.",
    );
    this.name = "WorkspaceSecretVaultOutdatedError";
  }
}

export class WorkspaceSecretConflictError extends Error {
  constructor(name: string) {
    super(`A secret named ${name} already exists. Use Replace to update it.`);
    this.name = "WorkspaceSecretConflictError";
  }
}

export class WorkspaceSecretNotFoundError extends Error {
  constructor(name: string) {
    super(`Secret ${name} no longer exists.`);
    this.name = "WorkspaceSecretNotFoundError";
  }
}

export interface LocalWorkspaceSecretStore {
  canKeep(): boolean;
  list(workspaceId: string): Promise<WorkspaceSecretSummary[]>;
  set(workspaceId: string, input: WorkspaceSecretWriteInput): Promise<WorkspaceSecretSummary[]>;
  remove(workspaceId: string, name: string): Promise<WorkspaceSecretSummary[]>;
  readSecretForExecution(
    workspaceId: string,
    name: string,
  ): Promise<{ summary: WorkspaceSecretSummary; value: string } | null>;
  clearWorkspace(workspaceId: string): Promise<void>;
  hasSaved(workspaceId: string): Promise<boolean>;
}

function summarizeEntries(entries: StoredFile["entries"]): WorkspaceSecretSummary[] {
  return Object.entries(entries)
    .map(([name, entry]) => ({
      name,
      usage: entry.usage,
      allowedHosts: [...entry.allowedHosts],
      generation: entry.generation,
      createdAtMs: entry.createdAtMs,
      updatedAtMs: entry.updatedAtMs,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function createLocalWorkspaceSecretStore(options: {
  readonly dir: string;
  readonly cipher?: TokenCipher;
  readonly nowMs?: () => number;
}): LocalWorkspaceSecretStore {
  const rootDir = join(options.dir, "workspace-secrets");
  const nowMs = options.nowMs ?? Date.now;
  const canKeep = () => options.cipher?.isAvailable() === true;
  let last: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const done = last.then(work, work);
    last = done.catch(() => undefined);
    return done;
  };

  const fileFor = (workspaceId: string) =>
    join(rootDir, `${createHash("sha256").update(workspaceId, "utf8").digest("hex")}.json`);

  const readFileOrEmpty = async (workspaceId: string): Promise<StoredFile> => {
    const file = fileFor(workspaceId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { entries: {} };
      }
      throw new WorkspaceSecretVaultCorruptError();
    }
    await chmod(file, 0o600).catch(() => undefined);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new WorkspaceSecretVaultCorruptError();
    }
    if (raw !== null && typeof raw === "object" && "version" in raw && raw.version === 1) {
      throw new WorkspaceSecretVaultOutdatedError();
    }
    try {
      const parsed = StoredWorkspaceSecretFile.parse(raw);
      if (parsed.workspaceId !== workspaceId) throw new WorkspaceSecretVaultCorruptError();
      const entries = StoredEntries.parse(
        openJson(options.cipher!, [VAULT_AAD_TAG, workspaceId], parsed.sealed),
      );
      return { entries };
    } catch {
      throw new WorkspaceSecretVaultCorruptError();
    }
  };

  const writeFileAtomic = async (workspaceId: string, data: StoredFile): Promise<void> => {
    const file = fileFor(workspaceId);
    if (Object.keys(data.entries).length === 0) {
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    const stored: z.input<typeof StoredWorkspaceSecretFile> = {
      version: 2,
      workspaceId,
      sealed: sealJson(options.cipher!, [VAULT_AAD_TAG, workspaceId], data.entries),
    };
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await atomicReplaceFile(file, (tmp) =>
      writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 }),
    );
  };

  return {
    canKeep,
    list: (workspaceId) =>
      inOrder(async () => {
        if (!canKeep()) throw new WorkspaceSecretStorageUnavailableError();
        const data = await readFileOrEmpty(workspaceId);
        return summarizeEntries(data.entries);
      }),
    set: (workspaceId, rawInput) =>
      inOrder(async () => {
        if (!canKeep()) throw new WorkspaceSecretStorageUnavailableError();
        const input = WorkspaceSecretWriteInput.parse(rawInput);
        const data = await readFileOrEmpty(workspaceId);
        const existing = Object.hasOwn(data.entries, input.name)
          ? data.entries[input.name]
          : undefined;
        if (input.mode === "create" && existing) {
          throw new WorkspaceSecretConflictError(input.name);
        }
        if (input.mode === "replace" && !existing) {
          throw new WorkspaceSecretNotFoundError(input.name);
        }
        const count = Object.keys(data.entries).length;
        if (!existing && count >= MAX_WORKSPACE_SECRETS) {
          throw new WorkspaceSecretLimitError(count, MAX_WORKSPACE_SECRETS);
        }
        const now = Math.trunc(nowMs());
        const createdAtMs = existing ? existing.createdAtMs : now;
        const updatedAtMs = Math.max(createdAtMs, now);
        const generation = existing ? existing.generation + 1 : 1;
        data.entries[input.name] = {
          usage: input.usage,
          allowedHosts: input.usage === "http-header" ? [...input.allowedHosts] : [],
          value: input.value,
          generation,
          createdAtMs,
          updatedAtMs,
        };
        await writeFileAtomic(workspaceId, data);
        return summarizeEntries(data.entries);
      }),
    remove: (workspaceId, rawName) =>
      inOrder(async () => {
        if (!canKeep()) throw new WorkspaceSecretStorageUnavailableError();
        const name = WorkspaceSecretName.parse(rawName);
        const data = await readFileOrEmpty(workspaceId);
        delete data.entries[name];
        await writeFileAtomic(workspaceId, data);
        return summarizeEntries(data.entries);
      }),
    readSecretForExecution: (workspaceId, rawName) =>
      inOrder(async () => {
        if (!canKeep()) return null;
        const parsedName = WorkspaceSecretName.safeParse(rawName);
        if (!parsedName.success) return null;
        const name = parsedName.data;
        let data: StoredFile;
        try {
          data = await readFileOrEmpty(workspaceId);
        } catch {
          return null;
        }
        const entry = Object.hasOwn(data.entries, name) ? data.entries[name] : undefined;
        if (!entry) return null;
        return {
          summary: {
            name,
            usage: entry.usage,
            allowedHosts: [...entry.allowedHosts],
            generation: entry.generation,
            createdAtMs: entry.createdAtMs,
            updatedAtMs: entry.updatedAtMs,
          },
          value: entry.value,
        };
      }),
    clearWorkspace: (workspaceId) =>
      inOrder(async () => {
        await unlink(fileFor(workspaceId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }),
    hasSaved: (workspaceId) =>
      inOrder(() =>
        access(fileFor(workspaceId)).then(
          () => true,
          () => false,
        ),
      ),
  };
}

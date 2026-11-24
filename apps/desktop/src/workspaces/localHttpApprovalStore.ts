import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  HttpStepApprovalDigest,
  HttpStepApprovalWriteInput,
  MAX_WORKSPACE_HTTP_APPROVALS,
} from "@dohc/workspace-contracts/http-step-approvals";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { atomicReplaceFile } from "../atomicReplaceFile";

const StoredHttpApprovalEntry = z
  .object({
    collectionPath: z
      .string()
      .min(1)
      .max(1024)
      .refine((path) => isNormalizedRelativePath(path) && !isSharedWithMePath(path)),
    automationId: z.string().min(1).max(64),
    stepOrdinal: z.number().int().min(0).max(256),
    approvedAtMs: z.number().int().min(0),
  })
  .strict();

const StoredHttpApprovalFile = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1),
    approvals: z
      .record(z.string(), StoredHttpApprovalEntry)
      .refine(
        (approvals) =>
          Object.keys(approvals).length <= MAX_WORKSPACE_HTTP_APPROVALS &&
          Object.keys(approvals).every(
            (digest) => HttpStepApprovalDigest.safeParse(digest).success,
          ),
      ),
  })
  .strict();

type StoredFile = z.output<typeof StoredHttpApprovalFile>;

export class LocalHttpApprovalStoreCorruptError extends Error {
  constructor() {
    super(
      "This workspace's webhook approvals file could not be read, so dohc kept it untouched and held webhook steps.",
    );
    this.name = "LocalHttpApprovalStoreCorruptError";
  }
}

export class LocalHttpApprovalLimitError extends Error {
  constructor(count: number, limit: number) {
    super(`Webhook approval limit reached (${count} of ${limit} approvals).`);
    this.name = "LocalHttpApprovalLimitError";
  }
}

export interface LocalHttpApprovalStore {
  isApproved(
    workspaceId: string,
    approvalDigest: string,
  ): Promise<"approved" | "unapproved" | "unavailable">;
  approve(workspaceId: string, input: HttpStepApprovalWriteInput): Promise<void>;
  list(workspaceId: string): Promise<string[]>;
  clearWorkspace(workspaceId: string): Promise<void>;
}

export function createLocalHttpApprovalStore(options: {
  readonly dir: string;
  readonly nowMs?: () => number;
}): LocalHttpApprovalStore {
  const rootDir = join(options.dir, "http-approvals");
  const nowMs = options.nowMs ?? Date.now;
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
        return { version: 1, workspaceId, approvals: {} };
      }
      throw new LocalHttpApprovalStoreCorruptError();
    }
    await chmod(file, 0o600).catch(() => undefined);
    try {
      const raw: unknown = JSON.parse(text);
      if (
        raw === null ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        !("approvals" in raw) ||
        raw.approvals === null ||
        typeof raw.approvals !== "object" ||
        Array.isArray(raw.approvals) ||
        !Object.keys(raw.approvals).every(
          (digest) => HttpStepApprovalDigest.safeParse(digest).success,
        )
      ) {
        throw new LocalHttpApprovalStoreCorruptError();
      }
      const parsed = StoredHttpApprovalFile.parse(raw);
      if (parsed.workspaceId !== workspaceId) {
        throw new LocalHttpApprovalStoreCorruptError();
      }
      return parsed;
    } catch {
      throw new LocalHttpApprovalStoreCorruptError();
    }
  };

  const writeFileAtomic = async (workspaceId: string, data: StoredFile): Promise<void> => {
    const file = fileFor(workspaceId);
    if (Object.keys(data.approvals).length === 0) {
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await atomicReplaceFile(file, (tmp) =>
      writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }),
    );
  };

  return {
    isApproved: (workspaceId, rawDigest) =>
      inOrder(async () => {
        const parsedDigest = HttpStepApprovalDigest.safeParse(rawDigest);
        if (!parsedDigest.success) return "unapproved";
        try {
          const data = await readFileOrEmpty(workspaceId);
          return Object.hasOwn(data.approvals, parsedDigest.data) ? "approved" : "unapproved";
        } catch (error) {
          if (error instanceof LocalHttpApprovalStoreCorruptError) return "unavailable";
          throw error;
        }
      }),
    approve: (workspaceId, rawInput) =>
      inOrder(async () => {
        const input = HttpStepApprovalWriteInput.parse(rawInput);
        if (
          !isNormalizedRelativePath(input.collectionPath) ||
          isSharedWithMePath(input.collectionPath)
        ) {
          throw new Error("Collection path must be a normalized owned Collection path.");
        }
        const data = await readFileOrEmpty(workspaceId);
        for (const [digestKey, entry] of Object.entries(data.approvals)) {
          if (
            digestKey !== input.approvalDigest &&
            entry.collectionPath === input.collectionPath &&
            entry.automationId === input.automationId &&
            entry.stepOrdinal === input.stepOrdinal
          ) {
            delete data.approvals[digestKey];
          }
        }
        const existing = Object.hasOwn(data.approvals, input.approvalDigest);
        const count = Object.keys(data.approvals).length;
        if (!existing && count >= MAX_WORKSPACE_HTTP_APPROVALS) {
          throw new LocalHttpApprovalLimitError(count, MAX_WORKSPACE_HTTP_APPROVALS);
        }
        data.approvals[input.approvalDigest] = {
          collectionPath: input.collectionPath,
          automationId: input.automationId,
          stepOrdinal: input.stepOrdinal,
          approvedAtMs: Math.trunc(nowMs()),
        };
        await writeFileAtomic(workspaceId, data);
      }),
    list: (workspaceId) =>
      inOrder(async () => {
        const data = await readFileOrEmpty(workspaceId);
        return Object.keys(data.approvals).sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
      }),
    clearWorkspace: (workspaceId) =>
      inOrder(async () => {
        await unlink(fileFor(workspaceId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }),
  };
}

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
import type { TokenCipher } from "./cloudCredentialStore";
import { openJson, SealedJson, sealJson } from "./localSealedJson";

const APPROVALS_AAD_TAG = "dohc-local-http-approvals-v2";

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

const StoredApprovals = z
  .record(z.string(), StoredHttpApprovalEntry)
  .refine(
    (approvals) =>
      Object.keys(approvals).length <= MAX_WORKSPACE_HTTP_APPROVALS &&
      Object.keys(approvals).every((digest) => HttpStepApprovalDigest.safeParse(digest).success),
  );
type StoredApprovals = z.output<typeof StoredApprovals>;

const PlainApprovalFile = z
  .object({ version: z.literal(1), workspaceId: z.string().min(1), approvals: StoredApprovals })
  .strict();

const SealedApprovalFile = z
  .object({ version: z.literal(2), workspaceId: z.string().min(1), sealed: SealedJson })
  .strict();

export class LocalHttpApprovalLimitError extends Error {
  constructor(count: number, limit: number) {
    super(`Webhook approval limit reached (${count} of ${limit} approvals).`);
    this.name = "LocalHttpApprovalLimitError";
  }
}

export interface LocalHttpApprovalStore {
  approved(workspaceId: string): Promise<ReadonlySet<string>>;
  approve(workspaceId: string, input: HttpStepApprovalWriteInput): Promise<void>;
  clearWorkspace(workspaceId: string): Promise<void>;
}

export function createLocalHttpApprovalStore(options: {
  readonly dir: string;
  readonly cipher?: TokenCipher;
  readonly nowMs?: () => number;
}): LocalHttpApprovalStore {
  const rootDir = join(options.dir, "http-approvals");
  const nowMs = options.nowMs ?? Date.now;
  const sealer = () => (options.cipher?.isAvailable() === true ? options.cipher : null);
  let last: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const done = last.then(work, work);
    last = done.catch(() => undefined);
    return done;
  };

  const fileFor = (workspaceId: string) =>
    join(rootDir, `${createHash("sha256").update(workspaceId, "utf8").digest("hex")}.json`);

  const readApprovals = async (workspaceId: string): Promise<StoredApprovals> => {
    const file = fileFor(workspaceId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return {};
    }
    await chmod(file, 0o600).catch(() => undefined);
    try {
      const raw: unknown = JSON.parse(text);
      const cipher = sealer();
      if (cipher) {
        const parsed = SealedApprovalFile.parse(raw);
        if (parsed.workspaceId !== workspaceId) return {};
        return StoredApprovals.parse(
          openJson(cipher, [APPROVALS_AAD_TAG, workspaceId], parsed.sealed),
        );
      }
      const parsed = PlainApprovalFile.parse(raw);
      return parsed.workspaceId === workspaceId ? parsed.approvals : {};
    } catch {
      return {};
    }
  };

  const writeApprovals = async (workspaceId: string, approvals: StoredApprovals): Promise<void> => {
    const file = fileFor(workspaceId);
    if (Object.keys(approvals).length === 0) {
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    const cipher = sealer();
    const stored = cipher
      ? {
          version: 2,
          workspaceId,
          sealed: sealJson(cipher, [APPROVALS_AAD_TAG, workspaceId], approvals),
        }
      : { version: 1, workspaceId, approvals };
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await atomicReplaceFile(file, (tmp) =>
      writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 }),
    );
  };

  return {
    approved: (workspaceId) =>
      inOrder(async () => new Set(Object.keys(await readApprovals(workspaceId)))),
    approve: (workspaceId, rawInput) =>
      inOrder(async () => {
        const input = HttpStepApprovalWriteInput.parse(rawInput);
        if (
          !isNormalizedRelativePath(input.collectionPath) ||
          isSharedWithMePath(input.collectionPath)
        ) {
          throw new Error("Collection path must be a normalized owned Collection path.");
        }
        const approvals = await readApprovals(workspaceId);
        for (const [digestKey, entry] of Object.entries(approvals)) {
          if (
            digestKey !== input.approvalDigest &&
            entry.collectionPath === input.collectionPath &&
            entry.automationId === input.automationId &&
            entry.stepOrdinal === input.stepOrdinal
          ) {
            delete approvals[digestKey];
          }
        }
        const existing = Object.hasOwn(approvals, input.approvalDigest);
        const count = Object.keys(approvals).length;
        if (!existing && count >= MAX_WORKSPACE_HTTP_APPROVALS) {
          throw new LocalHttpApprovalLimitError(count, MAX_WORKSPACE_HTTP_APPROVALS);
        }
        approvals[input.approvalDigest] = {
          collectionPath: input.collectionPath,
          automationId: input.automationId,
          stepOrdinal: input.stepOrdinal,
          approvedAtMs: Math.trunc(nowMs()),
        };
        await writeApprovals(workspaceId, approvals);
      }),
    clearWorkspace: (workspaceId) =>
      inOrder(async () => {
        await unlink(fileFor(workspaceId)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }),
  };
}

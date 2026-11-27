import { createHash } from "node:crypto";
import type { ShareViewFiles } from "./shareViewFiles";

export interface RuleFileDelivery {
  state: "pending" | "accepted" | "refused";
  contentHash: string | null;
  reason?: string;
}

const NOT_SENT =
  "dohc could not send this Collection's rules to the workspace. Check your connection, then try again.";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function writeSharedCollectionRules(input: {
  workspaceId: string;
  files: Record<string, string>;
  /** Refuse a file already there with other text, as a new Collection does. */
  exclusive: boolean;
  shareViewFiles: Pick<ShareViewFiles, "read" | "change">;
  withLease<T>(work: (lease: Parameters<ShareViewFiles["change"]>[0]) => Promise<T>): Promise<T>;
  push(): Promise<void>;
  delivery(paths: string[]): Promise<Record<string, RuleFileDelivery | undefined>>;
  signal: AbortSignal;
}): Promise<void> {
  const target = { kind: "standalone" as const, workspaceId: input.workspaceId };
  const entries = Object.entries(input.files).sort(
    ([a], [b]) => Number(a.endsWith("dataset.json")) - Number(b.endsWith("dataset.json")),
  );
  await input.withLease(async (lease) => {
    const writes = [];
    for (const [path, text] of entries) {
      input.signal.throwIfAborted();
      const current = await input.shareViewFiles
        .read(target, { kind: "text", path })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
          throw error;
        });
      if (current?.kind === "text" && !current.truncated && current.text === text) continue;
      if (current && input.exclusive)
        throw new Error(`A file is already at ${path}. Choose another name for the Collection.`);
      writes.push({ path, text, current });
    }
    for (const { path, text, current } of writes) {
      input.signal.throwIfAborted();
      const outcome = await input.shareViewFiles.change(
        lease,
        target,
        current?.kind === "text" && !current.truncated
          ? { kind: "save", path, text, expectedContentHash: current.contentHash }
          : { kind: "create", path, initialText: text },
      );
      const value = outcome.status === "committed" ? outcome.value : null;
      if (
        value === null ||
        (typeof value === "object" && "status" in value && value.status !== "written")
      )
        throw new Error(`${path} changed while dohc saved it. Try again.`);
    }
  });
  const paths = entries.map(([path]) => path);
  const delivered = async () => {
    input.signal.throwIfAborted();
    await input.push();
    input.signal.throwIfAborted();
    return input.delivery(paths);
  };
  let statuses = await delivered();
  if (paths.some((path) => statuses[path]?.state === "pending")) statuses = await delivered();
  for (const [path, text] of entries) {
    const status = statuses[path];
    if (status?.state === "refused")
      throw new Error(
        status.reason
          ? `The server refused ${path}: ${status.reason}`
          : `The server refused ${path}.`,
      );
    if (status?.state !== "accepted" || status.contentHash !== sha256(text))
      throw new Error(NOT_SENT);
  }
}

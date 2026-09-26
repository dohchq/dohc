import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NoticeRef } from "../ipc/bridgeContract";

// A Run now this computer began: saved before the notice's dismissal, and
// taken away once the run's claim exists or the relay says another computer
// won. A crash between the dismissal and the claim leaves it here, and the
// next start resumes it, whether or not the notice still shows.

export interface RunNowIntent {
  notice: NoticeRef;
  // The signed-in account whose notice list it came from, or null.
  account: string | null;
  workspaceId: string;
  automationId: string;
}

function isIntent(value: unknown): value is RunNowIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { notice, account, workspaceId, automationId } = value as Record<string, unknown>;
  if (!notice || typeof notice !== "object") return false;
  const { store, noticeId } = notice as Record<string, unknown>;
  return (store === "local" || store === "account") && typeof noticeId === "string" && noticeId.length > 0 &&
    (account === null || typeof account === "string") &&
    typeof workspaceId === "string" && workspaceId.length > 0 &&
    typeof automationId === "string" && automationId.length > 0;
}

export function createRunNowIntents(file: string) {
  // Writes go one at a time, so the last one lands last.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const read = async (): Promise<RunNowIntent[]> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isIntent) : [];
  };
  const write = async (intents: RunNowIntent[]) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, `${JSON.stringify(intents)}\n`);
    await rename(`${file}.tmp`, file);
  };
  const same = (left: NoticeRef, right: NoticeRef) => left.store === right.store && left.noticeId === right.noticeId;

  return {
    list: () => serial(read),
    save: (intent: RunNowIntent) =>
      serial(async () => write([...(await read()).filter((kept) => !same(kept.notice, intent.notice)), intent])),
    remove: (notice: NoticeRef) =>
      serial(async () => write((await read()).filter((kept) => !same(kept.notice, notice)))),
  };
}

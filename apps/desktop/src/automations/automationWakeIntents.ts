import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { isAutomationWake } from "@dohc/workspace-contracts/relay";
import { automationMessageId, automationWakeThreadId, type AutomationChatMessage } from "@dohc/automation-executor/automation-chat";
import type { PendingAutomationWake } from "../notices/noticeStore";

export interface AutomationWakeIntent extends PendingAutomationWake {
  claimed: boolean;
}

export function createAutomationWakeIntents(file: string) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const read = async (): Promise<AutomationWakeIntent[]> => {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || !value.every((row: unknown) => {
      if (!row || typeof row !== "object") return false;
      const intent = row as Record<string, unknown>;
      return typeof intent.account === "string" && intent.account.length > 0 &&
        typeof intent.workspaceId === "string" && intent.workspaceId.length > 0 &&
        typeof intent.noticeId === "string" && /^automation-wake:[a-f0-9]{64}$/.test(intent.noticeId) &&
        typeof intent.claimed === "boolean" && isAutomationWake(intent.wake);
    })) throw new Error("The saved agent wakes could not be read.");
    return value as AutomationWakeIntent[];
  };
  const same = (a: PendingAutomationWake, b: PendingAutomationWake) =>
    a.account === b.account && a.noticeId === b.noticeId;
  const write = async (rows: AutomationWakeIntent[]) => {
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(file + ".tmp", "w", 0o600);
    try { await handle.writeFile(JSON.stringify(rows) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(file + ".tmp", file);
  };
  return {
    list: () => serial(read),
    save: (intent: AutomationWakeIntent) => serial(async () =>
      write([...(await read()).filter((row) => !same(row, intent)), intent])),
    remove: (intent: AutomationWakeIntent) => serial(async () =>
      write((await read()).filter((row) => !same(row, intent)))),
  };
}

export function automationWakeMessage(intent: PendingAutomationWake): AutomationChatMessage {
  const effectId = "relay-wake:" + createHash("sha256").update(JSON.stringify([intent.account, intent.noticeId])).digest("hex");
  return {
    target: { kind: "agent" }, effectId, messageId: automationMessageId(effectId),
    threadId: automationWakeThreadId(intent.wake.automationId),
    automation: { automationId: intent.wake.automationId, name: intent.wake.name, depth: intent.wake.depth },
    body: intent.wake.body,
  };
}

/** One drain per computer. Saved winners resume without dismissing the notice again. */
export function createAutomationWakeConsumer(deps: {
  intents: ReturnType<typeof createAutomationWakeIntents>;
  pending(): Promise<PendingAutomationWake[]>;
  ready(intent: PendingAutomationWake, needsRunner: boolean): Promise<boolean>;
  enabled(intent: PendingAutomationWake): Promise<boolean>;
  /** Reads only an existing executor; undefined means the workspace is closed. */
  enabledIfOpen(intent: PendingAutomationWake): Promise<boolean | undefined>;
  dismiss(intent: PendingAutomationWake): Promise<"first" | "not-first" | "unanswered">;
  wake(intent: PendingAutomationWake, message: AutomationChatMessage): Promise<void>;
  onError(error: unknown): void;
}) {
  let running: Promise<void> | null = null;
  let again = false;
  return {
    resume(): Promise<void> {
      again = true;
      running ??= (async () => {
        const attempted = new Set<string>();
        do {
          again = false;
          const saved = await deps.intents.list();
          const pending = await deps.pending();
          const savedKeys = new Set(saved.map((row) => JSON.stringify([row.account, row.noticeId])));
          const intents = [...saved, ...pending.filter((row) =>
            !savedKeys.has(JSON.stringify([row.account, row.noticeId])))
            .map((row) => ({ ...row, claimed: false }))];
          for (const intent of intents) {
            const key = JSON.stringify([intent.account, intent.noticeId]);
            if (attempted.has(key)) continue;
            attempted.add(key);
            try {
              if (!(await deps.ready(intent, false))) continue;
              if (!(await deps.ready(intent, true)) && await deps.enabledIfOpen(intent) !== false) continue;
              if (!intent.claimed) {
                await deps.intents.save(intent);
                const result = await deps.dismiss(intent);
                if (result === "unanswered") continue;
                if (result === "not-first") { await deps.intents.remove(intent); continue; }
                intent.claimed = true;
                await deps.intents.save(intent);
              }
              if (!(await deps.ready(intent, false))) continue;
              if (await deps.ready(intent, true)) {
                if (await deps.enabled(intent)) {
                  if (!(await deps.ready(intent, true))) continue;
                  await deps.wake(intent, automationWakeMessage(intent));
                }
              } else if (await deps.enabledIfOpen(intent) !== false) continue;
              await deps.intents.remove(intent);
            } catch (error) { deps.onError(error); }
          }
        } while (again);
      })().catch(deps.onError).finally(() => { running = null; });
      return running;
    },
  };
}

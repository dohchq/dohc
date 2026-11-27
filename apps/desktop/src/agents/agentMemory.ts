import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteFile, type DurableFileOperations } from "../atomicReplaceFile";

const Memory = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  memoryId: z.string(),
  sessionId: z.uuid(),
  given: z.array(z.string()),
  busy: z.string().optional(),
});
type Memory = z.infer<typeof Memory>;

export interface MemoryTurn {
  sessionId: string;
  resume: boolean;
}

/**
 * Each agent's Claude Code or Codex session per workspace, kept only on this computer.
 * A new `memory` id in the agent's settings starts a new session.
 */
export interface AgentMemory {
  /** Saves the message as given to the session before its run starts. Null when the session has it already. */
  take(input: {
    workspaceId: string;
    agentId: string;
    memoryId: string;
    triggerMessageId: string;
  }): Promise<MemoryTurn | null>;
  /**
   * The session's run ended. A session still busy from an earlier dohc starts over, as its runner can outlive dohc.
   * Codex names a session itself in its first run, so `named` replaces the id dohc made.
   */
  finish(workspaceId: string, agentId: string, sessionId: string, named?: string): Promise<void>;
  /** The run never started, so the session never got its message. */
  release(
    workspaceId: string,
    agentId: string,
    sessionId: string,
    triggerMessageId: string,
  ): Promise<void>;
  /** Drops the session, so the next run starts a new one. */
  forget(workspaceId: string, agentId: string, sessionId: string): Promise<void>;
}

export function createAgentMemory(
  path: () => string,
  fileOperations?: DurableFileOperations,
): AgentMemory {
  const instance = randomUUID();
  let loaded: Promise<Memory[]> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  const change = <Result>(update: (memories: Memory[]) => [Memory[] | null, Result]) => {
    const next = writes.then(async () => {
      const memories = await (loaded ??= read(path()));
      const [changed, result] = update(memories);
      if (changed === null) return result;
      const destination = path();
      await mkdir(dirname(destination), { recursive: true });
      await atomicWriteFile(destination, JSON.stringify(changed), fileOperations);
      memories.splice(0, memories.length, ...changed);
      return result;
    });
    writes = next.catch(() => {
      loaded = null;
    });
    return next;
  };
  const others = (memories: Memory[], workspaceId: string, agentId: string) =>
    memories.filter((each) => each.workspaceId !== workspaceId || each.agentId !== agentId);
  const withSession = (
    workspaceId: string,
    agentId: string,
    sessionId: string,
    replace: (memory: Memory) => Memory[],
  ) =>
    change((memories) => {
      const found = memories.find(
        (each) =>
          each.workspaceId === workspaceId &&
          each.agentId === agentId &&
          each.sessionId === sessionId,
      );
      return [
        found ? [...others(memories, workspaceId, agentId), ...replace(found)] : null,
        undefined,
      ];
    });
  return {
    take: ({ workspaceId, agentId, memoryId, triggerMessageId }) =>
      change((memories) => {
        const found = memories.find(
          (each) =>
            each.workspaceId === workspaceId &&
            each.agentId === agentId &&
            each.memoryId === memoryId,
        );
        if (found?.given.includes(triggerMessageId)) return [null, null];
        const memory =
          found && (found.busy === undefined || found.busy === instance)
            ? found
            : { workspaceId, agentId, memoryId, sessionId: randomUUID(), given: [] };
        const next = {
          ...memory,
          given: [...memory.given, triggerMessageId],
          busy: instance,
        };
        return [
          [...others(memories, workspaceId, agentId), next],
          { sessionId: memory.sessionId, resume: memory.given.length > 0 },
        ];
      }),
    finish: (workspaceId, agentId, sessionId, named) =>
      withSession(workspaceId, agentId, sessionId, ({ busy: _ended, ...memory }) => [
        { ...memory, sessionId: named ?? memory.sessionId },
      ]),
    release: (workspaceId, agentId, sessionId, triggerMessageId) =>
      withSession(workspaceId, agentId, sessionId, ({ busy: _ended, ...memory }) => [
        { ...memory, given: memory.given.filter((given) => given !== triggerMessageId) },
      ]),
    forget: (workspaceId, agentId, sessionId) =>
      withSession(workspaceId, agentId, sessionId, () => []),
  };
}

async function read(path: string): Promise<Memory[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = z.array(Memory).safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  await rename(path, `${path}.damaged`);
  return [];
}

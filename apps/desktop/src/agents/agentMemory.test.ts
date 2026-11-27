import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createAgentMemory } from "./agentMemory";

const turn = (triggerMessageId: string, memoryId = "memory-1", workspaceId = "trip") => ({
  workspaceId,
  agentId: "default",
  memoryId,
  triggerMessageId,
});

describe("agent memory", () => {
  it("gives each message to a session once, even after dohc restarts", async () => {
    const path = join(await createTestScratch("dohc-agent-memory-"), "agent-memory.json");
    const first = await createAgentMemory(() => path).take(turn("message-1"));
    expect(first).toEqual({ sessionId: expect.any(String), resume: false });

    const restarted = createAgentMemory(() => path);
    await expect(restarted.take(turn("message-1"))).resolves.toBeNull();
    await expect(restarted.take(turn("message-2"))).resolves.toEqual({
      sessionId: first!.sessionId,
      resume: true,
    });
    const other = await restarted.take(turn("message-1", "memory-1", "fundraiser"));
    expect(other?.sessionId).not.toBe(first!.sessionId);
  });

  it("starts a new session for a new memory id or a forgotten session", async () => {
    const path = join(await createTestScratch("dohc-agent-memory-"), "agent-memory.json");
    const memory = createAgentMemory(() => path);
    const first = await memory.take(turn("message-1"));
    const fresh = await memory.take(turn("message-1", "memory-2"));
    expect(fresh).toEqual({ sessionId: expect.any(String), resume: false });
    expect(fresh!.sessionId).not.toBe(first!.sessionId);

    await memory.forget("trip", "default", first!.sessionId);
    await expect(memory.take(turn("message-2", "memory-2"))).resolves.toEqual({
      sessionId: fresh!.sessionId,
      resume: true,
    });
    await memory.forget("trip", "default", fresh!.sessionId);
    const after = await memory.take(turn("message-2", "memory-2"));
    expect(after).toEqual({ sessionId: expect.any(String), resume: false });
    expect(after!.sessionId).not.toBe(fresh!.sessionId);
  });

  it("sets a damaged file aside and starts fresh", async () => {
    const path = join(await createTestScratch("dohc-agent-memory-"), "agent-memory.json");
    await writeFile(path, "{not json");
    await expect(createAgentMemory(() => path).take(turn("message-1"))).resolves.toEqual({
      sessionId: expect.any(String),
      resume: false,
    });
    await expect(readFile(`${path}.damaged`, "utf8")).resolves.toBe("{not json");
  });
});

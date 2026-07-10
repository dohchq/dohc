import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENTS_CHAT_BEGIN_MARKER,
  AGENTS_CHAT_END_MARKER,
  AGENTS_CHAT_MANAGED_BLOCK,
  ensureAgentsChatBlock,
} from "./agentsChatBlock";

describe("ensureAgentsChatBlock", () => {
  let root: string;
  let agentsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dohc-agents-chat-"));
    agentsPath = join(root, "AGENTS.md");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates AGENTS.md with the complete agent-facing chat instructions", async () => {
    await expect(ensureAgentsChatBlock(root)).resolves.toBe(true);

    const content = await readFile(agentsPath, "utf8");
    expect(content).toBe(`${AGENTS_CHAT_MANAGED_BLOCK}\n`);
    expect(content).toContain("`dohc chat inbox --as-agent`");
    expect(content).toContain("`dohc chat grep <pattern> --as-agent`");
    expect(content).toContain("`dohc chat show <thread|message> --as-agent`");
    expect(content).toContain("`dohc chat reply <thread> --as-agent`");
    expect(content).toContain(
      "Always pass `--as-agent` on every chat command, including reads and writes",
    );
    expect(content).toContain("environment variables do not persist");
  });

  it("does not rewrite an already current managed block", async () => {
    await ensureAgentsChatBlock(root);
    const oldTime = new Date("2001-02-03T04:05:06.000Z");
    await utimes(agentsPath, oldTime, oldTime);
    const before = await stat(agentsPath);

    await expect(ensureAgentsChatBlock(root)).resolves.toBe(false);

    const after = await stat(agentsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("replaces stale managed content and preserves everything outside the markers", async () => {
    const prefix = "# Team instructions\n\nKeep this exact prefix.\n\n";
    const suffix = "\n\nKeep this exact suffix.\n";
    await writeFile(
      agentsPath,
      `${prefix}${AGENTS_CHAT_BEGIN_MARKER}\nOld managed text.\n${AGENTS_CHAT_END_MARKER}${suffix}`,
      "utf8",
    );

    await expect(ensureAgentsChatBlock(root)).resolves.toBe(true);

    expect(await readFile(agentsPath, "utf8")).toBe(
      `${prefix}${AGENTS_CHAT_MANAGED_BLOCK}${suffix}`,
    );
  });

  it("appends the block without changing an existing marker-free file", async () => {
    const existing = "# Existing instructions\n\nDo not change this line.";
    await writeFile(agentsPath, existing, "utf8");

    await ensureAgentsChatBlock(root);

    expect(await readFile(agentsPath, "utf8")).toBe(
      `${existing}\n\n${AGENTS_CHAT_MANAGED_BLOCK}\n`,
    );
  });

  it("atomically replaces AGENTS.md while preserving its mode", async () => {
    const existing = "# Existing instructions\n";
    await writeFile(agentsPath, existing, "utf8");
    if (process.platform !== "win32") await chmod(agentsPath, 0o640);

    await expect(ensureAgentsChatBlock(root)).resolves.toBe(true);

    expect(await readFile(agentsPath, "utf8")).toBe(
      `${existing}\n${AGENTS_CHAT_MANAGED_BLOCK}\n`,
    );
    if (process.platform !== "win32") {
      expect((await stat(agentsPath)).mode & 0o777).toBe(0o640);
    }
    expect((await readdir(root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("leaves the original intact when writing the replacement fails", async () => {
    const original = "# Existing instructions\n\nKeep this intact.\n";
    await writeFile(agentsPath, original, "utf8");
    const probe = await open(agentsPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as Pick<
      FileHandle,
      "write"
    >;
    await probe.close();
    const write = vi
      .spyOn(fileHandlePrototype, "write")
      .mockRejectedValueOnce(new Error("simulated write failure"));

    try {
      await expect(ensureAgentsChatBlock(root)).rejects.toThrow(
        "simulated write failure",
      );
    } finally {
      write.mockRestore();
    }

    expect(await readFile(agentsPath, "utf8")).toBe(original);
    expect((await readdir(root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("leaves an unmatched marker outside the managed block untouched", async () => {
    const existing = `${AGENTS_CHAT_BEGIN_MARKER}\nUser-owned text after an unmatched marker.`;
    await writeFile(agentsPath, existing, "utf8");

    await expect(ensureAgentsChatBlock(root)).resolves.toBe(true);
    const afterFirstRun = await readFile(agentsPath, "utf8");
    expect(afterFirstRun).toBe(`${existing}\n\n${AGENTS_CHAT_MANAGED_BLOCK}\n`);

    await expect(ensureAgentsChatBlock(root)).resolves.toBe(false);
    expect(await readFile(agentsPath, "utf8")).toBe(afterFirstRun);
  });

  it("serializes concurrent updates to the same AGENTS.md", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureAgentsChatBlock(root)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readFile(agentsPath, "utf8")).toBe(`${AGENTS_CHAT_MANAGED_BLOCK}\n`);
  });

  it("refuses a symlink without changing its target", async () => {
    const target = join(root, "outside.md");
    const original = "# Outside\n\nKeep this untouched.\n";
    await writeFile(target, original, "utf8");
    try {
      await symlink(target, agentsPath, "file");
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return;
      throw error;
    }

    await expect(ensureAgentsChatBlock(root)).rejects.toThrow(
      "AGENTS.md must be a regular file",
    );
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("refuses a non-regular AGENTS.md path", async () => {
    await mkdir(agentsPath);

    await expect(ensureAgentsChatBlock(root)).rejects.toThrow(
      "AGENTS.md must be a regular file",
    );
    expect((await stat(agentsPath)).isDirectory()).toBe(true);
  });
});

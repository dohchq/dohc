import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDohcMcpServer } from "../src/server";
import type { EvalCase, RunRecord } from "./case";
import { CASES } from "./cases";
import { seedWorkspace, workspaceFiles } from "./claude";
import { fakeDesktop } from "./desktop";
import { grade } from "./grade";

/** Runs a case's known-good calls against the real server and the stand-in app, with no model. */
async function replay(evalCase: EvalCase, calls: EvalCase["solution"]["calls"]): Promise<{ run: RunRecord; unanswered: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-eval-case-"));
  const root = join(dir, "workspace");
  const unansweredLog = join(dir, "unanswered.log");
  try {
    await seedWorkspace(root, evalCase);
    const server = createDohcMcpServer({ root, home: root, request: fakeDesktop({ root, answers: evalCase.desktop ?? {}, unansweredLog }) });
    const client = new Client({ name: "eval-case", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const recorded: RunRecord["calls"] = [];
    for (const call of calls) {
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      recorded.push({ tool: call.tool, args: call.args, ok: result.isError !== true });
    }
    await client.close();
    await server.close();
    return { run: { calls: recorded, text: evalCase.solution.text ?? "", files: await workspaceFiles(root) }, unanswered: await readFile(unansweredLog, "utf8").catch(() => "") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("eval cases", () => {
  it("names each case once and says where it came from", () => {
    expect(new Set(CASES.map((evalCase) => evalCase.id)).size).toBe(CASES.length);
    for (const evalCase of CASES) {
      expect(evalCase.experience, evalCase.id).toMatch(/\S/);
      expect(evalCase.source, evalCase.id).toMatch(evalCase.kind === "control" ? /^control$/ : /#\d+/);
    }
  });

  it.each(CASES.map((evalCase) => [evalCase.id, evalCase] as const))("%s passes with its known-good calls and fails without them", async (_id, evalCase) => {
    const solved = await replay(evalCase, evalCase.solution.calls);
    expect(solved.unanswered).toBe("");
    expect(grade(evalCase.expect, solved.run).filter((check) => !check.pass)).toEqual([]);
    // An agent that does nothing and says nothing must not pass. A control forbids calls, so
    // its answer checks carry that.
    const idle = await replay(evalCase, []);
    expect(grade(evalCase.expect, { ...idle.run, text: "" }).some((check) => !check.pass)).toBe(true);
  });
});

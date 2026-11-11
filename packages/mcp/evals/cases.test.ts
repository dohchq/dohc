import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliResultSchemas } from "@dohc/cli/protocol";
import { createDohcMcpServer } from "../src/server";
import type { EvalCase, RunRecord } from "./case";
import { CASES } from "./cases";
import { seedWorkspace, workspaceFiles } from "./claude";
import { fakeDesktop } from "./desktop";
import { grade } from "./grade";

/**
 * Runs a case's known-good calls against the real server and the stand-in app, with no model.
 * `misshapen` names each answer the app's own result schema refuses: the real server would turn
 * such an answer into a refusal the case never meant.
 */
async function replay(evalCase: EvalCase, calls: EvalCase["solution"]["calls"]): Promise<{ run: RunRecord; unanswered: string; misshapen: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-eval-case-"));
  const root = join(dir, "workspace");
  const unansweredLog = join(dir, "unanswered.log");
  const misshapen: string[] = [];
  try {
    await seedWorkspace(root, evalCase);
    const desktop = fakeDesktop({ root, answers: evalCase.desktop ?? {}, unansweredLog });
    const server = createDohcMcpServer({
      root,
      home: root,
      // An answer that throws stands for one that never arrived, so only answers are checked.
      request: async (request) => {
        const answer = await desktop(request);
        const parsed = cliResultSchemas[request.verb].safeParse(answer);
        if (!parsed.success) misshapen.push(`${request.verb}: ${parsed.error.issues[0]?.message ?? "refused"}`);
        return answer;
      },
    });
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
    return {
      run: { calls: recorded, text: evalCase.solution.text ?? "", files: await workspaceFiles(root) },
      unanswered: await readFile(unansweredLog, "utf8").catch(() => ""),
      misshapen,
    };
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
    expect(solved.misshapen).toEqual([]);
    expect(grade(evalCase.expect, solved.run).filter((check) => !check.pass)).toEqual([]);
    // An agent that does nothing and says nothing must not pass. A control forbids calls, so
    // its answer checks carry that.
    const idle = await replay(evalCase, []);
    expect(grade(evalCase.expect, { ...idle.run, text: "" }).some((check) => !check.pass)).toBe(true);
  });
});

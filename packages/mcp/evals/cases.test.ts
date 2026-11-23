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
import { EVERYDAY_CASES } from "./everydayCases";
import { grade } from "./grade";

const ALL_CASES: readonly EvalCase[] = [...CASES, ...EVERYDAY_CASES];

/**
 * Runs a case's known-good calls against the real server and the stand-in app, with no model.
 * `misshapen` names each answer the app's own result schema refuses: the real server would turn
 * such an answer into a refusal the case never meant.
 */
async function replay(
  evalCase: EvalCase,
  mode: "solution" | "idle",
): Promise<{ run: RunRecord; unanswered: string; misshapen: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-eval-case-"));
  const root = join(dir, "workspace");
  const home = join(dir, "home");
  const unansweredLog = join(dir, "unanswered.log");
  const misshapen: string[] = [];
  try {
    await seedWorkspace(root, evalCase, home);
    const answers = {
      ...(evalCase.setupDesktop ? evalCase.setupDesktop(root) : {}),
      ...evalCase.desktop,
    };
    const desktop = fakeDesktop({ root, answers, unansweredLog });
    const server = createDohcMcpServer({
      root,
      home,
      // An answer that throws stands for one that never arrived, so only answers are checked.
      request: async (request) => {
        const answer = await desktop(request);
        const parsed = cliResultSchemas[request.verb].safeParse(answer);
        if (!parsed.success)
          misshapen.push(`${request.verb}: ${parsed.error.issues[0]?.message ?? "refused"}`);
        return answer;
      },
    });
    const client = new Client({ name: "eval-case", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const recorded: RunRecord["calls"] = [];
    const callTool = async (
      tool: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const result = await client.callTool({ name: tool, arguments: args });
      recorded.push({ tool, args, ok: result.isError !== true });
      return (result.structuredContent as Record<string, unknown> | undefined) ?? {};
    };
    let text = evalCase.solution.text ?? "";
    if (mode === "solution") {
      if (evalCase.solution.run) {
        const out = await evalCase.solution.run(callTool);
        if (typeof out === "string") text = out;
      } else {
        for (const call of evalCase.solution.calls ?? []) {
          await callTool(call.tool, call.args);
        }
      }
    } else {
      text = "";
    }
    await client.close();
    await server.close();
    return {
      run: {
        calls: recorded,
        text,
        files: await workspaceFiles(root),
      },
      unanswered: await readFile(unansweredLog, "utf8").catch(() => ""),
      misshapen,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("eval cases", () => {
  it("names each case once and says where it came from", () => {
    expect(new Set(ALL_CASES.map((evalCase) => evalCase.id)).size).toBe(ALL_CASES.length);
    for (const evalCase of ALL_CASES) {
      expect(evalCase.experience, evalCase.id).toMatch(/\S/);
      expect(evalCase.source, evalCase.id).toMatch(
        evalCase.kind === "control"
          ? /^control$/
          : evalCase.kind === "everyday"
            ? /^everyday-job-\d+$/
            : /#\d+/,
      );
    }
  });

  it.each(ALL_CASES.map((evalCase) => [evalCase.id, evalCase] as const))(
    "%s passes with its known-good calls and fails without them",
    async (_id, evalCase) => {
      const solved = await replay(evalCase, "solution");
      expect(solved.unanswered).toBe("");
      expect(solved.misshapen).toEqual([]);
      expect(
        grade(evalCase.expect, solved.run, evalCase.gradeRun).filter((check) => !check.pass),
      ).toEqual([]);
      // An agent that does nothing and says nothing must not pass. A control forbids calls, so
      // its answer checks carry that.
      const idle = await replay(evalCase, "idle");
      expect(grade(evalCase.expect, idle.run, evalCase.gradeRun).some((check) => !check.pass)).toBe(
        true,
      );
    },
  );
});

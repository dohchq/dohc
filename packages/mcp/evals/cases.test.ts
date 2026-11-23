import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliResultSchemas } from "@dohc/cli/protocol";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { createDohcMcpServer } from "../src/server";
import type { EvalCase, RunRecord } from "./case";
import { CASES } from "./cases";
import { seedWorkspace, workspaceFiles } from "./claude";
import { fakeDesktop } from "./desktop";
import { EVERYDAY_CASES } from "./everydayCases";
import { createEverydayDesktop } from "./everydayDesktop";
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
      ...(evalCase.setupDesktop ? await evalCase.setupDesktop(root) : {}),
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
        (await grade(evalCase.expect, solved.run, evalCase.gradeRun)).filter(
          (check) => !check.pass,
        ),
      ).toEqual([]);
      // An agent that does nothing and says nothing must not pass. A control forbids calls, so
      // its answer checks carry that.
      const idle = await replay(evalCase, "idle");
      expect(
        (await grade(evalCase.expect, idle.run, evalCase.gradeRun)).some((check) => !check.pass),
      ).toBe(true);
    },
  );

  it("answers dohc_search_workspace and refuses paths outside the sample workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-eval-standin-"));
    const root = join(dir, "workspace");
    const home = join(dir, "home");
    const outside = join(dir, "outside.json");
    const unansweredLog = join(dir, "unanswered.log");
    try {
      await seedWorkspace(
        root,
        {
          ...EVERYDAY_CASES[0]!,
          files: { "notes/plan.md": "# Kyoto\nVisit Fushimi Inari.\n" },
        },
        home,
      );
      await writeFile(outside, JSON.stringify({ secret: true }));
      const answers = await createEverydayDesktop(root, { workspaceId: "ws-everyday" });
      const desktop = fakeDesktop({ root, answers, unansweredLog });
      const server = createDohcMcpServer({
        root,
        home,
        request: async (request) => {
          const answer = await desktop(request);
          expect(cliResultSchemas[request.verb].safeParse(answer).success).toBe(true);
          return answer;
        },
      });
      const client = new Client({ name: "eval-standin", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const search = await client.callTool({
        name: "dohc_search_workspace",
        arguments: { query: "Kyoto" },
      });
      expect(search.isError).not.toBe(true);
      expect(JSON.stringify(search.structuredContent)).toContain("notes/plan.md");

      const traversal = await client.callTool({
        name: "dohc_dataset",
        arguments: {
          request: {
            action: "prepare",
            workspaceId: "ws-everyday",
            descriptorPath: "../outside.json",
          },
        },
      });
      expect(traversal.isError).toBe(true);

      let symlinkCreated = false;
      try {
        await symlink(outside, join(root, "escape.json"));
        symlinkCreated = true;
      } catch {
        symlinkCreated = false;
      }
      if (symlinkCreated) {
        const escaped = await client.callTool({
          name: "dohc_dataset",
          arguments: {
            request: {
              action: "prepare",
              workspaceId: "ws-everyday",
              descriptorPath: "escape.json",
            },
          },
        });
        expect(escaped.isError).toBe(true);
      }

      await client.close();
      await server.close();
      expect(await readFile(unansweredLog, "utf8").catch(() => "")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails the finance and booking graders on broken implementations", async () => {
    const finance = EVERYDAY_CASES.find((c) => c.id === "everyday-finance-health-tracker")!;
    const financeSolved = await replay(finance, "solution");
    const readOnlyFinanceRun: RunRecord = {
      ...financeSolved.run,
      calls: financeSolved.run.calls.map((call) => {
        if (
          call.tool === "dohc_dataset" &&
          (call.args.request as Record<string, unknown> | undefined)?.action === "invoke"
        ) {
          return {
            ...call,
            args: {
              request: {
                ...(call.args.request as Record<string, unknown>),
                operationId: "a1000000-0000-4000-8000-000000000014",
                input: {},
              },
            },
          };
        }
        return call;
      }),
    };
    const financeChecks = await grade(finance.expect, readOnlyFinanceRun, finance.gradeRun);
    expect(financeChecks.some((c) => !c.pass && c.name.includes("expense"))).toBe(true);
    expect(financeChecks.some((c) => !c.pass && c.name.includes("check-in"))).toBe(true);

    const booking = EVERYDAY_CASES.find((c) => c.id === "everyday-booking-capacity-app")!;
    const bookingSolved = await replay(booking, "solution");
    const brokenBookingRun: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "workshop/backend.ts": `globalThis.operations = {
  // mentions ctx.refuse in a comment without enforcing capacity
  bookSeat(ctx, input) {
    ctx.db.execute("INSERT INTO bookings(id, name, seats) VALUES(?, ?, ?)", [ctx.requestId, String(input?.name ?? ""), Number(input?.seats ?? 1)]);
    return { id: ctx.requestId };
  },
  listBookings(ctx) {
    return { rows: ctx.db.query("SELECT id, name, seats FROM bookings") };
  },
};`,
      },
    };
    const bookingChecks = await grade(booking.expect, brokenBookingRun, booking.gradeRun);
    expect(bookingChecks.some((c) => !c.pass && c.name.includes("refuses 4 more"))).toBe(true);
  });

  it("keeps public skill automations.yaml examples valid under parseAutomationsFile", async () => {
    const docPath = fileURLToPath(
      new URL("../../../skills/dohc/references/automations.md", import.meta.url),
    );
    const markdown = await readFile(docPath, "utf8");
    const blocks = [...markdown.matchAll(/```yaml\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const parsed = parseAutomationsFile(block);
      expect(parsed.status).toBe("read");
      if (parsed.status === "read") {
        expect(parsed.entries.length).toBeGreaterThan(0);
        for (const entry of parsed.entries) {
          expect(entry.status, block).toBe("valid");
        }
      }
    }
  });
});

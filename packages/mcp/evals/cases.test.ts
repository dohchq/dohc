import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliResultSchemas } from "@dohc/cli/protocol";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { createDohcMcpServer } from "../src/server";
import type { DatasetSnapshot, EvalCase, FrontendVerificationRecord, RunRecord } from "./case";
import { CASES } from "./cases";
import { evalServerArgs, readEvalJsonRecord, seedWorkspace, workspaceFiles } from "./claude";
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
  customRun?: (
    callTool: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<string | void>,
): Promise<{ run: RunRecord; unanswered: string; misshapen: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-eval-case-"));
  const root = join(dir, "workspace");
  const home = join(dir, "home");
  const unansweredLog = join(dir, "unanswered.log");
  const misshapen: string[] = [];
  const datasetSnapshots: Record<string, DatasetSnapshot> = {};
  const frontendVerifications: Record<string, FrontendVerificationRecord> = {};
  try {
    await seedWorkspace(root, evalCase, home);
    const answers = {
      ...(evalCase.setupDesktop
        ? await evalCase.setupDesktop(root, {
            onDatasetSnapshot: (datasetPath, snapshot) => {
              datasetSnapshots[datasetPath] = snapshot;
            },
            onFrontendVerified: (appRoot, record) => {
              frontendVerifications[appRoot] = record;
            },
          })
        : {}),
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
    if (customRun) {
      const out = await customRun(callTool);
      if (typeof out === "string") text = out;
    } else if (mode === "solution") {
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
        ...(Object.keys(datasetSnapshots).length > 0 ? { datasetSnapshots } : {}),
        ...(Object.keys(frontendVerifications).length > 0 ? { frontendVerifications } : {}),
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

  it("answers dohc_search_workspace, refuses paths outside workspace (including junctions), rejects invalid collection manifests, and serializes concurrent writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-eval-standin-"));
    const root = join(dir, "workspace");
    const home = join(dir, "home");
    const outsideDir = join(dir, "outside-dir");
    const unansweredLog = join(dir, "unanswered.log");
    try {
      await seedWorkspace(
        root,
        {
          ...EVERYDAY_CASES[0]!,
          files: {
            "notes/plan.md": "# Kyoto\nVisit Fushimi Inari.\n",
            "bad-app/index.html": "<!doctype html><h1>Bad</h1>\n",
            "bad-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "index.html",
              inputs: ["index.html"],
              packageMap: {},
              collection: true,
            }),
          },
        },
        home,
      );
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, "secret.json"), JSON.stringify({ secret: true }));
      await symlink(
        outsideDir,
        join(root, "escape-dir"),
        process.platform === "win32" ? "junction" : "dir",
      );

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
            descriptorPath: "../outside-dir/secret.json",
          },
        },
      });
      expect(traversal.isError).toBe(true);

      const escaped = await client.callTool({
        name: "dohc_dataset",
        arguments: {
          request: {
            action: "prepare",
            workspaceId: "ws-everyday",
            descriptorPath: "escape-dir/secret.json",
          },
        },
      });
      expect(escaped.isError).toBe(true);
      expect(JSON.stringify(escaped.content)).toContain("escapes-workspace");

      const badManifest = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "prepareLocal",
            workspaceId: "ws-everyday",
            appRoot: "bad-app",
          },
        },
      });
      expect(badManifest.isError).toBe(true);

      // Verify concurrent dataset writes do not clobber each other's snapshot.
      const createRes = await client.callTool({
        name: "dohc_dataset",
        arguments: {
          request: {
            action: "create",
            workspaceId: "ws-everyday",
            definition: {
              formatVersion: 1,
              datasetId: "99000000-0000-4000-8000-000000000001",
              name: "Concurrent",
              schemaPath: "conc/schema.sql",
              operationsPath: "conc/ops.js",
              tables: [
                {
                  tableId: "99000000-0000-4000-8000-000000000002",
                  name: "Items",
                  sqlName: "items",
                  primaryKey: "id",
                  fields: [
                    {
                      fieldId: "99000000-0000-4000-8000-000000000003",
                      name: "ID",
                      sqlColumn: "id",
                      type: "text",
                      required: true,
                      unique: true,
                      generated: "record-id",
                    },
                    {
                      fieldId: "99000000-0000-4000-8000-000000000004",
                      name: "Label",
                      sqlColumn: "label",
                      type: "text",
                      required: true,
                      unique: false,
                    },
                  ],
                },
              ],
              operations: [
                {
                  operationId: "99000000-0000-4000-8000-000000000005",
                  name: "addItem",
                  label: "Add",
                  tableId: "99000000-0000-4000-8000-000000000002",
                  kind: "create",
                  access: "owner",
                  readOnly: false,
                  fieldIds: ["99000000-0000-4000-8000-000000000004"],
                },
                {
                  operationId: "99000000-0000-4000-8000-000000000006",
                  name: "listItems",
                  label: "List",
                  tableId: "99000000-0000-4000-8000-000000000002",
                  kind: "read",
                  access: "owner",
                  readOnly: true,
                  fieldIds: [
                    "99000000-0000-4000-8000-000000000003",
                    "99000000-0000-4000-8000-000000000004",
                  ],
                },
              ],
            },
          },
        },
      });
      const rev = (
        createRes.structuredContent as { revision: { revision: number; revisionSha256: string } }
      ).revision;
      const [w1, w2] = await Promise.all([
        client.callTool({
          name: "dohc_dataset",
          arguments: {
            request: {
              action: "invoke",
              workspaceId: "ws-everyday",
              datasetPath: "conc/dataset.json",
              operationId: "99000000-0000-4000-8000-000000000005",
              revision: rev.revision,
              revisionSha256: rev.revisionSha256,
              input: { values: { "99000000-0000-4000-8000-000000000004": "First" } },
              idempotencyKey: "k1",
            },
          },
        }),
        client.callTool({
          name: "dohc_dataset",
          arguments: {
            request: {
              action: "invoke",
              workspaceId: "ws-everyday",
              datasetPath: "conc/dataset.json",
              operationId: "99000000-0000-4000-8000-000000000005",
              revision: rev.revision,
              revisionSha256: rev.revisionSha256,
              input: { values: { "99000000-0000-4000-8000-000000000004": "Second" } },
              idempotencyKey: "k2",
            },
          },
        }),
      ]);
      expect(w1.isError).not.toBe(true);
      expect(w2.isError).not.toBe(true);
      const listed = await client.callTool({
        name: "dohc_dataset",
        arguments: {
          request: {
            action: "invoke",
            workspaceId: "ws-everyday",
            datasetPath: "conc/dataset.json",
            operationId: "99000000-0000-4000-8000-000000000006",
            revision: rev.revision,
            revisionSha256: rev.revisionSha256,
            input: {},
            idempotencyKey: "k3",
          },
        },
      });
      const listedText = JSON.stringify(listed.structuredContent);
      expect(listedText).toContain("First");
      expect(listedText).toContain("Second");

      await client.close();
      await server.close();
      expect(await readFile(unansweredLog, "utf8").catch(() => "")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails the finance, booking, and connected-form graders on broken implementations", async () => {
    const finance = EVERYDAY_CASES.find((c) => c.id === "everyday-finance-health-tracker")!;
    const financeSolved = await replay(finance, "solution");
    const spoofedFinanceRun: RunRecord = {
      ...financeSolved.run,
      calls: financeSolved.run.calls.map((call) => {
        const req = call.args.request as Record<string, unknown> | undefined;
        if (call.tool === "dohc_dataset" && req?.action === "invoke") {
          return {
            ...call,
            args: {
              request: {
                ...req,
                input: {
                  values:
                    req.operationId === "a1000000-0000-4000-8000-000000000013"
                      ? {
                          "a1000000-0000-4000-8000-000000000004": "2026-11-22",
                          "a1000000-0000-4000-8000-000000000005": "Seafood",
                          "a1000000-0000-4000-8000-000000000006": 118.5,
                          "a1000000-0000-4000-8000-000000000007": "Seafood 118.50",
                        }
                      : {
                          "a1000000-0000-4000-8000-000000000010": "2026-11-22",
                          "a1000000-0000-4000-8000-000000000011": 17.5,
                          "a1000000-0000-4000-8000-000000000012": 400,
                        },
                },
              },
            },
          };
        }
        return call;
      }),
    };
    const financeChecks = await grade(finance.expect, spoofedFinanceRun, finance.gradeRun);
    expect(financeChecks.some((c) => !c.pass && c.name.includes("expense"))).toBe(true);
    expect(financeChecks.some((c) => !c.pass && c.name.includes("check-in"))).toBe(true);

    const swappedCheckinRun: RunRecord = {
      ...financeSolved.run,
      calls: financeSolved.run.calls.map((call) => {
        const req = call.args.request as Record<string, unknown> | undefined;
        if (
          call.tool === "dohc_dataset" &&
          req?.action === "invoke" &&
          req.operationId === "a1000000-0000-4000-8000-000000000015"
        ) {
          return {
            ...call,
            args: {
              request: {
                ...req,
                input: {
                  values: {
                    "a1000000-0000-4000-8000-000000000010": "2026-11-22",
                    "a1000000-0000-4000-8000-000000000011": 40,
                    "a1000000-0000-4000-8000-000000000012": 7.5,
                  },
                },
              },
            },
          };
        }
        return call;
      }),
    };
    const swappedChecks = await grade(finance.expect, swappedCheckinRun, finance.gradeRun);
    expect(swappedChecks.some((c) => !c.pass && c.name.includes("check-in"))).toBe(true);

    const booking = EVERYDAY_CASES.find((c) => c.id === "everyday-booking-capacity-app")!;
    const bookingSolved = await replay(booking, "solution");
    const brokenBookingRun: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "workshop/backend.ts": `globalThis.operations = {
  bookSeat(ctx, input) {
    const taken = Number(ctx.db.query("SELECT COALESCE(SUM(seats), 0) AS t FROM bookings")[0].t);
    const seats = Number(input?.seats ?? 1);
    if (taken > 0 && taken + seats > 8) ctx.refuse("full", "Full");
    ctx.db.execute("INSERT INTO bookings(id, name, seats) VALUES(?, ?, ?)", [ctx.requestId, String(input?.name ?? ""), seats]);
    return { id: ctx.requestId };
  },
  listBookings(ctx) {
    return { rows: ctx.db.query("SELECT id, name, seats FROM bookings") };
  },
};`,
      },
    };
    const bookingChecks = await grade(booking.expect, brokenBookingRun, booking.gradeRun);
    expect(bookingChecks.some((c) => !c.pass && c.name.includes("8-seat capacity"))).toBe(true);

    const stubBookingFrontendRun: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "apps/booking/index.html": "<!doctype html><h1>Pottery Workshop</h1>\n",
        "apps/booking/app.publish.json": JSON.stringify(
          {
            ...JSON.parse(bookingSolved.run.files["apps/booking/app.publish.json"]!),
            inputs: ["index.html"],
          },
          null,
          2,
        ),
      },
    };
    delete stubBookingFrontendRun.files["apps/booking/app.js"];
    const stubBookingChecks = await grade(booking.expect, stubBookingFrontendRun, booking.gradeRun);
    expect(stubBookingChecks.some((c) => !c.pass && c.name.includes("booking controls"))).toBe(
      true,
    );

    const unlistedScriptBookingRun: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "apps/booking/app.publish.json": JSON.stringify(
          {
            ...JSON.parse(bookingSolved.run.files["apps/booking/app.publish.json"]!),
            inputs: ["index.html"],
          },
          null,
          2,
        ),
      },
    };
    const unlistedScriptChecks = await grade(
      booking.expect,
      unlistedScriptBookingRun,
      booking.gradeRun,
    );
    expect(
      unlistedScriptChecks.some(
        (c) => !c.pass && c.detail?.includes("not listed in app.publish.json"),
      ),
    ).toBe(true);

    const migrate = EVERYDAY_CASES.find((c) => c.id === "everyday-add-field-and-migrate")!;
    const renamedInsteadOfAddField = await replay(migrate, "solution", async (callTool) => {
      const described = (await callTool("dohc_dataset", {
        request: {
          action: "describe",
          workspaceId: "ws-everyday",
          datasetPath: "clients/dataset.json",
        },
      })) as { dataset: { revision: number; revisionSha256: string } };
      const prep = (await callTool("dohc_dataset", {
        request: {
          action: "prepareSchemaChange",
          workspaceId: "ws-everyday",
          datasetPath: "clients/dataset.json",
          revision: described.dataset.revision,
          revisionSha256: described.dataset.revisionSha256,
          change: { kind: "renameCollection", name: "Clients Renamed" },
        },
      })) as {
        preparationId: string;
        approvalDigest: string;
        revision: { revision: number; revisionSha256: string };
      };
      await callTool("dohc_dataset", {
        request: {
          action: "approveMigration",
          workspaceId: "ws-everyday",
          preparationId: prep.preparationId,
          revisionSha256: prep.revision.revisionSha256,
          approvalDigest: prep.approvalDigest,
        },
      });
      await callTool("dohc_write_file", {
        path: "apps/client-portal/app.publish.json",
        content: JSON.stringify(
          {
            version: 1,
            entryPath: "index.html",
            inputs: ["index.html"],
            packageMap: {},
            dataset: {
              kind: "dataset",
              datasetPath: "clients/dataset.json",
              revision: prep.revision.revision,
              revisionSha256: prep.revision.revisionSha256,
              operationIds: ["c1000000-0000-4000-8000-000000000006"],
            },
          },
          null,
          2,
        ),
      });
      const appPrep = (await callTool("dohc_publish_app", {
        request: {
          action: "prepareLocal",
          workspaceId: "ws-everyday",
          appRoot: "apps/client-portal",
        },
      })) as { approvalId: string; candidateDigest: string };
      await callTool("dohc_publish_app", {
        request: {
          action: "approve",
          workspaceId: "ws-everyday",
          approvalId: appPrep.approvalId,
          candidateDigest: appPrep.candidateDigest,
        },
      });
    });
    const renamedChecks = await grade(
      migrate.expect,
      renamedInsteadOfAddField.run,
      migrate.gradeRun,
    );
    expect(renamedChecks.some((c) => !c.pass && c.name.includes('"Tier"'))).toBe(true);
    expect(renamedChecks.some((c) => !c.pass && c.name.includes("3 seeded client records"))).toBe(
      true,
    );
    expect(
      renamedChecks.some(
        (c) => !c.pass && c.detail?.includes("remove revision and revisionSha256"),
      ),
    ).toBe(true);

    const form = EVERYDAY_CASES.find((c) => c.id === "everyday-connected-form-relations")!;
    const formSolved = await replay(form, "solution");
    const bogusManifest = JSON.parse(formSolved.run.files["apps/signup-form/app.publish.json"]!);
    bogusManifest.dataset.operationIds = [
      "e2000000-0000-4000-8000-000000000011",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ];
    const bogusFormRun: RunRecord = {
      ...formSolved.run,
      files: {
        ...formSolved.run.files,
        "apps/signup-form/app.publish.json": JSON.stringify(bogusManifest, null, 2),
      },
    };
    const formChecks = await grade(form.expect, bogusFormRun, form.gradeRun);
    expect(formChecks.some((c) => !c.pass && c.detail?.includes("not in approved"))).toBe(true);

    const staleManifest = JSON.parse(formSolved.run.files["apps/signup-form/app.publish.json"]!);
    expect(staleManifest.dataset.revision).toBeUndefined();
    expect(staleManifest.dataset.revisionSha256).toBeUndefined();
    staleManifest.dataset.revision = 1;
    staleManifest.dataset.revisionSha256 = "0".repeat(64);
    const staleFormRun: RunRecord = {
      ...formSolved.run,
      files: {
        ...formSolved.run.files,
        "apps/signup-form/app.publish.json": JSON.stringify(staleManifest, null, 2),
      },
    };
    const staleChecks = await grade(form.expect, staleFormRun, form.gradeRun);
    expect(staleChecks.some((c) => !c.pass && c.detail?.includes("stale revision"))).toBe(true);

    // Negative counterexamples for frontend verification binding and response handling.
    const skippedVerifyBooking: RunRecord = {
      ...bookingSolved.run,
      frontendVerifications: undefined,
    };
    const skippedVerifyChecks = await grade(booking.expect, skippedVerifyBooking, booking.gradeRun);
    expect(
      skippedVerifyChecks.some((c) => !c.pass && c.detail?.includes("verifyFrontend was not run")),
    ).toBe(true);

    const editedAfterVerifyBooking: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "apps/booking/app.js": `${bookingSolved.run.files["apps/booking/app.js"]}\n// edited after verify\n`,
      },
    };
    const editedAfterChecks = await grade(
      booking.expect,
      editedAfterVerifyBooking,
      booking.gradeRun,
    );
    expect(
      editedAfterChecks.some((c) => !c.pass && c.detail?.includes("source changed after")),
    ).toBe(true);

    const failedVerifyFinance: RunRecord = {
      ...financeSolved.run,
      frontendVerifications: {
        "apps/control-tower": {
          ...financeSolved.run.frontendVerifications!["apps/control-tower"]!,
          ok: false,
          stage: "runtime",
        },
      },
    };
    const failedVerifyChecks = await grade(finance.expect, failedVerifyFinance, finance.gradeRun);
    expect(
      failedVerifyChecks.some((c) => !c.pass && c.detail?.includes("verifyFrontend failed")),
    ).toBe(true);

    const noStepsBookingVerify: RunRecord = {
      ...bookingSolved.run,
      frontendVerifications: {
        "apps/booking": {
          ...bookingSolved.run.frontendVerifications!["apps/booking"]!,
          requestedSteps: [],
        },
      },
    };
    const noStepsChecks = await grade(booking.expect, noStepsBookingVerify, booking.gradeRun);
    expect(noStepsChecks.some((c) => !c.pass && c.detail?.includes("click.expectBackend"))).toBe(
      true,
    );

    const manifestOnlyEditBooking: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "apps/booking/broken.html": "<!doctype html><p>Broken</p>\n",
        "apps/booking/app.publish.json": JSON.stringify({
          ...JSON.parse(bookingSolved.run.files["apps/booking/app.publish.json"]!),
          entryPath: "broken.html",
        }),
      },
    };
    const manifestOnlyChecks = await grade(
      booking.expect,
      manifestOnlyEditBooking,
      booking.gradeRun,
    );
    expect(
      manifestOnlyChecks.some((c) => !c.pass && c.detail?.includes("source changed after")),
    ).toBe(true);

    const commentOnlyBooking: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "apps/booking/app.js":
          "// dohc-app-channel ports .onmessage backend.invoke bookSeat idempotencyKey addEventListener name seats\n",
      },
    };
    const commentOnlyChecks = await grade(booking.expect, commentOnlyBooking, booking.gradeRun);
    expect(commentOnlyChecks.some((c) => !c.pass)).toBe(true);

    const syntaxBrokenBooking: RunRecord = {
      ...bookingSolved.run,
      files: {
        ...bookingSolved.run.files,
        "apps/booking/app.js": `${bookingSolved.run.files["apps/booking/app.js"]}\nconst = ;\n`,
      },
    };
    const syntaxBrokenChecks = await grade(booking.expect, syntaxBrokenBooking, booking.gradeRun);
    expect(syntaxBrokenChecks.some((c) => !c.pass && c.detail?.includes("syntax error"))).toBe(
      true,
    );

    const observedWithoutBookSeat: RunRecord = {
      ...bookingSolved.run,
      frontendVerifications: {
        "apps/booking": {
          ...bookingSolved.run.frontendVerifications!["apps/booking"]!,
          mode: "observed",
          brokerCalls: [],
          steps: [{ index: 0, kind: "waitFor", ok: true }],
        },
      },
    };
    const observedWithoutBookChecks = await grade(
      booking.expect,
      observedWithoutBookSeat,
      booking.gradeRun,
    );
    expect(
      observedWithoutBookChecks.some(
        (c) => !c.pass && c.detail?.includes("observed verifyFrontend"),
      ),
    ).toBe(true);

    const fireAndForgetFinance: RunRecord = {
      ...financeSolved.run,
      files: {
        ...financeSolved.run.files,
        "apps/control-tower/app.js":
          'window.addEventListener("message", (e) => { if (e.data?.kind === "dohc-app-channel") e.ports[0]?.postMessage({ id: "r1", op: "backend.invoke", operation: "listExpenses", input: {}, idempotencyKey: "r1" }); });\n',
      },
    };
    const fireAndForgetChecks = await grade(finance.expect, fireAndForgetFinance, finance.gradeRun);
    expect(
      fireAndForgetChecks.some((c) => !c.pass && c.detail?.includes("port response handler")),
    ).toBe(true);
  });

  it("everydayDesktop verifyFrontend validates manifests/inputs without fabricating broker success and supports injected observed verifiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-eval-verify-"));
    const root = join(dir, "workspace");
    const home = join(dir, "home");
    const unansweredLog = join(dir, "unanswered.log");
    const recorded: Record<string, FrontendVerificationRecord> = {};
    try {
      await seedWorkspace(
        root,
        {
          ...EVERYDAY_CASES[0]!,
          files: {
            "comment-app/index.html":
              '<!doctype html><form><button type="submit">Go</button></form><div id="status">Booked</div>\n',
            "comment-app/app.js":
              "// dohc-app-channel ports .onmessage backend.invoke bookSeat preventDefault\n",
            "comment-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "index.html",
              inputs: ["index.html", "app.js"],
              packageMap: {},
            }),
            "ts-in-js-app/index.html":
              '<!doctype html><script type="module" src="./app.js"></script>\n',
            "ts-in-js-app/app.js": "const x: number = 1;\n",
            "ts-in-js-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "index.html",
              inputs: ["index.html", "app.js"],
              packageMap: {},
            }),
            "bad-tsx-app/index.html":
              '<!doctype html><script type="module" src="./app.tsx"></script>\n',
            "bad-tsx-app/app.tsx": "export function App() { return <div><span></div>; }\n",
            "bad-tsx-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "index.html",
              inputs: ["index.html", "app.tsx"],
              packageMap: {},
            }),
            "nested-ts-enum-app/ui/index.html":
              '<!doctype html><div id="booking:status">ok</div><script type="application/json">{"stop":"Kyoto"}</script><script nomodule src="./legacy.js"></script><script>const form = {}; form.onsubmit = (e) => e;</script><script type="module" src="./app.ts"></script>\n',
            "nested-ts-enum-app/ui/app.ts": "export enum SeatState { Open = 'open' }\n",
            "nested-ts-enum-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "ui/index.html",
              inputs: ["ui/index.html", "ui/app.ts"],
              packageMap: {},
            }),
            "inline-handler-app/index.html": '<!doctype html><button onclick="go()">Go</button>\n',
            "inline-handler-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "index.html",
              inputs: ["index.html"],
              packageMap: {},
            }),
            "syntax-err-app/index.html":
              '<!doctype html><div id="out">hi</div><script type="module" src="./app.js"></script>\n',
            "syntax-err-app/app.js": "const = ;\n",
            "syntax-err-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "index.html",
              inputs: ["index.html", "app.js"],
              packageMap: {},
            }),
            "missing-input-app/index.html":
              '<!doctype html><script type="module" src="./missing.js"></script>\n',
            "missing-input-app/app.publish.json": JSON.stringify({
              version: 1,
              entryPath: "index.html",
              inputs: ["index.html", "missing.js"],
              packageMap: {},
            }),
          },
        },
        home,
      );
      const answers = await createEverydayDesktop(
        root,
        { workspaceId: "ws-everyday" },
        {
          onFrontendVerified: (appRoot, record) => {
            recorded[appRoot] = record;
          },
        },
      );
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
      const client = new Client({ name: "eval-verify", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const commentRes = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "verifyFrontend",
            workspaceId: "ws-everyday",
            appRoot: "comment-app",
            steps: [
              {
                kind: "click",
                selector: "button",
                expectBackend: { op: "backend.invoke", operation: "bookSeat", status: 200 },
              },
              { kind: "waitFor", selector: "#status", textIncludes: "Booked" },
            ],
          },
        },
      });
      expect(commentRes.structuredContent).toMatchObject({
        kind: "frontendVerified",
        startupOk: false,
        stepsOk: false,
        handshake: { delivered: false, messageCount: 0 },
        brokerCalls: [],
        steps: [],
      });
      expect(recorded["comment-app"]?.mode).toBe("stand-in");
      expect(recorded["comment-app"]?.brokerCalls).toEqual([]);

      const nestedTsRes = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "verifyFrontend",
            workspaceId: "ws-everyday",
            appRoot: "nested-ts-enum-app",
            steps: [{ kind: "waitFor", selector: "#booking\\:status", textIncludes: "ok" }],
          },
        },
      });
      expect(nestedTsRes.isError).not.toBe(true);

      const inlineHandlerRes = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "verifyFrontend",
            workspaceId: "ws-everyday",
            appRoot: "inline-handler-app",
          },
        },
      });
      expect(inlineHandlerRes.isError).toBe(true);
      expect(JSON.stringify(inlineHandlerRes.structuredContent)).toContain("csp_violation");

      const tsInJsRes = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "verifyFrontend",
            workspaceId: "ws-everyday",
            appRoot: "ts-in-js-app",
          },
        },
      });
      expect(tsInJsRes.isError).toBe(true);
      expect(JSON.stringify(tsInJsRes.structuredContent)).toContain("compile_error");

      const badTsxRes = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: { action: "verifyFrontend", workspaceId: "ws-everyday", appRoot: "bad-tsx-app" },
        },
      });
      expect(badTsxRes.isError).toBe(true);
      expect(JSON.stringify(badTsxRes.structuredContent)).toContain("compile_error");

      // Approving a local publication pins its snapshot so breaking the live working copy does not fail publicationId verification.
      const prepNested = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "prepareLocal",
            workspaceId: "ws-everyday",
            appRoot: "nested-ts-enum-app",
          },
        },
      });
      const prepBody = prepNested.structuredContent as {
        approvalId: string;
        candidateDigest: string;
      };
      const approvedNested = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "approve",
            workspaceId: "ws-everyday",
            approvalId: prepBody.approvalId,
            candidateDigest: prepBody.candidateDigest,
          },
        },
      });
      const pubId = (approvedNested.structuredContent as { publicationId: string }).publicationId;
      await writeFile(join(root, "nested-ts-enum-app", "ui", "app.ts"), "const = ;\n", "utf8");
      const pubVerifyAfterEdit = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: { action: "verifyFrontend", workspaceId: "ws-everyday", publicationId: pubId },
        },
      });
      expect(pubVerifyAfterEdit.isError).not.toBe(true);

      const syntaxRes = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "verifyFrontend",
            workspaceId: "ws-everyday",
            appRoot: "syntax-err-app",
          },
        },
      });
      expect(syntaxRes.isError).toBe(true);
      expect(JSON.stringify(syntaxRes.structuredContent)).toContain("compile_error");

      const missingRes = await client.callTool({
        name: "dohc_publish_app",
        arguments: {
          request: {
            action: "verifyFrontend",
            workspaceId: "ws-everyday",
            appRoot: "missing-input-app",
          },
        },
      });
      expect(missingRes.isError).toBe(true);
      expect(JSON.stringify(missingRes.structuredContent)).toContain("missing_input");

      const argv = evalServerArgs({
        caseId: "everyday-booking-capacity-app",
        root,
        unansweredLog,
        home,
        writesLog: join(dir, "writes.log"),
        snapshotsFile: join(dir, "datasets.json"),
        verificationsFile: join(dir, "verifications.json"),
      });
      expect(argv[argv.length - 1]).toBe(join(dir, "verifications.json"));
      await writeFile(join(dir, "verifications.json"), JSON.stringify(recorded), "utf8");
      expect(
        await readEvalJsonRecord<FrontendVerificationRecord>(join(dir, "verifications.json")),
      ).toEqual(recorded);

      await client.close();
      await server.close();

      // Injected desktop verifier returning an engine-style sourceRevision must pass final-source grading
      // because everydayDesktop computes sourceRevision with the same canonical hash as the grader.
      const bookingCase = EVERYDAY_CASES.find((c) => c.id === "everyday-booking-capacity-app")!;
      const injectedDir = await mkdtemp(join(tmpdir(), "dohc-eval-injected-"));
      try {
        const injRoot = join(injectedDir, "workspace");
        const injHome = join(injectedDir, "home");
        const injLog = join(injectedDir, "unanswered.log");
        const injVerifications: Record<string, FrontendVerificationRecord> = {};
        await seedWorkspace(injRoot, bookingCase, injHome);
        const injAnswers = await createEverydayDesktop(
          injRoot,
          { workspaceId: "ws-everyday" },
          {
            onFrontendVerified: (appRoot, record) => {
              injVerifications[appRoot] = record;
            },
            verifyFrontend: async (req) => ({
              kind: "frontendVerified",
              ok: true,
              stage: "complete",
              target: {
                kind: "candidate",
                appRoot: req.appRoot ?? "apps/booking",
                sourceRevision: "f".repeat(64),
              },
              startupOk: true,
              stepsOk: true,
              handshake: { delivered: true, messageCount: 2 },
              brokerCalls: [
                { op: "backend.invoke", operation: "bookSeat", status: 200, ok: true },
                {
                  op: "backend.invoke",
                  operation: "bookSeat",
                  status: 409,
                  ok: false,
                  rejectedBy: "backend",
                  reasonCode: "refused",
                  refusalCode: "workshop_full",
                },
              ],
              steps: (req.steps ?? []).map((step, index) => ({
                index,
                kind: step.kind,
                ok: true,
              })),
              diagnostics: [],
              externalRequestsBlocked: 0,
            }),
          },
        );
        const injDesktop = fakeDesktop({
          root: injRoot,
          answers: injAnswers,
          unansweredLog: injLog,
        });
        const injServer = createDohcMcpServer({
          root: injRoot,
          home: injHome,
          request: injDesktop,
        });
        const injClient = new Client({ name: "eval-injected", version: "1" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([injServer.connect(st), injClient.connect(ct)]);
        const injCalls: RunRecord["calls"] = [];
        await bookingCase.solution.run!(async (tool, args) => {
          const res = await injClient.callTool({ name: tool, arguments: args });
          injCalls.push({ tool, args, ok: res.isError !== true });
          return (res.structuredContent as Record<string, unknown> | undefined) ?? {};
        });
        await injClient.close();
        await injServer.close();
        const injRun: RunRecord = {
          calls: injCalls,
          text: bookingCase.solution.text ?? "",
          files: await workspaceFiles(injRoot),
          frontendVerifications: injVerifications,
        };
        expect(injVerifications["apps/booking"]?.mode).toBe("observed");
        const injChecks = await grade(bookingCase.expect, injRun, bookingCase.gradeRun);
        expect(injChecks.filter((c) => !c.pass)).toEqual([]);

        // Inert JSON data blocks in index.html must not trigger JS syntax failures in the booking grader.
        const withJsonDataBlock: RunRecord = {
          ...injRun,
          files: {
            ...injRun.files,
            "apps/booking/index.html": `${injRun.files["apps/booking/index.html"]}<script type="application/json">{"stop":"Kyoto"}</script>`,
          },
        };
        const jsonDataChecks = await grade(
          bookingCase.expect,
          withJsonDataBlock,
          bookingCase.gradeRun,
        );
        const bookingFrontendCheck = jsonDataChecks.find(
          (c) =>
            c.name ===
            "apps/booking frontend provides booking controls wired to dohc-app-channel bookSeat",
        );
        expect(bookingFrontendCheck?.pass).toBe(true);

        // Mid-verify workspace edit must invalidate the observed sourceRevision binding.
        const raceVerifications: Record<string, FrontendVerificationRecord> = {};
        const raceAnswers = await createEverydayDesktop(
          injRoot,
          { workspaceId: "ws-everyday" },
          {
            onFrontendVerified: (appRoot, record) => {
              raceVerifications[appRoot] = record;
            },
            verifyFrontend: async (req) => {
              await writeFile(
                join(injRoot, "apps", "booking", "app.js"),
                `${await readFile(join(injRoot, "apps", "booking", "app.js"), "utf8")}\n// mutated mid-verify\n`,
                "utf8",
              );
              return {
                kind: "frontendVerified",
                ok: true,
                stage: "complete",
                target: { kind: "candidate", appRoot: req.appRoot ?? "apps/booking" },
                startupOk: true,
                stepsOk: true,
                handshake: { delivered: true, messageCount: 1 },
                brokerCalls: [],
                steps: [],
                diagnostics: [],
                externalRequestsBlocked: 0,
              };
            },
          },
        );
        const raceDesktop = fakeDesktop({
          root: injRoot,
          answers: raceAnswers,
          unansweredLog: injLog,
        });
        const raceServer = createDohcMcpServer({
          root: injRoot,
          home: injHome,
          request: raceDesktop,
        });
        const raceClient = new Client({ name: "eval-race", version: "1" });
        const [rct, rst] = InMemoryTransport.createLinkedPair();
        await Promise.all([raceServer.connect(rst), raceClient.connect(rct)]);
        await raceClient.callTool({
          name: "dohc_publish_app",
          arguments: {
            request: {
              action: "verifyFrontend",
              workspaceId: "ws-everyday",
              appRoot: "apps/booking",
            },
          },
        });
        await raceClient.close();
        await raceServer.close();
        expect(raceVerifications["apps/booking"]?.sourceRevision).toBeUndefined();
      } finally {
        await rm(injectedDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const drift = EVERYDAY_CASES.find((c) => c.id === "everyday-bound-app-migration-drift")!;
    const driftSolved = await replay(drift, "solution");
    const leakedForm = JSON.parse(driftSolved.run.files["apps/pledge-form/app.publish.json"]!);
    leakedForm.dataset.operationIds = [
      "f5000000-0000-4000-8000-000000000006",
      "f5000000-0000-4000-8000-000000000007",
    ];
    const leakedDriftChecks = await grade(
      drift.expect,
      {
        ...driftSolved.run,
        files: {
          ...driftSolved.run.files,
          "apps/pledge-form/app.publish.json": JSON.stringify(leakedForm, null, 2),
        },
      },
      drift.gradeRun,
    );
    expect(leakedDriftChecks.some((c) => !c.pass && c.detail?.includes("leaked owner-only"))).toBe(
      true,
    );

    const onlyOneAppApproved = await replay(drift, "solution", async (callTool) => {
      const described = (await callTool("dohc_dataset", {
        request: {
          action: "describe",
          workspaceId: "ws-everyday",
          datasetPath: "fundraiser/dataset.json",
        },
      })) as { dataset: { revision: number; revisionSha256: string } };
      const prep = (await callTool("dohc_dataset", {
        request: {
          action: "prepareSchemaChange",
          workspaceId: "ws-everyday",
          datasetPath: "fundraiser/dataset.json",
          revision: described.dataset.revision,
          revisionSha256: described.dataset.revisionSha256,
          change: {
            kind: "addField",
            tableId: "f5000000-0000-4000-8000-000000000002",
            field: { name: "Notes", type: "text", required: false, unique: false },
          },
        },
      })) as {
        preparationId: string;
        approvalDigest: string;
        revision: { revisionSha256: string };
      };
      await callTool("dohc_dataset", {
        request: {
          action: "approveMigration",
          workspaceId: "ws-everyday",
          preparationId: prep.preparationId,
          revisionSha256: prep.revision.revisionSha256,
          approvalDigest: prep.approvalDigest,
        },
      });
      const localPrep = (await callTool("dohc_publish_app", {
        request: { action: "prepareLocal", workspaceId: "ws-everyday", appRoot: "apps/organizer" },
      })) as { approvalId: string; candidateDigest: string };
      await callTool("dohc_publish_app", {
        request: {
          action: "approve",
          workspaceId: "ws-everyday",
          approvalId: localPrep.approvalId,
          candidateDigest: localPrep.candidateDigest,
        },
      });
      await callTool("dohc_publish_app", {
        request: {
          action: "prepare",
          workspaceId: "ws-everyday",
          appRoot: "apps/pledge-form",
          shareId: "share_pledge",
          grantId: "grant_pledge",
        },
      });
      await callTool("dohc_dataset", {
        request: {
          action: "permissions",
          workspaceId: "ws-everyday",
          datasetPath: "fundraiser/dataset.json",
        },
      });
    });
    const oneAppChecks = await grade(drift.expect, onlyOneAppApproved.run, drift.gradeRun);
    expect(
      oneAppChecks.some(
        (c) => !c.pass && c.name.includes("apps/pledge-form share-link publication is approved"),
      ),
    ).toBe(true);

    const withdrawnLinkApp = await replay(drift, "solution", async (callTool) => {
      await drift.solution.run!(callTool);
      const listed = (await callTool("dohc_publish_app", {
        request: { action: "list", workspaceId: "ws-everyday", appRoot: "apps/pledge-form" },
      })) as {
        publications: Array<{ publicationId: string; authorityRevision: number; active: boolean }>;
      };
      for (const pub of listed.publications) {
        if (!pub.active) continue;
        await callTool("dohc_publish_app", {
          request: {
            action: "withdraw",
            workspaceId: "ws-everyday",
            publicationId: pub.publicationId,
            expectedAuthorityRevision: pub.authorityRevision,
          },
        });
      }
    });
    const withdrawnChecks = await grade(drift.expect, withdrawnLinkApp.run, drift.gradeRun);
    expect(
      withdrawnChecks.some(
        (c) => !c.pass && c.name.includes("apps/pledge-form share-link publication is approved"),
      ),
    ).toBe(true);

    const leakedSnapshot = structuredClone(driftSolved.run.datasetSnapshots!);
    // The older publication is also listed, as needs-refresh; leak into the current one.
    const linkEntry = leakedSnapshot["fundraiser/dataset.json"]!.boundApps!.find(
      (app) =>
        app.scope === "link" && app.appRoot === "apps/pledge-form" && app.status === "compatible",
    )!;
    linkEntry.operationIds = [
      "f5000000-0000-4000-8000-000000000006",
      "f5000000-0000-4000-8000-000000000007",
    ];
    const leakedSnapshotChecks = await grade(
      drift.expect,
      { ...driftSolved.run, datasetSnapshots: leakedSnapshot },
      drift.gradeRun,
    );
    expect(
      leakedSnapshotChecks.some(
        (c) => !c.pass && c.name.includes("apps/pledge-form share-link publication is approved"),
      ),
    ).toBe(true);
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

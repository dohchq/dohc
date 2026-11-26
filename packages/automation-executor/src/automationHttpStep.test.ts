import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { checkAutomationReach, type ReachRoster } from "./automationReach";
import { createAutomationRunStore } from "./automationRunStore";
import { createAutomationTargets } from "./automationTargets";
import {
  runCollectionAutomation,
  type CollectionAutomationRunDependencies,
} from "./collectionAutomationRun";
import { undoCollectionAutomationRuns } from "./collectionAutomationUndo";
import {
  CollectionAutomations,
  HttpStepSecretProblemError,
  type CollectionAutomationEngine,
  type CollectionHttpApprovalGate,
} from "./collectionAutomations";
import { AutomationRunWait } from "./automationRunWait";
import { createTestScratch, testStoreFolder } from "./testScratch";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { WorkspaceSecretSummary } from "@dohc/workspace-contracts/workspace-secrets";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const everyDigest = { has: () => true } as unknown as ReadonlySet<string>;
const HOOK_SECRETS: WorkspaceSecretSummary[] = [
  {
    name: "API_TOKEN",
    usage: "http-header",
    allowedHosts: ["hooks.slack.com"],
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  },
  {
    name: "SLACK_HOOK",
    usage: "http-url",
    allowedHosts: [],
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  },
];

const HOOK_YAML = `version: 1
automations:
  - id: send-hook
    name: Send webhook
    when: record-added
    do:
      - run-file: helper.js
        as: computed
      - http:
          secret: SLACK_HOOK
        headers:
          X-Computed: '=computed'
        secret-headers:
          Authorization:
            secret: API_TOKEN
            prefix: 'Bearer '
        body:
          title: '=record.Title'
          note: '=computed'
`;

function makeMockEngine() {
  return {
    listCollections: async () => ({
      collections: [{ path: "Tasks", objectId: "Tasks", status: "valid", reasons: [] }],
    }),
    subscribeAutomation: async () => {},
    releaseAutomationGroups: async () => ({
      watchedGeneration: 0,
      handover: { floorMs: 0, automations: [] },
    }),
    claimNextAutomation: async () => null,
    getCollectionRecord: async () => ({
      record: {
        recordId: "rec-1",
        path: "Tasks/one.md",
        fields: { Title: "Hello" },
        history: [],
      },
    }),
    queryCollectionRecords: async () => ({ records: [] }),
    getAutomationClaim: async () => null,
    listAutomationClaims: async () => ({ claims: [], next: null }),
    listAutomationFailures: async () => ({ failures: [] }),
    pruneAutomationHistory: async () => ({ pruned: 0, more: false }),
  } as unknown as CollectionAutomationEngine;
}

describe("automation http steps", () => {
  it("allows http steps only in private solo Collections and stops them when anyone else has edit access", () => {
    const soloRoster: ReachRoster = { kind: "owner", ownerUserId: "owner", grants: [] };
    const sharedEditRoster: ReachRoster = {
      kind: "owner",
      ownerUserId: "owner",
      grants: [
        {
          grantId: "g-1",
          recipientUserId: "user-alex",
          recipientEmail: "alex@example.com",
          files: { paths: ["Tasks"], versionId: null, access: "edit" },
          chat: null,
        },
      ],
    };
    const sharedViewRoster: ReachRoster = {
      kind: "owner",
      ownerUserId: "owner",
      grants: [
        {
          grantId: "g-2",
          recipientUserId: "user-alex",
          recipientEmail: "alex@example.com",
          files: { paths: ["Tasks"], versionId: null, access: "view" },
          chat: null,
        },
      ],
    };

    const automation = {
      id: "send-hook",
      collection: { path: "Tasks", name: "Tasks" },
      codeFiles: [],
      steps: [{ kind: "http" as const, target: "hooks.example.com", stepOrdinal: 0 }],
    };

    expect(checkAutomationReach(soloRoster, automation)).toEqual([{ allowed: true }]);
    expect(checkAutomationReach(sharedViewRoster, automation)).toEqual([{ allowed: true }]);
    const [stopped] = checkAutomationReach(sharedEditRoster, automation);
    expect(stopped?.allowed).toBe(false);
    if (stopped && !stopped.allowed) {
      expect(stopped.reason).toContain("webhook");
      expect(stopped.reason).toContain("alex@example.com");
    }
  });

  it("holds new http steps behind external approval even if reachVerdicts.json is tampered, confirms them, and invalidates approval when a run-file script changes", async () => {
    const dir = await createTestScratch("dohc-http-hold-");
    const store = createAutomationRunStore(testStoreFolder(dir));
    const evaluator = createAutomationFormulaEvaluator();
    const files = new Map<string, string>([
      ["Tasks/automations.yaml", HOOK_YAML],
      ["Tasks/helper.js", 'export default () => "v1";'],
    ]);
    const approvedDigests = new Set<string>();
    let secrets = HOOK_SECRETS;
    const httpApprovals: CollectionHttpApprovalGate = {
      read: async () => ({ approved: approvedDigests, secrets }),
      approve: async (input) => {
        approvedDigests.add(input.approvalDigest);
      },
    };
    const roster: ReachRoster = { kind: "owner", ownerUserId: "owner", grants: [] };
    const engine = makeMockEngine();

    const makeExecutor = () =>
      new CollectionAutomations({
        withEngine: async (work) => work(engine),
        withRecordWrites: async () => {
          throw Error("unexpected write");
        },
        withUndoWrites: async () => {
          throw Error("unexpected undo");
        },
        readText: async (path) => {
          const text = files.get(path);
          return text === undefined ? null : { text, truncated: false, contentHash: sha256(text) };
        },
        writeText: async () => ({ status: "conflict" }),
        pathExists: async (path) => files.has(path),
        roster: async () => roster,
        cachedRoster: async () => roster,
        evaluator: evaluator.forWorkspace("ws-1"),
        store,
        personName: (id) => id,
        withDatasetHost: async () => null,
        groupHost: async () => null,
        groupRelayRecord: async () => ({ generation: 0, handover: null }),
        reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
        groupMessagesSkipped: async () => {},
        requestHost: async () => {},
        readMessageBody: async () => null,
        chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} },
        postNotice: async () => {},
        mayRetryPress: async () => false,
        onPressSettled: () => {},
        onPressWaiting: () => {},
        onRunsChanged: () => {},
        reportFailure: async () => {},
        withdrawFailure: async () => {},
        onSwitchedOff: () => {},
        onHoldsChanged: () => {},
        onAutomationsChanged: () => {},
        onError: (_where, error) => {
          throw error;
        },
        httpApprovals,
        nowMs: () => 1_000,
      });

    try {
      const first = makeExecutor();
      await first.open();
      const listed1 = await first.automationsIn("Tasks");
      expect(listed1.status).toBe("read");
      if (listed1.status !== "read" || !listed1.automations[0]?.valid)
        throw Error("expected valid");
      const auto1 = listed1.automations[0];
      expect(auto1.reach.kind).toBe("checked");
      if (auto1.reach.kind !== "checked") throw Error("expected checked");
      const httpVerdict1 = auto1.reach.steps.find((s) => s.verdict === "held");
      expect(httpVerdict1).toMatchObject({
        verdict: "held",
        action: "send-http",
        target: "secret SLACK_HOOK",
      });

      const verdictsPath = await first.reachVerdictsPath();
      const tampered = JSON.parse(await readFile(verdictsPath, "utf8")) as {
        verdicts: Array<{ verdict: string } & Record<string, unknown>>;
      };
      tampered.verdicts = tampered.verdicts.map((entry) => ({ ...entry, verdict: "allowed" }));
      await writeFile(verdictsPath, JSON.stringify(tampered), "utf8");
      await first.dispose();

      const afterTamper = makeExecutor();
      await afterTamper.open();
      const listed2 = await afterTamper.automationsIn("Tasks");
      if (listed2.status !== "read" || !listed2.automations[0]?.valid)
        throw Error("expected valid");
      const auto2 = listed2.automations[0];
      expect(auto2.reach.kind).toBe("checked");
      if (auto2.reach.kind !== "checked") throw Error("expected checked");
      const heldAfterTamper = auto2.reach.steps.find((s) => s.verdict === "held");
      expect(heldAfterTamper).toMatchObject({ verdict: "held", action: "send-http" });

      const confirmed = await afterTamper.confirmReach({
        automationId: auto2.automationId,
        definitionHash: auto2.definitionHash,
        step: heldAfterTamper!.step,
        seq: heldAfterTamper!.seq,
      });
      expect(confirmed).toBe("confirmed");
      expect(approvedDigests.size).toBe(1);

      const listed3 = await afterTamper.automationsIn("Tasks");
      if (listed3.status !== "read" || !listed3.automations[0]?.valid)
        throw Error("expected valid");
      expect(listed3.automations[0].reach).toEqual({
        kind: "checked",
        steps: [{ verdict: "allowed" }, { verdict: "allowed" }],
      });

      const listedReach = async () => {
        const listed = await afterTamper.automationsIn("Tasks");
        if (listed.status !== "read" || !listed.automations[0]?.valid)
          throw Error("expected valid");
        return listed.automations[0];
      };
      const replaceSecret = (name: string, change: Partial<WorkspaceSecretSummary>) => {
        secrets = secrets.map((secret) =>
          secret.name === name ? { ...secret, ...change } : secret,
        );
      };
      replaceSecret("API_TOKEN", { generation: 5 });
      expect((await listedReach()).reach).toEqual({
        kind: "checked",
        steps: [{ verdict: "allowed" }, { verdict: "allowed" }],
      });
      replaceSecret("SLACK_HOOK", { generation: 2 });
      const afterNewLink = await listedReach();
      if (afterNewLink.reach.kind !== "checked") throw Error("expected checked");
      expect(afterNewLink.reach.steps.find((s) => s.verdict === "held")).toMatchObject({
        verdict: "held",
        action: "send-http",
      });
      const withLink = secrets;
      secrets = secrets.filter((secret) => secret.name !== "SLACK_HOOK");
      const withoutLink = await listedReach();
      if (withoutLink.reach.kind !== "checked") throw Error("expected checked");
      const heldForLink = withoutLink.reach.steps.find((s) => s.verdict === "held");
      await expect(
        afterTamper.confirmReach({
          automationId: withoutLink.automationId,
          definitionHash: withoutLink.definitionHash,
          step: heldForLink!.step,
          seq: heldForLink!.seq,
        }),
      ).rejects.toEqual(
        new HttpStepSecretProblemError(
          "Add the secret SLACK_HOOK in Settings, then allow this step.",
        ),
      );
      secrets = withLink;
      const beforeAllow = await listedReach();
      if (beforeAllow.reach.kind !== "checked") throw Error("expected checked");
      const heldAgain = beforeAllow.reach.steps.find((s) => s.verdict === "held");
      expect(
        await afterTamper.confirmReach({
          automationId: beforeAllow.automationId,
          definitionHash: beforeAllow.definitionHash,
          step: heldAgain!.step,
          seq: heldAgain!.seq,
        }),
      ).toBe("confirmed");
      expect((await listedReach()).reach).toEqual({
        kind: "checked",
        steps: [{ verdict: "allowed" }, { verdict: "allowed" }],
      });

      files.set("Tasks/helper.js", 'export default () => "v2-tampered";');
      afterTamper.handleWatcherEvents([{ operation: "update", path: "Tasks/helper.js" }]);
      const listed4 = await afterTamper.automationsIn("Tasks");
      if (listed4.status !== "read" || !listed4.automations[0]?.valid)
        throw Error("expected valid");
      expect(listed4.automations[0].reach.kind).toBe("checked");
      if (listed4.automations[0].reach.kind !== "checked") throw Error("expected checked");
      expect(listed4.automations[0].reach.steps.some((s) => s.verdict === "held")).toBe(true);
      await afterTamper.dispose();
    } finally {
      await evaluator.close();
    }
  });

  it("persists v13 http-sent receipts without secrets, refuses crash auto-resend and depth >= 4, and reports webhooksSent on Undo", async () => {
    const dir = await createTestScratch("dohc-http-run-");
    const store = createAutomationRunStore(testStoreFolder(dir));
    const evaluator = createAutomationFormulaEvaluator();
    const yaml = `version: 1
automations:
  - id: send-hook
    name: Send webhook
    when: record-added
    do:
      - http:
          secret: SLACK_HOOK
        headers:
          X-Title: '=record.Title'
        secret-headers:
          Authorization:
            secret: API_TOKEN
            prefix: 'Bearer '
        body:
          title: '=record.Title'
`;
    const parsed = parseAutomationsFile(yaml);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("bad yaml");
    const automation = parsed.entries[0].automation;

    const executeMock = vi.fn(async () => ({ ok: true as const, status: 200 }));
    const roster: Exclude<ReachRoster, { kind: "unknown" }> = {
      kind: "owner",
      ownerUserId: "owner",
      grants: [],
    };
    const deps: CollectionAutomationRunDependencies = {
      makeDurable: async () => {},
      isButtonField: async () => false,
      withReads: async (work) =>
        work({
          getCollectionRecord: async () =>
            ({
              record: {
                id: "rec-1",
                path: "Tasks/one.md",
                values: [{ field: "Title", value: "Launch" }],
              },
            }) as never,
          queryCollectionRecords: async () => ({ records: [] }) as never,
        }),
      withRecordWrites: async (_signal, work) =>
        work({
          setFields: async () => ({ replaced: {}, kept: {} }),
          create: async () => ({ path: "Tasks/x.md", recordId: "x" }),
        }),
      collectionIdOf: (path) => (path === "Tasks" ? "Tasks" : null),
      collectionPathOf: (id) => (id === "Tasks" ? "Tasks" : null),
      targets: createAutomationTargets({
        revisionOf: () => 0,
        isCollection: (path) => path === "Tasks",
        readText: async () => null,
        readSchemaFields: async () => new Set(["Title"]),
        withHost: async () => null,
      }),
      readCode: async () => null,
      personName: (id) => id,
      evaluator: evaluator.forWorkspace("ws-1"),
      store,
      nowMs: () => 1_000,
      chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} },
      postNotice: async () => {},
      readMessageBody: async () => null,
      recipientVerdicts: async () => [],
      readHttpApprovals: async () => ({ approved: everyDigest, secrets: HOOK_SECRETS }),
      httpWebhook: { execute: executeMock },
    };

    const claim: AutomationClaim = {
      claimId: "claim-http-1",
      automationId: "collection:Tasks#send-hook",
      trigger: { historyId: 1 },
      recordId: "rec-1",
      collectionPath: "Tasks",
      depth: 0,
      change: {
        kind: "added",
        authorOriginId: null,
        onBehalfOf: null,
        actorKind: "human",
        sharedAuthor: null,
        liveCursor: null,
        fields: [],
        fieldsOmitted: 0,
      },
      state: "running",
      attempts: 1,
      run: 1,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    };

    try {
      const outcome = await runCollectionAutomation(deps, {
        claim,
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      });

      expect(outcome).toEqual({ kind: "done" });
      expect(executeMock).toHaveBeenCalledTimes(1);

      const savedRuns = await store.runsOf(claim.automationId, claim.claimId);
      const savedRun = savedRuns.runs[0]!;
      expect(savedRun.applied[0]?.writes).toEqual([
        {
          kind: "http-sent",
          target: "secret SLACK_HOOK",
          status: 200,
          deliveryId: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
      const serialized = JSON.stringify(savedRun);
      expect(serialized).toContain('"secret":"SLACK_HOOK"');
      expect(serialized).toContain('"secret":"API_TOKEN"');
      expect(serialized).not.toContain("https://");

      const { undone } = await undoCollectionAutomationRuns(
        {
          withReads: deps.withReads,
          withRecordWrites: deps.withRecordWrites,
          trash: async () => {},
          collectionPathOf: deps.collectionPathOf,
        },
        [savedRun],
        new AbortController().signal,
      );
      expect(undone.webhooksSent).toBe(1);

      const deepOutcome = await runCollectionAutomation(deps, {
        claim: { ...claim, claimId: "claim-http-deep", depth: 4 },
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      });
      expect(deepOutcome.kind).toBe("failed");
      expect(executeMock).toHaveBeenCalledTimes(1);

      // Pre-send refusal (beforeSend: true) can be retried after fixing the precondition.
      let attempt = 0;
      const retryExecuteMock = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false as const,
            reason: "Sync this workspace first.",
            beforeSend: true,
          };
        }
        return { ok: true as const, status: 204 };
      });
      const retryDeps: CollectionAutomationRunDependencies = {
        ...deps,
        httpWebhook: { execute: retryExecuteMock },
      };
      const retryClaim: AutomationClaim = {
        ...claim,
        claimId: "claim-http-retry-before-send",
        attempts: 1,
        run: 1,
      };
      const firstRefusal = await runCollectionAutomation(retryDeps, {
        claim: retryClaim,
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      });
      expect(firstRefusal).toMatchObject({ kind: "failed", error: "Sync this workspace first." });
      expect(retryExecuteMock).toHaveBeenCalledTimes(1);

      const retriedSuccess = await runCollectionAutomation(retryDeps, {
        claim: { ...retryClaim, attempts: 2, run: 2 },
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      });
      expect(retriedSuccess).toEqual({ kind: "done" });
      expect(retryExecuteMock).toHaveBeenCalledTimes(2);

      // Script bytes changing between run-file execution and http dispatch must fail closed without sending.
      const scriptYaml = `version: 1
automations:
  - id: script-then-hook
    name: Script then hook
    when: record-added
    do:
      - run-file: helper.js
        as: out
      - http: https://api.example.com/hook
        body:
          val: '=out'
`;
      const scriptParsed = parseAutomationsFile(scriptYaml);
      if (scriptParsed.status !== "read" || scriptParsed.entries[0]?.status !== "valid") {
        throw Error("bad script yaml");
      }
      const scriptAutomation = scriptParsed.entries[0].automation;
      let scriptReads = 0;
      const scriptSendMock = vi.fn(async () => ({ ok: true as const, status: 200 }));
      const tamperedScriptOutcome = await runCollectionAutomation(
        {
          ...deps,
          readCode: async (path) => {
            if (path !== "Tasks/helper.js") return null;
            scriptReads += 1;
            return {
              text: scriptReads === 1 ? "return { output: 'v1' };" : "return { output: 'v2' };",
              truncated: false,
            };
          },
          httpWebhook: { execute: scriptSendMock },
        },
        {
          claim: { ...claim, claimId: "claim-http-script-changed" },
          automation: scriptAutomation,
          collection: { path: "Tasks", name: "Tasks" },
          roster,
          signal: new AbortController().signal,
          stopped: new AbortController().signal,
        },
      );
      expect(tamperedScriptOutcome.kind).toBe("failed");
      if (tamperedScriptOutcome.kind === "failed") {
        expect(tamperedScriptOutcome.error).toContain("changed after it ran");
      }
      expect(scriptSendMock).not.toHaveBeenCalled();

      // Pre-send roster wait during apply() sets httpRefusedBeforeSend so resume succeeds instead of failing uncertainly.
      let rosterChecks = 0;
      const rosterWaitSend = vi.fn(async () => ({ ok: true as const, status: 201 }));
      const rosterWaitClaim: AutomationClaim = {
        ...claim,
        claimId: "claim-http-roster-wait",
        attempts: 1,
        run: 1,
      };
      const firstRosterWait = await runCollectionAutomation(
        {
          ...deps,
          cachedRoster: async () => {
            rosterChecks += 1;
            if (rosterChecks === 1) {
              throw new AutomationRunWait("Waiting for roster.", "roster");
            }
            return roster;
          },
          httpWebhook: { execute: rosterWaitSend },
        },
        {
          claim: rosterWaitClaim,
          automation,
          collection: { path: "Tasks", name: "Tasks" },
          roster,
          signal: new AbortController().signal,
          stopped: new AbortController().signal,
        },
      );
      expect(firstRosterWait).toEqual({ kind: "wait", reason: "roster" });
      expect(rosterWaitSend).not.toHaveBeenCalled();

      const resumedAfterRoster = await runCollectionAutomation(
        {
          ...deps,
          cachedRoster: async () => roster,
          httpWebhook: { execute: rosterWaitSend },
        },
        {
          claim: { ...rosterWaitClaim, attempts: 2, run: 1 },
          automation,
          collection: { path: "Tasks", name: "Tasks" },
          roster,
          signal: new AbortController().signal,
          stopped: new AbortController().signal,
        },
      );
      expect(resumedAfterRoster).toEqual({ kind: "done" });
      expect(rosterWaitSend).toHaveBeenCalledTimes(1);

      // Crash resume (effect already saved in steps without applied receipt) refuses automatic resend.
      const crashClaim: AutomationClaim = {
        ...claim,
        claimId: "claim-http-crash",
        attempts: 2,
        run: 1,
      };
      await store.save({
        ...savedRun,
        claimId: crashClaim.claimId,
        applied: [],
        outcome: null,
        finishedAtMs: null,
        durableEffects: 0,
      });
      const resumeOutcome = await runCollectionAutomation(deps, {
        claim: crashClaim,
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      });
      expect(resumeOutcome.kind).toBe("failed");
      if (resumeOutcome.kind === "failed") {
        expect(resumeOutcome.error).toContain("did not send it again");
      }
      expect(executeMock).toHaveBeenCalledTimes(1);
    } finally {
      await evaluator.close();
    }
  });

  it("fetches JSON with GET, writes a field from it, keeps it out of history, and fetches again after an unrecorded GET", async () => {
    const dir = await createTestScratch("dohc-http-fetch-");
    const store = createAutomationRunStore(testStoreFolder(dir));
    const evaluator = createAutomationFormulaEvaluator();
    const yaml = `version: 1
automations:
  - id: pull-stats
    name: Pull stats
    when: record-added
    do:
      - http: https://api.example.com/stats
        method: GET
        secret-headers:
          Authorization:
            secret: STATS_KEY
            prefix: 'Bearer '
        as: stats
      - set:
          Count: '=stats.results[0].count'
`;
    const parsed = parseAutomationsFile(yaml);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("bad yaml");
    const automation = parsed.entries[0].automation;
    const roster: Exclude<ReachRoster, { kind: "unknown" }> = {
      kind: "owner",
      ownerUserId: "owner",
      grants: [],
    };
    const written: Array<Record<string, unknown>> = [];
    let busyWrites = 0;
    let failedWrites = 0;
    const execute = vi.fn(async (_input: { method: string; readResponse: boolean }) => ({
      ok: true as const,
      status: 200,
      response: { results: [{ count: 42 }] },
    }));
    const deps: CollectionAutomationRunDependencies = {
      makeDurable: async () => {},
      isButtonField: async () => false,
      withReads: async (work) =>
        work({
          getCollectionRecord: async () =>
            ({
              record: {
                id: "rec-1",
                path: "Tasks/one.md",
                values: [{ field: "Count", value: null }],
              },
            }) as never,
          queryCollectionRecords: async () => ({ records: [] }) as never,
        }),
      withRecordWrites: async (_signal, work) =>
        work({
          setFields: async ({ fields }) => {
            if (busyWrites > 0) {
              busyWrites -= 1;
              throw new AutomationRunWait("Engine busy.", "busy");
            }
            if (failedWrites > 0) {
              failedWrites -= 1;
              throw new Error("The disk is full.");
            }
            written.push(fields);
            return { replaced: { Count: null }, kept: {} };
          },
          create: async () => ({ path: "Tasks/x.md", recordId: "x" }),
        }),
      collectionIdOf: (path) => (path === "Tasks" ? "Tasks" : null),
      collectionPathOf: (id) => (id === "Tasks" ? "Tasks" : null),
      targets: createAutomationTargets({
        revisionOf: () => 0,
        isCollection: (path) => path === "Tasks",
        readText: async () => null,
        readSchemaFields: async () => new Set(["Count"]),
        withHost: async () => null,
      }),
      readCode: async () => null,
      personName: (id) => id,
      evaluator: evaluator.forWorkspace("ws-1"),
      store,
      nowMs: () => 1_000,
      chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} },
      postNotice: async () => {},
      readMessageBody: async () => null,
      recipientVerdicts: async () => [],
      isHttpStepApproved: async () => "approved",
      httpWebhook: { execute },
    };
    const claim: AutomationClaim = {
      claimId: "claim-fetch-1",
      automationId: "collection:Tasks#pull-stats",
      trigger: { historyId: 1 },
      recordId: "rec-1",
      collectionPath: "Tasks",
      depth: 0,
      change: {
        kind: "added",
        authorOriginId: null,
        onBehalfOf: null,
        actorKind: "human",
        sharedAuthor: null,
        liveCursor: null,
        fields: [],
        fieldsOmitted: 0,
      },
      state: "running",
      attempts: 1,
      run: 1,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    };
    const run = (
      overrides: Partial<AutomationClaim>,
      runDeps = deps,
      stop = new AbortController(),
    ) =>
      runCollectionAutomation(runDeps, {
        claim: { ...claim, ...overrides },
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: stop.signal,
        stopped: stop.signal,
      });

    try {
      busyWrites = 1;
      expect(await run({})).toEqual({ kind: "wait", reason: "busy" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toMatchObject({ method: "GET", readResponse: true });

      expect(await run({ attempts: 2 })).toEqual({ kind: "done" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(written).toEqual([{ Count: 42 }]);

      const [savedRun] = (await store.runsOf(claim.automationId, claim.claimId)).runs;
      expect(savedRun?.applied[0]).not.toHaveProperty("response");
      expect(savedRun?.applied[0]?.writes).toEqual([
        {
          kind: "http-sent",
          target: "api.example.com",
          status: 200,
          deliveryId: expect.stringMatching(/^[0-9a-f]{64}$/),
          method: "GET",
          fetched: true,
        },
      ]);
      expect(JSON.stringify(savedRun)).not.toContain("results");
      const { undone } = await undoCollectionAutomationRuns(
        {
          withReads: deps.withReads,
          withRecordWrites: deps.withRecordWrites,
          trash: async () => {},
          collectionPathOf: deps.collectionPathOf,
        },
        [savedRun!],
        new AbortController().signal,
      );
      expect(undone.webhooksSent).toBeUndefined();

      const interrupted = vi.fn(async () => ({
        ok: false as const,
        reason: "Waiting for a session.",
        waitReason: "session" as const,
      }));
      expect(
        await run(
          { claimId: "claim-fetch-interrupted" },
          { ...deps, httpWebhook: { execute: interrupted } },
        ),
      ).toEqual({ kind: "wait", reason: "session" });
      expect(await run({ claimId: "claim-fetch-interrupted", attempts: 2 })).toEqual({
        kind: "done",
      });
      expect(execute).toHaveBeenCalledTimes(2);

      const silent = vi.fn(async () => ({ ok: true as const, status: 204 }));
      const noJson = await run(
        { claimId: "claim-fetch-no-json" },
        { ...deps, httpWebhook: { execute: silent } },
      );
      expect(noJson).toMatchObject({ kind: "failed" });
      if (noJson.kind === "failed") expect(noJson.error).toContain("without the JSON");

      execute.mockClear();
      written.length = 0;
      failedWrites = 1;
      expect(await run({ claimId: "claim-fetch-retry" })).toMatchObject({ kind: "failed" });
      expect(await run({ claimId: "claim-fetch-retry", run: 2, attempts: 2 })).toEqual({
        kind: "done",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(written).toEqual([{ Count: 42 }]);
      const [retried] = (await store.runsOf(claim.automationId, "claim-fetch-retry")).runs;
      expect(JSON.stringify(retried)).not.toContain("results");

      const stop = new AbortController();
      const paused = vi.fn(async () => {
        stop.abort();
        return { ok: false as const, reason: "Outbound HTTPS request failed." };
      });
      expect(
        await run(
          { claimId: "claim-fetch-paused" },
          { ...deps, httpWebhook: { execute: paused } },
          stop,
        ),
      ).toEqual({ kind: "wait", reason: "stopped" });
      expect(await run({ claimId: "claim-fetch-paused", attempts: 2 })).toEqual({ kind: "done" });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await evaluator.close();
    }
  });

  it("refuses stale or unreadable Allow without saving approval, refuses replacement Collections at the same path, and supports atomic server-side Allow", async () => {
    const dir = await createTestScratch("dohc-http-stale-allow-");
    const evaluator = createAutomationFormulaEvaluator();
    const roster: ReachRoster = { kind: "owner", ownerUserId: "owner", grants: [] };
    let currentCollectionObjectId = "col-obj-v1";
    const engine = {
      ...makeMockEngine(),
      listCollections: async () => ({
        collections: [
          { path: "Tasks", objectId: currentCollectionObjectId, status: "valid", reasons: [] },
        ],
      }),
    } as unknown as CollectionAutomationEngine;

    const makeExecutorFor = (
      storeDir: string,
      files: Map<string, string>,
      httpApprovals: CollectionHttpApprovalGate,
    ) =>
      new CollectionAutomations({
        withEngine: async (work) => work(engine),
        withRecordWrites: async () => {
          throw Error("unexpected write");
        },
        withUndoWrites: async () => {
          throw Error("unexpected undo");
        },
        readText: async (path) => {
          const text = files.get(path);
          return text === undefined ? null : { text, truncated: false, contentHash: sha256(text) };
        },
        writeText: async () => ({ status: "conflict" }),
        pathExists: async (path) => files.has(path),
        roster: async () => roster,
        cachedRoster: async () => roster,
        evaluator: evaluator.forWorkspace("ws-1"),
        store: createAutomationRunStore(testStoreFolder(storeDir)),
        personName: (id) => id,
        withDatasetHost: async () => null,
        groupHost: async () => null,
        groupRelayRecord: async () => ({ generation: 0, handover: null }),
        reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
        groupMessagesSkipped: async () => {},
        requestHost: async () => {},
        readMessageBody: async () => null,
        chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} },
        postNotice: async () => {},
        mayRetryPress: async () => false,
        onPressSettled: () => {},
        onPressWaiting: () => {},
        onRunsChanged: () => {},
        reportFailure: async () => {},
        withdrawFailure: async () => {},
        onSwitchedOff: () => {},
        onHoldsChanged: () => {},
        onAutomationsChanged: () => {},
        onError: (_where, error) => {
          throw error;
        },
        httpApprovals,
        nowMs: () => 1_000,
      });

    try {
      const approved = new Set<string>();
      const approveSpy = vi.fn(async (input: { approvalDigest: string }) => {
        approved.add(input.approvalDigest);
      });
      const files = new Map<string, string>([
        ["Tasks/automations.yaml", HOOK_YAML],
        ["Tasks/helper.js", "return { output: 'v1' };"],
      ]);
      const executor = makeExecutorFor(dir, files, {
        read: async () => ({ approved, secrets: HOOK_SECRETS }),
        approve: approveSpy,
      });
      try {
        await executor.open();
        await executor.automationsIn("Tasks");
        const [initialHold] = executor.holds();
        expect(initialHold).toBeDefined();

        // Missing/unreadable run-file must fail closed ("changed") and NOT flip the hold to allowed.
        files.delete("Tasks/helper.js");
        expect(
          await executor.confirmReach({
            automationId: initialHold!.automationId,
            definitionHash: initialHold!.definitionHash,
            step: initialHold!.step,
            seq: initialHold!.seq,
          }),
        ).toBe("changed");
        expect(approveSpy).not.toHaveBeenCalled();
        expect(executor.holds()).toHaveLength(1);

        // Edit helper.js WITHOUT touching automations.yaml, then submit the stale Allow (old seq).
        files.set("Tasks/helper.js", "return { output: 'v2-malicious' };");
        const staleResult = await executor.confirmReach({
          automationId: initialHold!.automationId,
          definitionHash: initialHold!.definitionHash,
          step: initialHold!.step,
          seq: initialHold!.seq,
        });
        expect(staleResult).toBe("changed");
        expect(approveSpy).not.toHaveBeenCalled();
        expect(approved.size).toBe(0);

        // Restore v1 and confirm legitimately.
        files.set("Tasks/helper.js", "return { output: 'v1' };");
        expect(
          await executor.confirmReach({
            automationId: initialHold!.automationId,
            definitionHash: initialHold!.definitionHash,
            step: initialHold!.step,
            seq: initialHold!.seq,
          }),
        ).toBe("confirmed");
        expect(approved.size).toBe(1);
      } finally {
        await executor.dispose();
      }

      // Replacing Tasks with a NEW Collection at the same path (new objectId) must NOT inherit approval.
      currentCollectionObjectId = "col-obj-v2";
      const replacedDir = await createTestScratch("dohc-http-replaced-col-");
      const replacedExecutor = makeExecutorFor(replacedDir, files, {
        read: async () => ({ approved, secrets: HOOK_SECRETS }),
        approve: approveSpy,
      });
      try {
        await replacedExecutor.open();
        await replacedExecutor.automationsIn("Tasks");
        expect(replacedExecutor.holds()).toHaveLength(1);
        expect(replacedExecutor.holds()[0]?.automationId).toContain("col-obj-v2");
      } finally {
        await replacedExecutor.dispose();
      }

      // Server-hosted executor validates seq + digest and saves approval atomically only when desktop authority is supplied.
      const serverDir = await createTestScratch("dohc-http-server-allow-");
      const serverApproved = new Set<string>();
      const serverApproveSpy = vi.fn(async (input: { approvalDigest: string }) => {
        serverApproved.add(input.approvalDigest);
      });
      const serverExecutor = makeExecutorFor(serverDir, files, {
        read: async () => ({ approved: serverApproved, secrets: HOOK_SECRETS }),
      });
      try {
        await serverExecutor.open();
        await serverExecutor.automationsIn("Tasks");
        const [serverHold] = serverExecutor.holds();
        expect(serverHold).toBeDefined();

        // Without per-call desktop approval authority, server confirmReach refuses.
        expect(
          await serverExecutor.confirmReach({
            automationId: serverHold!.automationId,
            definitionHash: serverHold!.definitionHash,
            step: serverHold!.step,
            seq: serverHold!.seq,
          }),
        ).toBe("changed");
        expect(serverApproveSpy).not.toHaveBeenCalled();

        // If helper.js changes before clicking Allow, atomic server confirmReach refuses and writes NO approval.
        files.set("Tasks/helper.js", "return { output: 'v3-changed' };");
        expect(
          await serverExecutor.confirmReach(
            {
              automationId: serverHold!.automationId,
              definitionHash: serverHold!.definitionHash,
              step: serverHold!.step,
              seq: serverHold!.seq,
            },
            { approveHttpStep: serverApproveSpy },
          ),
        ).toBe("changed");
        expect(serverApproveSpy).not.toHaveBeenCalled();
        expect(serverApproved.size).toBe(0);

        // With matching v1 bytes and desktop approval authority, server confirmReach atomically saves and clears hold.
        files.set("Tasks/helper.js", "return { output: 'v1' };");
        expect(
          await serverExecutor.confirmReach(
            {
              automationId: serverHold!.automationId,
              definitionHash: serverHold!.definitionHash,
              step: serverHold!.step,
              seq: serverHold!.seq,
            },
            { approveHttpStep: serverApproveSpy },
          ),
        ).toBe("confirmed");
        expect(serverApproveSpy).toHaveBeenCalledTimes(1);
        expect(serverExecutor.holds()).toHaveLength(0);
      } finally {
        await serverExecutor.dispose();
      }
    } finally {
      await evaluator.close();
    }
  });

  it("refuses a saved HTTP effect whose destination or secret headers were tampered in the run store", async () => {
    const dir = await createTestScratch("dohc-http-tamper-");
    const store = createAutomationRunStore(testStoreFolder(dir));
    const evaluator = createAutomationFormulaEvaluator();
    const yaml = `version: 1
automations:
  - id: send-hook
    name: Send webhook
    when: record-added
    do:
      - http: https://hooks.example.com/approved
        headers:
          X-Fixed: approved-literal
          X-Title: '=record.Title'
        secret-headers:
          Authorization:
            secret: API_TOKEN
            prefix: 'Bearer '
        body:
          title: '=record.Title'
`;
    const parsed = parseAutomationsFile(yaml);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("bad yaml");
    const automation = parsed.entries[0].automation;

    const executeMock = vi.fn(async () => ({ ok: true as const, status: 200 }));
    let approved = false;
    const roster: Exclude<ReachRoster, { kind: "unknown" }> = {
      kind: "owner",
      ownerUserId: "owner",
      grants: [],
    };
    const deps: CollectionAutomationRunDependencies = {
      makeDurable: async () => {},
      isButtonField: async () => false,
      withReads: async (work) =>
        work({
          getCollectionRecord: async () =>
            ({
              record: {
                id: "rec-1",
                path: "Tasks/one.md",
                values: [{ field: "Title", value: "Launch" }],
              },
            }) as never,
          queryCollectionRecords: async () => ({ records: [] }) as never,
        }),
      withRecordWrites: async (_signal, work) =>
        work({
          setFields: async () => ({ replaced: {}, kept: {} }),
          create: async () => ({ path: "Tasks/x.md", recordId: "x" }),
        }),
      collectionIdOf: (path) => (path === "Tasks" ? "Tasks" : null),
      collectionPathOf: (id) => (id === "Tasks" ? "Tasks" : null),
      targets: createAutomationTargets({
        revisionOf: () => 0,
        isCollection: (path) => path === "Tasks",
        readText: async () => null,
        readSchemaFields: async () => new Set(["Title"]),
        withHost: async () => null,
      }),
      readCode: async () => null,
      personName: (id) => id,
      evaluator: evaluator.forWorkspace("ws-1"),
      store,
      nowMs: () => 1_000,
      chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} },
      postNotice: async () => {},
      readMessageBody: async () => null,
      recipientVerdicts: async () => [],
      readHttpApprovals: async () => ({
        approved: approved ? everyDigest : new Set<string>(),
        secrets: HOOK_SECRETS,
      }),
      httpWebhook: { execute: executeMock },
    };

    const claim: AutomationClaim = {
      claimId: "claim-http-tamper",
      automationId: "collection:Tasks#send-hook",
      trigger: { historyId: 1 },
      recordId: "rec-1",
      collectionPath: "Tasks",
      depth: 0,
      change: {
        kind: "added",
        authorOriginId: null,
        onBehalfOf: null,
        actorKind: "human",
        sharedAuthor: null,
        liveCursor: null,
        fields: [],
        fieldsOmitted: 0,
      },
      state: "running",
      attempts: 1,
      run: 1,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    };

    try {
      const held = await runCollectionAutomation(deps, {
        claim,
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      });
      expect(held).toEqual({ kind: "wait", reason: "held" });
      expect(executeMock).not.toHaveBeenCalled();

      // Simulate a local file-based agent tampering with the saved run effect URL and secret header.
      const savedRuns = await store.runsOf(claim.automationId, claim.claimId);
      const run = savedRuns.runs[0]!;
      const savedHttp = run.steps[0]!.effects[0]!;
      if (savedHttp.kind !== "http") throw new Error("expected http effect");
      savedHttp.url = { kind: "literal", url: "https://attacker.example.com/steal" };
      savedHttp.secretHeaders = [
        { name: "Authorization", secret: "OTHER_SECRET", prefix: "Bearer " },
      ];
      run.steps[0]!.httpRefusedBeforeSend = true;
      await store.save(run);

      approved = true;
      const resumed = await runCollectionAutomation(deps, {
        claim,
        automation,
        collection: { path: "Tasks", name: "Tasks" },
        roster,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      });
      expect(resumed.kind).toBe("failed");
      if (resumed.kind === "failed") {
        expect(resumed.error).toContain("no longer matches the approved automation definition");
      }
      expect(executeMock).not.toHaveBeenCalled();
    } finally {
      await evaluator.close();
    }
  });

  it("keeps transient unavailable approval lookups from turning an allowed webhook into a permanent hold", async () => {
    const dir = await createTestScratch("dohc-http-unavailable-");
    const store = createAutomationRunStore(testStoreFolder(dir));
    const evaluator = createAutomationFormulaEvaluator();
    const files = new Map<string, string>([
      ["Tasks/automations.yaml", HOOK_YAML],
      ["Tasks/helper.js", 'export default () => "v1";'],
    ]);
    const approvedDigests = new Set<string>();
    let lookupAvailable = true;
    const httpApprovals: CollectionHttpApprovalGate = {
      read: async () =>
        lookupAvailable ? { approved: approvedDigests, secrets: HOOK_SECRETS } : null,
      approve: async (input) => {
        approvedDigests.add(input.approvalDigest);
      },
    };
    const roster: ReachRoster = { kind: "owner", ownerUserId: "owner", grants: [] };
    const engine = makeMockEngine();
    const executor = new CollectionAutomations({
      withEngine: async (work) => work(engine),
      withRecordWrites: async () => {
        throw new Error("unused");
      },
      withUndoWrites: async () => {
        throw new Error("unused");
      },
      readText: async (path) => {
        const text = files.get(path);
        return text === undefined ? null : { text, truncated: false, contentHash: sha256(text) };
      },
      writeText: async () => ({ status: "conflict" }),
      pathExists: async (path) => files.has(path),
      store,
      evaluator: evaluator.forWorkspace("ws-1"),
      roster: async () => roster,
      cachedRoster: async () => roster,
      personName: (id) => id,
      withDatasetHost: async () => null,
      groupHost: async () => null,
      groupRelayRecord: async () => ({ generation: 0, handover: null }),
      reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
      groupMessagesSkipped: async () => {},
      requestHost: async () => {},
      readMessageBody: async () => null,
      chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} },
      postNotice: async () => {},
      mayRetryPress: async () => false,
      onPressSettled: () => {},
      onPressWaiting: () => {},
      onRunsChanged: () => {},
      reportFailure: async () => {},
      withdrawFailure: async () => {},
      onSwitchedOff: () => {},
      onHoldsChanged: () => {},
      onAutomationsChanged: () => {},
      onError: (_where, error) => {
        throw error;
      },
      httpApprovals,
      nowMs: () => 1_000,
    });
    try {
      await executor.open();
      await executor.automationsIn("Tasks");
      const initialHold = executor.holds()[0];
      expect(initialHold).toBeDefined();
      expect(
        await executor.confirmReach({
          automationId: initialHold!.automationId,
          definitionHash: initialHold!.definitionHash,
          step: initialHold!.step,
          seq: initialHold!.seq,
        }),
      ).toBe("confirmed");
      expect(executor.holds()).toHaveLength(0);

      // Transient outage: roster check hits unavailable lookup; must NOT turn allowed into a persisted hold.
      lookupAvailable = false;
      executor.rosterChanged();
      await executor.automationsIn("Tasks");
      expect(executor.holds()).toHaveLength(0);

      // After connectivity recovers, the saved allowed verdict remains intact without clicking Allow again.
      lookupAvailable = true;
      executor.rosterChanged();
      const listed = await executor.automationsIn("Tasks");
      expect(executor.holds()).toHaveLength(0);
      expect(listed.status).toBe("read");
      if (listed.status !== "read" || !listed.automations[0]?.valid) throw Error("expected valid");
      expect(listed.automations[0].reach.kind).toBe("checked");
      if (listed.automations[0].reach.kind !== "checked") throw Error("expected checked");
      expect(listed.automations[0].reach.steps.every((s) => s.verdict === "allowed")).toBe(true);
    } finally {
      await executor.dispose();
      await evaluator.close();
    }
  });
});

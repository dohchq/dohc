import { z } from "zod";
import { WriteSchema } from "@dohc/automation-executor/automation-run-store";
import type { DatasetUndoConfirmed } from "@dohc/automation-executor/dataset-automation-undo";
import type {
  CollectionAutomationHold,
  CollectionAutomationRetry,
  CollectionAutomationRun,
  CollectionAutomationUndo,
} from "@dohc/automation-executor/collection-automations";

// The runs a self-hosted server made in a workspace, as its owner sees them
// on this computer. The server keeps its runs where they ran (ADR 0008);
// these calls read them and act on them through the relay's owner routes.
// The relay decides who the owner is; this computer only asks.

/** The account a relay answer was asked as, and whether that sign-in is still the current one. */
export interface ServerAsker {
  account: string;
  current(): boolean;
}

/** A relay answer, or null when this computer cannot ask as the workspace's owner. */
export type ServerAnswer = { status: number; body: unknown; asker: ServerAsker } | null;

export type ServerRequest =
  | { method: "GET"; action: "runs" | "holds"; query?: Record<string, string> }
  | { method: "POST"; action: "retry" | "undo" | "restore" | "allow"; body: Record<string, unknown> };

const Run = z.object({
  claimId: z.string(),
  state: z.enum(["pending", "running", "done", "failed"]),
  error: z.string().nullable(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  trigger: z.object({
    sharedAuthor: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("named"), userId: z.string(), grantId: z.string(), grantGeneration: z.number().int() }),
      z.object({ kind: z.literal("link"), grantId: z.string(), grantGeneration: z.number().int(), principalId: z.string() }),
    ]).nullable(),
    kind: z.enum(["added", "changed", "removed", "message", "button", "schedule"]).nullable(),
    recordId: z.string().nullable(), by: z.enum(["human", "agent", "automation"]).nullable(), depth: z.number().int().nonnegative(),
  }),
  writes: z.array(WriteSchema),
  definitionChanged: z.boolean(),
  chainStopped: z.boolean(),
  neverStarted: z.boolean(),
  undone: z.boolean(),
});
const Retry = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued"), press: z.boolean() }),
  z.object({ status: z.literal("definition-changed"), repeatsMessages: z.boolean() }),
  z.object({ status: z.literal("refused"), reason: z.string() }),
]);
const Count = z.number().int().nonnegative();
const Undo = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("undone"),
    reverted: Count, removed: Count, kept: Count, changedSince: Count, missing: Count, irreversible: Count, actions: Count, actionsReversed: Count,
    deleted: Count, keptChanged: Count, gone: Count,
  }),
  z.object({ status: z.literal("confirm"), preview: z.object({
    deletes: Count, unchecked: Count, kept: Count, keptChanged: Count, gone: Count, reverts: Count,
    irreversible: Count, reverses: Count, actions: Count, token: z.string(),
    choices: z.array(z.object({ key: z.string(), table: z.string(), records: Count,
      operations: z.array(z.object({ operationId: z.string(), label: z.string() })),
    })),
  }) }),
  z.object({ status: z.literal("refused"), reason: z.string() }),
]);
const Hold = z.object({
  automationId: z.string(),
  collectionPath: z.string(),
  automationName: z.string(),
  definitionHash: z.string(),
  step: z.string(),
  seq: z.number().int().nonnegative(),
  collection: z.string(),
  target: z.string(),
  action: z.enum(["change", "find", "post", "notify", "wake", "read"]),
  recipient: z.string().optional(),
  stoppedFor: z.string().nullable(),
  fileUnread: z.boolean(),
});

const GONE = "Your server no longer has this run.";

/** The relay's owner routes to a server's runs, over `send`. */
export function createServerRuns(send: (workspaceId: string, request: ServerRequest) => Promise<ServerAnswer>) {
  // The answer's body when it is the relay's success; null for no copy of
  // the workspace on the server, or no way to ask as its owner.
  async function ask<T>(workspaceId: string, request: ServerRequest, schema: z.ZodType<T>): Promise<T | null> {
    return read(await send(workspaceId, request), schema);
  }
  function read<T>(answer: ServerAnswer, schema: z.ZodType<T>): T | null {
    if (answer === null || answer.status === 404) return null;
    const body = answer.body as { ok?: unknown } | undefined;
    if (answer.status !== 200 || body?.ok !== true) {
      throw new Error(`Your server answered with ${answer.status}.`);
    }
    return schema.parse(body);
  }

  return {
    /** One automation's newest runs on the server, or null when it has no copy of the workspace. */
    async runs(workspaceId: string, automationId: string, before?: string): Promise<{ runs: CollectionAutomationRun[]; next: string | null } | null> {
      return ask(workspaceId, { method: "GET", action: "runs", query: { automationId, ...(before === undefined ? {} : { before }) } }, z.object({ runs: z.array(Run), next: z.string().nullable() }));
    },
    /**
     * Whether the server shows this computer's sign-in a run, and who asked,
     * for a yes or a no alike. Null when this computer cannot ask as the owner.
     */
    async shownTo(workspaceId: string, automationId: string, claimId: string): Promise<{ shown: boolean; asker: ServerAsker } | null> {
      const answer = await send(workspaceId, { method: "GET", action: "runs", query: { automationId, claimId } });
      if (answer === null) return null;
      return { shown: Boolean(read(answer, z.object({ run: Run.nullable() }))?.run), asker: answer.asker };
    },
    async get(workspaceId: string, automationId: string, claimId: string): Promise<CollectionAutomationRun | null> {
      const answer = await ask(workspaceId, { method: "GET", action: "runs", query: { automationId, claimId } }, z.object({ run: Run.nullable() }));
      return answer?.run ?? null;
    },
    async retry(workspaceId: string, input: { automationId: string; claimId: string; startOver: boolean }): Promise<CollectionAutomationRetry> {
      return (await ask(workspaceId, { method: "POST", action: "retry", body: input }, Retry)) ?? { status: "refused", reason: GONE };
    },
    async undo(workspaceId: string, input: { automationId: string; claimId: string; deletes: DatasetUndoConfirmed | null }): Promise<CollectionAutomationUndo> {
      return (await ask(workspaceId, { method: "POST", action: "undo", body: input }, Undo)) ?? { status: "refused", reason: GONE };
    },
    /**
     * Stop and restore's pass over every run on the server under these
     * definitions, as CollectionAutomations.undoRunsOf. None when the
     * server keeps no copy of the workspace.
     */
    async restore(
      workspaceId: string,
      definitions: ReadonlyArray<{ collectionPath: string; id: string; definitionHash: string }>,
      again: boolean,
    ): Promise<{ undone: number; left: number; reverted: number; missing: number; keptFields: string[]; otherKept: number; errorMessage: string | null }> {
      const answer = await ask(workspaceId, { method: "POST", action: "restore", body: { definitions, again } },
        z.object({ undone: Count, left: Count, reverted: Count, missing: Count, keptFields: z.array(z.string().regex(/^[a-f0-9]{32}$/)), otherKept: Count, errorMessage: z.string().nullable() }));
      return answer ?? { undone: 0, left: 0, reverted: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null };
    },
    /** The steps the server holds until a current editor allows them. */
    async holds(workspaceId: string): Promise<CollectionAutomationHold[]> {
      const answer = await ask(workspaceId, { method: "GET", action: "holds" }, z.object({ holds: z.array(Hold) }));
      return answer?.holds ?? [];
    },
    async allow(
      workspaceId: string,
      input: { automationId: string; definitionHash: string; step: string; seq: number; recipient?: string },
    ): Promise<"confirmed" | "changed"> {
      const answer = await ask(workspaceId, { method: "POST", action: "allow", body: input }, z.object({ status: z.enum(["confirmed", "changed"]) }));
      // A server that no longer has the copy holds nothing.
      return answer?.status ?? "changed";
    },
  };
}

export type ServerRuns = ReturnType<typeof createServerRuns>;

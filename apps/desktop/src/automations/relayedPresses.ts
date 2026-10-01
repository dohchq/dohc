import type {
  AutomationPressOutcome,
  RelayAutomationPress,
  RelayAutomationPressReceipt,
  SyncRelayConnection,
  RelayButtonAuthority,
  RelayButtonInspection,
  RelayButtonTarget,
  RelayButtonInspectionRequest,
} from "@dohc/workspace-contracts/relay";
import { AutomationRunWait, SHARED_BUTTON_DENIED, SHARED_BUTTON_UNCHECKED } from "@dohc/automation-executor/button-presser";
import type { PressTransport } from "@dohc/automation-executor/relayed-presses";
import { relayRequest } from "../workspaces/relayRequest";
import { z } from "zod";

// The relay's Button press routes, over HTTP with the owner's or a
// recipient's session. The loop that takes relayed presses lives in the
// executor package, so the server runs the same loop in process.

// How long one list waits for a press. The relay holds it at most 25 seconds,
// and a list with no answer well past that is abandoned.
const LIST_WAIT_MS = 25_000;
const LIST_TIMEOUT_MS = LIST_WAIT_MS + 15_000;

const json = { "content-type": "application/json" };
const identifier = z.string().min(1);
const authoritySchema = z.object({
  workspaceId: identifier, automationId: identifier, collectionPath: identifier, definitionHash: z.string().regex(/^[0-9a-f]{16}$/u),
  userId: identifier, grantId: identifier, grantGeneration: z.number().int().positive(), hostGeneration: z.number().int().positive(),
  principals: z.array(z.object({ grantId: identifier, userId: identifier, access: z.enum(["view", "comment", "edit"]) })),
  recordId: identifier.optional(), confirmed: z.array(identifier),
});
const inspectionSchema = z.union([
  z.object({ kind: z.literal("ready"), automationId: identifier, definitionHash: z.string().regex(/^[0-9a-f]{16}$/u),
    irreversible: z.array(z.object({ name: identifier, label: identifier })) }),
  z.object({ kind: z.enum(["denied", "unchecked"]), reason: identifier }),
]);

/** The relay routes the host and a recipient use. */
export function automationPressRelay(relay: SyncRelayConnection) {
  let inspections: RelayButtonInspectionRequest[] = [];
  const call = async (path: string, init: RequestInit = {}, label = "Automation press request", errors?: Record<number, () => Error>) =>
    await (await relayRequest({ relay, path, init, label, ...(errors ? { errors } : {}) })).json() as Record<string, unknown>;
  const ws = (workspaceId: string) => `/sync/${encodeURIComponent(workspaceId)}`;
  return {
    async list(workspaceId: string, installId: string, signal: AbortSignal): Promise<RelayAutomationPress[]> {
      const query = new URLSearchParams({ installId, waitMs: String(LIST_WAIT_MS) });
      const answer = await call(`${ws(workspaceId)}/automation-presses?${query}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]),
      });
      inspections = z.array(z.object({ inspectionId: identifier, automationId: identifier, collectionPath: identifier, definitionHash: identifier })).parse(answer.inspections);
      return Array.isArray(answer.presses) ? answer.presses as RelayAutomationPress[] : [];
    },
    inspections: () => inspections,
    async authority(workspaceId: string, installId: string, generation: number, id: string, inspection = false): Promise<RelayButtonAuthority> {
      try {
        const answer = await call(`${ws(workspaceId)}/automation-presses/${inspection ? "inspection-authority" : "authority"}`, {
          method: "POST", headers: json, body: JSON.stringify({ installId, generation, [inspection ? "inspectionId" : "hostPressId"]: id }), signal: AbortSignal.timeout(15_000),
        }, "Button access", { 403: () => new Error(SHARED_BUTTON_DENIED), 404: () => new Error(SHARED_BUTTON_DENIED), 409: () => new AutomationRunWait(SHARED_BUTTON_UNCHECKED, "roster") });
        const parsed = authoritySchema.safeParse(answer.authority);
        if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.hostGeneration !== generation || (!inspection && !parsed.data.recordId)) {
          throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED, "roster");
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof Error && error.message === SHARED_BUTTON_DENIED) throw error;
        throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED, "roster");
      }
    },
    async inspect(shareId: string, targets: readonly RelayButtonTarget[]): Promise<RelayButtonInspection[]> {
      try {
        const answer = await call(`/sync/shares/${encodeURIComponent(shareId)}/automation-presses?inspect=true`, {
          method: "POST", headers: json, body: JSON.stringify({ targets }), signal: AbortSignal.timeout(15_000),
        }, "Button access", { 403: () => new Error(SHARED_BUTTON_DENIED), 404: () => new Error(SHARED_BUTTON_DENIED) });
        const parsed = z.array(inspectionSchema).length(targets.length).safeParse(answer.inspections);
        if (!parsed.success) return targets.map(() => ({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED }));
        return parsed.data.map(result => result.kind === "ready" ? result : { kind: result.kind,
          reason: result.kind === "denied" ? SHARED_BUTTON_DENIED : SHARED_BUTTON_UNCHECKED });
      } catch (error) { return targets.map(() => error instanceof Error && error.message === SHARED_BUTTON_DENIED
        ? { kind: "denied", reason: SHARED_BUTTON_DENIED } : { kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED }); }
    },
    async answerInspection(workspaceId: string, installId: string, generation: number, inspectionId: string, inspection: RelayButtonInspection): Promise<void> {
      await call(`${ws(workspaceId)}/automation-presses/inspection-answer`, { method: "POST", headers: json,
        body: JSON.stringify({ installId, generation, inspectionId, inspection }) });
    },
    async accept(workspaceId: string, installId: string, generation: number, hostPressIds: string[]): Promise<string[]> {
      const answer = await call(`${ws(workspaceId)}/automation-presses/accept`, {
        method: "POST", headers: json, body: JSON.stringify({ installId, generation, hostPressIds }),
      });
      return Array.isArray(answer.accepted) ? answer.accepted.filter((id): id is string => typeof id === "string") : [];
    },
    async settle(workspaceId: string, input: { installId: string; hostPressId: string; outcome: AutomationPressOutcome; error: string | null }): Promise<void> {
      await call(`${ws(workspaceId)}/automation-presses/settle`, { method: "POST", headers: json, body: JSON.stringify(input) });
    },
    /** A recipient's press on a shared Collection's button. */
    async press(shareId: string, input: { pressId: string; automationId: string; collectionPath: string; definitionHash: string; recordId: string; confirmed: readonly string[] }): Promise<RelayAutomationPressReceipt> {
      const { ok: _ok, ...receipt } = await call(`/sync/shares/${encodeURIComponent(shareId)}/automation-presses`, {
        method: "POST", headers: json, body: JSON.stringify(input),
      }, "Button press", {
        403: () => new Error("Your access to this Collection does not let you use its buttons."),
        404: () => new Error("This shared Collection is no longer available."),
        409: () => new Error("This press already went to another button. Press it again."),
        429: () => new Error("Too many button presses. Wait a moment, then press again."),
      });
      return receipt as unknown as RelayAutomationPressReceipt;
    },
  };
}

/** This computer's press routes for one workspace, over the owner's relay session. */
export function relayPressTransport(relay: SyncRelayConnection, workspaceId: string, installId: string): PressTransport {
  const routes = automationPressRelay(relay);
  return {
    list: (signal) => routes.list(workspaceId, installId, signal),
    accept: (generation, hostPressIds) => routes.accept(workspaceId, installId, generation, hostPressIds),
    settle: (input) => routes.settle(workspaceId, { installId, ...input }),
    inspections: routes.inspections,
    answerInspection: (generation, inspectionId, inspection) => routes.answerInspection(workspaceId, installId, generation, inspectionId, inspection),
  };
}

import type {
  AutomationPressOutcome,
  RelayAutomationPress,
  RelayAutomationPressReceipt,
  SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { PressTransport } from "@dohc/automation-executor/relayed-presses";
import { relayRequest } from "../workspaces/relayRequest";

// The relay's Button press routes, over HTTP with the owner's or a
// recipient's session. The loop that takes relayed presses lives in the
// executor package, so the server runs the same loop in process.

// How long one list waits for a press. The relay holds it at most 25 seconds,
// and a list with no answer well past that is abandoned.
const LIST_WAIT_MS = 25_000;
const LIST_TIMEOUT_MS = LIST_WAIT_MS + 15_000;

const json = { "content-type": "application/json" };

/** The relay routes the host and a recipient use. */
export function automationPressRelay(relay: SyncRelayConnection) {
  const call = async (path: string, init: RequestInit = {}, label = "Automation press request", errors?: Record<number, () => Error>) =>
    await (await relayRequest({ relay, path, init, label, ...(errors ? { errors } : {}) })).json() as Record<string, unknown>;
  const ws = (workspaceId: string) => `/sync/${encodeURIComponent(workspaceId)}`;
  return {
    async list(workspaceId: string, installId: string, signal: AbortSignal): Promise<RelayAutomationPress[]> {
      const query = new URLSearchParams({ installId, waitMs: String(LIST_WAIT_MS) });
      const answer = await call(`${ws(workspaceId)}/automation-presses?${query}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]),
      });
      return Array.isArray(answer.presses) ? answer.presses as RelayAutomationPress[] : [];
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
    async press(shareId: string, input: { pressId: string; automationId: string; collectionPath: string; definitionHash: string; recordId: string }): Promise<RelayAutomationPressReceipt> {
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
  };
}

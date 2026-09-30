import { AUTOMATION_SERVER_INSTALL_ID } from "@dohc/workspace-contracts/relay";
import type { ScheduleHostComputer, ScheduleHostResult } from "../ipc/bridgeContract";

// Which of the owner's computers, or their dohc server, runs a workspace's
// schedules, as settings and the ⚡ panel show it.

type RelayHost = Extract<ScheduleHostResult, { kind: "relay" }>;
type Named = Pick<ScheduleHostComputer, "kind" | "label" | "thisComputer">;

/** How a computer heads its row: "This computer", "This server" with the server's name, or its name. */
export function computerName(computer: Named): string {
  if (computer.kind === "server") return computer.label === "This server" ? "This server" : `This server (${computer.label})`;
  return computer.thisComputer ? "This computer" : computer.label;
}

/** How a computer reads inside a sentence: "this computer", "this server", or its name. */
export function computerInSentence(computer: Named): string {
  return computer.kind === "server" ? "this server" : computer.thisComputer ? "this computer" : computer.label;
}

/**
 * The host and handover to show. The relay lists the server only while it
 * runs automations. A record that still names a server that does not shows
 * what runs now: the computer that was handing over to the server, which
 * never stopped, or nothing when the server was the one running.
 * `serverOff` says why. Choosing a computer then starts it at once.
 */
export function shownScheduleHost(relay: RelayHost): { hostInstallId: string | null; handoverFrom: string | null; serverOff: boolean } {
  const { hostInstallId, handoverFrom } = relay;
  const serverOff = (hostInstallId === AUTOMATION_SERVER_INSTALL_ID || handoverFrom === AUTOMATION_SERVER_INSTALL_ID) &&
    !relay.computers.some((computer) => computer.kind === "server");
  if (!serverOff) return { hostInstallId, handoverFrom, serverOff };
  const running = handoverFrom ?? hostInstallId;
  return { hostInstallId: running === AUTOMATION_SERVER_INSTALL_ID ? null : running, handoverFrom: null, serverOff };
}

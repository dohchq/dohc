import { randomUUID } from "node:crypto";
import { CHANNELS } from "./channels";
import { shareDirectWriteDeliveryOperations, type ShareDirectWriteDeliveryPayload, type PushShareDirectWritesResult, type ShareDirectWritesPushedEvent } from "./bridgeContract";
import { registerOperations, type OperationBoundary } from "./operationTable";

const MAX_HELD_ANSWERS = 8;
type Listener = Extract<ShareDirectWriteDeliveryPayload, { action: "listen" }>;
interface Target {
  send(channel: string, event: ShareDirectWritesPushedEvent): void;
  once(event: "destroyed", callback: () => void): unknown;
}

export function createShareDirectWriteDelivery<Sender extends Target>(dependencies: {
  targets(): readonly Sender[];
  currentSession(sender: Sender): { workspaceId: string; rendererDocumentId: string } | undefined;
  isSharedView(workspaceId: string): boolean;
}) {
  type Claim = { sender: Sender; listener: Listener };
  type Answer = ShareDirectWritesPushedEvent & { claim: Claim | null; offered: WeakMap<Sender, string> };
  const listeners = new WeakMap<Sender, Listener>();
  const observed = new WeakSet<Sender>();
  const held = new Map<string, Answer[]>();

  function sessionWorkspaceAndDocumentMatch(sender: Sender, listener: Listener): boolean {
    const session = dependencies.currentSession(sender);
    return session?.workspaceId === listener.workspaceId && session.rendererDocumentId === listener.rendererDocumentId &&
      dependencies.isSharedView(listener.workspaceId);
  }
  function owns(sender: Sender, input: ShareDirectWriteDeliveryPayload): boolean {
    const listener = listeners.get(sender);
    return listener?.workspaceId === input.workspaceId && listener.rendererDocumentId === input.rendererDocumentId &&
      listener.subscriptionId === input.subscriptionId;
  }
  function releaseClaims(sender: Sender, listener: Listener): void {
    for (const answer of held.get(listener.workspaceId) ?? []) {
      if (answer.claim?.sender === sender && answer.claim.listener.subscriptionId === listener.subscriptionId) {
        answer.claim = null;
        answer.offered = new WeakMap();
      }
    }
  }
  function replay(workspaceId: string): void {
    const answers = held.get(workspaceId) ?? [];
    for (const answer of [...answers]) {
      if (answer.claim && (!owns(answer.claim.sender, answer.claim.listener) ||
        !sessionWorkspaceAndDocumentMatch(answer.claim.sender, answer.claim.listener))) {
        answer.claim = null;
        answer.offered = new WeakMap();
      }
      if (answer.claim) continue;
      for (const sender of dependencies.targets()) {
        if (!answers.includes(answer) || answer.claim) break;
        const listener = listeners.get(sender);
        if (!listener || listener.workspaceId !== workspaceId || !sessionWorkspaceAndDocumentMatch(sender, listener) ||
          answer.offered.get(sender) === listener.subscriptionId) continue;
        answer.offered.set(sender, listener.subscriptionId);
        sender.send(CHANNELS.shareDirectWritesPushed, { answerId: answer.answerId, workspaceId, result: answer.result });
      }
    }
  }
  function update(sender: Sender, input: ShareDirectWriteDeliveryPayload): boolean {
    if (input.action === "listen") {
      if (!input.listening) {
        if (!owns(sender, input)) return false;
        listeners.delete(sender);
        releaseClaims(sender, input);
        replay(input.workspaceId);
        return true;
      }
      if (!sessionWorkspaceAndDocumentMatch(sender, input)) return false;
      const previous = listeners.get(sender);
      if (previous) releaseClaims(sender, previous);
      listeners.set(sender, input);
      if (!observed.has(sender)) {
        observed.add(sender);
        sender.once("destroyed", () => {
          const listener = listeners.get(sender);
          if (!listener) return;
          listeners.delete(sender);
          releaseClaims(sender, listener);
          replay(listener.workspaceId);
        });
      }
      replay(input.workspaceId);
      return true;
    }
    if (!owns(sender, input)) return false;
    const answers = held.get(input.workspaceId);
    const answer = answers?.find(row => row.answerId === input.answerId);
    if (!answer) return false;
    const listener = listeners.get(sender)!;
    if (input.action === "claim") {
      if (!sessionWorkspaceAndDocumentMatch(sender, listener) || answer.offered.get(sender) !== input.subscriptionId) return false;
      if (answer.claim && !sessionWorkspaceAndDocumentMatch(answer.claim.sender, answer.claim.listener)) answer.claim = null;
      if (answer.claim) return false;
      answer.claim = { sender, listener };
      return true;
    }
    if (answer.claim?.sender !== sender || answer.claim.listener.subscriptionId !== input.subscriptionId) return false;
    if (input.action === "acknowledge") {
      answers!.splice(answers!.indexOf(answer), 1);
      if (answers!.length === 0) held.delete(input.workspaceId);
    } else {
      answer.claim = null;
      answer.offered = new WeakMap();
      replay(input.workspaceId);
    }
    return true;
  }
  return {
    update,
    report(workspaceId: string, result: PushShareDirectWritesResult): void {
      if (result.status === "pushed" && result.writes.every(write => write.result === "written")) return;
      const answers = held.get(workspaceId) ?? [];
      answers.push({ answerId: randomUUID(), workspaceId, result, claim: null, offered: new WeakMap() });
      if (answers.length > MAX_HELD_ANSWERS) answers.splice(0, answers.length - MAX_HELD_ANSWERS);
      held.set(workspaceId, answers);
      replay(workspaceId);
    },
    register<Event extends { sender: Sender }, WorkspaceOperation>(boundary: OperationBoundary<Event, WorkspaceOperation>): void {
      registerOperations(boundary, shareDirectWriteDeliveryOperations, {
        updateShareDirectWriteDelivery: (input, { event }) => update(event.sender, input),
      });
    },
  };
}

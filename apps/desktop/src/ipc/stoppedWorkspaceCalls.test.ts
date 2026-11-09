import { describe, expect, it, vi } from "vitest";
import { chatOperations } from "./chatOperations";
import { CHANNELS } from "./channels";
import { datasetOperations } from "./datasetOperations";
import { ipcWireError, isPrivacyDenied, isStoppedWorkspaceCall, isStoppedWorkspaceRead, readError, refusalCode } from "./errorWords";
import { stoppedWorkspaceCall } from "./stoppedWorkspaceCalls";

const INACTIVE = "This workspace is no longer open in this window.";

// What the renderer receives: Electron sends a rejected handler's error as its string.
function received(channel: string, payload: unknown, error: Error, stopped: string | null): Error {
  const sent = ipcWireError(error, stoppedWorkspaceCall(channel, payload, () => stopped));
  return new Error(`Error invoking remote method '${channel}': ${String(sent)}`);
}

describe("a call on the workspace its window has stopped", () => {
  it("marks a failed read so the window drops it, with its words unchanged", () => {
    for (const [channel, payload] of [
      [chatOperations.listChatMessages.channel, { workspaceId: "w1" }],
      [CHANNELS.listCollections, { workspaceId: "w1" }],
      [datasetOperations.dataset.channel, { workspaceId: "w1", action: "list", limit: 50 }],
    ] as const) {
      const error = received(channel, payload, new Error(INACTIVE), "w1");
      expect(isStoppedWorkspaceRead(error)).toBe(true);
      expect(isStoppedWorkspaceCall(error)).toBe(true);
      expect(readError(error).words).toBe(readError(new Error(INACTIVE)).words);
    }
  });

  it("marks any other failed call as one Try again cannot fix, and not as a read", () => {
    for (const [channel, payload] of [
      [chatOperations.sendChatMessage.channel, { workspaceId: "w1" }],
      [datasetOperations.dataset.channel, { workspaceId: "w1", action: "create" }],
    ] as const) {
      const error = received(channel, payload, new Error(INACTIVE), "w1");
      expect(isStoppedWorkspaceRead(error)).toBe(false);
      expect(isStoppedWorkspaceCall(error)).toBe(true);
    }
  });

  it("keeps the failure's own code and what it means", () => {
    const denied = Object.assign(new Error("Operation not permitted"), { code: "privacy-denied" });
    const error = received(chatOperations.sendChatMessage.channel, { workspaceId: "w1" }, denied, "w1");
    expect(refusalCode(error)).toBe("privacy-denied");
    expect(isPrivacyDenied(error)).toBe(true);
    expect(isStoppedWorkspaceCall(error)).toBe(true);
  });

  it("leaves a failure alone unless its call names the stopped workspace", () => {
    const stopped = vi.fn(() => "w1");
    const channel = chatOperations.listChatMessages.channel;
    expect(stoppedWorkspaceCall(channel, { workspaceId: "w2" }, stopped)).toBeUndefined();
    expect(stoppedWorkspaceCall(channel, { workspaceId: "w1" }, () => null)).toBeUndefined();
    stopped.mockClear();
    expect(stoppedWorkspaceCall(channel, {}, stopped)).toBeUndefined();
    expect(stoppedWorkspaceCall(channel, undefined, stopped)).toBeUndefined();
    expect(stopped).not.toHaveBeenCalled();
    const failure = new Error(INACTIVE);
    expect(ipcWireError(failure, undefined)).toBe(failure);
  });
});

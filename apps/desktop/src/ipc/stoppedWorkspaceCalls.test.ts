import { describe, expect, it, vi } from "vitest";
import { chatOperations } from "./chatOperations";
import { CHANNELS } from "./channels";
import { ipcWireError, isStoppedWorkspaceCall, isStoppedWorkspaceRead, readError } from "./errorWords";
import { markStoppedWorkspaceCall } from "./stoppedWorkspaceCalls";

const INACTIVE = "This workspace is no longer open in this window.";

// What the renderer receives: Electron sends a rejected handler's error as its string.
function received(channel: string, payload: unknown, error: Error, stopped: string | null): Error {
  const sent = ipcWireError(markStoppedWorkspaceCall(channel, payload, error, () => stopped));
  return new Error(`Error invoking remote method '${channel}': ${String(sent)}`);
}

describe("a call on the workspace its window has stopped", () => {
  it("marks a failed read so the window drops it, with its words unchanged", () => {
    for (const channel of [chatOperations.listChatMessages.channel, CHANNELS.listCollections]) {
      const error = received(channel, { workspaceId: "w1" }, new Error(INACTIVE), "w1");
      expect(isStoppedWorkspaceRead(error)).toBe(true);
      expect(isStoppedWorkspaceCall(error)).toBe(true);
      expect(readError(error).words).toBe(readError(new Error(INACTIVE)).words);
    }
  });

  it("marks any other failed call as one Try again cannot fix, and not as a read", () => {
    const error = received(chatOperations.sendChatMessage.channel, { workspaceId: "w1" }, new Error(INACTIVE), "w1");
    expect(isStoppedWorkspaceRead(error)).toBe(false);
    expect(isStoppedWorkspaceCall(error)).toBe(true);
  });

  it("leaves a failure alone unless its call names the stopped workspace", () => {
    const failure = new Error(INACTIVE);
    const stopped = vi.fn(() => "w1");
    const channel = chatOperations.listChatMessages.channel;
    expect(markStoppedWorkspaceCall(channel, { workspaceId: "w2" }, failure, stopped)).toBe(failure);
    expect(markStoppedWorkspaceCall(channel, { workspaceId: "w1" }, failure, () => null)).toBe(failure);
    stopped.mockClear();
    expect(markStoppedWorkspaceCall(channel, {}, failure, stopped)).toBe(failure);
    expect(markStoppedWorkspaceCall(channel, undefined, failure, stopped)).toBe(failure);
    expect(stopped).not.toHaveBeenCalled();
  });
});

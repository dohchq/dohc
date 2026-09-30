// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetryCollectionAutomationResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { REPEATS_MESSAGES_SENTENCE, useAutomationRetry } from "./useAutomationRetry";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const request = (target: { automationId: string; claimId: string; onServer: boolean }, startOver: boolean) =>
  bridge().retryCollectionAutomation({ workspaceId: "ws-a", ...target, startOver });

function Retry(props: { workspaceId: string; onError: () => void; onQueued: () => void; onSwitchedOff?: () => void }) {
  const { retry, dialog } = useAutomationRetry({ ...props, onSwitchedOff: props.onSwitchedOff ?? (() => undefined), request });
  return (
    <>
      <button type="button" onClick={() => retry({ automationId: "collection:Tasks#stamp", claimId: "atc_1", onServer: false })}>
        Try again
      </button>
      {dialog}
    </>
  );
}

describe("Try again for an automation run", () => {
  it("drops an answer that arrives after the workspace changed, instead of confirming or reporting it there", async () => {
    const answers: Array<{ resolve: (value: RetryCollectionAutomationResult) => void; reject: (error: unknown) => void }> = [];
    const retryCollectionAutomation = vi.fn(() => new Promise<RetryCollectionAutomationResult>((resolve, reject) => {
      answers.push({ resolve, reject });
    }));
    vi.stubGlobal("dohcDesktop", { retryCollectionAutomation });
    const onError = vi.fn();
    const onQueued = vi.fn();
    const { rerender } = render(<Retry workspaceId="ws-a" onError={onError} onQueued={onQueued} />);

    act(() => screen.getByRole("button", { name: "Try again" }).click());
    act(() => screen.getByRole("button", { name: "Try again" }).click());
    expect(retryCollectionAutomation).toHaveBeenCalledWith({
      workspaceId: "ws-a", automationId: "collection:Tasks#stamp", claimId: "atc_1", startOver: false, onServer: false,
    });
    rerender(<Retry workspaceId="ws-b" onError={onError} onQueued={onQueued} />);
    await act(async () => {
      answers[0]!.resolve({ status: "definition-changed", repeatsMessages: false });
      answers[1]!.reject(new Error("The workspace engine is not running."));
    });
    expect(screen.queryByTestId("automation-start-over")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it.each([false, true])("confirms a changed automation and warns when it repeats messages: %s", async (repeatsMessages) => {
    const retryCollectionAutomation = vi.fn(async (payload: { startOver: boolean }): Promise<RetryCollectionAutomationResult> =>
      payload.startOver ? { status: "queued", press: false } : { status: "definition-changed", repeatsMessages });
    vi.stubGlobal("dohcDesktop", { retryCollectionAutomation });
    const onQueued = vi.fn();
    render(<Retry workspaceId="ws-a" onError={() => undefined} onQueued={onQueued} />);

    await act(async () => screen.getByRole("button", { name: "Try again" }).click());
    expect(screen.getByTestId("automation-start-over").textContent?.includes(REPEATS_MESSAGES_SENTENCE)).toBe(repeatsMessages);
    await act(async () => screen.getByTestId("automation-start-over-confirm").click());
    expect(retryCollectionAutomation).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "ws-a", startOver: true }));
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it("queues nothing for a switched-off automation and hands its controls over, in this workspace only", async () => {
    const controls = {
      recovery: "automation-controls" as const, automation: "collection:Tasks#stamp", path: "Tasks/automations.yaml",
    };
    const answers: Array<(value: RetryCollectionAutomationResult) => void> = [];
    vi.stubGlobal("dohcDesktop", {
      retryCollectionAutomation: vi.fn(() => new Promise<RetryCollectionAutomationResult>((resolve) => answers.push(resolve))),
    });
    const onError = vi.fn();
    const onQueued = vi.fn();
    const onSwitchedOff = vi.fn();
    const { rerender } = render(<Retry workspaceId="ws-a" onError={onError} onQueued={onQueued} onSwitchedOff={onSwitchedOff} />);

    act(() => screen.getByRole("button", { name: "Try again" }).click());
    await act(async () => answers[0]!({ status: "switched-off", target: controls }));
    expect(onSwitchedOff).toHaveBeenCalledWith(controls, { automationId: "collection:Tasks#stamp", claimId: "atc_1", onServer: false });
    expect(onQueued).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    act(() => screen.getByRole("button", { name: "Try again" }).click());
    rerender(<Retry workspaceId="ws-b" onError={onError} onQueued={onQueued} onSwitchedOff={onSwitchedOff} />);
    await act(async () => answers[1]!({ status: "switched-off", target: controls }));
    expect(onSwitchedOff).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePendingAgentMention, type AgentMentionInput } from "./usePendingAgentMention";

// Pins the promise the busy-mention path makes to the user: a mention sent
// while the agent is mid-run is NEVER dropped — it is held and delivered the
// moment the run ends (active -> idle), oldest first.

function mention(threadId: string): AgentMentionInput {
  return { threadId, mentioned: [], body: `hi ${threadId}` };
}

describe("usePendingAgentMention", () => {
  it("delivers a queued mention when the run ends (active -> idle)", () => {
    const deliver = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }) => usePendingAgentMention({ agentActive: active, deliver }),
      { initialProps: { active: true } },
    );

    act(() => result.current.enqueue(mention("t1")));
    // Still busy: nothing delivered yet, but the mention is retained.
    expect(deliver).not.toHaveBeenCalled();
    expect(result.current.pendingCount()).toBe(1);

    // Run ends → the held mention goes out exactly once.
    rerender({ active: false });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(mention("t1"));
    expect(result.current.pendingCount()).toBe(0);
  });

  it("does not deliver while the agent stays busy", () => {
    const deliver = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }) => usePendingAgentMention({ agentActive: active, deliver }),
      { initialProps: { active: true } },
    );
    act(() => result.current.enqueue(mention("t1")));
    rerender({ active: true }); // still running
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does nothing on an idle -> idle tick with nothing queued", () => {
    const deliver = vi.fn();
    const { rerender } = renderHook(
      ({ active }) => usePendingAgentMention({ agentActive: active, deliver }),
      { initialProps: { active: false } },
    );
    rerender({ active: false });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("drains FIFO, one mention per run, oldest first", () => {
    const deliver = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }) => usePendingAgentMention({ agentActive: active, deliver }),
      { initialProps: { active: true } },
    );
    act(() => {
      result.current.enqueue(mention("first"));
      result.current.enqueue(mention("second"));
    });

    // First run ends → oldest mention delivered.
    rerender({ active: false });
    expect(deliver).toHaveBeenLastCalledWith(mention("first"));
    expect(result.current.pendingCount()).toBe(1);

    // Delivering started a new run; when THAT ends the next mention rides out.
    rerender({ active: true });
    rerender({ active: false });
    expect(deliver).toHaveBeenLastCalledWith(mention("second"));
    expect(result.current.pendingCount()).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

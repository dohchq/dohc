// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatDispatchStateForThreadResult } from "../../ipc/bridgeContract";
import type { AgentAddressedOffer, AgentOfferState } from "../offers/agentAddressed";
import { AgentOffer, NEW_CONVERSATION, useAgentOffer } from "./AgentOffer";
import { ChatAvatar } from "./ChatAvatar";
import type { AgentSetupSummary } from "./ChatsView";
import { MentionComposer } from "./MentionComposer";

// Counts the offer's renders: in a stream composer only the offer draws an avatar.
vi.mock("./ChatAvatar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ChatAvatar")>();
  return { ...actual, ChatAvatar: vi.fn(actual.ChatAvatar) };
});

const candidates = [
  { id: "agent:default", kind: "agent" as const, handle: "Nova", label: "Nova", description: "your agent" },
  { id: "user:you", kind: "user" as const, handle: "you", label: "You", description: "you" },
];
const ready: AgentSetupSummary = {
  workspaceId: "ws-a", agentName: "Nova", runnerConfigured: true, runnerEnabled: true, agentRunActive: false,
  agents: [{ id: "default", name: "Nova", enabled: true }],
};

function Composer(props: {
  scope?: string;
  workspaceId?: string;
  setup?: AgentSetupSummary;
  dispatch?: ChatDispatchStateForThreadResult | null;
}) {
  const [value, setValue] = useState("");
  const { offer, onRosterPick, scope } = useAgentOffer({
    workspaceId: props.workspaceId ?? "ws-a",
    scope: props.scope ?? "ws-a:thread:one",
    setup: props.setup ?? ready,
    dispatch: props.dispatch === undefined ? NEW_CONVERSATION : props.dispatch,
    reach: "C:\\work\\trip-planner",
  });
  return (
    <MentionComposer testIdPrefix="chats" composerId="chats-composer" value={value} sending={false}
      placeholder="Write a comment…" sendLabel="Send message" candidates={candidates} onChange={setValue}
      onSend={() => setValue("")} onRosterPick={onRosterPick} rosterScope={scope} agentOffer={offer} />
  );
}

async function pickAgent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("chats-composer"), "@No");
  await user.click(screen.getAllByTestId("chats-mention-option")[0]!);
}

function offer(state: AgentOfferState, working = state === "working"): AgentAddressedOffer {
  return {
    kind: "agent-addressed", agent: candidates[0]!, presentation: { group: "", hue: null, self: false },
    state, working, reach: "C:\\work\\trip-planner",
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the agent offer", () => {
  it.each([
    ["runs", "Runs when you send", "reaches trip-planner", "run"],
    ["working", "Runs after the current run", "reaches trip-planner", "working"],
    ["paused", "Replies paused · runs after Resume", "reaches trip-planner", null],
    // Alone, the folder says what it is.
    ["unknown", null, "Reaches trip-planner", null],
  ] as const)("%s says %j", (state, words, reach, mark) => {
    render(<AgentOffer offer={offer(state)} surface="post" />);
    const node = screen.getByTestId("composer-agent-offer");
    expect(node.dataset.state).toBe(state);
    expect(screen.queryByTestId("composer-agent-offer-words")?.textContent ?? null).toBe(words);
    expect(screen.queryByTestId("composer-agent-offer-reach")?.textContent ?? null).toBe(reach);
    const run = screen.queryByTestId("composer-agent-offer-run");
    expect(run ? (run.className.includes("bg-agent") ? "working" : "run") : null).toBe(mark);
  });

  it("shows only the agent when nothing is known, not even its folder", () => {
    render(<AgentOffer offer={{ ...offer("unknown"), reach: null }} surface="stream" />);
    expect(screen.getByTestId("composer-agent-offer").textContent).toBe("Nova");
  });

  it("floats over a stream composer's bars, not inside its box", () => {
    render(
      <MentionComposer testIdPrefix="chats" composerId="chats-composer" value="@Nova " sending={false}
        placeholder="Write a comment…" sendLabel="Send message" candidates={candidates} onChange={() => {}}
        onSend={() => {}} agentOffer={offer("runs")}
        above={<div data-testid="chats-replying-mode">Replying to Sam</div>} />,
    );
    const stack = screen.getByTestId("composer-agent-offer").parentElement!;
    expect(stack.firstElementChild).toBe(screen.getByTestId("chats-replying-mode"));
    expect(screen.getByTestId("chats-composer").closest("form")!.contains(screen.getByTestId("composer-agent-offer"))).toBe(false);
  });

  it("marks a known run when the rest is unknown", () => {
    render(<AgentOffer offer={offer("unknown", true)} surface="stream" />);
    expect(screen.getByTestId("composer-agent-offer-run").className).toContain("bg-agent");
    expect(screen.getByTestId("composer-agent-offer").textContent).toContain("agent working");
  });

  it("appears on a roster pick and never on a typed @Nova", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const composer = screen.getByTestId("chats-composer");
    await user.type(composer, "@Nova check it");
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
    await user.clear(composer);
    await pickAgent(user);
    expect(screen.getByTestId("composer-agent-offer").dataset.state).toBe("runs");
  });

  it("follows the open conversation's dispatch", async () => {
    const user = userEvent.setup();
    const view = render(<Composer dispatch={null} />);
    await pickAgent(user);
    expect(screen.getByTestId("composer-agent-offer").dataset.state).toBe("unknown");
    view.rerender(<Composer dispatch={{ liveRunId: null, pendingCount: 0, paused: true }} />);
    expect(screen.getByTestId("composer-agent-offer").dataset.state).toBe("paused");
    view.rerender(<Composer dispatch={{ liveRunId: "run-1", pendingCount: 0, paused: false }} />);
    expect(screen.getByTestId("composer-agent-offer").dataset.state).toBe("working");
  });

  it("leaves when the mention is deleted", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await pickAgent(user);
    const composer = screen.getByTestId("chats-composer") as HTMLTextAreaElement;
    composer.focus();
    composer.setSelectionRange(0, 6);
    await user.keyboard("{Backspace}");
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
  });

  it("leaves after the send", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await pickAgent(user);
    await user.type(screen.getByTestId("chats-composer"), "check it{Enter}");
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
  });

  it("leaves on a conversation switch and does not come back with the draft", async () => {
    const user = userEvent.setup();
    const view = render(<Composer />);
    await pickAgent(user);
    view.rerender(<Composer scope="ws-a:thread:two" />);
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
    view.rerender(<Composer scope="ws-a:thread:one" />);
    expect((screen.getByTestId("chats-composer") as HTMLTextAreaElement).value).toBe("@Nova ");
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
  });

  it("never shows runner facts read for another workspace", async () => {
    const user = userEvent.setup();
    render(<Composer workspaceId="ws-b" scope="ws-b:thread:one" />);
    await pickAgent(user);
    expect(screen.queryByTestId("composer-agent-offer")).toBeNull();
  });

  it("does no offer work while the person types", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    await pickAgent(user);
    const node = screen.getByTestId("composer-agent-offer");
    const renders = vi.mocked(ChatAvatar).mock.calls.length;
    expect(renders).toBeGreaterThan(0);
    await user.type(screen.getByTestId("chats-composer"), "check funnel.csv against last week");
    expect(screen.getByTestId("composer-agent-offer")).toBe(node);
    expect(vi.mocked(ChatAvatar).mock.calls.length).toBe(renders);
  });
});

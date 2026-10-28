// @vitest-environment jsdom
import { writeFileSync } from "node:fs";
import { useCallback, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MentionComposer } from "./MentionComposer";
import { NEW_CONVERSATION, useAgentOffer } from "./AgentOffer";
import type { AgentRosterPick } from "../offers/agentAddressed";
const candidates = [{ id: "agent:default", kind: "agent" as const, handle: "agent", label: "Agent" }];
const setup = {
  workspaceId: "ws", runnerConfigured: true, runnerEnabled: true, agentRunActive: false,
  agents: [{ id: "default", name: "Agent", enabled: true }],
};
afterEach(cleanup);

// With a pick, the composer also shows the agent's offer, as ChatsView does.
function Composer(props: { onPick?: (pick: AgentRosterPick | null) => void }) {
  const [value, setValue] = useState("@ag");
  const agent = useAgentOffer({ workspaceId: "ws", scope: "ws:thread", setup, dispatch: NEW_CONVERSATION, reach: "C:\\work" });
  const { onPick } = props;
  const { onRosterPick } = agent;
  const report = useCallback((pick: AgentRosterPick | null) => { onPick?.(pick); onRosterPick(pick); }, [onPick, onRosterPick]);
  return <><MentionComposer composerId="typing-composer" testIdPrefix="typing" value={value}
    sending={false} placeholder="Message" sendLabel="Send" candidates={candidates}
    fileCandidates={[]} onChange={setValue} onSend={() => {}} onRosterPick={onPick ? report : undefined}
    rosterScope={agent.scope} agentOffer={agent.offer} />
    <output data-testid="controlled-value">{value}</output></>;
}

it("measures input dispatch through the mounted controlled composer with a retained roster pick", () => {
  const measurements = [];
  for (const selected of [false, true]) {
    const onPick = selected ? vi.fn() : undefined;
    render(<Composer onPick={onPick} />);
    const node = screen.getByTestId("typing-composer") as HTMLTextAreaElement;
    node.focus(); node.setSelectionRange(3, 3);
    fireEvent.click(node);
    fireEvent.mouseDown(screen.getByTestId("typing-mention-option"));
    let value = "@agent " + "x".repeat(10_000);
    fireEvent.input(node, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
    expect(screen.getByTestId("controlled-value").textContent).toBe(value);
    if (onPick) expect(onPick).toHaveBeenLastCalledWith({ candidate: candidates[0], from: 0, to: 6 });
    expect(screen.queryByTestId("composer-agent-offer") !== null).toBe(selected);
    const samples: number[] = [];
    for (let i = 0; i < 600; i++) {
      const character = i % 50 === 0 ? "/" : "x";
      const next = value + character;
      const start = performance.now();
      fireEvent.keyDown(node, { key: character });
      fireEvent.keyPress(node, { key: character, charCode: character.charCodeAt(0) });
      fireEvent.input(node, { target: { value: next, selectionStart: next.length, selectionEnd: next.length } });
      fireEvent.keyUp(node, { key: character });
      const elapsed = performance.now() - start;
      if (i >= 100) samples.push(elapsed);
      value = next;
      expect(screen.getByTestId("controlled-value").textContent).toBe(value);
    }
    samples.sort((a,b) => a-b);
    measurements.push({ selected, samples: samples.length, p50: samples[250], p95: samples[475], max: samples[499] });
    expect(samples[475]).toBeLessThan(16);
    if (onPick) expect(onPick).toHaveBeenLastCalledWith({ candidate: candidates[0], from: 0, to: 6 });
    expect(screen.queryByTestId("composer-agent-offer") !== null).toBe(selected);
    cleanup();
  }
  if (process.env.DOHC_COMPOSER_MEASUREMENT) writeFileSync(process.env.DOHC_COMPOSER_MEASUREMENT, JSON.stringify({ runtime: process.version, environment: "jsdom, mounted controlled React composer", bodyLength: 10007, warmup: 100, scope: "keydown, keypress, input, keyup through handlers, controlled parent render and effects; excludes browser paint", measurements }, null, 2));
  console.log("Mounted composer typing ms", JSON.stringify(measurements));
});

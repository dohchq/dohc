// @vitest-environment jsdom
import "../../testing/legendListMock";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ActorPresentation } from "../../ipc/bridgeContract";
import type { IdentityHue } from "../tokens";
import { AgentColorAvatar, AgentColorContext, AgentColorName, AgentColorScope, saveAgentColor } from "./AgentColorPicker";
import { bindAgentColorUpdates, clearAgentColorOverrides, neutralPresentation, ownAgentPresentation } from "./actorPresentation";
import { ChatAvatar } from "./ChatAvatar";
import { ChatMessageList } from "./chatMessages";

afterEach(() => {
  clearAgentColorOverrides();
  cleanup();
});

const ORBIT: ActorPresentation = { group: "7", hue: "plum", self: false };

function Row(props: {
  save?: (group: string, hue: IdentityHue | null) => void;
  presentation?: ActorPresentation;
  kind?: "human" | "agent" | "automation";
}) {
  const presentation = props.presentation ?? ORBIT;
  const kind = props.kind ?? "agent";
  const row = (
    <AgentColorScope name="Orbit" kind={kind} presentation={presentation}>
      <AgentColorAvatar><ChatAvatar name="Orbit" kind={kind} presentation={presentation} /></AgentColorAvatar>
      <span data-testid="author"><AgentColorName>Orbit</AgentColorName></span>
      <button type="button">After</button>
    </AgentColorScope>
  );
  return props.save === undefined ? row : <AgentColorContext.Provider value={props.save}>{row}</AgentColorContext.Provider>;
}

// jsdom has no top layer, so an open popover reads as hidden to role and
// name queries. Its roles and names are read as attributes.
const dialog = () => screen.queryByTestId("agent-color-popover");
const radios = () => [...dialog()!.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]')];
const swatch = (name: string) => {
  const found = radios().find((radio) => radio.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no ${name} swatch`);
  return found;
};

it("opens square swatches from the avatar, olive first, the agent's choice checked and focused", async () => {
  const user = userEvent.setup();
  render(<Row save={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Color for Orbit" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  // In the top layer, so a virtualized list's transformed rows cannot cover it.
  expect(dialog()?.getAttribute("popover")).toBe("manual");
  expect(dialog()?.getAttribute("role")).toBe("dialog");
  expect(dialog()?.getAttribute("aria-label")).toBe("Color for Orbit");
  expect(dialog()?.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Color for Orbit");
  expect(radios().map((radio) => radio.getAttribute("aria-label"))).toEqual(
    ["Olive", "Rust", "Amber", "Teal", "Blue", "Indigo", "Plum", "Rose"]);
  expect(radios()[0]!.className).toContain("bg-agent");
  for (const radio of radios()) expect(radio.className).toContain("rounded-md");
  expect(swatch("Plum").getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(swatch("Plum"));
});

it("saves a pick under the token's group, closes, and returns focus; Olive clears the choice", async () => {
  const user = userEvent.setup();
  const save = vi.fn();
  render(<Row save={save} />);
  const trigger = screen.getByRole("button", { name: "Color for Orbit" });
  await user.click(trigger);
  await user.click(swatch("Teal"));
  expect(save).toHaveBeenLastCalledWith("7", "teal");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger);
  await user.click(swatch("Olive"));
  expect(save).toHaveBeenLastCalledWith("7", null);
});

it("moves focus with the arrows without saving, and picks with Enter or Space", async () => {
  const user = userEvent.setup();
  const save = vi.fn();
  render(<Row save={save} />);
  const trigger = screen.getByRole("button", { name: "Color for Orbit" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(swatch("Rose"));
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(swatch("Olive"));
  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(document.activeElement).toBe(swatch("Plum"));
  expect(save).not.toHaveBeenCalled();
  await user.keyboard("{ArrowLeft}{Enter}");
  expect(save).toHaveBeenLastCalledWith("7", "indigo");
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  await user.keyboard("{ArrowRight} ");
  expect(save).toHaveBeenLastCalledWith("7", "rose");
});

it("closes on Escape and returns focus to the avatar, saving nothing", async () => {
  const user = userEvent.setup();
  const save = vi.fn();
  const outer = vi.fn();
  render(<div onKeyDown={(event) => outer(event.key)}><Row save={save} /></div>);
  const trigger = screen.getByRole("button", { name: "Color for Orbit" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(dialog()).not.toBeNull();
  await user.keyboard("{Escape}");
  expect(dialog()).toBeNull();
  await act(async () => undefined);
  expect(document.activeElement).toBe(trigger);
  expect(save).not.toHaveBeenCalled();
  expect(outer).not.toHaveBeenCalledWith("Escape");
});

// user-event moves Tab on from the key's original target, which this close
// removes; a browser moves on from the focused element. So the test pins what
// the browser moves on from: focus on the trigger, the key not prevented.
it.each([["Tab", false], ["Shift+Tab", true]] as const)(
  "closes on %s from a swatch the arrows reached, and leaves the key to move focus on from the avatar",
  async (_, shiftKey) => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<Row save={save} />);
    const trigger = screen.getByRole("button", { name: "Color for Orbit" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(swatch("Indigo"));
    let notPrevented = false;
    act(() => { notPrevented = fireEvent.keyDown(swatch("Indigo"), { key: "Tab", shiftKey }); });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);
    await act(async () => undefined);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(save).not.toHaveBeenCalled();
  },
);

it.each([
  ["its chat scrolls", () => fireEvent.scroll(screen.getByTestId("chat"))],
  ["the window resizes", () => fireEvent(window, new Event("resize"))],
] as const)("closes when %s, returning focus that was inside it to the avatar", async (_, move) => {
  const user = userEvent.setup();
  render(<div data-testid="chat"><Row save={vi.fn()} /></div>);
  const trigger = screen.getByRole("button", { name: "Color for Orbit" });
  await user.click(trigger);
  expect(document.activeElement).toBe(swatch("Plum"));
  // A scroll inside the popover is its own and keeps it open.
  fireEvent.scroll(dialog()!);
  expect(dialog()).not.toBeNull();
  act(move);
  await act(async () => undefined);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("opens from the agent's name, which stays plain text to the keyboard", async () => {
  const user = userEvent.setup();
  render(<Row save={vi.fn()} />);
  expect(within(screen.getByTestId("author")).queryByRole("button")).toBeNull();
  await user.click(screen.getByText("Orbit", { selector: "[data-testid=author] span" }));
  expect(dialog()).not.toBeNull();
});

it("checks what main's event says, not the save", async () => {
  const user = userEvent.setup();
  let changed: Parameters<import("../../ipc/bridgeContract").DohcDesktopBridge["onAgentColorChanged"]>[0] = () => undefined;
  const stop = bindAgentColorUpdates({ onAgentColorChanged: (listener) => { changed = listener; return () => undefined; } }, () => "w");
  render(<Row save={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Color for Orbit" }));
  await user.click(swatch("Teal"));
  await user.click(screen.getByRole("button", { name: "Color for Orbit" }));
  expect(swatch("Plum").getAttribute("aria-checked")).toBe("true");
  act(() => changed({ workspaceId: "w", group: "7", hue: "teal" }));
  expect(swatch("Teal").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByTitle("Orbit").className).toContain("text-hue-teal");
  act(() => changed({ workspaceId: "w", group: "7", hue: null }));
  expect(swatch("Olive").getAttribute("aria-checked")).toBe("true");
  stop();
});

it.each([
  ["no save in this surface", undefined, ORBIT, "agent"],
  ["a person", vi.fn(), { ...ORBIT, hue: null }, "human"],
  ["an automation", vi.fn(), neutralPresentation, "automation"],
  ["an agent main did not issue a group for", vi.fn(), neutralPresentation, "agent"],
  ["the renderer's own agent token", vi.fn(), ownAgentPresentation, "agent"],
  ["an unknown author", vi.fn(), { group: "unknown:abc", hue: null, self: false }, "agent"],
] as const)("offers no choice for %s", (_, save, presentation, kind) => {
  render(<Row save={save} presentation={presentation} kind={kind} />);
  expect(screen.queryByRole("button", { name: "Color for Orbit" })).toBeNull();
});

it("puts the choice on an agent's message in a conversation, and saves it with the workspace and the token's group", async () => {
  const user = userEvent.setup();
  const api = { setAgentColor: vi.fn(async () => undefined) };
  render(
    <AgentColorContext.Provider value={saveAgentColor(api, "workspace-a", vi.fn())}>
      <ChatMessageList testIdPrefix="chat" loading={false} emptyLabel="None" messages={[
        { id: "m1", threadId: "t", authorKind: "human", authorDisplayName: "Sam", presentation: { group: "3", hue: "rust", self: false }, body: "Hi", createdAtMs: 1 },
        { id: "m2", threadId: "t", authorKind: "agent", authorDisplayName: "Orbit", presentation: ORBIT, body: "Hello", createdAtMs: 2 },
      ]} />
    </AgentColorContext.Provider>,
  );
  expect(screen.queryByRole("button", { name: "Color for Sam" })).toBeNull();
  // The name and the sparkle take the avatar's plum; the person's name stays ink.
  const authors = await screen.findAllByTestId("chat-message-author");
  expect(authors.map((author) => author.querySelector(".text-hue-plum")?.textContent ?? null)).toEqual([null, "Orbit"]);
  expect(authors[0]!.className).toContain("text-ink");
  expect(screen.getByTestId("chat-agent-badge").parentElement!.className).toContain("text-hue-plum");
  await user.click(await screen.findByRole("button", { name: "Color for Orbit" }));
  await user.click(swatch("Blue"));
  expect(api.setAgentColor).toHaveBeenCalledWith({ workspaceId: "workspace-a", group: "7", hue: "blue" });
});

it("reports a refused save with Try again, which saves the same choice again", async () => {
  const api = { setAgentColor: vi.fn().mockRejectedValueOnce(new Error("Choose an agent shown in this workspace.")).mockResolvedValue(undefined) };
  const report = vi.fn();
  saveAgentColor(api, "workspace-a", report)("7", null);
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  expect(report.mock.calls[0]![0]).toBe("dohc could not save this agent's color.");
  expect((report.mock.calls[0]![1] as Error).message).toContain("Choose an agent shown in this workspace.");
  (report.mock.calls[0]![2] as () => void)();
  expect(api.setAgentColor).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", group: "7", hue: null });
  expect(api.setAgentColor).toHaveBeenCalledTimes(2);
});

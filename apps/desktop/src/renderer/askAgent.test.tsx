// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentIsSetUp, agentRequestText, AskAgentButton } from "./askAgent";
import { CUSTOMIZE_TARGETS } from "./settings/customize";
import { documentCollectionFiles } from "./collections/CollectionCustomizeDialog";

const where = { settingsFile: "C:\\state\\settings.json", workspaceId: "ws-1" };

afterEach(cleanup);

describe("agentRequestText", () => {
  it("names the settings file and the part's key", () => {
    expect(agentRequestText({ kind: "settings", target: CUSTOMIZE_TARGETS.editor }, where)).toBe(
      [
        'Change my dohc editor settings. They are the "editor.fontFamily" and "editor.fontSize" keys in my dohc settings file, C:\\state\\settings.json.',
        "dohc applies the file when it is saved.",
        "What I want: ",
      ].join("\n"),
    );
  });

  it("names the settings file alone when no part asked", () => {
    expect(agentRequestText({ kind: "settings" }, where).split("\n")[0]).toBe(
      "Change my dohc settings. They are in my dohc settings file, C:\\state\\settings.json.",
    );
  });

  it("names each file a Collection keeps and what it holds", () => {
    expect(agentRequestText({ kind: "collection", name: "Trips", files: documentCollectionFiles("plans/trips") }, where)).toBe(
      [
        'Change my dohc Collection "Trips" in this workspace.',
        "Its fields and views are in plans/trips/collection.yaml.",
        "Its automations are in plans/trips/automations.yaml.",
        "dohc applies each file when it is saved.",
        "What I want: ",
      ].join("\n"),
    );
  });

  it("names where an app's pin goes for this workspace", () => {
    const text = agentRequestText({ kind: "app" }, where);
    expect(text).toContain("a new folder with an index.html");
    expect(text).toContain('"sidebar" > "pinnedApps" > "ws-1" in my dohc settings file, C:\\state\\settings.json.');
    expect(text.endsWith("What I want: ")).toBe(true);
  });
});

describe("agentIsSetUp", () => {
  const setup = { runnerConfigured: true, runnerEnabled: true, mcpEnabled: false };
  it("needs a name and a runner that is on", () => {
    expect(agentIsSetUp({ ...setup, agentName: "Scout" })).toBe(true);
    expect(agentIsSetUp(setup)).toBe(false);
    expect(agentIsSetUp({ ...setup, agentName: "Scout", runnerEnabled: false })).toBe(false);
  });
});

describe("AskAgentButton", () => {
  it("asks the agent with its request", async () => {
    const ask = vi.fn();
    render(
      <AskAgentButton askAgent={{ ready: true, ask, setUp: vi.fn() }} request={{ kind: "app" }} label="Ask my agent for an app" />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Ask my agent for an app" }));
    expect(ask).toHaveBeenCalledExactlyOnceWith({ kind: "app" });
  });

  it("says there is no agent and offers to set one up", async () => {
    const ask = vi.fn();
    const setUp = vi.fn();
    render(<AskAgentButton askAgent={{ ready: false, ask, setUp }} request={{ kind: "settings" }} />);
    expect(screen.getByText("You have no agent set up.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask my agent" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Set up an agent" }));
    expect(setUp).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
  });
});

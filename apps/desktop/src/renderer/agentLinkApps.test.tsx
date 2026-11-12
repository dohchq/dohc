// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentLinkAppMenu, agentLinkSetups } from "./agentLinkApps";
import { ShellErrorReporter, type ReportShellFailure } from "./shell/useShellError";
import { COPY_FEEDBACK_MS } from "./ui/CopyButton";

const PERSONAL = "https://relay.test/mcp/agent/w/ws-1";
const SHARE = "https://relay.test:8443/mcp/s/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const texts = (link: string, server: "dohc-personal" | "dohc-share") =>
  Object.fromEntries(agentLinkSetups(link, server).map((setup) => [setup.id, setup.text]));

it("gives each agent its own message or commands for the link", () => {
  expect(texts(PERSONAL, "dohc-personal")).toEqual({
    "grok-bot": `Add the MCP server ${PERSONAL} and connect it.`,
    "claude-code": `claude mcp add --transport http dohc-personal ${PERSONAL}\nclaude mcp login dohc-personal`,
    codex: `codex mcp add dohc-personal --url ${PERSONAL}\ncodex mcp login dohc-personal`,
  });
  expect(texts(SHARE, "dohc-share")).toEqual({
    "grok-bot": `Add the MCP server ${SHARE} and connect it.`,
    "claude-code": `claude mcp add --transport http dohc-share ${SHARE}\nclaude mcp login dohc-share`,
    codex: `codex mcp add dohc-share --url ${SHARE}\ncodex mcp login dohc-share`,
  });
});

it.each([
  ["a quote", "https://relay.test/mcp/agent/w/it's"],
  ["a space written as %20", "https://relay.test/mcp/agent/w/my%20notes"],
  ["a command separator", "https://relay.test/mcp/agent/w/a;b"],
  ["a subshell", "https://relay.test/mcp/agent/w/$(id)"],
  ["an IPv6 host", "https://[::1]:8443/mcp/agent/w/ws-1"],
  ["a tilde, which zsh can read as a pattern", "https://relay.test/mcp/agent/w/a~b"],
])("gives no command for a link with %s, which a shell would not take as typed", (_what, link) => {
  expect(agentLinkSetups(link, "dohc-personal").map((setup) => setup.id)).toEqual(["grok-bot"]);
});

// userEvent installs the clipboard a test then spies on, so each test makes its user first.
function userWith(timers: "fake" | "real") {
  if (timers === "real") return userEvent.setup();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

// The list opens in the top layer, which jsdom does not draw, so it reads the list as hidden.
const list = () => screen.queryByRole("menu", { hidden: true });

type MenuFixture = { link: string | null; sensitive?: boolean; report?: ReportShellFailure };

function menu(props: MenuFixture) {
  return (
    <ShellErrorReporter.Provider value={props.report ?? null}>
      <AgentLinkAppMenu
        link={props.link}
        server="dohc-share"
        sensitive={props.sensitive ? { what: "the address for an agent", again: "Reset the link in Share to get a new one." } : undefined}
        testId="apps"
      />
    </ShellErrorReporter.Provider>
  );
}

function renderMenu(props: MenuFixture) {
  const { rerender } = render(menu(props));
  return { rerender: (next: MenuFixture) => rerender(menu(next)) };
}

it("copies the picked agent's setup, says so on its row, then closes", async () => {
  const user = userWith("fake");
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  renderMenu({ link: SHARE });
  await user.click(screen.getByRole("button", { name: "Copy setup for an agent" }));
  expect(screen.getAllByRole("menuitem", { hidden: true }).map((row) => row.textContent)).toEqual([
    "Message for Grok Bot",
    "Commands for Claude Code",
    "Commands for Codex",
  ]);
  await user.click(screen.getByTestId("apps-codex"));
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith(`codex mcp add dohc-share --url ${SHARE}\ncodex mcp login dohc-share`);
  expect(screen.getByTestId("apps-codex").textContent).toBe("Copied");
  expect(screen.getByRole("status", { hidden: true }).textContent).toBe("Copied");
  // The other rows keep their names while one answers.
  expect(screen.getByTestId("apps-grok-bot").textContent).toBe("Message for Grok Bot");
  act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS); });
  expect(list()).toBeNull();
  // Opened again, the row has its name back.
  await user.click(screen.getByRole("button", { name: "Copy setup for an agent" }));
  expect(screen.getByTestId("apps-codex").textContent).toBe("Commands for Codex");
});

it("keeps a list opened again open when the earlier answer's time is up", async () => {
  const user = userWith("fake");
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  renderMenu({ link: SHARE });
  const trigger = screen.getByRole("button", { name: "Copy setup for an agent" });
  await user.click(trigger);
  await user.click(screen.getByTestId("apps-grok-bot"));
  expect(screen.getByTestId("apps-grok-bot").textContent).toBe("Copied");
  await user.keyboard("{Escape}");
  expect(list()).toBeNull();
  await user.click(trigger);
  act(() => { vi.advanceTimersByTime(COPY_FEEDBACK_MS); });
  expect(list()).not.toBeNull();
  expect(screen.getByTestId("apps-grok-bot").textContent).toBe("Message for Grok Bot");
});

it("says a refused copy on its row and reports it without keeping a secret link to try again with", async () => {
  const user = userWith("real");
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  const report = vi.fn<ReportShellFailure>();
  renderMenu({ link: SHARE, sensitive: true, report });
  await user.click(screen.getByRole("button", { name: "Copy setup for an agent" }));
  await user.click(screen.getByTestId("apps-grok-bot"));
  expect(screen.getByTestId("apps-grok-bot").textContent).toBe("Could not copy");
  expect(report).toHaveBeenCalledTimes(1);
  const failure = report.mock.calls[0]![0];
  expect(failure.message).toContain("dohc could not copy the address for an agent.");
  expect(failure.message).not.toContain(SHARE);
  // Once the menu is gone, Try again has no address to copy: it says where to get one.
  cleanup();
  expect(writeText).toHaveBeenCalledTimes(1);
  act(() => failure.retry?.());
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledTimes(2);
  const later = report.mock.calls[1]![0];
  expect(later.retry).toBeNull();
  expect(later.message).toContain("Reset the link in Share to get a new one.");
});

it("never copies a link its surface has replaced when Try again comes after a failed copy", async () => {
  const user = userWith("real");
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
  const report = vi.fn<ReportShellFailure>();
  const { rerender } = renderMenu({ link: SHARE, sensitive: true, report });
  await user.click(screen.getByRole("button", { name: "Copy setup for an agent" }));
  await user.click(screen.getByTestId("apps-codex"));
  expect(report).toHaveBeenCalledTimes(1);
  // The surface gets a new link while the same menu stays on screen.
  const replaced = SHARE.replace(/6$/u, "7");
  rerender({ link: replaced, sensitive: true, report });
  await act(async () => report.mock.calls[0]![0].retry?.());
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(writeText).toHaveBeenLastCalledWith(`codex mcp add dohc-share --url ${replaced}\ncodex mcp login dohc-share`);
  // With no link left, Try again copies nothing.
  rerender({ link: null, sensitive: true, report });
  await act(async () => report.mock.calls[0]![0].retry?.());
  expect(writeText).toHaveBeenCalledTimes(2);
});

it("cannot open while there is no link", async () => {
  const user = userWith("real");
  renderMenu({ link: null });
  const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Copy setup for an agent" });
  expect(trigger.disabled).toBe(true);
  await user.click(trigger);
  expect(list()).toBeNull();
});

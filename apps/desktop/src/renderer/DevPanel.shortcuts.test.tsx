// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { makeBridge, STORED_STATE } from "./DesktopWorkspaceShell.testHarness";
import { DevPanel } from "./DevPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ["win32", "Ctrl+Shift+D", "Ctrl Shift D"],
  ["darwin", "⇧⌘D", "⇧⌘D"],
  ["linux", "Ctrl+Shift+D", "Ctrl Shift D"],
] as const)("shows the %s dev title and chip keys from the registry", (platform, title, chip) => {
  vi.stubGlobal("dohcDesktop", { ...makeBridge(Promise.resolve(STORED_STATE), platform), devTools: true });
  render(<DevPanel />);
  const trigger = screen.getByRole("button", { name: "Dev tools" });
  expect(trigger.title).toBe(`Dev tools (${title})`);
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Dev tools" }).querySelector("kbd")?.textContent).toBe(chip);
});

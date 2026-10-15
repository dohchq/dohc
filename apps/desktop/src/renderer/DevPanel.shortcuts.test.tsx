// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { makeBridge, STORED_STATE } from "./DesktopWorkspaceShell.testHarness";
import { DevPanel } from "./DevPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["win32", "darwin", "linux"] as const)("preserves the %s dev title and chip text from the registry", (platform) => {
  vi.stubGlobal("dohcDesktop", { ...makeBridge(Promise.resolve(STORED_STATE), platform), devTools: true });
  render(<DevPanel />);
  const trigger = screen.getByRole("button", { name: "Dev tools" });
  expect(trigger.title).toBe("Dev tools (Ctrl+Shift+D)");
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Dev tools" }).querySelector("kbd")?.textContent).toBe("Ctrl Shift D");
});

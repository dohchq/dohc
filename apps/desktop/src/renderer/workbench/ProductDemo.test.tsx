// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProductDemo } from "../../../../site/src/ProductDemo";

vi.mock("../editor/MarkdownEditor", () => ({ MarkdownEditor: () => null }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps a demo Explorer collision in Notices after the toast closes", async () => {
  render(<ProductDemo />);
  fireEvent.click(screen.getByRole("button", { name: "New file" }));
  const input = screen.getByTestId("tree-edit-input");
  fireEvent.change(input, { target: { value: "welcome.md" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const toast = await screen.findByTestId("workspace-shell-error");
  expect(toast.textContent).toContain("A document already exists at welcome.md");
  expect(within(toast).getByRole("button", { name: "Copy error details" })).toBeTruthy();
  fireEvent.click(within(toast).getByRole("button", { name: "Dismiss workspace error" }));
  expect(screen.queryByTestId("workspace-shell-error")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Notices (1)" }));
  expect(screen.getByText("A document already exists at welcome.md")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy error details" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  expect(screen.queryByText("A document already exists at welcome.md")).toBeNull();
  expect(screen.getByRole("button", { name: "Notices" })).toBeTruthy();
});

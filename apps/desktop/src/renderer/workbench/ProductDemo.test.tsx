// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
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
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  render(<ProductDemo />, { container });
  const demo = within(container);
  fireEvent.click(demo.getByRole("button", { name: "New file" }));
  const input = demo.getByTestId("tree-edit-input");
  fireEvent.change(input, { target: { value: "welcome.md" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const toast = await demo.findByTestId("workspace-shell-error");
  expect(toast.textContent).toContain("A document already exists at welcome.md");
  expect(within(toast).getByRole("button", { name: "Copy error details" })).toBeTruthy();
  fireEvent.click(within(toast).getByRole("button", { name: "Dismiss workspace error" }));
  expect(demo.queryByTestId("workspace-shell-error")).toBeNull();
  fireEvent.click(demo.getByRole("button", { name: "Notices, 1 unread" }));
  expect(demo.getByText("A document already exists at welcome.md")).toBeTruthy();
  const copy = demo.getByRole("button", { name: "Copy error details" });
  fireEvent.pointerDown(copy, { bubbles: true, composed: true });
  expect(demo.getByRole("button", { name: "Copy error details" })).toBe(copy);
  fireEvent.pointerDown(demo.getByRole("button", { name: "New file" }), { bubbles: true, composed: true });
  expect(demo.queryByTestId("notice-center")).toBeNull();
  fireEvent.click(demo.getByRole("button", { name: "Notices, 1 unread" }));
  const dismiss = demo.getByRole("button", { name: "Dismiss notice" });
  fireEvent.pointerDown(dismiss, { bubbles: true, composed: true });
  expect(demo.getByRole("button", { name: "Dismiss notice" })).toBe(dismiss);
  fireEvent.click(dismiss);
  expect(demo.queryByText("A document already exists at welcome.md")).toBeNull();
  expect(demo.getByRole("button", { name: "Notices" })).toBeTruthy();
  host.remove();
});

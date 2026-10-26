// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { focusedElementIn } from "./focusedElement";

afterEach(() => document.body.replaceChildren());

it("names the focused element in the document", () => {
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  expect(focusedElementIn(button)).toBe(button);
});

it("names the focused element inside a shadow root, not its host", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const button = document.createElement("button");
  host.attachShadow({ mode: "open" }).append(button);
  button.focus();
  expect(document.activeElement).toBe(host);
  expect(focusedElementIn(button)).toBe(button);
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

// main.tsx sets data-platform on the root; styles.css scopes platform chrome
// by it.
const offMac = ':root:not([data-platform="darwin"])';

// macOS draws its own scrollbars, which follow the "Show scroll bars"
// setting. A ::-webkit-scrollbar rule replaces them wherever it reaches.
it("styles the window's scrollbar and every other one everywhere but macOS", () => {
  expect(css.match(/^::-webkit-scrollbar.*$/gm)).toBeNull();
  for (const part of ["", "-track", "-corner", "-thumb", "-thumb:hover"]) {
    expect(css).toContain(`${offMac}::-webkit-scrollbar${part},\n${offMac} ::-webkit-scrollbar${part}`);
  }
});

// macOS controls keep the arrow cursor; the pointing hand is for links.
describe("the macOS arrow-cursor rule", () => {
  const selector = css.match(/^(:root\[data-platform="darwin"\] :is\(\.cursor-pointer.*) \{$/m)![1]!;
  const arrow = (html: string, platform = "darwin") => {
    document.documentElement.dataset.platform = platform;
    document.body.innerHTML = html;
    return document.querySelector("[data-probe]")!.matches(selector);
  };

  it("gives controls the arrow", () => {
    expect(arrow('<button class="cursor-pointer" data-probe></button>')).toBe(true);
    expect(arrow('<div class="app-chrome"><div role="tab" data-probe></div></div>')).toBe(true);
    expect(arrow('<input type="checkbox" data-probe>')).toBe(true);
  });

  it("leaves links, what is inside them, disabled controls, and other platforms alone", () => {
    expect(arrow('<a href="https://example.com" class="cursor-pointer" data-probe>x</a>')).toBe(false);
    expect(arrow('<a href="https://example.com"><span class="cursor-pointer" data-probe>x</span></a>')).toBe(false);
    expect(arrow('<button class="cursor-pointer" disabled data-probe></button>')).toBe(false);
    expect(arrow('<button class="cursor-pointer" data-probe></button>', "win32")).toBe(false);
  });
});

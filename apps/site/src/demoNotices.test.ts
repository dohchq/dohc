// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";

// demo.css's own rules. Its @import and @source lines build the desktop's
// Tailwind styles, which jsdom can't, so the test leaves them out.
const demoRules = readFileSync(join(import.meta.dirname, "demo.css"), "utf8")
  .replace(/^@(?:import|source) [^;]+;$/gmu, "");

// The demo mounts the notice center in its activity bar. No positioned box
// sits between it and the demo window.
beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = demoRules;
  document.head.append(style);
  document.body.innerHTML = `
    <div class="demo-window">
      <div class="demo-workbench">
        <nav><div>
          <div data-testid="notice-toasts"></div>
          <div data-testid="notice-center" role="dialog"></div>
        </div></nav>
      </div>
    </div>`;
});

it("places the notice toasts against the demo window, not the page", () => {
  const toasts = document.querySelector('[data-testid="notice-toasts"]')!;
  expect(getComputedStyle(toasts).position).toBe("absolute");
});

it("places the Notices panel against the demo window and keeps it inside", () => {
  const panel = document.querySelector('[data-testid="notice-center"]')!;
  const style = getComputedStyle(panel);
  expect(style.position).toBe("absolute");
  expect(style.maxHeight).toBe("calc(100% - 100px)");
});

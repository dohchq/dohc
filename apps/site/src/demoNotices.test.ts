// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";

// demo.css's own rules. Its @import and @source lines build the desktop's
// Tailwind styles, which jsdom can't, so the test leaves them out.
const demoRules = readFileSync(join(import.meta.dirname, "demo.css"), "utf8")
  .replace(/^@(?:import|source) [^;]+;$/gmu, "");

// The demo mounts the toasts and the Notices panel in its activity bar. Above
// 720px the demo window places them. At 720px or less the workbench places
// them, and it is as wide as the window.
beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = demoRules;
  document.head.append(style);
  document.body.innerHTML = `
    <div class="demo-window">
      <div class="demo-workbench">
        <nav><div>
          <div data-testid="notice-toasts"><div role="alert"></div></div>
          <div data-testid="notice-center" role="dialog"></div>
        </div></nav>
      </div>
    </div>`;
});

it("places the notice toasts against the demo window, inside it and clear of the activity bar", () => {
  const toasts = document.querySelector('[data-testid="notice-toasts"]')!;
  expect(getComputedStyle(toasts).position).toBe("absolute");
  expect(getComputedStyle(toasts).maxWidth).toBe("calc(100% - 68px)");
  expect(getComputedStyle(toasts.firstElementChild!).maxWidth).toBe("100%");
});

it("places the Notices panel against the demo window and keeps it inside", () => {
  const panel = document.querySelector('[data-testid="notice-center"]')!;
  const style = getComputedStyle(panel);
  expect(style.position).toBe("absolute");
  expect(style.maxWidth).toBe("calc(100% - 68px)");
  expect(style.maxHeight).toBe("calc(100% - 100px)");
});

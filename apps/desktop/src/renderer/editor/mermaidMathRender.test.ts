// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderMermaidDiagram } from "./mermaidRender";

const mathMLElementDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "MathMLElement",
);
const getBBoxDescriptor = Object.getOwnPropertyDescriptor(
  SVGElement.prototype,
  "getBBox",
);

beforeAll(() => {
  vi.stubGlobal(
    "CSS",
    window.CSS ?? {
      escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_"),
    },
  );
  vi.stubGlobal("CSSStyleSheet", window.CSSStyleSheet);
  Object.defineProperty(window, "MathMLElement", {
    configurable: true,
    value: window.HTMLElement,
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 120, height: 40 }),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    top: 0,
    right: 120,
    bottom: 40,
    left: 0,
    toJSON: () => ({}),
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (mathMLElementDescriptor) {
    Object.defineProperty(window, "MathMLElement", mathMLElementDescriptor);
  } else {
    Reflect.deleteProperty(window, "MathMLElement");
  }
  if (getBBoxDescriptor) {
    Object.defineProperty(
      SVGElement.prototype,
      "getBBox",
      getBBoxDescriptor,
    );
  } else {
    Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  }
});

describe("renderMermaidDiagram with math", () => {
  it(
    "renders a math-bearing diagram through Mermaid and KaTeX",
    async () => {
      const { svg } = await renderMermaidDiagram(
        "dohc-mermaid-math",
        String.raw`flowchart LR
  A["$$\frac{x^2}{y}$$"] --> B[done]`,
      );

      const rendered = document.createElement("div");
      rendered.innerHTML = svg;

      expect(rendered.querySelector("svg")).not.toBeNull();
      expect(rendered.querySelector(".node .katex math")).not.toBeNull();
      expect(rendered.textContent).not.toContain(
        "MathML is unsupported in this environment.",
      );
    },
    15_000,
  );
});

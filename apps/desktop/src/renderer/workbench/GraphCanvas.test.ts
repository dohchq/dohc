import { describe, expect, it } from "vitest";
import { contrastRatio, mixHex } from "../accentColor";
import { identityHues, palette } from "../tokens";
import { GROUP_HUES, LABEL_DIM, NODE_DIM, NODE_TOKEN, fitCamera, followCamera, labelOpacity } from "./GraphCanvas";

// The Graph page draws on bg, the side panel on panel.
const SURFACES = ["bg", "panel"] as const;

function lowest(theme: "light" | "dark", colors: readonly string[], alpha: number): number {
  const tokens = palette[theme];
  return Math.min(
    ...SURFACES.flatMap((surface) =>
      colors.map((color) => contrastRatio(mixHex(color, tokens[surface], alpha), tokens[surface])),
    ),
  );
}

describe.each(["light", "dark"] as const)("dimmed Graph nodes in %s", (theme) => {
  const nodeColors = [palette[theme][NODE_TOKEN[theme]], ...GROUP_HUES.map((hue) => identityHues[theme][hue])];

  it("keep every node colour at 3:1, and dim no further than that needs", () => {
    expect(lowest(theme, nodeColors, NODE_DIM[theme])).toBeGreaterThanOrEqual(3);
    expect(lowest(theme, nodeColors, NODE_DIM[theme] - 0.02)).toBeLessThan(3);
  });

  it("keep labels at 4.5:1, never fainter than their nodes", () => {
    expect(lowest(theme, [palette[theme].muted], LABEL_DIM[theme])).toBeGreaterThanOrEqual(4.5);
    expect(LABEL_DIM[theme]).toBeGreaterThanOrEqual(NODE_DIM[theme]);
  });

  it("hide a label still fading in or out while another node is emphasised", () => {
    for (const emphasis of [0.1, 0.5, 1]) {
      for (const fade of [0.05, 0.5, 0.95, 1]) {
        const alpha = labelOpacity(fade, emphasis, LABEL_DIM[theme], false);
        if (alpha > 0) expect(lowest(theme, [palette[theme].muted], alpha)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(labelOpacity(0.5, 1, LABEL_DIM[theme], false)).toBe(0);
    expect(labelOpacity(1, 1, LABEL_DIM[theme], false)).toBeCloseTo(LABEL_DIM[theme]);
    // With nothing emphasised, the zoom fade is unchanged; the emphasised node's own label shows whole.
    expect(labelOpacity(0.5, 0, LABEL_DIM[theme], false)).toBe(0.5);
    expect(labelOpacity(0.5, 1, LABEL_DIM[theme], true)).toBe(1);
  });
});

describe("fitting the Graph to its view", () => {
  it("leaves a 16 px margin on the side that limits it, centred", () => {
    // A 300 by 288 panel and a graph 1,000 wide and 500 tall: the width limits it.
    const camera = fitCamera(-500, -250, 500, 250, 300, 288);
    expect(camera.k).toBeCloseTo(0.268);
    expect(-500 * camera.k + camera.tx).toBeCloseTo(16);
    expect(500 * camera.k + camera.tx).toBeCloseTo(284);
    expect(camera.ty).toBe(144);
  });

  it("never draws a node larger than at 100% zoom", () => {
    expect(fitCamera(0, 0, 40, 20, 300, 288)).toEqual({ k: 1, tx: 130, ty: 134 });
  });

  it("zooms out to the fit at once while the layout cools, and eases otherwise", () => {
    const camera = { k: 1, tx: 100, ty: 100 };
    const out = { k: 0.5, tx: 200, ty: 0 };
    const zoomIn = { k: 2, tx: 200, ty: 0 };
    expect(followCamera(camera, out, true)).toEqual(out);
    expect(followCamera(camera, zoomIn, true)).toEqual({ k: 1.15, tx: 115, ty: 85 });
    expect(followCamera(camera, out, false)).toEqual({ k: 0.925, tx: 115, ty: 85 });
  });
});

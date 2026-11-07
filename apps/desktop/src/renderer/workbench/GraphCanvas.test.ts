import { describe, expect, it } from "vitest";
import { contrastRatio, mixHex } from "../accentColor";
import { identityHues, palette } from "../tokens";
import { GROUP_HUES, LABEL_DIM, NODE_DIM, NODE_TOKEN, labelOpacity } from "./GraphCanvas";

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

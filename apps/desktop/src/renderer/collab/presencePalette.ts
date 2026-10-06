const PRESENCE_PALETTE = [
  { background: "#f3e5df", stroke: "#905d47" },
  { background: "#f0ebdd", stroke: "#806d42" },
  { background: "#dceee8", stroke: "#446a50" },
  { background: "#dfeaf2", stroke: "#52697a" },
  { background: "#e2e3f0", stroke: "#545c78" },
  { background: "#ebdfef", stroke: "#725478" },
  { background: "#f2dfe6", stroke: "#965567" },
] as const;

export function presencePalette(slot: number) {
  return PRESENCE_PALETTE[slot] ?? PRESENCE_PALETTE[3]!;
}

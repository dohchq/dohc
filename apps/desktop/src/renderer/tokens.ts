// Warm paper + graphite palette (brand bible / packages/brand, supersedes the
// zinc D-E5 draft): near-monochrome warm neutrals, green-graphite accent,
// color only where semantics demand it (success/warning/danger, selection).
//
// Duplication guard — single source of truth pattern: styles.css carries the
// same values as a static stylesheet so first paint never waits on JS, and
// surfaces CSS cannot reach (window backgroundColor, titleBarOverlay) read
// them from here. tokens.test.ts parses styles.css and asserts every value
// below matches byte-for-byte; that sync test IS the guard — edit both files
// together or it fails. This is deliberate, tested duplication, not drift.
export interface ThemeTokens {
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  ink: string;
  hover: string;
  selected: string;
  skeleton: string;
  scrim: string;
  muted: string;
  subtle: string;
  accent: string;
  focus: string;
  agent: string;
  match: string;
  success: string;
  warning: string;
  danger: string;
  dangerFill: string;
  onDanger: string;
  selection: string;
}

export const palette: Record<"light" | "dark", ThemeTokens> = {
  light: {
    // Warm paper: document surface stays lightest, sidebar/panels step down
    // toward the line color so borders read without shouting.
    bg: "#faf9f5",
    panel: "#f3f1ea",
    panel2: "#ebe8e0",
    line: "#e4e1d8",
    ink: "#1c1b18",
    // State fills are ink alpha so one value serves both themes: 7% hover,
    // 14% selected, far enough apart to tell a hovered row from the
    // selection (see the contrast test).
    hover: "color-mix(in srgb, var(--dohc-ink) 7%, transparent)",
    selected: "color-mix(in srgb, var(--dohc-ink) 14%, transparent)",
    // The fill of loading bars.
    skeleton: "color-mix(in srgb, var(--dohc-ink) 11%, transparent)",
    scrim: "rgba(0, 0, 0, 0.40)",
    muted: "#55524a",
    // Decorative text must clear 3.0:1 on every surface it sits on —
    // panel-2 (insets), not just bg — in both modes (see the contrast
    // test).
    subtle: "#7f7b6e",
    // Green-graphite (the brand accent): keyboard focus, primary buttons.
    accent: "#2d342e",
    // The keyboard focus halo: the accent at the alpha that keeps it 3:1 on
    // every surface and state fill (see the contrast test).
    focus: "color-mix(in srgb, var(--dohc-accent) 60%, transparent)",
    // Olive, the default agent color: AA as text on bg, panel and panel-2.
    agent: "#666d2e",
    // Find-match highlight (search panel <mark>, pressed search toggles):
    // the editor's selection-blue family, tuned so the OPAQUE mark clears
    // 3:1 against every surface and the 14% selected-row fill, with paper
    // (bg) text on it at AA — see the contrast test below. The graphite
    // accent stays the only structural accent; this token means exactly
    // one thing: "your match".
    match: "#326fce",
    success: "#38684e",
    // AA as text on panel-2, where strips sit (see the contrast test).
    warning: "#855f1e",
    // AA as text on a menu row's 14% fill, its tightest surface (see the
    // contrast test).
    danger: "#9d3c28",
    // A danger confirm's fill and label.
    dangerFill: "#9d3c28",
    onDanger: "#faf9f5",
    selection: "rgba(58, 126, 233, 0.22)",
  },
  dark: {
    // Warm charcoal, never pure black. The ladder climbs away from the
    // paper the same way light descends from it: bg is the darkest, chrome
    // (panel) one step up, insets (panel-2) two steps up.
    bg: "#131211",
    panel: "#181715",
    panel2: "#201f1c",
    line: "#2a2925",
    ink: "#f6f4ee",
    hover: "color-mix(in srgb, var(--dohc-ink) 7%, transparent)",
    selected: "color-mix(in srgb, var(--dohc-ink) 14%, transparent)",
    skeleton: "color-mix(in srgb, var(--dohc-ink) 11%, transparent)",
    // Black dims a near-black page far less than a paper one, so dark needs
    // more of it for the page behind a dialog to recede.
    scrim: "rgba(0, 0, 0, 0.65)",
    muted: "#aba79b",
    subtle: "#7d7a6e",
    accent: "#d7d0c0",
    focus: "color-mix(in srgb, var(--dohc-accent) 50%, transparent)",
    agent: "#c0c585",
    // Dark variant: 3:1+ vs every surface and the 14% selected-row fill,
    // with paper (bg) text on it at AA.
    match: "#4382fa",
    success: "#82c29b",
    warning: "#d9a94e",
    danger: "#e1866c",
    // Danger text needs the light red on the panel, but a fill that light
    // reads soft with a dark label. The fill is deeper, under an ink label.
    dangerFill: "#b04530",
    onDanger: "#f6f4ee",
    selection: "rgba(102, 148, 245, 0.30)",
  },
};

/**
 * tokens.ts key → the custom property name styles.css spells it with, so the
 * sync test names each token the way the stylesheet does.
 */
export const CSS_TOKEN_NAMES: Record<keyof ThemeTokens, string> = {
  bg: "--dohc-bg",
  panel: "--dohc-panel",
  panel2: "--dohc-panel-2",
  line: "--dohc-line",
  ink: "--dohc-ink",
  hover: "--dohc-hover",
  selected: "--dohc-selected",
  skeleton: "--dohc-skeleton",
  scrim: "--dohc-scrim",
  muted: "--dohc-muted",
  subtle: "--dohc-subtle",
  accent: "--dohc-accent",
  focus: "--dohc-focus",
  agent: "--dohc-agent",
  match: "--dohc-match",
  success: "--dohc-success",
  warning: "--dohc-warning",
  danger: "--dohc-danger",
  dangerFill: "--dohc-danger-fill",
  onDanger: "--dohc-on-danger",
  selection: "--dohc-selection",
};

// A person's hue choices. Olive marks an agent, so a person never has it.
export const IDENTITY_HUES = [
  "rust",
  "amber",
  "teal",
  "blue",
  "indigo",
  "plum",
  "rose",
] as const;
export type IdentityHue = (typeof IDENTITY_HUES)[number];

// An agent's hue choices, in the picker's order.
export const AGENT_HUES = ["olive", ...IDENTITY_HUES] as const;
export type AgentHue = (typeof AGENT_HUES)[number];
// A new agent takes the first free hue here. Unlike the picker's order, each
// next hue is far from the ones before it, so two or three agents side by side stay apart.
export const AGENT_HUE_ASSIGNMENT_ORDER = [
  "olive", "blue", "rose", "teal", "plum", "rust", "amber", "indigo",
] as const satisfies readonly AgentHue[];

export const identityHues: Record<"light" | "dark", Record<IdentityHue, string>> = {
  light: {
    rust: "#88412c",
    amber: "#705012",
    teal: "#22645a",
    blue: "#285884",
    indigo: "#4c528f",
    plum: "#764580",
    rose: "#8e3f5a",
  },
  dark: {
    rust: "#dc9378",
    amber: "#d9b05a",
    teal: "#82c9bb",
    blue: "#8fb8e2",
    indigo: "#a7abee",
    plum: "#d09fd9",
    rose: "#e39bb2",
  },
};

/**
 * The type stacks, which do not change with theme. Same duplication guard as
 * the palette: tokens.test.ts asserts these against styles.css :root.
 *
 * Both stacks name bundled families first and fall through to the system
 * families rather than to the browser default.
 */
export const fonts = {
  "--font-sans": '"Inter Variable", system-ui, "Segoe UI", sans-serif',
  "--font-mono":
    '"IBM Plex Mono", ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace',
} as const;

// The custom titlebar strip and the OS titleBarOverlay must agree on height.
export const TITLEBAR_HEIGHT_PX = 40;

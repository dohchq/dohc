// Warm paper + graphite palette (brand bible / packages/brand, supersedes the
// zinc D-E5 draft): near-monochrome warm neutrals, green-graphite accent,
// color ONLY where semantics demand it (success/warning/danger, selection).
//
// DUPLICATION GUARD — single source of truth pattern: styles.css carries the
// SAME values as a static stylesheet so first paint never waits on JS, and
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
  muted: string;
  subtle: string;
  accent: string;
  agent: string;
  match: string;
  success: string;
  warning: string;
  danger: string;
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
    muted: "#55524a",
    // Decorative text must clear 3.0:1 on EVERY surface it sits on —
    // panel-2 (sidebar/status bar), not just bg — in both modes (see the
    // contrast test).
    subtle: "#7f7b6e",
    // Green-graphite (the brand accent): focus rings, primary buttons.
    accent: "#2d342e",
    agent: "#5c6250",
    // Find-match highlight (search panel <mark>, pressed search toggles):
    // the editor's selection-blue family, tuned so the OPAQUE mark clears
    // 3:1 against panel/panel-2 AND the selected-row bg (line), with bold
    // ink text on it at AA (4.38:1) — see the contrast test below. The
    // graphite accent stays the only structural accent; this token means
    // exactly one thing: "your match".
    match: "#3a7ee9",
    success: "#38684e",
    warning: "#8a6420",
    danger: "#a6402c",
    selection: "rgba(58, 126, 233, 0.22)",
  },
  dark: {
    // Warm charcoal with a green-black card surface (panel) per the brand
    // bible — never pure black.
    bg: "#131211",
    panel: "#1b1d1a",
    panel2: "#181715",
    line: "#2a2925",
    ink: "#f6f4ee",
    muted: "#a9a599",
    subtle: "#7d7a6e",
    accent: "#d7d0c0",
    agent: "#b7b8a4",
    // Dark variant: 3:1+ vs panel/panel-2/line. Ink-on-match is 4.30:1 —
    // near the physical ceiling while holding 3:1 against the selected-row
    // bg (any brighter mark erodes the ink text further); the mark text is
    // bold, which carries the remaining gap.
    match: "#2f6ce9",
    success: "#82c29b",
    warning: "#d9a94e",
    danger: "#e08065",
    selection: "rgba(102, 148, 245, 0.30)",
  },
};

/**
 * tokens.ts key → the custom property name styles.css spells it with. One
 * map, so the sync test and the plugin panel theme bridge name these tokens
 * the same way and cannot drift apart.
 */
export const CSS_TOKEN_NAMES: Record<keyof ThemeTokens, string> = {
  bg: "--dohc-bg",
  panel: "--dohc-panel",
  panel2: "--dohc-panel-2",
  line: "--dohc-line",
  ink: "--dohc-ink",
  muted: "--dohc-muted",
  subtle: "--dohc-subtle",
  accent: "--dohc-accent",
  agent: "--dohc-agent",
  match: "--dohc-match",
  success: "--dohc-success",
  warning: "--dohc-warning",
  danger: "--dohc-danger",
  selection: "--dohc-selection",
};

/**
 * The type stacks, which do not change with theme. Same duplication guard as
 * the palette: tokens.test.ts asserts these against styles.css :root.
 *
 * Both stacks name bundled families first. A surface that cannot load dohc's
 * fonts — a plugin panel on its own origin — falls through to the system
 * families here rather than to the browser default.
 */
export const fonts = {
  "--font-sans": '"InterVariable", system-ui, "Segoe UI", sans-serif',
  "--font-mono":
    '"IBM Plex Mono", ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace',
} as const;

// The custom titlebar strip and the OS titleBarOverlay must agree on height.
export const TITLEBAR_HEIGHT_PX = 40;

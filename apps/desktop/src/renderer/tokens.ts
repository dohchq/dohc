// Graphite-minimal palette (decision D-E5): near-monochrome, accent = ink,
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
  match: string;
  success: string;
  warning: string;
  danger: string;
  selection: string;
}

export const palette: Record<"light" | "dark", ThemeTokens> = {
  light: {
    bg: "#ffffff",
    panel: "#fafafa",
    panel2: "#f4f4f5",
    line: "#e4e4e7",
    ink: "#18181b",
    muted: "#52525b",
    // Two steps darker than zinc-400 (#a1a1aa): decorative text must clear
    // 3.0:1 on EVERY surface it sits on — panel-2 (sidebar/status bar), not
    // just bg — in both modes (see the contrast test).
    subtle: "#8b8b93",
    accent: "#18181b",
    // Find-match highlight (search panel <mark>, pressed search toggles):
    // the editor's selection-blue family, tuned so the OPAQUE mark clears
    // 3:1 against panel/panel-2 AND the selected-row bg (line), with bold
    // ink text on it at AA (4.62:1) — see the contrast test below. The
    // graphite accent stays the only structural accent; this token means
    // exactly one thing: "your match".
    match: "#3a80ec",
    success: "#15803d",
    warning: "#a16207",
    danger: "#b91c1c",
    selection: "rgba(59, 130, 246, 0.22)",
  },
  dark: {
    bg: "#18181b",
    panel: "#1e1e20",
    panel2: "#1c1c1e",
    line: "#2e2e33",
    ink: "#fafafa",
    muted: "#a1a1aa",
    subtle: "#71717a",
    accent: "#fafafa",
    // Dark variant: 3:1+ vs panel/panel-2/line. Ink-on-match is 4.27:1 —
    // the physical ceiling while holding 3:1 against the selected-row bg
    // (any brighter mark erodes the ink text further); the mark text is
    // bold, which carries the remaining gap.
    match: "#3270f0",
    success: "#4ade80",
    warning: "#fbbf24",
    danger: "#f87171",
    selection: "rgba(96, 165, 250, 0.32)",
  },
};

// The custom titlebar strip and the OS titleBarOverlay must agree on height.
export const TITLEBAR_HEIGHT_PX = 40;

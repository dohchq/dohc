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
    success: "#4ade80",
    warning: "#fbbf24",
    danger: "#f87171",
    selection: "rgba(96, 165, 250, 0.32)",
  },
};

// The custom titlebar strip and the OS titleBarOverlay must agree on height.
export const TITLEBAR_HEIGHT_PX = 40;

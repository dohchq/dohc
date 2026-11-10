import { useColorScheme } from "react-native";

// The desktop's palette (apps/desktop/src/renderer/tokens.ts), same names, for the colours the phone uses.
// Structure (tab bar, navigation, menus) stays the platform's own; these colour the content.
// `subtle` is one step darker than the desktop's here: phone text that uses it (muted chats) must stay readable.
const palette = {
  light: {
    bg: "#faf9f5", panel: "#f3f1ea", panel2: "#ebe8e0", line: "#e4e1d8",
    ink: "#1c1b18", muted: "#55524a", subtle: "#746f63",
    accent: "#2d342e", agent: "#666d2e", success: "#38684e", warning: "#855f1e", danger: "#a43e2a", presence: "#34a65f",
    // Chat: your own reaction, an agent option's outline, and the mention tint.
    mine: "#ddd8cd", outline: "#a29d93", mention: "rgba(45, 52, 46, 0.14)",
    agentTint: "rgba(102, 109, 46, 0.14)", field: "#ebe8e0", fieldLine: "transparent", reaction: "#f3f1ea", reactionLine: "#e4e1d8",
    // The desktop's agent/50 border; a floating surface (toast) that must lift off bg.
    agentLine: "rgba(102, 109, 46, 0.5)", raised: "#f3f1ea", raisedLine: "#e4e1d8",
    // The desktop's quiet unread count: its line at 70%.
    quietCount: "rgba(228, 225, 216, 0.7)",
    // The desktop's identity hues (tokens.ts identityHues), for an agent's or a person's chosen colour.
    hues: { rust: "#88412c", amber: "#705012", teal: "#22645a", blue: "#285884", indigo: "#4c528f", plum: "#764580", rose: "#8e3f5a" },
  },
  dark: {
    bg: "#131211", panel: "#181715", panel2: "#201f1c", line: "#2a2925",
    ink: "#f6f4ee", muted: "#a9a599", subtle: "#969184",
    accent: "#d7d0c0", agent: "#c0c585", success: "#82c29b", warning: "#d9a94e", danger: "#e08065", presence: "#5cc98a",
    mine: "#3d3a33", outline: "#777268", mention: "rgba(215, 208, 192, 0.18)",
    agentTint: "rgba(192, 197, 133, 0.16)", field: "#24231f", fieldLine: "transparent", reaction: "#201f1c", reactionLine: "#36332d",
    agentLine: "rgba(192, 197, 133, 0.5)", raised: "#201f1c", raisedLine: "#36332d",
    quietCount: "rgba(42, 41, 37, 0.7)",
    hues: { rust: "#dc9378", amber: "#d9b05a", teal: "#82c9bb", blue: "#8fb8e2", indigo: "#a7abee", plum: "#d09fd9", rose: "#e39bb2" },
  },
} as const;

/** Fills for a workspace's mark, under its white initial: the light identity hues, which hold it in both themes. */
export const workspaceMarkFills: readonly string[] = Object.values(palette.light.hues);

export type Theme = (typeof palette)["light"] | (typeof palette)["dark"];
export type IdentityHue = keyof Theme["hues"];

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? palette.dark : palette.light;
}

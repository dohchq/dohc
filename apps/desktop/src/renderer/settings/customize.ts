import { createContext } from "react";
import type { AskAgent } from "../askAgent";
import type { SettingsSectionId } from "./settingsRegistry";

/** A part of dohc whose ••• menu offers Customize… into Settings. */
export type CustomizePart = "sidebar" | "chats" | "editor";

export interface CustomizeTarget {
  // The Settings section that opens, and the row it brings into view.
  section: SettingsSectionId;
  row: string;
  // The part's keys in the settings file, which a request to an agent names.
  keys: readonly string[];
  // What that request calls the part.
  subject: string;
}

export const CUSTOMIZE_TARGETS: Record<CustomizePart, CustomizeTarget> = {
  sidebar: { section: "appearance", row: "settings-row-sidebar", keys: ["sidebar"], subject: "sidebar" },
  chats: {
    section: "appearance",
    row: "settings-row-your-color",
    keys: ["appearance.yourColor", "appearance.yourAgentColor"],
    subject: "chat colors",
  },
  editor: {
    section: "appearance",
    row: "settings-row-editor-font",
    keys: ["editor.fontFamily", "editor.fontSize"],
    subject: "editor",
  },
};

/**
 * What a part inside a workspace shell needs to be customized: Settings at
 * its row, and the person's agent when chats are on. Absent outside a shell.
 */
export const CustomizeContext = createContext<{
  customize: (part: CustomizePart) => void;
  askAgent?: AskAgent;
} | null>(null);

import { createContext } from "react";
import type { SettingsSectionId } from "./settingsRegistry";

/** A part of dohc whose ••• menu offers Customize… into Settings. */
export type CustomizePart = "sidebar" | "chats" | "editor";

export interface CustomizeTarget {
  // The Settings section that opens, and the row it brings into view.
  section: SettingsSectionId;
  row: string;
}

export const CUSTOMIZE_TARGETS: Record<CustomizePart, CustomizeTarget> = {
  sidebar: { section: "appearance", row: "settings-row-sidebar" },
  chats: { section: "appearance", row: "settings-row-your-color" },
  editor: { section: "appearance", row: "settings-row-editor-font" },
};

/**
 * What a part inside a workspace shell needs to be customized: Settings at
 * its row. Absent outside a shell.
 */
export const CustomizeContext = createContext<{
  customize: (part: CustomizePart) => void;
} | null>(null);

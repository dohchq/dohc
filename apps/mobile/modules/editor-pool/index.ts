import { requireNativeModule, requireNativeView } from "expo";
import type { ComponentType, Ref } from "react";
import { Platform, type StyleProp, type ViewStyle } from "react-native";

/** How a page got its editor: a spare that had loaded, a spare still loading, or a new one. */
export type EditorClaim = "ready" | "loading" | "cold";

export interface EditorSlotHandle {
  inject(script: string): Promise<void>;
}

type EditorSlotProps = {
  ref?: Ref<EditorSlotHandle>;
  /** The editor page's file URI. A spare loaded from another URI is never used. */
  source: string;
  /** The folder the page may read from. `source` must be inside it. */
  folder: string;
  /** Runs once in the page, once its script has started. */
  startScript?: string;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  /** The page failed to load or its web process ended. The slot stays empty. */
  onLost: () => void;
  onClaim?: (event: { nativeEvent: { kind: EditorClaim } }) => void;
  style?: StyleProp<ViewStyle>;
};

interface EditorPoolModule {
  /** Names the editor files. A rewrite drops a spare loaded from the old ones. */
  prepare(page: string, folder: string, rewritten: boolean): Promise<void>;
  /** While on, a spare loads two seconds after the app is active with every open settled. Off drops the spare. */
  keepSpare(on: boolean): Promise<void>;
  addListener(
    event: "spareReady",
    listener: (event: { ready: boolean }) => void,
  ): { remove(): void };
}

const pooled = Platform.OS === "ios" && !Platform.isPad;

/** A page's editor on iPhone, taken from the pool once the slot is in a window. Null elsewhere. */
export const EditorSlot: ComponentType<EditorSlotProps> | null = pooled
  ? requireNativeView<EditorSlotProps>("EditorPool")
  : null;

export const editorPool: EditorPoolModule | null = pooled
  ? requireNativeModule<EditorPoolModule>("EditorPool")
  : null;

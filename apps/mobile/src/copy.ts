import { documentWords } from "@dohc/interface-words/documents";
import * as Haptics from "expo-haptics";
import { AccessibilityInfo, Clipboard } from "react-native";

export function copyText(text: string) {
  Clipboard.setString(text);
  // A light tap, as the check is neutral: a copy is a small acknowledgment, not a finished task.
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  AccessibilityInfo.announceForAccessibility(documentWords.copied);
}

import { documentWords } from "@dohc/interface-words/documents";
import * as Haptics from "expo-haptics";
import { AccessibilityInfo, Clipboard } from "react-native";

// Copies text with React Native's own clipboard module, which ships in the app already. React Native marks it
// deprecated ("extracted from react-native core and will be removed in a future release"): before an upgrade
// removes it, switch to expo-clipboard. VoiceOver hears the
// desktop's "Copied"; the control that copied shows a check for a moment.
export function copyText(text: string) {
  Clipboard.setString(text);
  // A light tap, as the check is neutral: a copy is a small acknowledgment, not a finished task (the DL).
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  AccessibilityInfo.announceForAccessibility(documentWords.copied);
}
